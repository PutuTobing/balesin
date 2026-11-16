import { AppError } from '@balesin/core';
import type { Database } from '@balesin/db';
import {
  API_ROUTES,
  assignConversationRequestSchema,
  conversationEventListResponseSchema,
  conversationIdParamsSchema,
  conversationActionResponseSchema,
  errorEnvelopeSchema,
  inboxAgentListResponseSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import { permissionGrant } from '../auth/permission-grant';
import type { AssignmentContext, AssignmentService } from './assignment.service';
import { findConversation, lastMessagesOf } from './inbox.repo';
import { toConversation } from './inbox-view';

export interface AssignmentRoutesOptions {
  db: Database;
  assignment: AssignmentService;
  limiter: RateLimiter;
  now?: () => Date;
}

/**
 * Penanganan percakapan (Fase 2 butir 7, docs/KONTRAK-API-INBOX.md "Penanganan"). Semua POST lewat
 * hook CSRF (Origin + token). PRD §4:
 *  - ambil / tugaskan / alihkan = `inbox.assign` (Owner, Admin, Supervisor, CS);
 *  - kembalikan ke antrian = `inbox.reply` + cakupan; tanpa `inbox.assign` (Teknisi) hanya miliknya;
 *  - tandai selesai / buka lagi = `inbox.reply` + cakupan (Teknisi: yang di-assign);
 *  - riwayat & daftar agen = `inbox.view`.
 */
export const ASSIGNMENT_RULE: RateLimitRule = { name: 'inbox-aksi', limit: 120, windowSeconds: 60 };

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
};

const UUID = z.uuid();
const NOT_FOUND = 'Percakapan tidak ditemukan.';
const limitMessage = (wait: string) =>
  `Terlalu banyak aksi dalam waktu singkat. Coba lagi dalam ${wait}.`;

function idOf(request: { params: { conversationId: string } }): string {
  if (!UUID.safeParse(request.params.conversationId).success) {
    throw new AppError('NOT_FOUND', { message: NOT_FOUND });
  }
  return request.params.conversationId;
}

export const assignmentRoutes: FastifyPluginCallbackZod<AssignmentRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { db, assignment, limiter } = options;
  const now = options.now ?? (() => new Date());
  const routes = API_ROUTES.inbox;

  const contextOf = (request: FastifyRequest): AssignmentContext => ({
    auth: requireAuth(request),
    client: clientInfo(request),
  });

  /** Keadaan terbaru menurut cakupan pemanggil SESUDAH aksi; `null` bila akses hilang. */
  async function respond(request: FastifyRequest, conversationId: string) {
    const grant = await permissionGrant(request, 'inbox.view');
    const row = await findConversation(db, grant, conversationId);
    if (!row) return { conversation: null };
    const last = await lastMessagesOf(db, grant.organizationId, [row.id]);
    return { conversation: toConversation(row, last.get(row.id), now()) };
  }

  const actions = [
    [routes.claim, 'inbox.assign', (c: AssignmentContext, id: string) => assignment.claim(c, id)],
    [
      routes.unassign,
      'inbox.reply',
      (c: AssignmentContext, id: string) => assignment.unassign(c, id),
    ],
    [
      routes.resolve,
      'inbox.reply',
      (c: AssignmentContext, id: string) => assignment.resolve(c, id),
    ],
    [routes.reopen, 'inbox.reply', (c: AssignmentContext, id: string) => assignment.reopen(c, id)],
  ] as const;

  for (const [url, permission, run] of actions) {
    app.post(
      url,
      {
        config: { access: requirePermission(permission) },
        schema: {
          params: conversationIdParamsSchema,
          response: { 200: conversationActionResponseSchema, ...errors },
        },
      },
      async (request) => {
        const id = idOf(request);
        const context = contextOf(request);
        await enforceRateLimit(limiter, ASSIGNMENT_RULE, context.auth.user.id, limitMessage);
        await run(context, id);
        return respond(request, id);
      },
    );
  }

  app.post(
    routes.assign,
    {
      config: { access: requirePermission('inbox.assign') },
      schema: {
        params: conversationIdParamsSchema,
        body: assignConversationRequestSchema,
        response: { 200: conversationActionResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = idOf(request);
      const context = contextOf(request);
      await enforceRateLimit(limiter, ASSIGNMENT_RULE, context.auth.user.id, limitMessage);
      await assignment.assign(context, id, request.body.userId);
      return respond(request, id);
    },
  );

  app.get(
    routes.events,
    {
      config: { access: requirePermission('inbox.view') },
      schema: {
        params: conversationIdParamsSchema,
        response: { 200: conversationEventListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = idOf(request);
      const grant = await permissionGrant(request, 'inbox.view');
      const events = await assignment.events(grant, id);
      if (!events) throw new AppError('NOT_FOUND', { message: NOT_FOUND });
      return { events };
    },
  );

  app.get(
    routes.agents,
    {
      config: { access: requirePermission('inbox.view') },
      schema: { response: { 200: inboxAgentListResponseSchema, ...errors } },
    },
    async (request) => {
      const grant = await permissionGrant(request, 'inbox.view');
      return { agents: await assignment.agents(grant.organizationId) };
    },
  );

  done();
};
