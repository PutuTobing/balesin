import {
  API_ROUTES,
  confirmTwoFactorEnrollmentRequestSchema,
  confirmTwoFactorEnrollmentResponseSchema,
  disableTwoFactorResponseSchema,
  errorEnvelopeSchema,
  regenerateBackupCodesResponseSchema,
  startTwoFactorEnrollmentRequestSchema,
  startTwoFactorEnrollmentResponseSchema,
  twoFactorReauthRequestSchema,
  twoFactorStatusResponseSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { AUTHENTICATED, AUTHENTICATED_OR_ENROLLING } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import { setSessionCookies } from '../auth/auth.routes';
import { toAuthenticatedSession } from '../auth/session.service';
import type { TwoFactorContext, TwoFactorService } from './two-factor.service';

export interface TwoFactorRoutesOptions {
  twoFactor: TwoFactorService;
  cookieSecure: boolean;
}

const BODY_LIMIT_BYTES = 16 * 1024;

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

/**
 * Pengelolaan verifikasi dua langkah oleh pengguna sendiri. Semua perlu sesi; yang mengubah data
 * perlu CSRF (hook auth). Langkah kedua saat masuk (`POST /auth/2fa/verify`) ada di auth.routes.
 *
 * Boleh dari sesi terbatas "wajib mendaftar 2FA" (`AUTHENTICATED_OR_ENROLLING`):
 * - `GET  /auth/2fa`                 status
 * - `POST /auth/2fa/enroll`          mulai pendaftaran (rahasia + URI otpauth)
 * - `POST /auth/2fa/enroll/confirm`  konfirmasi kode pertama → 2FA aktif, sesi baru, kode cadangan
 *
 * Hanya sesi penuh (`AUTHENTICATED`):
 * - `POST /auth/2fa/backup-codes`    buat ulang kode cadangan (password + kode)
 * - `POST /auth/2fa/disable`         nonaktifkan (peran tidak wajib saja; password + kode)
 *
 * Mengatur ulang 2FA pengguna LAIN (Owner/Admin) ada di manajemen pengguna:
 * `POST /users/:userId/2fa/reset` (`modules/team`).
 */
export const twoFactorRoutes: FastifyPluginCallbackZod<TwoFactorRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { twoFactor, cookieSecure } = options;

  const contextOf = (request: FastifyRequest): TwoFactorContext => ({
    client: clientInfo(request),
    log: request.log,
    presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
  });

  app.get(
    API_ROUTES.twoFactor.status,
    {
      config: { access: AUTHENTICATED_OR_ENROLLING },
      schema: { response: { 200: twoFactorStatusResponseSchema, 401: errorEnvelopeSchema } },
    },
    async (request, reply) => reply.send(await twoFactor.status(requireAuth(request))),
  );

  app.post(
    API_ROUTES.twoFactor.enroll,
    {
      config: { access: AUTHENTICATED_OR_ENROLLING },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: startTwoFactorEnrollmentRequestSchema.optional(),
        response: { 200: startTwoFactorEnrollmentResponseSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.send(
        await twoFactor.startEnrollment(
          requireAuth(request),
          { password: request.body?.password },
          contextOf(request),
        ),
      ),
  );

  app.post(
    API_ROUTES.twoFactor.confirmEnrollment,
    {
      config: { access: AUTHENTICATED_OR_ENROLLING },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: confirmTwoFactorEnrollmentRequestSchema,
        response: { 200: confirmTwoFactorEnrollmentResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const completed = await twoFactor.confirmEnrollment(
        requireAuth(request),
        request.body,
        contextOf(request),
      );
      // Rotasi: cookie sesi lama sudah dicabut di server; cookie baru menggantikannya.
      setSessionCookies(
        reply,
        { ...completed.issued, deviceToken: completed.deviceToken },
        cookieSecure,
      );
      return reply.send({
        ...toAuthenticatedSession(completed.issued.auth),
        backupCodes: completed.backupCodes,
      });
    },
  );

  app.post(
    API_ROUTES.twoFactor.regenerateBackupCodes,
    {
      config: { access: AUTHENTICATED },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: twoFactorReauthRequestSchema,
        response: { 200: regenerateBackupCodesResponseSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.send(
        await twoFactor.regenerateBackupCodes(
          requireAuth(request),
          request.body,
          contextOf(request),
        ),
      ),
  );

  app.post(
    API_ROUTES.twoFactor.disable,
    {
      config: { access: AUTHENTICATED },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: twoFactorReauthRequestSchema,
        response: { 200: disableTwoFactorResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      await twoFactor.disable(requireAuth(request), request.body, contextOf(request));
      return reply.send({ status: 'disabled' as const });
    },
  );

  done();
};
