import { AppError, INLINE_MEDIA_TYPES } from '@balesin/core';
import {
  MOBICHAT_HISTORY_DEFAULT,
  MOBICHAT_ROUTES,
  MOBICHAT_SETTABLE_STATUSES,
  idempotencyKeyHeaderSchema,
  mobichatAssignRequestSchema,
  mobichatBotErrorSchema,
  mobichatBotReplyMediaRequestSchema,
  mobichatBotReplyRequestSchema,
  mobichatBotReplyResponseSchema,
  mobichatContactResponseSchema,
  mobichatConversationNumber,
  mobichatConversationQuerySchema,
  mobichatConversationStatusResponseSchema,
  mobichatErrorSchema,
  mobichatMediaParamsSchema,
  mobichatMediaQuerySchema,
  mobichatMessagesQuerySchema,
  mobichatMessagesResponseSchema,
  mobichatNoteRequestSchema,
  mobichatSendMessagesRequestSchema,
  mobichatSendMessagesResponseSchema,
  mobichatSetStatusRequestSchema,
  mobichatSuccessResponseSchema,
  mobichatTagsRequestSchema,
  mobichatUnassignRequestSchema,
  mobichatUpdateContactRequestSchema,
} from '@balesin/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod, FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { prepareErrorReply, type ErrorResponse } from '../../http/error-handler';
import { PUBLIC, requireMobichatApiKeyScope } from '../../http/route-access';
import { requireApiKey } from '../api-keys/api-key-auth';
import { contentDisposition } from '../messages/media-store';
import type { MediaUrlSigner } from './media-signature';
import type { MobichatService, SentSummary } from './mobichat.service';

export interface MobichatRoutesOptions {
  mobichat: MobichatService;
  signer: MediaUrlSigner;
  now?: () => Date;
}

/**
 * Rute kompatibel MobiChat (docs/KONTRAK-API-MOBICHAT.md). Dua keluarga dengan bentuk galat
 * berbeda, sama seperti MobiChat:
 *  - `/api/public/*` → `{ success: false, code, message }`;
 *  - `/api/bot/*` (Bot API lama) → `{ error: "..." }`.
 * Penangan galat dipasang per konteks plugin, jadi berlaku juga untuk penolakan di hook auth
 * (API key salah/scope kurang) pada rute ini. Kode status tetap standar (400/401/403/404/409/413/
 * 415/423/429/5xx).
 */

/** Pesan galat ringkas: galat validasi menyebut isian pertama yang salah (berguna di log n8n). */
function messageOf(response: ErrorResponse): string {
  const detail = response.details?.[0];
  if (response.code === 'VALIDATION_ERROR' && detail) {
    return detail.field ? `${detail.field}: ${detail.message}` : detail.message;
  }
  return response.message;
}

function publicErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const response = prepareErrorReply(error, request, reply);
  return reply
    .status(response.statusCode)
    .send({ success: false, code: response.code, message: messageOf(response) });
}

function botErrorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const response = prepareErrorReply(error, request, reply);
  return reply.status(response.statusCode).send({ error: messageOf(response) });
}

const publicErrors = {
  400: mobichatErrorSchema,
  401: mobichatErrorSchema,
  403: mobichatErrorSchema,
  404: mobichatErrorSchema,
  409: mobichatErrorSchema,
  413: mobichatErrorSchema,
  415: mobichatErrorSchema,
  423: mobichatErrorSchema,
  429: mobichatErrorSchema,
  503: mobichatErrorSchema,
};
const botErrors = {
  400: mobichatBotErrorSchema,
  401: mobichatBotErrorSchema,
  403: mobichatBotErrorSchema,
  404: mobichatBotErrorSchema,
  409: mobichatBotErrorSchema,
  413: mobichatBotErrorSchema,
  415: mobichatBotErrorSchema,
  423: mobichatBotErrorSchema,
  429: mobichatBotErrorSchema,
  503: mobichatBotErrorSchema,
};

function sendResponse(summary: SentSummary) {
  const first = summary.messages[0];
  return {
    success: true as const,
    conversation_id: summary.conversationNumber,
    message_id: first?.number ?? 0,
    status: first?.status ?? null,
    messages: summary.messages.map((message) => ({
      id: message.number,
      message_id: message.number,
      message_type: message.type,
      status: message.status,
    })),
  };
}

/** Jawaban Bot API lama (bentuk MobiChat). `wamid` `null`: pesan dikirim lewat antrean worker. */
function botReplyResponse(summary: SentSummary) {
  const first = summary.messages[0];
  const phone = summary.phone ?? '';
  return {
    success: true as const,
    message_id: first?.number ?? 0,
    conversation_id: summary.conversationNumber,
    result: {
      success: true as const,
      data: {
        messaging_product: 'whatsapp' as const,
        contacts: phone ? [{ input: phone, wa_id: phone }] : [],
        messages: [{ id: null }],
      },
    },
    status: first?.status ?? null,
  };
}

const ok = (message: string, conversationNumber?: number) => ({
  success: true as const,
  status: 'success',
  message,
  ...(conversationNumber !== undefined ? { conversation_id: conversationNumber } : {}),
});

