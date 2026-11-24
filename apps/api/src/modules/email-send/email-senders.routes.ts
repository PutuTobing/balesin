import {
  API_ROUTES,
  emailOutboundListQuerySchema,
  emailOutboundListResponseSchema,
  emailSenderIdParamsSchema,
  emailSenderSettingsListResponseSchema,
  emailSenderSettingsResponseSchema,
  errorEnvelopeSchema,
  pauseEmailSenderRequestSchema,
  resumeEmailSenderRequestSchema,
  updateEmailSenderLimitRequestSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { TwoFactorContext } from '../two-factor/two-factor.service';
import type { EmailSendersService } from './email-senders.service';

export interface EmailSendersRoutesOptions {
  senders: EmailSendersService;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

/**
 * Tahap 9.1: Pengaturan → Batas kirim → "Email per pengirim" (`sending.limits.manage`; lanjutkan =
 * `sending.resume`) dan Pengaturan → API key → "Email terkirim" (`api_keys.manage`).
 */
const LIMITS = requirePermission('sending.limits.manage');
const WRITE_RULE: RateLimitRule = { name: 'pengirim-email', limit: 30, windowSeconds: 60 };
const limitMessage = (wait: string) =>
  `Terlalu banyak perubahan dalam waktu singkat. Coba lagi dalam ${wait}.`;

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
};

export const emailSendersRoutes: FastifyPluginCallbackZod<EmailSendersRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { senders, limiter, cookieSecure } = options;
  const routes = API_ROUTES.emailSenders;

  const confirmContext = (request: FastifyRequest): TwoFactorContext => ({
    client: clientInfo(request),
    log: request.log,
    presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
  });

  app.get(
    routes.list,
    {
      config: { access: LIMITS },
      schema: { response: { 200: emailSenderSettingsListResponseSchema, ...errors } },
    },
    async (request) => ({ senders: await senders.list(requireAuth(request).organizationId) }),
  );

  app.put(
    routes.sender,
    {
      config: { access: LIMITS },
      schema: {
        params: emailSenderIdParamsSchema,
        body: updateEmailSenderLimitRequestSchema,
        response: { 200: emailSenderSettingsResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, WRITE_RULE, auth.user.id, limitMessage);
      return {
        sender: await senders.updateLimit(
          auth,
          request.params.senderId,
          request.body,
          confirmContext(request),
        ),
      };
    },
  );

  app.post(
    routes.pause,
    {
      config: { access: LIMITS },
      schema: {
        params: emailSenderIdParamsSchema,
        body: pauseEmailSenderRequestSchema,
        response: { 200: emailSenderSettingsResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, WRITE_RULE, auth.user.id, limitMessage);
      return {
        sender: await senders.pause(
          auth,
          request.params.senderId,
          request.body.reason,
          clientInfo(request),
        ),
      };
    },
  );

  app.post(
    routes.resume,
    {
      config: { access: requirePermission('sending.resume') },
      schema: {
        params: emailSenderIdParamsSchema,
        body: resumeEmailSenderRequestSchema,
        response: { 200: emailSenderSettingsResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, WRITE_RULE, auth.user.id, limitMessage);
      return {
        sender: await senders.resume(
          auth,
          request.params.senderId,
          request.body.confirmation,
          confirmContext(request),
        ),
      };
    },
  );

  app.get(
    API_ROUTES.emailOutbound.list,
    {
      config: { access: requirePermission('api_keys.manage') },
      schema: {
        querystring: emailOutboundListQuerySchema,
        response: { 200: emailOutboundListResponseSchema, ...errors },
      },
    },
    async (request) => senders.history(requireAuth(request).organizationId, request.query),
  );

  done();
};
