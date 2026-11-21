import { AppError } from '@balesin/core';
import {
  API_ROUTES,
  channelBotSettingsResponseSchema,
  errorEnvelopeSchema,
  updateChannelBotSettingsRequestSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { BotService } from './bot.service';

export interface BotRoutesOptions {
  bot: BotService;
  limiter: RateLimiter;
}

/**
 * Pengaturan → Channel → Bot (Fase 3): `GET`/`PUT /settings/channels/:id/bot`, `integrations.manage`.
 * PUT lewat hook CSRF; tanpa konfirmasi identitas (bukan kredensial; hanya mengatur ke mana
 * percakapan baru diarahkan, dan bisa dibalik kapan saja) — diaudit.
 */
const WRITE_RULE: RateLimitRule = { name: 'bot-pengaturan', limit: 30, windowSeconds: 60 };
const MANAGE = requirePermission('integrations.manage');
const UUID = z.uuid();
const channelParams = z.object({ channelId: z.string() });

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
};

function channelIdOf(value: string): string {
  if (!UUID.safeParse(value).success) {
    throw new AppError('NOT_FOUND', { message: 'Channel tidak ditemukan.' });
  }
  return value;
}

export const botRoutes: FastifyPluginCallbackZod<BotRoutesOptions> = (app, options, done) => {
  const { bot, limiter } = options;

  app.get(
    API_ROUTES.channels.bot,
    {
      config: { access: MANAGE },
      schema: {
        params: channelParams,
        response: { 200: channelBotSettingsResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      return {
        settings: await bot.channelSettings(
          auth.organizationId,
          channelIdOf(request.params.channelId),
        ),
      };
    },
  );

  app.put(
    API_ROUTES.channels.bot,
    {
      config: { access: MANAGE },
      schema: {
        params: channelParams,
        body: updateChannelBotSettingsRequestSchema,
        response: { 200: channelBotSettingsResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(
        limiter,
        WRITE_RULE,
        auth.user.id,
        (wait) => `Terlalu banyak perubahan. Coba lagi dalam ${wait}.`,
      );
      return {
        settings: await bot.updateChannelSettings(
          auth,
          channelIdOf(request.params.channelId),
          request.body,
          clientInfo(request),
        ),
      };
    },
  );

  done();
};
