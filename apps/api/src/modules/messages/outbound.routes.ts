import multipart from '@fastify/multipart';
import { AppError, INLINE_MEDIA_TYPES } from '@balesin/core';
import {
  API_ROUTES,
  MAX_UPLOAD_BYTES,
  conversationIdParamsSchema,
  errorEnvelopeSchema,
  messageIdParamsSchema,
  messageResponseSchema,
  sendMessageRequestSchema,
  uploadMediaResponseSchema,
} from '@balesin/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { permissionGrant } from '../auth/permission-grant';
import { toMessage } from '../inbox/inbox-view';
import { contentDisposition } from './media-store';
import type { OutboundService } from './outbound.service';

export interface OutboundRoutesOptions {
  outbound: OutboundService;
  limiter: RateLimiter;
}

/**
 * Ruang chat (docs/KONTRAK-API-INBOX.md "Ruang chat"):
 *  - `POST /conversations/:id/messages` kirim (CSRF, `inbox.reply` + cakupan)
 *  - `POST /conversations/:id/media`    unggah media (multipart, CSRF, `inbox.reply` + cakupan)
 *  - `POST /messages/:id/retry`         kirim ulang yang gagal (CSRF, `inbox.reply` + cakupan)
 *  - `GET  /messages/:id/media`         unduh media (CSRF — memakai jatah Meta + menulis cache;
 *                                       `inbox.view` + cakupan)
 *
 * PRD §4: membalas percakapan yang SUDAH ADA = `inbox.reply` (Teknisi: hanya yang di-assign);
 * memulai percakapan ke nomor baru (`inbox.initiate`, template) belum ada di butir ini.
 */

/** Batas kirim per pengguna (cegah akun curian membanjiri pelanggan) dan per organisasi. */
export const SEND_USER_RULE: RateLimitRule = {
  name: 'kirim-pengguna',
  limit: 30,
  windowSeconds: 60,
};
export const SEND_ORGANIZATION_RULE: RateLimitRule = {
  name: 'kirim-organisasi',
  limit: 600,
  windowSeconds: 60,
};
export const UPLOAD_USER_RULE: RateLimitRule = {
  name: 'unggah-media',
  limit: 20,
  windowSeconds: 60,
};
export const MEDIA_USER_RULE: RateLimitRule = {
  name: 'unduh-media',
  limit: 120,
  windowSeconds: 60,
};

const REPLY = requirePermission('inbox.reply');
const VIEW = requirePermission('inbox.view');
const UUID = z.uuid();

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  413: errorEnvelopeSchema,
  415: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  502: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

function requireUuid(value: string, message: string): string {
  if (!UUID.safeParse(value).success) throw new AppError('NOT_FOUND', { message });
  return value;
}

const sendLimit = (wait: string) =>
  `Terlalu banyak pesan dalam waktu singkat. Coba lagi dalam ${wait}.`;
const orgLimit = (wait: string) =>
  `Batas kirim organisasi per menit tercapai. Coba lagi dalam ${wait}.`;
const uploadLimit = (wait: string) => `Terlalu banyak unggahan. Coba lagi dalam ${wait}.`;
const mediaLimit = (wait: string) => `Terlalu banyak unduhan media. Coba lagi dalam ${wait}.`;

