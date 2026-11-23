import {
  API_ROUTES,
  errorEnvelopeSchema,
  mailActionRequestSchema,
  mailActionResponseSchema,
  mailAttachmentIdParamsSchema,
  mailAttachmentLoadingResponseSchema,
  mailAttachmentQuerySchema,
  mailMessageDetailResponseSchema,
  mailMessageIdParamsSchema,
  mailMessageListQuerySchema,
  mailMessageListResponseSchema,
  mailMessageViewRequestSchema,
  mailMessageViewResponseSchema,
  mailRemoteImageSenderRequestSchema,
  mailRemoteImageSendersResponseSchema,
  mailSourceQuerySchema,
  mailViewCidParamsSchema,
  mailViewImageParamsSchema,
  mailViewTokenParamsSchema,
} from '@balesin/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo, ipRateLimitKey } from '../../http/client-info';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { PUBLIC, requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type {
  MailBinaryResponse,
  MailMessagesService,
  MailRequestContext,
  MailTokenGuard,
} from './mail-messages.service';

export interface MailMessagesRoutesOptions {
  messages: MailMessagesService;
  limiter: RateLimiter;
}

/** Batas laju (kontrak §7–§9). */
export const MAIL_LIST_RULE: RateLimitRule = { name: 'mail-daftar', limit: 240, windowSeconds: 60 };
export const MAIL_VIEW_RULE: RateLimitRule = {
  name: 'mail-tampilan',
  limit: 120,
  windowSeconds: 60,
};
export const MAIL_ACTION_RULE: RateLimitRule = { name: 'mail-aksi', limit: 120, windowSeconds: 60 };
/**
 * Review 9A-2 S5: rute token dibatasi per PENGGUNA & per ORGANISASI sesi asal (setelah token
 * di-resolve) — bukan per token, karena email lain = token lain. Per IP (IPv6 per /64) sebelum itu.
 */
export const MAIL_IMAGE_RULE: RateLimitRule = {
  name: 'mail-gambar-pengguna',
  limit: 300,
  windowSeconds: 60,
};
export const MAIL_IMAGE_ORG_RULE: RateLimitRule = {
  name: 'mail-gambar-organisasi',
  limit: 3_000,
  windowSeconds: 60,
};
export const MAIL_VIEW_DOCUMENT_RULE: RateLimitRule = {
  name: 'mail-dokumen-pengguna',
  limit: 240,
  windowSeconds: 60,
};
export const MAIL_CID_RULE: RateLimitRule = {
  name: 'mail-cid-pengguna',
  limit: 600,
  windowSeconds: 60,
};
export const MAIL_TOKEN_IP_RULE: RateLimitRule = {
  name: 'mail-token-ip',
  limit: 600,
  windowSeconds: 60,
};
export const MAIL_READ_RULE: RateLimitRule = { name: 'mail-baca', limit: 240, windowSeconds: 60 };
/**
 * Review 9A-2 R10: pengambilan BARU dari server email (isi/lampiran belum di cache) per pengguna —
 * tiap job = satu LOGIN IMAP; menyisir banyak email bisa membuat server email memblokir IP Balesin.
 */
export const MAIL_SERVER_FETCH_RULE: RateLimitRule = {
  name: 'mail-ambil-server',
  limit: 60,
  windowSeconds: 60,
};
export const MAIL_SERVER_FETCH_MESSAGE = (wait: string) =>
  `Terlalu banyak email dibuka sekaligus. Coba lagi dalam ${wait}.`;

const VIEW = requirePermission('mail.view');

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  410: errorEnvelopeSchema,
  413: errorEnvelopeSchema,
  415: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

const BODY_LIMIT_BYTES = 32 * 1024;
const waitMessage = (wait: string) => `Terlalu banyak permintaan email. Coba lagi dalam ${wait}.`;

function sendBinary(reply: FastifyReply, response: MailBinaryResponse) {
  // Dokumen tampilan dibingkai aplikasi sendiri: `X-Frame-Options: DENY` global diganti
  // `frame-ancestors` di CSP dokumen ini (kontrak §8). Rute lain tetap DENY.
  if (response.headers['content-security-policy']?.includes('frame-ancestors')) {
    reply.removeHeader('x-frame-options');
  }
  void reply.status(response.status).headers(response.headers);
  return reply.send(response.body);
}

/**
 * Modul Email bagian 2 — daftar, baca, aksi (docs/KONTRAK-API-EMAIL.md §7–§9, penyimpangan §16).
 * Rute sesi berpintu `mail.view` (hak nyata per akun di service). Rute `/mail/view/:token*` PUBLIK
 * dari sisi sesi cookie (iframe sandbox ber-origin opak tidak membawa cookie) — autentikasinya token
 * bertanda tangan yang memeriksa ulang sesi asal + hak setiap kali.
 */
