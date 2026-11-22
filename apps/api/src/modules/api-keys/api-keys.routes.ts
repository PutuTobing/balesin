import { AppError } from '@balesin/core';
import {
  API_ROUTES,
  apiKeyIdParamsSchema,
  apiKeyListResponseSchema,
  apiKeyResponseSchema,
  apiSettingsResponseSchema,
  apiSettingsSchema,
  createApiKeyRequestSchema,
  createApiKeyResponseSchema,
  errorEnvelopeSchema,
  updateApiKeyRequestSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { ApiKeysService } from './api-keys.service';

export interface ApiKeysRoutesOptions {
  apiKeys: ApiKeysService;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

/** Pengaturan → API key (`api_keys.manage` = Owner/Admin). Semua tulis lewat CSRF hook. */
const MANAGE = requirePermission('api_keys.manage');
const WRITE_RULE: RateLimitRule = { name: 'api-key-kelola', limit: 30, windowSeconds: 60 };
const UUID = z.uuid();
const limitMessage = (wait: string) =>
  `Terlalu banyak perubahan dalam waktu singkat. Coba lagi dalam ${wait}.`;

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

export const apiKeysRoutes: FastifyPluginCallbackZod<ApiKeysRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { apiKeys, limiter, cookieSecure } = options;
  const routes = API_ROUTES.apiKeys;

  app.get(
    routes.list,
    {
      config: { access: MANAGE },
      schema: { response: { 200: apiKeyListResponseSchema, ...errors } },
    },
    async (request) => ({ apiKeys: await apiKeys.list(requireAuth(request).organizationId) }),
  );

  app.post(
    routes.list,
    {
      config: { access: MANAGE },
      schema: {
        body: createApiKeyRequestSchema,
        response: { 201: createApiKeyResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, WRITE_RULE, auth.user.id, limitMessage);
      const created = await apiKeys.create(auth, request.body, {
        client: clientInfo(request),
        log: request.log,
        presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
      });
      // Rahasia hanya ada di jawaban ini: jangan disimpan cache perantara mana pun.
      void reply.code(201).header('Cache-Control', 'no-store');
      return created;
    },
  );

  app.post(
    routes.revoke,
    {
      config: { access: MANAGE },
      schema: { params: apiKeyIdParamsSchema, response: { 200: apiKeyResponseSchema, ...errors } },
    },
    async (request) => {
      const auth = requireAuth(request);
      if (!UUID.safeParse(request.params.apiKeyId).success) {
        throw new AppError('NOT_FOUND', { message: 'API key tidak ditemukan.' });
      }
      await enforceRateLimit(limiter, WRITE_RULE, auth.user.id, limitMessage);
      return {
        apiKey: await apiKeys.revoke(auth, clientInfo(request), request.params.apiKeyId),
      };
    },
  );

  // Tahap 9.1: pengirim email + host lampiran (SELALU konfirmasi identitas; scope tetap).
  app.patch(
    routes.key,
    {
      config: { access: MANAGE },
      schema: {
        params: apiKeyIdParamsSchema,
        body: updateApiKeyRequestSchema,
        response: { 200: apiKeyResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      if (!UUID.safeParse(request.params.apiKeyId).success) {
        throw new AppError('NOT_FOUND', { message: 'API key tidak ditemukan.' });
      }
      await enforceRateLimit(limiter, WRITE_RULE, auth.user.id, limitMessage);
      return {
        apiKey: await apiKeys.update(auth, request.params.apiKeyId, request.body, {
          client: clientInfo(request),
          log: request.log,
          presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
        }),
      };
    },
  );

  app.get(
    routes.settings,
    {
      config: { access: MANAGE },
      schema: { response: { 200: apiSettingsResponseSchema, ...errors } },
    },
    async (request) => ({ settings: await apiKeys.settings(requireAuth(request).organizationId) }),
  );

  app.put(
    routes.settings,
    {
      config: { access: MANAGE },
      schema: { body: apiSettingsSchema, response: { 200: apiSettingsResponseSchema, ...errors } },
    },
    async (request) => ({
      settings: await apiKeys.updateSettings(
        requireAuth(request),
        clientInfo(request),
        request.body,
      ),
    }),
  );

  done();
};
