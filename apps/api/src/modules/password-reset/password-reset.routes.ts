import {
  API_ROUTES,
  completePasswordResetRequestSchema,
  completePasswordResetResponseSchema,
  errorEnvelopeSchema,
  inspectPasswordResetRequestSchema,
  inspectPasswordResetResponseSchema,
  passwordResetStatusResponseSchema,
  requestPasswordResetRequestSchema,
  requestPasswordResetResponseSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { PUBLIC } from '../../http/route-access';
import type { PasswordResetService } from './password-reset.service';

export interface PasswordResetRoutesOptions {
  passwordReset: PasswordResetService;
  cookieSecure: boolean;
}

const BODY_LIMIT_BYTES = 16 * 1024;

const errors = {
  400: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  410: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

/**
 * Atur ulang password (docs/KONTRAK-API-AUTH.md bagian "Atur ulang password"). Semua publik;
 * token selalu di BODY.
 *
 * - `GET  /auth/password-reset`           `{ available }` — email pengirim instalasi sudah diatur
 * - `POST /auth/password-reset/request`   minta tautan (202, sama untuk email apa pun)
 * - `POST /auth/password-reset/inspect`   isi tautan yang sah (perlu kode 2FA atau tidak)
 * - `POST /auth/password-reset/complete`  password baru (+ kode 2FA) → semua sesi dicabut
 */
export const passwordResetRoutes: FastifyPluginCallbackZod<PasswordResetRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { passwordReset, cookieSecure } = options;
  const context = (request: Parameters<typeof clientInfo>[0] & { log: typeof app.log }) => {
    const presentedDeviceToken = readDeviceToken(request.headers.cookie, cookieSecure);
    return {
      client: clientInfo(request),
      log: request.log,
      ...(presentedDeviceToken ? { presentedDeviceToken } : {}),
    };
  };

  app.get(
    API_ROUTES.passwordReset.status,
    {
      config: { access: PUBLIC },
      schema: { response: { 200: passwordResetStatusResponseSchema } },
    },
    async () => passwordReset.status(),
  );

  app.post(
    API_ROUTES.passwordReset.request,
    {
      config: { access: PUBLIC },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: requestPasswordResetRequestSchema,
        response: { 202: requestPasswordResetResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const result = await passwordReset.request(request.body.email, context(request));
      return reply.code(202).send(result);
    },
  );

  app.post(
    API_ROUTES.passwordReset.inspect,
    {
      config: { access: PUBLIC },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: inspectPasswordResetRequestSchema,
        response: { 200: inspectPasswordResetResponseSchema, ...errors },
      },
    },
    async (request) => passwordReset.inspect(request.body.token, context(request)),
  );

  app.post(
    API_ROUTES.passwordReset.complete,
    {
      config: { access: PUBLIC },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: completePasswordResetRequestSchema,
        response: { 200: completePasswordResetResponseSchema, ...errors },
      },
    },
    async (request) => {
      // Semua sesi akun ini dicabut. Cookie sesi di browser ini sengaja tidak disentuh: bila itu
      // sesi akun yang sama, permintaan berikutnya dijawab 401 dan cookie-nya dihapus hook auth.
      await passwordReset.complete(request.body, context(request));
      return { status: 'password_reset' as const };
    },
  );

  done();
};
