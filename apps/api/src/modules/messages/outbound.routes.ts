import multipart from '@fastify/multipart';
import { AppError, INLINE_MEDIA_TYPES } from '@balesin/core';
import {
  API_ROUTES,
  MAX_UPLOAD_BYTES,
  conversationIdParamsSchema,
  emailHtmlResponseSchema,
  errorEnvelopeSchema,
  messageIdParamsSchema,
  messageResponseSchema,
  sendMessageRequestSchema,
  uploadMediaResponseSchema,
  hasPermission,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { ACCESS_RULES, forbidByRule, type AccessDeniedRecorder } from '../auth/access-denied';
import { requireAuth } from '../auth/auth.hook';
import { permissionGrant } from '../auth/permission-grant';
import { toMessage } from '../inbox/inbox-view';
import { contentDisposition } from './media-store';
import type { InitiationGrant, OutboundService } from './outbound.service';

export interface OutboundRoutesOptions {
  outbound: OutboundService;
  limiter: RateLimiter;
  /** Pencatat penolakan wewenang (mulai percakapan tanpa izin, QA P2-T1). */
  accessDenied: AccessDeniedRecorder;
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
/**
 * Mulai percakapan (template ke nomor baru, atau pesan baru ke percakapan yang sudah selesai — audit
 * akhir A1/A6): maks. 200 per pengguna per 24 jam (selain batas kirim harian biasa).
 */
export const INITIATE_USER_RULE: RateLimitRule = {
  name: 'mulai-percakapan',
  limit: 200,
  windowSeconds: 24 * 60 * 60,
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

/** Kembalikan `units` jatah mulai-percakapan (usaha terbaik — Redis bermasalah = dilewati). */
async function refundInitiation(limiter: RateLimiter, userId: string, units: number) {
  for (let index = 0; index < units; index += 1) {
    await limiter.refund(INITIATE_USER_RULE, userId).catch(() => undefined);
  }
}

/**
 * Izin "mulai percakapan" pengirim (audit akhir A1/A6/P2): `inbox.initiate` + jatah harian
 * `mulai-percakapan` (dipotong service hanya bila pesannya benar-benar memulai).
 */
function initiationGrant(
  request: FastifyRequest,
  limiter: RateLimiter,
  accessDenied: AccessDeniedRecorder,
): InitiationGrant {
  const auth = requireAuth(request);
  return {
    deny: (reason, message) =>
      forbidByRule(accessDenied, {
        auth,
        rule:
          reason === 'resolved'
            ? ACCESS_RULES.inboxInitiateResolved
            : reason === 'stale'
              ? ACCESS_RULES.inboxInitiateStale
              : ACCESS_RULES.inboxInitiateEmailRecipient,
        client: clientInfo(request),
        message,
      }),
    allowed: hasPermission(auth.user.role, 'inbox.initiate'),
    // Review 9.0 R1: N unit sekaligus — bila jatah habis di tengah, unit yang sudah diambil dikembalikan.
    consume: async (units = 1) => {
      let taken = 0;
      try {
        while (taken < units) {
          taken += 1;
          await enforceRateLimit(
            limiter,
            INITIATE_USER_RULE,
            auth.user.id,
            (wait) => `Batas harian memulai percakapan baru tercapai. Coba lagi dalam ${wait}.`,
          );
        }
      } catch (error) {
        await refundInitiation(limiter, auth.user.id, taken);
        throw error;
      }
    },
    refund: (units) => refundInitiation(limiter, auth.user.id, units),
  };
}

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
  const { outbound, limiter, accessDenied } = options;
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
      const { message, created } = await outbound.send(
        grant,
        id,
        request.body,
        clientInfo(request),
        initiationGrant(request, limiter, accessDenied),
      );
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
      const message = await outbound.retry(
        grant,
        id,
        clientInfo(request),
        initiationGrant(request, limiter, accessDenied),
      );
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
      // Dialirkan ke disk (review ruang chat S1) — tidak pernah dibaca utuh ke memori.
      const media = await outbound.upload(grant, id, {
        stream: part.file,
        filename: part.filename || null,
        truncated: () => part.file.truncated,
      });
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
      // Klien memutus sebelum jawaban selesai → unduhan dari Meta dibatalkan (bila tak ada peminta lain).
      const disconnected = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) disconnected.abort();
      });
      const { file, stream, sizeBytes } = await outbound.media(grant, id, disconnected.signal);
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

  // Fase 6: HTML email tersanitasi (web menampilkannya di `<iframe sandbox>`).
  app.get(
    API_ROUTES.inbox.emailHtml,
    {
      config: { access: VIEW },
      schema: {
        params: messageIdParamsSchema,
        response: { 200: emailHtmlResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const grant = await permissionGrant(request, 'inbox.view');
      const id = requireUuid(request.params.messageId, 'Pesan tidak ditemukan.');
      void reply.header('cache-control', 'private, no-store');
      return outbound.emailHtml(grant, id);
    },
  );
};
