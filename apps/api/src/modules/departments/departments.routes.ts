import { AppError } from '@balesin/core';
import type { Database } from '@balesin/db';
import {
  API_ROUTES,
  conversationActionResponseSchema,
  conversationIdParamsSchema,
  createDepartmentRequestSchema,
  departmentAccessParamsSchema,
  departmentAccessResponseSchema,
  departmentIdParamsSchema,
  departmentListResponseSchema,
  departmentResponseSchema,
  departmentSettingsResponseSchema,
  errorEnvelopeSchema,
  setConversationDepartmentRequestSchema,
  updateDepartmentAccessRequestSchema,
  updateDepartmentRequestSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import { permissionGrant } from '../auth/permission-grant';
import { conversationExtras, findConversation } from '../inbox/inbox.repo';
import { toConversation } from '../inbox/inbox-view';
import { DEPARTMENT_NOT_FOUND, type DepartmentsService } from './departments.service';

export interface DepartmentsRoutesOptions {
  db: Database;
  departments: DepartmentsService;
  limiter: RateLimiter;
  cookieSecure: boolean;
  now?: () => Date;
}

const WRITE_RULE: RateLimitRule = { name: 'departemen-ubah', limit: 60, windowSeconds: 60 };
const MOVE_RULE: RateLimitRule = { name: 'percakapan-departemen', limit: 120, windowSeconds: 60 };
const UUID = z.uuid();
const limitMessage = (wait: string) =>
  `Terlalu banyak perubahan dalam waktu singkat. Coba lagi dalam ${wait}.`;

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
};

function uuidOr404(value: string, message: string): string {
  if (!UUID.safeParse(value).success) throw new AppError('NOT_FOUND', { message });
  return value;
}

/**
 * Departemen Fase 5 (docs/KONTRAK-API-CRM-TIKET.md "Departemen"). Daftar nama = `inbox.view`;
 * kelola & akses pengguna = `settings.workspace.manage`; pindah percakapan = `inbox.assign`.
 */
export const departmentsRoutes: FastifyPluginCallbackZod<DepartmentsRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { db, departments, limiter, cookieSecure } = options;
  const now = options.now ?? (() => new Date());
  const routes = API_ROUTES.departments;
  const SETTINGS = requirePermission('settings.workspace.manage');

  async function write(request: FastifyRequest, rule: RateLimitRule = WRITE_RULE) {
    await enforceRateLimit(limiter, rule, requireAuth(request).user.id, limitMessage);
  }

  app.get(
    routes.list,
    {
      config: { access: requirePermission('inbox.view') },
      schema: { response: { 200: departmentListResponseSchema, ...errors } },
    },
    async (request) => ({
      departments: await departments.summaries(requireAuth(request).organizationId),
    }),
  );

  app.get(
    routes.settings,
    {
      config: { access: SETTINGS },
      schema: { response: { 200: departmentSettingsResponseSchema, ...errors } },
    },
    async (request) => ({
      departments: await departments.details(requireAuth(request).organizationId),
    }),
  );

  app.post(
    routes.settings,
    {
      config: { access: SETTINGS },
      schema: {
        body: createDepartmentRequestSchema,
        response: { 201: departmentResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      await write(request);
      const department = await departments.create(
        requireAuth(request),
        request.body,
        clientInfo(request),
      );
      void reply.code(201);
      return { department };
    },
  );

  app.patch(
    routes.department,
    {
      config: { access: SETTINGS },
      schema: {
        params: departmentIdParamsSchema,
        body: updateDepartmentRequestSchema,
        response: { 200: departmentResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.departmentId, DEPARTMENT_NOT_FOUND);
      await write(request);
      return {
        department: await departments.update(
          requireAuth(request),
          id,
          request.body,
          clientInfo(request),
        ),
      };
    },
  );

  app.delete(
    routes.department,
    {
      config: { access: SETTINGS },
      schema: {
        params: departmentIdParamsSchema,
        response: { 200: z.object({ deleted: z.literal(true) }), ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.departmentId, DEPARTMENT_NOT_FOUND);
      await write(request);
      await departments.remove(requireAuth(request), id, clientInfo(request));
      return { deleted: true as const };
    },
  );

  app.get(
    routes.access,
    {
      config: { access: SETTINGS },
      schema: {
        params: departmentAccessParamsSchema,
        response: { 200: departmentAccessResponseSchema, ...errors },
      },
    },
    async (request) => {
      const userId = uuidOr404(request.params.userId, 'Pengguna tidak ditemukan.');
      return { access: await departments.access(requireAuth(request).organizationId, userId) };
    },
  );

  app.put(
    routes.access,
    {
      config: { access: SETTINGS },
      schema: {
        params: departmentAccessParamsSchema,
        body: updateDepartmentAccessRequestSchema,
        response: { 200: departmentAccessResponseSchema, ...errors },
      },
    },
    async (request) => {
      const userId = uuidOr404(request.params.userId, 'Pengguna tidak ditemukan.');
      await write(request);
      const { confirmation, ...input } = request.body;
      return {
        access: await departments.setAccess(requireAuth(request), userId, input, confirmation, {
          client: clientInfo(request),
          log: request.log,
          presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
        }),
      };
    },
  );

  // Pindahkan percakapan ke departemen (inbox).
  app.post(
    API_ROUTES.inbox.department,
    {
      config: { access: requirePermission('inbox.assign') },
      schema: {
        params: conversationIdParamsSchema,
        body: setConversationDepartmentRequestSchema,
        response: { 200: conversationActionResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.conversationId, 'Percakapan tidak ditemukan.');
      await write(request, MOVE_RULE);
      await departments.setConversationDepartment(
        requireAuth(request),
        id,
        request.body.departmentId,
      );
      const grant = await permissionGrant(request, 'inbox.view');
      const row = await findConversation(db, grant, id);
      if (!row) return { conversation: null };
      const extras = await conversationExtras(db, grant.organizationId, [row]);
      return {
        conversation: toConversation(
          row,
          extras.lastMessages.get(row.id),
          now(),
          extras.tags.get(row.contact.id) ?? [],
        ),
      };
    },
  );

  done();
};