const publicRoutes: FastifyPluginCallbackZod<MobichatRoutesOptions> = (app, options, done) => {
  const { mobichat, signer } = options;
  const now = options.now ?? (() => new Date());
  app.setErrorHandler(publicErrorHandler);

  app.get(
    MOBICHAT_ROUTES.messages,
    {
      config: { access: requireMobichatApiKeyScope('messages:read') },
      schema: {
        querystring: mobichatMessagesQuerySchema,
        response: { 200: mobichatMessagesResponseSchema, ...publicErrors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const result = await mobichat.history(
        key,
        mobichatConversationNumber(request.query),
        request.query.limit ?? MOBICHAT_HISTORY_DEFAULT,
      );
      return {
        success: true as const,
        conversation_id: result.conversationNumber,
        messages: result.messages,
      };
    },
  );

  app.post(
    MOBICHAT_ROUTES.messages,
    {
      config: { access: requireMobichatApiKeyScope('messages:send') },
      schema: {
        headers: idempotencyKeyHeaderSchema,
        body: mobichatSendMessagesRequestSchema,
        response: { 200: mobichatSendMessagesResponseSchema, ...publicErrors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const summary = await mobichat.send(
        key,
        mobichatConversationNumber(request.body),
        request.body.messages,
        request.headers['idempotency-key'],
        clientInfo(request),
      );
      return sendResponse(summary);
    },
  );

  app.get(
    MOBICHAT_ROUTES.conversationStatus,
    {
      config: { access: requireMobichatApiKeyScope('conversations:read') },
      schema: {
        querystring: mobichatConversationQuerySchema,
        response: { 200: mobichatConversationStatusResponseSchema, ...publicErrors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const result = await mobichat.status(key, mobichatConversationNumber(request.query));
      return {
        success: true as const,
        conversation_id: result.conversationNumber,
        status: result.status,
        assignments: result.assignments,
      };
    },
  );

  app.post(
    MOBICHAT_ROUTES.conversationStatus,
    {
      config: { access: requireMobichatApiKeyScope('conversations:write') },
      schema: {
        body: mobichatSetStatusRequestSchema,
        response: { 200: mobichatSuccessResponseSchema, ...publicErrors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const number = mobichatConversationNumber(request.body);
      const client = clientInfo(request);
      if (request.body.status === 'unserved') {
        const { changed } = await mobichat.release(key, number, null, client);
        return ok(
          changed
            ? 'Percakapan dilepas dari bot dan masuk antrian "Belum dilayani".'
            : 'Percakapan tidak sedang dipegang bot; tidak ada yang diubah.',
          number,
        );
      }
      if (request.body.status === 'resolved') {
        const { changed } = await mobichat.resolve(key, number, client);
        return ok(changed ? 'Percakapan ditandai selesai.' : 'Percakapan sudah selesai.', number);
      }
      throw new AppError('VALIDATION_ERROR', {
        message: `Status "${request.body.status.slice(0, 32)}" belum didukung. Pakai ${MOBICHAT_SETTABLE_STATUSES.join(' atau ')}.`,
      });
    },
  );

  app.post(
    MOBICHAT_ROUTES.unassignAgent,
    {
      config: { access: requireMobichatApiKeyScope('conversations:write') },
      schema: {
        body: mobichatUnassignRequestSchema,
        response: { 200: mobichatSuccessResponseSchema, ...publicErrors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const number = mobichatConversationNumber(request.body);
      const { changed } = await mobichat.release(
        key,
        number,
        request.body.agent_id,
        clientInfo(request),
      );
      return ok(
        changed
          ? 'Percakapan dilepas dan masuk antrian "Belum dilayani".'
          : 'Tidak ada yang dilepas (percakapan sudah di antrian atau dipegang agen lain).',
        number,
      );
    },
  );

  app.post(
    MOBICHAT_ROUTES.agents,
    {
      config: { access: requireMobichatApiKeyScope('conversations:write') },
      schema: {
        body: mobichatAssignRequestSchema,
        response: { 200: mobichatSuccessResponseSchema, ...publicErrors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const number = mobichatConversationNumber(request.body);
      await mobichat.assign(key, number, request.body.agent_id, clientInfo(request));
      return ok('Percakapan ditugaskan ke agen.', number);
    },
  );

  app.post(
    MOBICHAT_ROUTES.notes,
    {
      config: { access: requireMobichatApiKeyScope('conversations:write') },
      schema: {
        body: mobichatNoteRequestSchema,
        response: { 200: mobichatSuccessResponseSchema, ...publicErrors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const number = mobichatConversationNumber(request.body);
      await mobichat.note(key, number, request.body.notes, clientInfo(request));
      return ok('Catatan tersimpan.', number);
    },
  );

  app.put(
    MOBICHAT_ROUTES.contacts,
    {
      config: { access: requireMobichatApiKeyScope('contacts:write') },
      schema: {
        body: mobichatUpdateContactRequestSchema,
        response: { 200: mobichatContactResponseSchema, ...publicErrors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const { edited_name: edited, full_name: full, name } = request.body;
      const chosen = [edited, full, name].find(
        (value) => value !== undefined && value.trim() !== '',
      );
      const contact = await mobichat.rename(
        key,
        mobichatConversationNumber(request.body),
        chosen ?? '',
      );
      return {
        success: true as const,
        status: 'success',
        message: 'Nama kontak diperbarui.',
        contact,
      };
    },
  );

  app.put(
    MOBICHAT_ROUTES.tagsWhatsapp,
    {
      config: { access: requireMobichatApiKeyScope('contacts:write') },
      schema: {
        body: mobichatTagsRequestSchema,
        response: { 200: mobichatContactResponseSchema, ...publicErrors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const contact = await mobichat.addTags(key, request.body.whatsapp_number, request.body.tags);
      return { success: true as const, status: 'success', message: 'Tag ditambahkan.', contact };
    },
  );

  // URL media bertanda tangan (tanpa header: n8n/penyedia AI mengunduh dengan GET polos).
  app.get(
    MOBICHAT_ROUTES.media,
    {
      config: { access: PUBLIC, rawResponse: true },
      schema: { params: mobichatMediaParamsSchema, querystring: mobichatMediaQuerySchema },
    },
    async (request, reply) => {
      const unavailable = () =>
        new AppError('NOT_FOUND', { message: 'Media tidak ditemukan atau tautannya kedaluwarsa.' });
      const number = Number(request.params.messageNumber);
      const exp = Number(request.query.exp);
      const { kid, sig } = request.query;
      if (
        !/^[1-9]\d{0,14}$/.test(request.params.messageNumber) ||
        !Number.isSafeInteger(exp) ||
        !kid ||
        !sig ||
        !signer.verify({ messageNumber: number, exp, kid, sig }, now())
      ) {
        throw unavailable();
      }
      const disconnected = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) disconnected.abort();
      });
      const media = await mobichat.signedMedia(number, kid, disconnected.signal);
      if (!media) throw unavailable();
      const { file, stream, sizeBytes } = media;
      const inline = INLINE_MEDIA_TYPES.has(file.mimeType);
      void reply.headers({
        'content-type': inline ? file.mimeType : 'application/octet-stream',
        'content-length': String(sizeBytes),
        'content-disposition': contentDisposition(
          inline ? 'inline' : 'attachment',
          file.filename ?? `media-${String(number)}`,
        ),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-store',
        'referrer-policy': 'no-referrer',
      });
      return reply.send(stream);
    },
  );
  done();
};

const botRoutes: FastifyPluginCallbackZod<MobichatRoutesOptions> = (app, options, done) => {
  const { mobichat } = options;
  app.setErrorHandler(botErrorHandler);

  app.post(
    MOBICHAT_ROUTES.botReply,
    {
      config: { access: requireMobichatApiKeyScope('messages:send') },
      schema: {
        headers: idempotencyKeyHeaderSchema,
        body: mobichatBotReplyRequestSchema,
        response: { 200: mobichatBotReplyResponseSchema, ...botErrors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const type = request.body.message_type ?? 'text';
      if (type !== 'text' && type !== 'button' && type !== 'list') {
        throw new AppError('VALIDATION_ERROR', {
          message: `message_type "${type.slice(0, 32)}" belum didukung. Pakai "text", "button", atau "list".`,
        });
      }
      if (!request.body.message_text?.trim()) {
        throw new AppError('VALIDATION_ERROR', { message: 'message_text wajib diisi.' });
      }
      if (type !== 'text' && !request.body.list_options?.length) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'list_options wajib diisi untuk pesan tombol/daftar.',
        });
      }
      const summary = await mobichat.send(
        key,
        request.body.conversation_id,
        [
          {
            message_type: type,
            text: request.body.message_text,
            ...(request.body.list_title !== undefined
              ? { list_title: request.body.list_title }
              : {}),
            ...(request.body.list_options !== undefined
              ? { list_options: request.body.list_options }
              : {}),
          },
        ],
        request.headers['idempotency-key'],
        clientInfo(request),
      );
      return botReplyResponse(summary);
    },
  );

  app.post(
    MOBICHAT_ROUTES.botReplyMedia,
    {
      config: { access: requireMobichatApiKeyScope('messages:send') },
      schema: {
        headers: idempotencyKeyHeaderSchema,
        body: mobichatBotReplyMediaRequestSchema,
        response: { 200: mobichatBotReplyResponseSchema, ...botErrors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const { conversation_id: number, media_url, media_type, caption, file_name } = request.body;
      const summary = await mobichat.send(
        key,
        number,
        [
          {
            message_type: 'media',
            media_url,
            media_type,
            ...(caption !== undefined ? { caption } : {}),
            ...(file_name !== undefined ? { file_name } : {}),
          },
        ],
        request.headers['idempotency-key'],
        clientInfo(request),
      );
      return botReplyResponse(summary);
    },
  );
  done();
};

/** Daftarkan kedua keluarga rute (konteks plugin terpisah = penangan galat terpisah). */
export const mobichatRoutes: FastifyPluginAsyncZod<MobichatRoutesOptions> = async (
  app,
  options,
) => {
  await app.register(publicRoutes, options);
  await app.register(botRoutes, options);
};
