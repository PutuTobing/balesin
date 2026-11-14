import {
  API_ROUTES,
  acceptInvitationRequestSchema,
  acceptInvitationResponseSchema,
  createInvitationRequestSchema,
  errorEnvelopeSchema,
  inspectInvitationRequestSchema,
  inspectInvitationResponseSchema,
  invitationIdParamsSchema,
  invitationIssuedResponseSchema,
  invitationListResponseSchema,
  revokeInvitationResponseSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { clientInfo } from '../../http/client-info';
import { readSessionToken } from '../../http/cookies';
import { PUBLIC, requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import { setSessionCookies } from '../auth/auth.routes';
import { toSessionResponse } from '../auth/session.service';
import type { InvitationService } from './invitations.service';

export interface InvitationRoutesOptions {
  invitations: InvitationService;
  cookieSecure: boolean;
}

/** PRD §4: undang pengguna = `team.invite` (Owner, Admin). Peran yang boleh diundang: service. */
const MANAGE = requirePermission('team.invite');

/** Body kecil (email + peran, atau token + nama + password). */
const BODY_LIMIT_BYTES = 16 * 1024;

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
};

const publicErrors = {
  400: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  410: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

/**
 * Undangan (docs/KONTRAK-API-AUTH.md bagian "Undangan").
 *
 * - `GET    /invitations`                       daftar undangan tertunda/kedaluwarsa (Owner/Admin)
 * - `POST   /invitations`                       buat undangan (Owner/Admin)
 * - `POST   /invitations/:invitationId/resend`  kirim ulang: tautan baru, tautan lama batal
 * - `DELETE /invitations/:invitationId`         batalkan
 * - `POST   /auth/invitation/inspect`           publik: isi undangan untuk token yang sah
 * - `POST   /auth/invitation/accept`            publik: nama + password → akun + sesi
 *
 * Token selalu di BODY (dari fragment `#token=` tautan email), tidak pernah di path/query.
 */
export const invitationRoutes: FastifyPluginCallbackZod<InvitationRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { invitations, cookieSecure } = options;

  app.get(
    API_ROUTES.invitations.collection,
    {
      config: { access: MANAGE },
      schema: { response: { 200: invitationListResponseSchema, ...errors } },
    },
    async (request) => invitations.list(requireAuth(request)),
  );

  app.post(
    API_ROUTES.invitations.collection,
    {
      config: { access: MANAGE },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: createInvitationRequestSchema,
        response: { 201: invitationIssuedResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const result = await invitations.create(requireAuth(request), request.body, {
        client: clientInfo(request),
        log: request.log,
      });
      return reply.code(201).send(result);
    },
  );

  app.post(
    API_ROUTES.invitations.resend,
    {
      config: { access: MANAGE },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: invitationIdParamsSchema,
        response: { 200: invitationIssuedResponseSchema, ...errors },
      },
    },
    async (request) =>
      invitations.resend(requireAuth(request), request.params.invitationId, {
        client: clientInfo(request),
        log: request.log,
      }),
  );

  app.delete(
    API_ROUTES.invitations.revoke,
    {
      config: { access: MANAGE },
      schema: {
        params: invitationIdParamsSchema,
        response: { 200: revokeInvitationResponseSchema, ...errors },
      },
    },
    async (request) => {
      await invitations.revoke(requireAuth(request), request.params.invitationId, {
        client: clientInfo(request),
        log: request.log,
      });
      return { status: 'revoked' as const };
    },
  );

  app.post(
    API_ROUTES.invitations.inspect,
    {
      config: { access: PUBLIC },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: inspectInvitationRequestSchema,
        response: { 200: inspectInvitationResponseSchema, ...publicErrors },
      },
    },
    async (request) =>
      invitations.inspect(request.body.token, { client: clientInfo(request), log: request.log }),
  );

  app.post(
    API_ROUTES.invitations.accept,
    {
      config: { access: PUBLIC },
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: acceptInvitationRequestSchema,
        response: { 201: acceptInvitationResponseSchema, ...publicErrors },
      },
    },
    async (request, reply) => {
      const result = await invitations.accept(request.body, {
        client: clientInfo(request),
        log: request.log,
        presentedToken: readSessionToken(request.headers.cookie, cookieSecure),
      });
      setSessionCookies(reply, result, cookieSecure);
      return reply.code(201).send(toSessionResponse(result.auth));
    },
  );

  done();
};
