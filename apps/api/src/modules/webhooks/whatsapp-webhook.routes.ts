import type { Channel } from '@balesin/db';
import { WEBHOOK_ROUTES, errorEnvelopeSchema } from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { PUBLIC } from '../../http/route-access';
import type { WebhookGuard } from './webhook-guard';
import { WEBHOOK_BODY_LIMIT_BYTES, type WhatsAppWebhookService } from './whatsapp-webhook.service';

export interface WhatsAppWebhookRoutesOptions {
  guard: WebhookGuard;
  webhooks: WhatsAppWebhookService;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Channel yang lolos `WebhookGuard.admit` (hanya di rute webhook). */
    webhookChannel: Channel | null;
  }
}

export const webhookReceivedResponseSchema = z.object({ status: z.literal('received') });

const errors = {
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  413: errorEnvelopeSchema,
  415: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

function channelIdOf(request: FastifyRequest): string {
  const params = request.params as { channelId?: unknown } | undefined;
  return typeof params?.channelId === 'string' ? params.channelId : '';
}

/**
 * Penerima webhook WhatsApp Cloud API (docs/KONTRAK-API-CHANNEL.md bagian "Penerima webhook").
 *
 * - `GET  /webhooks/whatsapp/:channelId` — jabat tangan verifikasi Meta → `hub.challenge` (`text/plain`).
 * - `POST /webhooks/whatsapp/:channelId` — notifikasi Meta, tanda tangan `X-Hub-Signature-256`.
 *
 * PUBLIK (tanpa sesi/CSRF; Meta tidak mengirim `Origin`). Keaslian dari verify token (GET) dan tanda
 * tangan App Secret (POST), bukan dari `:channelId`. Plugin ini SENGAJA tidak dibungkus
 * `fastify-plugin`: parser `application/json` diganti parser body mentah (`Buffer`) hanya di dalam
 * cakupan rute ini — rute lain tetap memakai parser JSON biasa.
 */
export const whatsAppWebhookRoutes: FastifyPluginCallbackZod<WhatsAppWebhookRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { guard, webhooks } = options;

  app.decorateRequest('webhookChannel', null);

  // Body mentah: tanda tangan dihitung atas byte persis yang dikirim Meta, SEBELUM `JSON.parse`.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
    (_request, body, parsed) => {
      parsed(null, body);
    },
  );

  // Sebelum body dibaca: batas laju + channel ada (banjir tidak memaksa server membaca 3 MB).
  const admit = async (request: FastifyRequest) => {
    request.webhookChannel = await guard.admit(channelIdOf(request), clientInfo(request));
  };
  const channelOf = (request: FastifyRequest): Channel => {
    if (!request.webhookChannel) throw new Error('Rute webhook tanpa channel yang lolos penjaga');
    return request.webhookChannel;
  };

  app.get(
    WEBHOOK_ROUTES.whatsapp,
    {
      config: { access: PUBLIC, rawResponse: true },
      // HEAD tidak berguna untuk jabat tangan dan hanya akan memantulkan status tanpa isi.
      exposeHeadRoute: false,
      onRequest: admit,
    },
    async (request, reply) => {
      const challenge = await webhooks.handshake(
        channelOf(request),
        request.query,
        clientInfo(request),
        request.log,
      );
      // `text/plain` + `nosniff` (helmet): nilai yang dipantulkan tidak pernah ditafsirkan sebagai
      // HTML, dan polanya hanya `[A-Za-z0-9_-]`.
      return reply.type('text/plain; charset=utf-8').send(challenge);
    },
  );

  app.post(
    WEBHOOK_ROUTES.whatsapp,
    {
      config: { access: PUBLIC },
      bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
      onRequest: admit,
      schema: { response: { 200: webhookReceivedResponseSchema, ...errors } },
    },
    async (request) => {
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      await webhooks.receive({
        channel: channelOf(request),
        rawBody,
        headers: request.headers,
        client: clientInfo(request),
        log: request.log,
      });
      return { status: 'received' as const };
    },
  );

  done();
};
