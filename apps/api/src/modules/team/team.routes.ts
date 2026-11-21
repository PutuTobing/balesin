import {
  API_ROUTES,
  activeSessionListResponseSchema,
  changeUserRoleRequestSchema,
  errorEnvelopeSchema,
  identityConfirmationSchema,
  revokeSessionResponseSchema,
  revokeSessionsResponseSchema,
  teamUserActionResponseSchema,
  teamUserListResponseSchema,
  teamUserResponseSchema,
  userIdParamsSchema,
  userSessionParamsSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { TeamContext, TeamService } from './team.service';

export interface TeamRoutesOptions {
  team: TeamService;
  cookieSecure: boolean;
}

/** PRD §4 "Undang/nonaktifkan pengguna" = `team.manage` (Owner, Admin). Aturan per peran: service. */
const MANAGE = requirePermission('team.manage');

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
 * Manajemen pengguna (docs/KONTRAK-API-AUTH.md bagian "Manajemen pengguna & sesi").
 *
 * - `GET    /users`                                 semua pengguna
 * - `GET    /users/:userId`                         satu pengguna
 * - `PUT    /users/:userId/role`                    ubah peran           (+ konfirmasi identitas)
 * - `POST   /users/:userId/disable`                 nonaktifkan          (+ konfirmasi identitas)
 * - `POST   /users/:userId/enable`                  aktifkan kembali     (+ konfirmasi identitas)
 * - `POST   /users/:userId/2fa/reset`               atur ulang 2FA       (+ konfirmasi identitas)
 * - `POST   /users/:userId/2fa/enrollment-window`   buka lagi pendaftaran 2FA (+ konfirmasi)
 * - `POST   /users/:userId/unlock`                  buka kunci           (+ konfirmasi identitas)
 * - `GET    /users/:userId/sessions`                sesi aktif pengguna itu
 * - `DELETE /users/:userId/sessions/:sessionId`     keluarkan satu sesi
 * - `POST   /users/:userId/sessions/revoke-all`     keluarkan semua sesi (+ konfirmasi identitas)
 */
export const teamRoutes: FastifyPluginCallbackZod<TeamRoutesOptions> = (app, options, done) => {
  const { team, cookieSecure } = options;

  const contextOf = (request: FastifyRequest): TeamContext => ({
    client: clientInfo(request),
    log: request.log,
    presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
  });

  app.get(
    API_ROUTES.team.users,
    {
      config: { access: MANAGE },
      schema: { response: { 200: teamUserListResponseSchema, ...errors } },
    },
    async (request) => team.list(requireAuth(request)),
  );

  app.get(
    API_ROUTES.team.user,
    {
      config: { access: MANAGE },
      schema: { params: userIdParamsSchema, response: { 200: teamUserResponseSchema, ...errors } },
    },
    async (request) => ({ user: await team.get(requireAuth(request), request.params.userId) }),
  );

  app.put(
    API_ROUTES.team.role,
    {
      config: { access: MANAGE },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: userIdParamsSchema,
        body: changeUserRoleRequestSchema,
        response: { 200: teamUserActionResponseSchema, ...errors },
      },
    },
    async (request) =>
      team.changeRole(
        requireAuth(request),
        request.params.userId,
        request.body,
        contextOf(request),
      ),
  );

  type ConfirmedAction =
    'disable' | 'enable' | 'resetTwoFactor' | 'reopenTwoFactorEnrollment' | 'unlock';
  const confirmedActions: ReadonlyArray<readonly [string, ConfirmedAction]> = [
    [API_ROUTES.team.disable, 'disable'],
    [API_ROUTES.team.enable, 'enable'],
    [API_ROUTES.team.resetTwoFactor, 'resetTwoFactor'],
    [API_ROUTES.team.reopenTwoFactorEnrollment, 'reopenTwoFactorEnrollment'],
    [API_ROUTES.team.unlock, 'unlock'],
  ];
  for (const [path, action] of confirmedActions) {
    app.post(
      path,
      {
        config: { access: MANAGE },
        bodyLimit: BODY_LIMIT_BYTES,
        schema: {
          params: userIdParamsSchema,
          body: identityConfirmationSchema,
          response: { 200: teamUserActionResponseSchema, ...errors },
        },
      },
      async (request) =>
        team[action](requireAuth(request), request.params.userId, request.body, contextOf(request)),
    );
  }

  app.get(
    API_ROUTES.team.sessions,
    {
      config: { access: MANAGE },
      schema: {
        params: userIdParamsSchema,
        response: { 200: activeSessionListResponseSchema, ...errors },
      },
    },
    async (request) =>
      team.sessions(requireAuth(request), request.params.userId, contextOf(request)),
  );

  app.delete(
    API_ROUTES.team.revokeSession,
    {
      config: { access: MANAGE },
      schema: {
        params: userSessionParamsSchema,
        response: { 200: revokeSessionResponseSchema, ...errors },
      },
    },
    async (request) => {
      await team.revokeSession(
        requireAuth(request),
        request.params.userId,
        request.params.sessionId,
        contextOf(request),
      );
      return { status: 'revoked' as const };
    },
  );

  app.post(
    API_ROUTES.team.revokeAllSessions,
    {
      config: { access: MANAGE },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: userIdParamsSchema,
        body: identityConfirmationSchema,
        response: { 200: revokeSessionsResponseSchema, ...errors },
      },
    },
    async (request) => ({
      revokedSessions: await team.revokeAllSessions(
        requireAuth(request),
        request.params.userId,
        request.body,
        contextOf(request),
      ),
    }),
  );

  done();
};
