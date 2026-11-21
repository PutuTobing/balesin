import type { Channel } from '@balesin/db';
import { WEBHOOK_ROUTES, errorEnvelopeSchema, type ChannelType } from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { PUBLIC } from '../../http/route-access';
import {
  TELEGRAM_WEBHOOK_BODY_LIMIT_BYTES,
  type ChannelWebhooksService,
} from './channel-webhooks.service';
import type { WebhookGuard, WebhookMethod } from './webhook-guard';
import { WEBHOOK_BODY_LIMIT_BYTES } from './whatsapp-webhook.service';

export interface ChannelWebhookRoutesOptions {
  guard: WebhookGuard;
  webhooks: ChannelWebhooksService;
}

const errors = {
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  413: errorEnvelopeSchema,
  415: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

/**
 * Jawaban webhook Telegram: `{status}` biasa, atau — untuk tombol inline — panggilan Bot API di badan
 * respons (`answerCallbackQuery`, fitur webhook Bot API) supaya tombol berhenti "memuat" tanpa
 * Balesin memanggil Telegram dengan token.
 */
const telegramResponseSchema = z.union([
  z.object({ status: z.literal('received') }),
  z.object({ method: z.literal('answerCallbackQuery'), callback_query_id: z.string() }),
]);
const receivedSchema = z.object({ status: z.literal('received') });

function channelIdOf(request: FastifyRequest): string {
  const params = request.params as { channelId?: unknown } | undefined;
  return typeof params?.channelId === 'string' ? params.channelId : '';
}

/**
 * Penerima webhook Telegram, Messenger, Instagram (Fase 6). PUBLIK (tanpa sesi/CSRF) — keaslian dari
 * secret token Telegram / tanda tangan App Secret Meta. Tidak dibungkus `fastify-plugin`: parser JSON
 * diganti parser body MENTAH hanya di cakupan ini (tanda tangan dihitung atas byte asli).
 */
export const channelWebhookRoutes: FastifyPluginCallbackZod<ChannelWebhookRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { guard, webhooks } = options;

  app.decorateRequest('webhookChannel', null);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
    (_request, body, parsed) => {
      parsed(null, body);
    },
  );

  const admitFor =
    (method: WebhookMethod, type: ChannelType) => async (request: FastifyRequest) => {
      request.webhookChannel = await guard.admit(
        channelIdOf(request),
        clientInfo(request),
        method,
        type,
      );
    };
  const channelOf = (request: FastifyRequest): Channel => {
    if (!request.webhookChannel) throw new Error('Rute webhook tanpa channel yang lolos penjaga');
    return request.webhookChannel;
  };
  const rawOf = (request: FastifyRequest) =>
    Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);

  app.post(
    WEBHOOK_ROUTES.telegram,
    {
      config: { access: PUBLIC },
      bodyLimit: TELEGRAM_WEBHOOK_BODY_LIMIT_BYTES,
      onRequest: admitFor('POST', 'telegram'),
      schema: { response: { 200: telegramResponseSchema, ...errors } },
    },
    async (request) => {
      const result = await webhooks.receiveTelegram({
        channel: channelOf(request),
        rawBody: rawOf(request),
        headers: request.headers,
        client: clientInfo(request),
        log: request.log,
      });
      return result.callbackQueryId
        ? { method: 'answerCallbackQuery' as const, callback_query_id: result.callbackQueryId }
        : { status: 'received' as const };
    },
  );

  for (const type of ['messenger', 'instagram'] as const) {
    const path = WEBHOOK_ROUTES[type];
    app.get(
      path,
      {
        config: { access: PUBLIC, rawResponse: true },
        exposeHeadRoute: false,
        onRequest: admitFor('GET', type),
      },
      async (request, reply) => {
        const challenge = await webhooks.handshakeMetaSocial(
          channelOf(request),
          request.query,
          clientInfo(request),
          request.log,
        );
        return reply.type('text/plain; charset=utf-8').send(challenge);
      },
    );
    app.post(
      path,
      {
        config: { access: PUBLIC },
        bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
        onRequest: admitFor('POST', type),
        schema: { response: { 200: receivedSchema, ...errors } },
      },
      async (request) => {
        await webhooks.receiveMetaSocial({
          channel: channelOf(request),
          rawBody: rawOf(request),
          headers: request.headers,
          client: clientInfo(request),
          log: request.log,
        });
        return { status: 'received' as const };
      },
    );
  }

  done();
};
