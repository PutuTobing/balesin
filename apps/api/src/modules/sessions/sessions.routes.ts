import {
  API_ROUTES,
  activeSessionListResponseSchema,
  errorEnvelopeSchema,
  identityConfirmationSchema,
  revokeSessionResponseSchema,
  revokeSessionsResponseSchema,
  sessionIdParamsSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { AUTHENTICATED } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { OwnSessionsService, SessionsContext } from './sessions.service';

export interface SessionsRoutesOptions {
  sessionsService: OwnSessionsService;
  cookieSecure: boolean;
}

const BODY_LIMIT_BYTES = 16 * 1024;

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

/**
 * Sesi aktif milik sendiri — "cukup sesi" (`AUTHENTICATED`, sesi PENUH; data milik pemanggil).
 *
 * - `GET    /auth/sessions`                daftar sesi yang masih berlaku
 * - `DELETE /auth/sessions/:sessionId`     keluarkan satu sesi lain
 * - `POST   /auth/sessions/revoke-others`  keluarkan semua sesi lain (password + kode 2FA)
 */
export const sessionsRoutes: FastifyPluginCallbackZod<SessionsRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { sessionsService, cookieSecure } = options;

  const contextOf = (request: FastifyRequest): SessionsContext => ({
    client: clientInfo(request),
    log: request.log,
    presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
  });

  app.get(
    API_ROUTES.sessions.list,
    {
      config: { access: AUTHENTICATED },
      schema: { response: { 200: activeSessionListResponseSchema, ...errors } },
    },
    async (request) => sessionsService.list(requireAuth(request)),
  );

  app.delete(
    API_ROUTES.sessions.revoke,
    {
      config: { access: AUTHENTICATED },
      schema: {
        params: sessionIdParamsSchema,
        response: { 200: revokeSessionResponseSchema, ...errors },
      },
    },
    async (request) => {
      await sessionsService.revoke(
        requireAuth(request),
        request.params.sessionId,
        contextOf(request),
      );
      return { status: 'revoked' as const };
    },
  );

  app.post(
    API_ROUTES.sessions.revokeOthers,
    {
      config: { access: AUTHENTICATED },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: identityConfirmationSchema,
        response: { 200: revokeSessionsResponseSchema, ...errors },
      },
    },
    async (request) => ({
      revokedSessions: await sessionsService.revokeOthers(
        requireAuth(request),
        request.body,
        contextOf(request),
      ),
    }),
  );

  done();
};
