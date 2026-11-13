import {
  API_ROUTES,
  authenticatedSessionSchema,
  checkSetupPasswordRequestSchema,
  completeSetupRequestSchema,
  detectEmailHostResponseSchema,
  emailTestResultSchema,
  errorEnvelopeSchema,
  passwordCheckResponseSchema,
  setupDetectEmailHostRequestSchema,
  setupSendTestEmailRequestSchema,
  setupStatusResponseSchema,
  setupTestEmailConnectionRequestSchema,
  verifySetupTokenRequestSchema,
  verifySetupTokenResponseSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo, ipRateLimitKey } from '../../http/client-info';
import { deviceCookie, sessionCookie } from '../../http/cookies';
import { enforceRateLimit, type RateLimiter } from '../../http/rate-limit';
import { PUBLIC } from '../../http/route-access';
import { SESSION_ABSOLUTE_SECONDS } from '../auth/session.repo';
import { toAuthenticatedSession } from '../auth/session.service';
import { TRUSTED_DEVICE_MAX_AGE_SECONDS } from '../auth/trusted-device';
import {
  EMAIL_DETECT_RULE,
  EMAIL_TEST_RULE,
  emailDetectLimitMessage,
  emailTestLimitMessage,
} from '../email-settings/email-settings.routes';
import type { EmailSettingsService } from '../email-settings/email-settings.service';
import type { SetupService } from './setup.service';

export interface SetupRoutesOptions {
  setup: SetupService;
  emailSettings: EmailSettingsService;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

const errors = {
  400: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

/**
 * Wizard setup pertama kali. Semua rute di sini PUBLIK (belum ada akun), tetapi setiap rute
 * selain `status` mewajibkan `setupToken` di body dan berhenti berfungsi (409) begitu Owner
 * sudah dibuat.
 *
 * - `GET  /setup/status`                 perlu wizard atau tidak
 * - `POST /setup/verify-token`           periksa token setup
 * - `POST /setup/check-password`         periksa kekuatan password Owner
 * - `POST /setup/email/detect-host`      saran host SMTP dari domain email
 * - `POST /setup/email/test-connection`  tes koneksi SMTP (isi form)
 * - `POST /setup/email/send-test`        kirim email tes (isi form)
 * - `POST /setup/complete`               buat organisasi + Owner, langsung masuk
 */
export const setupRoutes: FastifyPluginCallbackZod<SetupRoutesOptions> = (app, options, done) => {
  const { setup, emailSettings, limiter, cookieSecure } = options;

  app.get(
    API_ROUTES.setup.status,
    { config: { access: PUBLIC }, schema: { response: { 200: setupStatusResponseSchema } } },
    async (_request, reply) => reply.send(await setup.status()),
  );

  app.post(
    API_ROUTES.setup.verifyToken,
    {
      config: { access: PUBLIC },
      schema: {
        body: verifySetupTokenRequestSchema,
        response: { 200: verifySetupTokenResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      await setup.assertSetupToken(request.body.setupToken, {
        client: clientInfo(request),
        log: request.log,
      });
      return reply.send({ valid: true as const });
    },
  );

  app.post(
    API_ROUTES.setup.checkPassword,
    {
      config: { access: PUBLIC },
      schema: {
        body: checkSetupPasswordRequestSchema,
        response: { 200: passwordCheckResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      await setup.assertSetupToken(request.body.setupToken, {
        client: clientInfo(request),
        log: request.log,
      });
      return reply.send(setup.checkPassword(request.body));
    },
  );

  app.post(
    API_ROUTES.setup.detectEmailHost,
    {
      config: { access: PUBLIC },
      schema: {
        body: setupDetectEmailHostRequestSchema,
        response: { 200: detectEmailHostResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const client = clientInfo(request);
      await setup.assertSetupToken(request.body.setupToken, { client, log: request.log });
      await enforceRateLimit(
        limiter,
        EMAIL_DETECT_RULE,
        `setup:${ipRateLimitKey(client)}`,
        emailDetectLimitMessage,
      );
      return reply.send(await emailSettings.detectHost(request.body.emailAddress));
    },
  );

  app.post(
    API_ROUTES.setup.testEmailConnection,
    {
      config: { access: PUBLIC },
      schema: {
        body: setupTestEmailConnectionRequestSchema,
        response: { 200: emailTestResultSchema, ...errors },
      },
    },
    async (request, reply) => {
      const client = clientInfo(request);
      await setup.assertSetupToken(request.body.setupToken, { client, log: request.log });
      await enforceRateLimit(
        limiter,
        EMAIL_TEST_RULE,
        `setup:${ipRateLimitKey(client)}`,
        emailTestLimitMessage,
      );
      const context = { client, log: request.log };
      const result = await emailSettings.testConnection(null, request.body.settings, context);
      await setup.rememberEmailTest(request.body.settings, result, context);
      return reply.send(result);
    },
  );

  app.post(
    API_ROUTES.setup.sendTestEmail,
    {
      config: { access: PUBLIC },
      schema: {
        body: setupSendTestEmailRequestSchema,
        response: { 200: emailTestResultSchema, ...errors },
      },
    },
    async (request, reply) => {
      const client = clientInfo(request);
      await setup.assertSetupToken(request.body.setupToken, { client, log: request.log });
      await enforceRateLimit(
        limiter,
        EMAIL_TEST_RULE,
        `setup:${ipRateLimitKey(client)}`,
        emailTestLimitMessage,
      );
      const context = { client, log: request.log };
      const result = await emailSettings.sendTest(
        null,
        request.body.to,
        request.body.settings,
        context,
      );
      await setup.rememberEmailTest(request.body.settings, result, context);
      return reply.send(result);
    },
  );

  app.post(
    API_ROUTES.setup.complete,
    {
      config: { access: PUBLIC },
      schema: {
        body: completeSetupRequestSchema,
        response: { 201: authenticatedSessionSchema, ...errors },
      },
    },
    async (request, reply) => {
      const issued = await setup.complete(request.body, {
        client: clientInfo(request),
        log: request.log,
      });
      void reply.header('set-cookie', [
        sessionCookie(issued.token, cookieSecure, SESSION_ABSOLUTE_SECONDS),
        deviceCookie(issued.deviceToken, cookieSecure, TRUSTED_DEVICE_MAX_AGE_SECONDS),
      ]);
      return reply.status(201).send(toAuthenticatedSession(issued.auth));
    },
  );

  done();
};
