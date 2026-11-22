import multipart from '@fastify/multipart';
import { AppError } from '@balesin/core';
import {
  API_ROUTES,
  EMAIL_ATTACHMENT_MAX_BYTES,
  EMAIL_SEND_BODY_LIMIT_BYTES,
  emailIdParamsSchema,
  emailMediaResponseSchema,
  emailReplyRequestSchema,
  emailReplyResponseSchema,
  emailSendRequestSchema,
  emailSendResponseSchema,
  emailStatusResponseSchema,
  errorEnvelopeSchema,
  idempotencyKeyHeaderSchema,
  publicEmailSendersResponseSchema,
  publicEmailTemplatesResponseSchema,
} from '@balesin/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { requireApiKeyScope } from '../../http/route-access';
import { requireApiKey } from '../api-keys/api-key-auth';
import type { EmailMessageTemplatesService } from '../email-message-templates/email-message-templates.service';
import { principalOf, type EmailSendService } from './email-send.service';

export interface EmailSendRoutesOptions {
  emailSend: EmailSendService;
  templates: Pick<EmailMessageTemplatesService, 'published'>;
}

/**
 * API publik email (tahap 9.1, docs/KONTRAK-API-EMAIL-KIRIM.md §3). `Authorization: Bearer
 * blsn_live_…`; baca = `email:read`, kirim/batal/balas/unggah = `email:send` (sudah termasuk
 * memulai percakapan email; tidak butuh `messages:initiate`). Autentikasi, `Origin` asing, 401/403,
 * dan 300 permintaan/menit per key = hook API publik.
 */

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  413: errorEnvelopeSchema,
  415: errorEnvelopeSchema,
  423: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

export const emailSendRoutes: FastifyPluginAsyncZod<EmailSendRoutesOptions> = async (
  app,
  options,
) => {
  const { emailSend, templates } = options;
  const routes = API_ROUTES.publicEmail;

  // Unggah lampiran: isian `senderId` lalu `file` (≤ 20 MB). Plugin terbungkus di modul ini saja.
  await app.register(multipart, {
    limits: {
      fileSize: EMAIL_ATTACHMENT_MAX_BYTES,
      files: 1,
      fields: 1,
      parts: 2,
      fieldNameSize: 32,
      fieldSize: 200,
    },
  });

  app.get(
    routes.senders,
    {
      config: { access: requireApiKeyScope('email:read') },
      schema: { response: { 200: publicEmailSendersResponseSchema, ...errors } },
    },
    async (request) => ({
      senders: await emailSend.senders(principalOf(requireApiKey(request))),
    }),
  );

  app.post(
    routes.send,
    {
      bodyLimit: EMAIL_SEND_BODY_LIMIT_BYTES,
      config: { access: requireApiKeyScope('email:send') },
      schema: {
        headers: idempotencyKeyHeaderSchema,
        body: emailSendRequestSchema,
        response: { 200: emailSendResponseSchema, 202: emailSendResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const key = requireApiKey(request);
      const { response, created } = await emailSend.send(
        principalOf(key),
        request.body,
        request.headers['idempotency-key'],
        clientInfo(request),
      );
      void reply.code(created ? 202 : 200);
      return response;
    },
  );

  app.post(
    routes.media,
    {
      config: { access: requireApiKeyScope('email:send') },
      schema: { response: { 201: emailMediaResponseSchema, ...errors } },
    },
    async (request, reply) => {
      const key = requireApiKey(request);
      if (!request.isMultipart()) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
          message: 'Kirim multipart/form-data berisi isian senderId lalu file.',
        });
      }
      let senderId: string | undefined;
      let file: { buffer: Buffer; filename: string | null } | null = null;
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'senderId' && typeof part.value === 'string') {
            senderId = part.value.trim();
          }
          continue;
        }
        if (part.fieldname !== 'file') {
          part.file.resume();
          continue;
        }
        const buffer = await part.toBuffer();
        if (part.file.truncated) {
          throw new AppError('PAYLOAD_TOO_LARGE', { message: 'Ukuran lampiran maksimal 20 MB.' });
        }
        file = { buffer, filename: part.filename || null };
      }
      if (!file) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Kirim satu berkas di isian "file".',
          details: [{ location: 'body', field: 'file', message: 'Berkas wajib dikirim.' }],
        });
      }
      const media = await emailSend.upload(principalOf(key), senderId, file);
      void reply.code(201);
      return { media };
    },
  );

  app.get(
    routes.message,
    {
      config: { access: requireApiKeyScope('email:read') },
      schema: {
        params: emailIdParamsSchema,
        response: { 200: emailStatusResponseSchema, ...errors },
      },
    },
    async (request) => ({
      email: await emailSend.status(principalOf(requireApiKey(request)), request.params.emailId),
    }),
  );

  app.post(
    routes.cancel,
    {
      config: { access: requireApiKeyScope('email:send') },
      schema: {
        params: emailIdParamsSchema,
        response: { 200: emailStatusResponseSchema, ...errors },
      },
    },
    async (request) => ({
      email: await emailSend.cancel(principalOf(requireApiKey(request)), request.params.emailId),
    }),
  );

  app.get(
    routes.templates,
    {
      config: { access: requireApiKeyScope('email:read') },
      schema: { response: { 200: publicEmailTemplatesResponseSchema, ...errors } },
    },
    async (request) => ({
      templates: await templates.published(requireApiKey(request).organizationId),
    }),
  );

  app.post(
    routes.reply,
    {
      bodyLimit: EMAIL_SEND_BODY_LIMIT_BYTES,
      config: { access: requireApiKeyScope('email:send') },
      schema: {
        params: emailIdParamsSchema,
        headers: idempotencyKeyHeaderSchema,
        body: emailReplyRequestSchema,
        response: { 200: emailReplyResponseSchema, 202: emailReplyResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const key = requireApiKey(request);
      const { response, created } = await emailSend.reply(
        principalOf(key),
        request.params.emailId,
        request.body,
        request.headers['idempotency-key'],
        clientInfo(request),
      );
      void reply.code(created ? 202 : 200);
      return {
        id: response.id,
        status: response.status,
        conversationId: response.conversationId,
        messageId: response.messageId,
        sanitized: response.sanitized,
      };
    },
  );
};