export const mailMessagesRoutes: FastifyPluginCallbackZod<MailMessagesRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { messages, limiter } = options;
  const routes = API_ROUTES.mail;
  const contextOf = (request: FastifyRequest): MailRequestContext => ({
    client: clientInfo(request),
    log: request.log,
  });
  const limit = (rule: RateLimitRule, key: string) =>
    enforceRateLimit(limiter, rule, key, waitMessage);
  const ipLimit = (request: FastifyRequest) =>
    limit(MAIL_TOKEN_IP_RULE, ipRateLimitKey(clientInfo(request)));
  const actorLimit =
    (rule: RateLimitRule, organizationRule?: RateLimitRule): MailTokenGuard =>
    async (actor) => {
      await limit(rule, actor.user.id);
      if (organizationRule) await limit(organizationRule, actor.organizationId);
    };
  const documentGuard = actorLimit(MAIL_VIEW_DOCUMENT_RULE);
  const imageGuard = actorLimit(MAIL_IMAGE_RULE, MAIL_IMAGE_ORG_RULE);
  const cidGuard = actorLimit(MAIL_CID_RULE);

  app.get(
    routes.messages,
    {
      config: { access: VIEW },
      schema: {
        querystring: mailMessageListQuerySchema,
        response: { 200: mailMessageListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_LIST_RULE, auth.user.id);
      return messages.list(auth, request.query);
    },
  );

  app.post(
    routes.messageActions,
    {
      config: { access: VIEW },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: mailActionRequestSchema,
        response: { 200: mailActionResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_ACTION_RULE, auth.user.id);
      return messages.act(auth, request.body, contextOf(request));
    },
  );

  app.get(
    routes.message,
    {
      config: { access: VIEW },
      schema: {
        params: mailMessageIdParamsSchema,
        response: { 200: mailMessageDetailResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_READ_RULE, auth.user.id);
      return messages.detail(auth, request.params.messageId, contextOf(request));
    },
  );

  app.post(
    routes.messageView,
    {
      config: { access: VIEW },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: mailMessageIdParamsSchema,
        body: mailMessageViewRequestSchema.optional(),
        response: { 200: mailMessageViewResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_VIEW_RULE, auth.user.id);
      return messages.createView(auth, request.params.messageId, request.body?.images ?? 'auto');
    },
  );

  app.get(
    routes.messageSource,
    {
      config: { access: VIEW, rawResponse: true },
      schema: { params: mailMessageIdParamsSchema, querystring: mailSourceQuerySchema },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await limit(MAIL_READ_RULE, auth.user.id);
      return sendBinary(
        reply,
        await messages.source(auth, request.params.messageId, request.query.download === '1'),
      );
    },
  );

  for (const [route, preview] of [
    [routes.attachment, false],
    [routes.attachmentPreview, true],
  ] as const) {
    app.get(
      route,
      {
        config: { access: VIEW, rawResponse: true },
        schema: { params: mailAttachmentIdParamsSchema, querystring: mailAttachmentQuerySchema },
      },
      async (request, reply) => {
        const auth = requireAuth(request);
        await limit(MAIL_READ_RULE, auth.user.id);
        const result = await messages.attachment(
          auth,
          request.params.attachmentId,
          { confirm: request.query.confirm === '1', preview },
          contextOf(request),
        );
        if (!('headers' in result)) {
          return reply
            .status(202)
            .send(mailAttachmentLoadingResponseSchema.parse({ state: 'loading' }));
        }
        return sendBinary(reply, result);
      },
    );
  }

  app.get(
    routes.remoteImageSenders,
    {
      config: { access: VIEW },
      schema: { response: { 200: mailRemoteImageSendersResponseSchema, ...errors } },
    },
    (request) => messages.remoteImageSenders(requireAuth(request)),
  );

  app.post(
    routes.remoteImageSenders,
    {
      config: { access: VIEW },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: mailRemoteImageSenderRequestSchema,
        response: { 200: mailRemoteImageSendersResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_ACTION_RULE, auth.user.id);
      return messages.addRemoteImageSender(auth, request.body.address);
    },
  );

  app.delete(
    routes.remoteImageSenders,
    {
      config: { access: VIEW },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: mailRemoteImageSenderRequestSchema,
        response: { 200: mailRemoteImageSendersResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await limit(MAIL_ACTION_RULE, auth.user.id);
      return messages.removeRemoteImageSender(auth, request.body.address);
    },
  );

  // ── Rute token (iframe sandbox) ──────────────────────────────────────────

  app.get(
    routes.view,
    {
      config: { access: PUBLIC, rawResponse: true },
      schema: { params: mailViewTokenParamsSchema },
    },
    async (request, reply) => {
      await ipLimit(request);
      return sendBinary(reply, await messages.viewDocument(request.params.token, documentGuard));
    },
  );

  app.get(
    routes.viewImage,
    {
      config: { access: PUBLIC, rawResponse: true },
      schema: { params: mailViewImageParamsSchema },
    },
    async (request, reply) => {
      await ipLimit(request);
      return sendBinary(
        reply,
        await messages.viewImage(request.params.token, request.params.index, imageGuard),
      );
    },
  );

  app.get(
    routes.viewCid,
    {
      config: { access: PUBLIC, rawResponse: true },
      schema: { params: mailViewCidParamsSchema },
    },
    async (request, reply) => {
      await ipLimit(request);
      return sendBinary(
        reply,
        await messages.viewCid(request.params.token, request.params.attachmentId, cidGuard),
      );
    },
  );

  done();
};
