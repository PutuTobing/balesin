import {
  API_ROUTES,
  emailVerificationStatusResponseSchema,
  errorEnvelopeSchema,
  sendEmailVerificationResponseSchema,
  verifyEmailRequestSchema,
  verifyEmailResponseSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { AUTHENTICATED, PUBLIC } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { EmailVerificationService } from './email-verification.service';

export interface EmailVerificationRoutesOptions {
  emailVerification: EmailVerificationService;
}

const BODY_LIMIT_BYTES = 16 * 1024;

/**
 * Verifikasi email (docs/KONTRAK-API-AUTH.md bagian "Verifikasi email").
 *
 * - `GET  /auth/email/verification`  (sesi penuh) status email akun sendiri
 * - `POST /auth/email/verification`  (sesi penuh + CSRF) kirim tautan verifikasi → 202
 * - `POST /auth/email/verify`        (publik) token dari tautan → terverifikasi
 */
export const emailVerificationRoutes: FastifyPluginCallbackZod<EmailVerificationRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { emailVerification } = options;

  app.get(
    API_ROUTES.emailVerification.status,
    {
      config: { access: AUTHENTICATED },
      schema: {
        response: {
          200: emailVerificationStatusResponseSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
        },
      },
    },
    async (request) => emailVerification.status(requireAuth(request)),
  );

  app.post(
    API_ROUTES.emailVerification.status,
    {
      config: { access: AUTHENTICATED },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        response: {
          202: sendEmailVerificationResponseSchema,
          401: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          409: errorEnvelopeSchema,
          429: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await emailVerification.send(requireAuth(request), {
        client: clientInfo(request),
        log: request.log,
      });
      return reply.code(202).send(result);
    },
  );

  app.post(
    API_ROUTES.emailVerification.verify,
    {
      config: { access: PUBLIC },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: verifyEmailRequestSchema,
        response: {
          200: verifyEmailResponseSchema,
          400: errorEnvelopeSchema,
          403: errorEnvelopeSchema,
          410: errorEnvelopeSchema,
          429: errorEnvelopeSchema,
        },
      },
    },
    async (request) =>
      emailVerification.verify(request.body.token, {
        client: clientInfo(request),
        log: request.log,
      }),
  );

  done();
};
