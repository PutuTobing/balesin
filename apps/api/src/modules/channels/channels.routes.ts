import { AppError } from '@balesin/core';
import type { Database } from '@balesin/db';
import {
  API_ROUTES,
  businessProfileResponseSchema,
  channelIdParamsSchema,
  channelResponseSchema,
  channelSettingsListResponseSchema,
  channelSummaryListResponseSchema,
  channelTestResultSchema,
  channelWebhookResponseSchema,
  createChannelRequestSchema,
  createChannelResponseSchema,
  deleteChannelRequestSchema,
  deleteChannelResponseSchema,
  errorEnvelopeSchema,
  updateBusinessProfileRequestSchema,
  updateBusinessProfileResponseSchema,
  updateChannelRequestSchema,
  webhookHealthResponseSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import { webhookHealth } from '../webhooks/webhook-health';
import type { ChannelContext, ChannelsService } from './channels.service';

export interface ChannelsRoutesOptions {
  db: Database;
  channels: ChannelsService;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

/**
 * PENGATURAN-UI.md: "Hanya Owner/Admin yang bisa mengubah" = `channels.manage`. Termasuk MEMBACA
 * pengaturan channel (ID Meta, petunjuk rahasia, verify token).
 */
const MANAGE = requirePermission('channels.manage');
/**
 * Daftar nama channel untuk inbox/filter: semua peran yang boleh melihat inbox (Teknisi pun perlu
 * tahu nama channel percakapan yang di-assign kepadanya). Tanpa ID Meta maupun petunjuk rahasia.
 */
const VIEW = requirePermission('inbox.view');

/** Tes koneksi: dua sampai tujuh panggilan Graph API per tes. Per pengguna. */
export const CHANNEL_TEST_RULE: RateLimitRule = {
  name: 'channel-tes',
  limit: 10,
  windowSeconds: 300,
};
/** Baca/ubah profil bisnis (diteruskan ke Graph API). Per pengguna. */
export const CHANNEL_META_RULE: RateLimitRule = {
  name: 'channel-meta',
  limit: 30,
  windowSeconds: 300,
};

// Tanpa durasi tunggu: web menampilkan hitung mundur dari `Retry-After`.
const testLimitMessage = () =>
  `Batas tes koneksi (${CHANNEL_TEST_RULE.limit} kali per 5 menit) sudah tercapai.`;
const metaLimitMessage = () =>
  `Batas permintaan profil bisnis (${CHANNEL_META_RULE.limit} kali per 5 menit) sudah tercapai.`;

/** Body terbesar: token System User (≤ 4 KB) + konfirmasi identitas. */
const BODY_LIMIT_BYTES = 16 * 1024;

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  502: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

/**
 * Channel (docs/KONTRAK-API-CHANNEL.md).
 *
 * - `GET    /channels`                                         ringkasan (inbox.view)
 * - `GET    /settings/channels`                                semua channel + status
 * - `POST   /settings/channels`                                buat channel WhatsApp (wizard)
 * - `GET    /settings/channels/:channelId`                     satu channel
 * - `PATCH  /settings/channels/:channelId`                     ubah (kredensial: + konfirmasi identitas)
 * - `DELETE /settings/channels/:channelId`                     hapus (+ konfirmasi identitas)
 * - `POST   /settings/channels/:channelId/disable` · `/enable` nonaktifkan / aktifkan
 * - `POST   /settings/channels/:channelId/test`                tes koneksi Graph API
 * - `GET    /settings/channels/:channelId/webhook`             URL webhook + verify token
 * - `POST   /settings/channels/:channelId/webhook/verify-token` buat ulang verify token
 * - `GET    /settings/channels/:channelId/business-profile`    profil bisnis dari Meta
 * - `PUT    /settings/channels/:channelId/business-profile`    ubah profil bisnis
 */
export const channelsRoutes: FastifyPluginCallbackZod<ChannelsRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { channels, limiter, cookieSecure } = options;
  const routes = API_ROUTES.channels;

  const contextOf = (request: FastifyRequest): ChannelContext => ({
    client: clientInfo(request),
    log: request.log,
    presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
  });

  app.get(
    routes.list,
    {
      config: { access: VIEW },
      schema: { response: { 200: channelSummaryListResponseSchema, ...errors } },
    },
    async (request) => channels.listSummaries(requireAuth(request)),
  );

  app.get(
    routes.settings,
    {
      config: { access: MANAGE },
      schema: { response: { 200: channelSettingsListResponseSchema, ...errors } },
    },
    async (request) => channels.listSettings(requireAuth(request)),
  );

  app.post(
    routes.settings,
    {
      config: { access: MANAGE },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: createChannelRequestSchema,
        response: { 201: createChannelResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const created = await channels.create(requireAuth(request), request.body, contextOf(request));
      return reply.status(201).send(created);
    },
  );

  app.get(
    routes.channel,
    {
      config: { access: MANAGE },
      schema: {
        params: channelIdParamsSchema,
        response: { 200: channelResponseSchema, ...errors },
      },
    },
    async (request) => ({
      channel: await channels.get(requireAuth(request), request.params.channelId),
    }),
  );

  app.patch(
    routes.channel,
    {
      config: { access: MANAGE },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: channelIdParamsSchema,
        body: updateChannelRequestSchema,
        response: { 200: channelResponseSchema, ...errors },
      },
    },
    async (request) => ({
      channel: await channels.update(
        requireAuth(request),
        request.params.channelId,
        request.body,
        contextOf(request),
      ),
    }),
  );

  app.delete(
    routes.channel,
    {
      config: { access: MANAGE },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: channelIdParamsSchema,
        body: deleteChannelRequestSchema,
        response: { 200: deleteChannelResponseSchema, ...errors },
      },
    },
    async (request) => {
      await channels.remove(
        requireAuth(request),
        request.params.channelId,
        request.body,
        contextOf(request),
      );
      return { status: 'deleted' as const };
    },
  );

  for (const [path, enabled] of [
    [routes.disable, false],
    [routes.enable, true],
  ] as const) {
    app.post(
      path,
      {
        config: { access: MANAGE },
        schema: {
          params: channelIdParamsSchema,
          response: { 200: channelResponseSchema, ...errors },
        },
      },
      async (request) => ({
        channel: await channels.setEnabled(
          requireAuth(request),
          request.params.channelId,
          enabled,
          contextOf(request),
        ),
      }),
    );
  }

  app.post(
    routes.test,
    {
      config: { access: MANAGE },
      schema: {
        params: channelIdParamsSchema,
        response: { 200: channelTestResultSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, CHANNEL_TEST_RULE, auth.user.id, testLimitMessage);
      return channels.test(auth, request.params.channelId, contextOf(request));
    },
  );

  app.get(
    routes.webhook,
    {
      config: { access: MANAGE },
      schema: {
        params: channelIdParamsSchema,
        response: { 200: channelWebhookResponseSchema, ...errors },
      },
    },
    async (request) => channels.webhook(requireAuth(request), request.params.channelId),
  );

  // Diagnosis webhook 24 jam (butir 10 sisa): hitungan & waktu saja, tanpa payload.
  app.get(
    routes.webhookHealth,
    {
      config: { access: MANAGE },
      schema: {
        params: channelIdParamsSchema,
        response: { 200: webhookHealthResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      const id = request.params.channelId;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new AppError('NOT_FOUND', { message: 'Channel tidak ditemukan.' });
      }
      return { health: await webhookHealth(options.db, limiter, auth.organizationId, id) };
    },
  );

  app.post(
    routes.rotateVerifyToken,
    {
      config: { access: MANAGE },
      schema: {
        params: channelIdParamsSchema,
        response: { 200: channelWebhookResponseSchema, ...errors },
      },
    },
    async (request) =>
      channels.rotateVerifyToken(
        requireAuth(request),
        request.params.channelId,
        contextOf(request),
      ),
  );

  app.get(
    routes.businessProfile,
    {
      // Memakai jatah batas laju + memanggil Meta: tidak boleh dipicu tautan dari situs lain.
      config: { access: MANAGE, requireCsrf: true },
      schema: {
        params: channelIdParamsSchema,
        response: { 200: businessProfileResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, CHANNEL_META_RULE, auth.user.id, metaLimitMessage);
      return channels.readBusinessProfile(auth, request.params.channelId);
    },
  );

  app.put(
    routes.businessProfile,
    {
      config: { access: MANAGE },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: channelIdParamsSchema,
        body: updateBusinessProfileRequestSchema,
        response: { 200: updateBusinessProfileResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, CHANNEL_META_RULE, auth.user.id, metaLimitMessage);
      return channels.updateBusinessProfile(
        auth,
        request.params.channelId,
        request.body,
        contextOf(request),
      );
    },
  );

  done();
};
