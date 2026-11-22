import {
  API_ROUTES,
  channelAccessResponseSchema,
  channelIdParamsSchema,
  errorEnvelopeSchema,
  updateChannelAccessRequestSchema,
  updateChannelAccessResponseSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { ChannelAccessService } from './channel-access.service';

export interface ChannelAccessRoutesOptions {
  channelAccess: ChannelAccessService;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

/** Simpan akses channel: per pengguna. */
export const CHANNEL_ACCESS_WRITE_RULE: RateLimitRule = {
  name: 'channel-akses',
  limit: 30,
  windowSeconds: 60,
};

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
};

/**
 * Akses per channel (tahap 9.0, docs/KONTRAK-API-CHANNEL.md "Akses per channel"), semua jenis
 * channel. Izin = `channels.manage` (sama dengan Pengaturan → Channel). PUT lewat CSRF (aturan
 * bawaan rute pengubah data).
 *
 * - `GET /settings/channels/:channelId/access`  mode + daftar departemen & pengguna
 * - `PUT /settings/channels/:channelId/access`  ganti seluruh aturan
 */
export const channelAccessRoutes: FastifyPluginCallbackZod<ChannelAccessRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { channelAccess, limiter, cookieSecure } = options;
  const MANAGE = requirePermission('channels.manage');
  const route = API_ROUTES.channels.access;

  app.get(
    route,
    {
      config: { access: MANAGE },
      schema: {
        params: channelIdParamsSchema,
        response: { 200: channelAccessResponseSchema, ...errors },
      },
    },
    async (request) => ({
      access: await channelAccess.get(
        requireAuth(request).organizationId,
        request.params.channelId,
      ),
    }),
  );

  app.put(
    route,
    {
      config: { access: MANAGE },
      bodyLimit: 64 * 1024,
      schema: {
        params: channelIdParamsSchema,
        body: updateChannelAccessRequestSchema,
        response: { 200: updateChannelAccessResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(
        limiter,
        CHANNEL_ACCESS_WRITE_RULE,
        auth.user.id,
        (wait) => `Terlalu banyak perubahan akses channel. Coba lagi dalam ${wait}.`,
      );
      return channelAccess.update(auth, request.params.channelId, request.body, {
        client: clientInfo(request),
        log: request.log,
        presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
      });
    },
  );

  done();
};
