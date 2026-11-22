import {
  API_ROUTES,
  errorEnvelopeSchema,
  loginRequestSchema,
  loginResponseSchema,
  logoutResponseSchema,
  meResponseSchema,
  verifyTwoFactorRequestSchema,
  verifyTwoFactorResponseSchema,
} from '@balesin/shared';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import {
  clearedSessionCookie,
  deviceCookie,
  readDeviceToken,
  readSessionToken,
  sessionCookie,
} from '../../http/cookies';
import { AUTHENTICATED_OR_ENROLLING, PUBLIC } from '../../http/route-access';
import { requireAuth } from './auth.hook';
import type { AuthService, LoginResult } from './auth.service';
import {
  sessionCookieMaxAge,
  toAuthenticatedSession,
  toSessionResponse,
  type AuthContext,
} from './session.service';
import { TRUSTED_DEVICE_MAX_AGE_SECONDS } from './trusted-device';

export interface AuthRoutesOptions {
  auth: AuthService;
  cookieSecure: boolean;
  /**
   * Fase 9: menu berbasis data (`navigation.mail`). Gagal dihitung = dilewati (klien menganggap
   * `false`), respons sesi tetap terkirim.
   */
  navigation?: (auth: AuthContext) => Promise<{ mail: boolean }>;
}

/** Body login hanya email + password; batas kecil supaya tidak bisa dipakai membebani parser. */
const AUTH_BODY_LIMIT_BYTES = 16 * 1024;

/** Memasang cookie sesi (+ cookie perangkat dikenal bila semua langkah masuk sudah selesai). */
export function setSessionCookies(
  reply: FastifyReply,
  result: Pick<LoginResult, 'token' | 'auth' | 'deviceToken'>,
  cookieSecure: boolean,
): void {
  const cookies = [sessionCookie(result.token, cookieSecure, sessionCookieMaxAge(result.auth))];
  if (result.deviceToken) {
    cookies.push(deviceCookie(result.deviceToken, cookieSecure, TRUSTED_DEVICE_MAX_AGE_SECONDS));
  }
  void reply.header('set-cookie', cookies);
}

/**
 * - `POST /auth/login`       — publik. Lihat `loginResponseSchema`: sesi penuh, sesi terbatas
 *                              (wajib mendaftar 2FA), atau tantangan langkah kedua (tanpa cookie).
 * - `POST /auth/2fa/verify`  — publik. Tantangan + kode → sesi penuh + cookie.
 * - `POST /auth/logout`      — perlu sesi (juga sesi terbatas) + CSRF.
 * - `GET  /auth/me`          — perlu sesi (juga sesi terbatas). "Siapa saya" + langkah berikutnya.
 */
export const authRoutes: FastifyPluginCallbackZod<AuthRoutesOptions> = (app, options, done) => {
  const { auth, cookieSecure } = options;
  const withNavigation = async <T extends object>(session: T, context: AuthContext) => {
    if (!options.navigation || context.twoFactor.enrollmentRequired) return session;
    try {
      return { ...session, navigation: await options.navigation(context) };
    } catch {
      return session;
    }
  };

  app.post(
    API_ROUTES.auth.login,
    {
      config: { access: PUBLIC },
      bodyLimit: AUTH_BODY_LIMIT_BYTES,
      schema: {
        body: loginRequestSchema,
        response: {
          200: loginResponseSchema,
          401: errorEnvelopeSchema,
          429: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const outcome = await auth.login(request.body, {
        client: clientInfo(request),
        log: request.log,
        presentedToken: readSessionToken(request.headers.cookie, cookieSecure),
        presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
      });
      // Tantangan 2FA: belum ada sesi, jadi tidak ada cookie yang dipasang (sesi lama di browser
      // ini, bila ada, baru dicabut saat langkah kedua selesai).
      if (outcome.kind === 'two_factor_challenge') return reply.send(outcome.challenge);
      setSessionCookies(reply, outcome.result, cookieSecure);
      return reply.send(
        await withNavigation(toSessionResponse(outcome.result.auth), outcome.result.auth),
      );
    },
  );

  app.post(
    API_ROUTES.twoFactor.verify,
    {
      config: { access: PUBLIC },
      bodyLimit: AUTH_BODY_LIMIT_BYTES,
      schema: {
        body: verifyTwoFactorRequestSchema,
        response: {
          200: verifyTwoFactorResponseSchema,
          400: errorEnvelopeSchema,
          401: errorEnvelopeSchema,
          429: errorEnvelopeSchema,
          503: errorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await auth.verifyTwoFactor(request.body, {
        client: clientInfo(request),
        log: request.log,
        presentedToken: readSessionToken(request.headers.cookie, cookieSecure),
        presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
      });
      setSessionCookies(reply, result, cookieSecure);
      return reply.send({
        ...toAuthenticatedSession(result.auth),
        twoFactor: { method: result.method, backupCodesRemaining: result.backupCodesRemaining },
      });
    },
  );

  app.post(
    API_ROUTES.auth.logout,
    {
      config: { access: AUTHENTICATED_OR_ENROLLING },
      bodyLimit: AUTH_BODY_LIMIT_BYTES,
      schema: { response: { 200: logoutResponseSchema, 401: errorEnvelopeSchema } },
    },
    async (request, reply) => {
      await auth.logout(requireAuth(request), { client: clientInfo(request), log: request.log });
      void reply.header('set-cookie', clearedSessionCookie(cookieSecure));
      return reply.send({ status: 'logged_out' as const });
    },
  );

  app.get(
    API_ROUTES.auth.me,
    {
      config: { access: AUTHENTICATED_OR_ENROLLING },
      schema: { response: { 200: meResponseSchema, 401: errorEnvelopeSchema } },
    },
    async (request, reply) => {
      const context = requireAuth(request);
      return reply.send(await withNavigation(toSessionResponse(context), context));
    },
  );

  done();
};