export const outboundRoutes: FastifyPluginAsyncZod<OutboundRoutesOptions> = async (
  app,
  options,
) => {
  const { outbound, limiter } = options;
  const routes = API_ROUTES.inbox;

  // Parser multipart HANYA di dalam plugin ini (rute lain tetap menolak multipart).
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1, fieldNameSize: 32 },
  });

  app.post(
    routes.messages,
    {
      config: { access: REPLY },
      schema: {
        params: conversationIdParamsSchema,
        body: sendMessageRequestSchema,
        response: { 200: messageResponseSchema, 202: messageResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const grant = await permissionGrant(request, 'inbox.reply');
      const id = requireUuid(request.params.conversationId, 'Percakapan tidak ditemukan.');
      await enforceRateLimit(limiter, SEND_USER_RULE, grant.userId, sendLimit);
      await enforceRateLimit(limiter, SEND_ORGANIZATION_RULE, grant.organizationId, orgLimit);
      const { message, created } = await outbound.send(grant, id, request.body);
      void reply.code(created ? 202 : 200);
      return { message: toMessage(message) };
    },
  );

  app.post(
    API_ROUTES.inbox.retry,
    {
      config: { access: REPLY },
      schema: {
        params: messageIdParamsSchema,
        response: { 202: messageResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const grant = await permissionGrant(request, 'inbox.reply');
      const id = requireUuid(request.params.messageId, 'Pesan tidak ditemukan.');
      await enforceRateLimit(limiter, SEND_USER_RULE, grant.userId, sendLimit);
      await enforceRateLimit(limiter, SEND_ORGANIZATION_RULE, grant.organizationId, orgLimit);
      const message = await outbound.retry(grant, id);
      void reply.code(202);
      return { message: toMessage(message) };
    },
  );

  app.post(
    routes.upload,
    {
      config: { access: REPLY },
      schema: {
        params: conversationIdParamsSchema,
        response: { 201: uploadMediaResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const grant = await permissionGrant(request, 'inbox.reply');
      const id = requireUuid(request.params.conversationId, 'Percakapan tidak ditemukan.');
      await enforceRateLimit(limiter, UPLOAD_USER_RULE, grant.userId, uploadLimit);
      if (!request.isMultipart()) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
          message: 'Kirim berkas sebagai multipart/form-data (isian "file").',
        });
      }
      let part;
      try {
        part = await request.file();
      } catch {
        throw new AppError('BAD_REQUEST', { message: 'Berkas tidak bisa dibaca.' });
      }
      if (!part || part.fieldname !== 'file') {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Pilih satu berkas untuk diunggah.',
          details: [{ location: 'body', field: 'file', message: 'Berkas wajib diisi.' }],
        });
      }
      let bytes: Buffer;
      try {
        bytes = await part.toBuffer();
      } catch {
        throw new AppError('PAYLOAD_TOO_LARGE', {
          message: `Berkas terlalu besar (maks. ${String(MAX_UPLOAD_BYTES / (1024 * 1024))} MB).`,
        });
      }
      if (bytes.byteLength === 0) {
        throw new AppError('VALIDATION_ERROR', { message: 'Berkas kosong.' });
      }
      const media = await outbound.upload(grant, id, { bytes, filename: part.filename || null });
      void reply.code(201);
      return { media };
    },
  );

  app.get(
    API_ROUTES.inbox.media,
    {
      // Efek samping (unduh dari Meta, tulis cache, memakai jatah): wajib CSRF walau GET.
      config: { access: VIEW, rawResponse: true, requireCsrf: true },
      schema: { params: messageIdParamsSchema },
    },
    async (request, reply) => {
      const grant = await permissionGrant(request, 'inbox.view');
      const id = requireUuid(request.params.messageId, 'Pesan tidak ditemukan.');
      await enforceRateLimit(limiter, MEDIA_USER_RULE, grant.userId, mediaLimit);
      const { file, stream, sizeBytes } = await outbound.media(grant, id);
      const inline = INLINE_MEDIA_TYPES.has(file.mimeType);
      void reply.headers({
        'content-type': inline ? file.mimeType : 'application/octet-stream',
        'content-length': String(sizeBytes),
        'content-disposition': contentDisposition(
          inline ? 'inline' : 'attachment',
          file.filename ?? `media-${file.id.slice(0, 8)}`,
        ),
        'x-content-type-options': 'nosniff',
        // Berkas pelanggan tidak pernah dijalankan sebagai halaman (SVG/HTML tidak inline).
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, max-age=300',
        'cross-origin-resource-policy': 'same-origin',
      });
      return reply.send(stream);
    },
  );
};
