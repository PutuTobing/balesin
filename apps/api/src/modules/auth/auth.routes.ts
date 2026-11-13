import {
  API_ROUTES,
  errorEnvelopeSchema,
  loginRequestSchema,
  loginResponseSchema,
  logoutResponseSchema,
  meResponseSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { clearedSessionCookie, readSessionToken, sessionCookie } from '../../http/cookies';
import { AUTHENTICATED, PUBLIC } from '../../http/route-access';
import { requireAuth } from './auth.hook';
import type { AuthService } from './auth.service';
import { SESSION_ABSOLUTE_SECONDS } from './session.repo';
import { toAuthenticatedSession } from './session.service';

export interface AuthRoutesOptions {
  auth: AuthService;
  cookieSecure: boolean;
}

/** Body login hanya email + password; batas kecil supaya tidak bisa dipakai membebani parser. */
const AUTH_BODY_LIMIT_BYTES = 16 * 1024;

/**
 * - `POST /auth/login`  — publik. Memasang cookie sesi dan mengembalikan `csrfToken`.
 * - `POST /auth/logout` — perlu sesi + CSRF. Mencabut sesi dan menghapus cookie.
 * - `GET  /auth/me`     — perlu sesi. "Siapa saya" + `csrfToken` (dipanggil web saat dimuat).
 */
export const authRoutes: FastifyPluginCallbackZod<AuthRoutesOptions> = (app, options, done) => {
  const { auth, cookieSecure } = options;

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
      const issued = await auth.login(request.body, {
        client: clientInfo(request),
        log: request.log,
        presentedToken: readSessionToken(request.headers.cookie, cookieSecure),
      });
      void reply.header(
        'set-cookie',
        sessionCookie(issued.token, cookieSecure, SESSION_ABSOLUTE_SECONDS),
      );
      return reply.send(toAuthenticatedSession(issued.auth));
    },
  );

  app.post(
    API_ROUTES.auth.logout,
    {
      config: { access: AUTHENTICATED },
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
      config: { access: AUTHENTICATED },
      schema: { response: { 200: meResponseSchema, 401: errorEnvelopeSchema } },
    },
    (request, reply) => {
      void reply.send(toAuthenticatedSession(requireAuth(request)));
    },
  );

  done();
};
