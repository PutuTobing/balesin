import {
  API_ROUTES,
  createPushSubscriptionRequestSchema,
  deletePushSubscriptionRequestSchema,
  errorEnvelopeSchema,
  notificationPreferencesResponseSchema,
  notificationPreferencesSchema,
  notificationSettingsResponseSchema,
  notificationSettingsSchema,
  notificationTestResponseSchema,
  pushSubscriptionDeletedResponseSchema,
  pushSubscriptionResponseSchema,
  vapidPublicKeyResponseSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { NotificationsService } from './notifications.service';

export interface NotificationsRoutesOptions {
  notifications: NotificationsService;
  limiter: RateLimiter;
}

/**
 * Notifikasi Web Push (Fase 2 butir 10, docs/KONTRAK-API-NOTIFIKASI.md). Langganan, preferensi, dan
 * tes = data/perangkat PEMANGGIL sendiri, untuk semua pemegang `inbox.view` (notifikasi = inbox).
 * Pengaturan cuplikan organisasi = `organization.manage` (Owner). Semua tulis lewat CSRF hook.
 */
export const NOTIFICATION_WRITE_RULE: RateLimitRule = {
  name: 'notifikasi-ubah',
  limit: 30,
  windowSeconds: 60,
};
export const NOTIFICATION_TEST_RULE: RateLimitRule = {
  name: 'notifikasi-tes',
  limit: 5,
  windowSeconds: 60,
};

const VIEW = requirePermission('inbox.view');
const limitMessage = (wait: string) =>
  `Terlalu banyak permintaan dalam waktu singkat. Coba lagi dalam ${wait}.`;

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

export const notificationsRoutes: FastifyPluginCallbackZod<NotificationsRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { notifications, limiter } = options;
  const routes = API_ROUTES.notifications;

  app.get(
    routes.vapidPublicKey,
    {
      config: { access: VIEW },
      schema: { response: { 200: vapidPublicKeyResponseSchema, ...errors } },
    },
    async (request) => ({
      publicKey: await notifications.vapidPublicKey(requireAuth(request).organizationId),
    }),
  );

  app.post(
    routes.subscriptions,
    {
      config: { access: VIEW },
      schema: {
        body: createPushSubscriptionRequestSchema,
        response: { 201: pushSubscriptionResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, NOTIFICATION_WRITE_RULE, auth.user.id, limitMessage);
      const row = await notifications.subscribe(auth, request.body);
      void reply.code(201);
      return { subscription: { id: row.id, createdAt: row.createdAt.toISOString() } };
    },
  );

  app.delete(
    routes.subscriptions,
    {
      config: { access: VIEW },
      schema: {
        body: deletePushSubscriptionRequestSchema,
        response: { 200: pushSubscriptionDeletedResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, NOTIFICATION_WRITE_RULE, auth.user.id, limitMessage);
      return { deleted: await notifications.unsubscribe(auth, request.body.endpoint) };
    },
  );

  app.get(
    routes.preferences,
    {
      config: { access: VIEW },
      schema: { response: { 200: notificationPreferencesResponseSchema, ...errors } },
    },
    async (request) => notifications.preferences(requireAuth(request)),
  );

  app.put(
    routes.preferences,
    {
      config: { access: VIEW },
      schema: {
        body: notificationPreferencesSchema,
        response: { 200: notificationPreferencesResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, NOTIFICATION_WRITE_RULE, auth.user.id, limitMessage);
      return notifications.updatePreferences(auth, request.body);
    },
  );

  app.post(
    routes.test,
    {
      config: { access: VIEW },
      schema: { response: { 200: notificationTestResponseSchema, ...errors } },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, NOTIFICATION_TEST_RULE, auth.user.id, limitMessage);
      return { devices: await notifications.test(auth) };
    },
  );

  app.get(
    routes.settings,
    {
      config: { access: requirePermission('organization.manage') },
      schema: { response: { 200: notificationSettingsResponseSchema, ...errors } },
    },
    async (request) => ({
      settings: await notifications.settings(requireAuth(request).organizationId),
    }),
  );

  app.put(
    routes.settings,
    {
      config: { access: requirePermission('organization.manage') },
      schema: {
        body: notificationSettingsSchema,
        response: { 200: notificationSettingsResponseSchema, ...errors },
      },
    },
    async (request) => ({
      settings: await notifications.updateSettings(
        requireAuth(request),
        clientInfo(request),
        request.body,
      ),
    }),
  );

  done();
};
