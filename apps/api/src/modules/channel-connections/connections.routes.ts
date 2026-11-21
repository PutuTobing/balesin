import {
  API_ROUTES,
  channelIdParamsSchema,
  channelWebhookResponseSchema,
  connectionChannelListResponseSchema,
  connectionChannelResponseSchema,
  connectionTestResultSchema,
  createConnectionChannelRequestSchema,
  createConnectionChannelResponseSchema,
  deleteChannelRequestSchema,
  deleteChannelResponseSchema,
  errorEnvelopeSchema,
  updateConnectionChannelRequestSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { enforceRateLimit, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import { CHANNEL_TEST_RULE } from '../channels/channels.routes';
import type { ChannelContext } from '../channels/channels.service';
import type { ConnectionsService } from './connections.service';

export interface ConnectionsRoutesOptions {
  connections: ConnectionsService;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

/** Owner/Admin — termasuk MEMBACA pengaturan (host email, ID Halaman, petunjuk rahasia). */
const MANAGE = requirePermission('channels.manage');
/** Body terbesar: token Meta (≤ 4 KB) + dua password + konfirmasi identitas. */
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

const testLimitMessage = () =>
  `Batas tes koneksi (${CHANNEL_TEST_RULE.limit} kali per 5 menit) sudah tercapai.`;

/**
 * Channel selain WhatsApp (docs/KONTRAK-API-CHANNEL-LAIN.md) — semua `channels.manage`.
 *
 * - `GET    /settings/channel-connections`                       daftar + info jenis channel
 * - `POST   /settings/channel-connections`                       buat (+ konfirmasi identitas)
 * - `GET    /settings/channel-connections/:channelId`            satu channel
 * - `PATCH  /settings/channel-connections/:channelId`            ubah (kredensial: + konfirmasi)
 * - `DELETE /settings/channel-connections/:channelId`            hapus (+ konfirmasi identitas)
 * - `POST   /settings/channel-connections/:channelId/disable|enable`
 * - `POST   /settings/channel-connections/:channelId/test`       tes koneksi (jatah bersama WhatsApp)
 * - `GET    /settings/channel-connections/:channelId/webhook`    Messenger/IG: URL + verify token
 * - `POST   /settings/channel-connections/:channelId/webhook`    Telegram: pasang ulang; Meta: token baru
 */
export const connectionsRoutes: FastifyPluginCallbackZod<ConnectionsRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { connections, limiter, cookieSecure } = options;
  const routes = API_ROUTES.channelConnections;
  const contextOf = (request: FastifyRequest): ChannelContext => ({
    client: clientInfo(request),
    log: request.log,
    presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
  });

  app.get(
    routes.list,
    {
      config: { access: MANAGE },
      schema: { response: { 200: connectionChannelListResponseSchema, ...errors } },
    },
    async (request) => connections.list(requireAuth(request)),
  );

  app.post(
    routes.list,
    {
      config: { access: MANAGE },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: createConnectionChannelRequestSchema,
        response: { 201: createConnectionChannelResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      // Telegram memanggil getMe saat dibuat: memakai jatah tes koneksi yang sama.
      await enforceRateLimit(limiter, CHANNEL_TEST_RULE, auth.user.id, testLimitMessage);
      const created = await connections.create(auth, request.body, contextOf(request));
      return reply.status(201).send(created);
    },
  );

  app.get(
    routes.channel,
    {
      config: { access: MANAGE },
      schema: {
        params: channelIdParamsSchema,
        response: { 200: connectionChannelResponseSchema, ...errors },
      },
    },
    async (request) => ({
      channel: await connections.get(requireAuth(request), request.params.channelId),
    }),
  );

  app.patch(
    routes.channel,
    {
      config: { access: MANAGE },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: channelIdParamsSchema,
        body: updateConnectionChannelRequestSchema,
        response: { 200: connectionChannelResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, CHANNEL_TEST_RULE, auth.user.id, testLimitMessage);
      return {
        channel: await connections.update(
          auth,
          request.params.channelId,
          request.body,
          contextOf(request),
        ),
      };
    },
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
      await connections.remove(
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
          response: { 200: connectionChannelResponseSchema, ...errors },
        },
      },
      async (request) => ({
        channel: await connections.setEnabled(
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
        response: { 200: connectionTestResultSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, CHANNEL_TEST_RULE, auth.user.id, testLimitMessage);
      return connections.test(auth, request.params.channelId, contextOf(request));
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
    async (request) => connections.webhook(requireAuth(request), request.params.channelId),
  );

  app.post(
    routes.webhook,
    {
      config: { access: MANAGE },
      schema: {
        params: channelIdParamsSchema,
        response: { 200: createConnectionChannelResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, CHANNEL_TEST_RULE, auth.user.id, testLimitMessage);
      return connections.rotateWebhook(auth, request.params.channelId, contextOf(request));
    },
  );

  done();
};
