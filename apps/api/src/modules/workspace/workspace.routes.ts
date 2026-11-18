import { AppError } from '@balesin/core';
import {
  API_ROUTES,
  allocationAgentListResponseSchema,
  allocationAgentParamsSchema,
  allocationAgentResponseSchema,
  availabilityResponseSchema,
  availabilitySchema,
  errorEnvelopeSchema,
  updateAllocationAgentRequestSchema,
  updateWorkspaceSettingsRequestSchema,
  workspaceSettingsResponseSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { readDeviceToken } from '../../http/cookies';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import type { WorkspaceService } from './workspace.service';

export interface WorkspaceRoutesOptions {
  workspace: WorkspaceService;
  limiter: RateLimiter;
  cookieSecure: boolean;
}

const WRITE_RULE: RateLimitRule = { name: 'workspace-ubah', limit: 60, windowSeconds: 60 };
const AVAILABILITY_RULE: RateLimitRule = { name: 'ketersediaan', limit: 60, windowSeconds: 60 };
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

/**
 * Pengaturan kerja tim (Fase 5; docs/KONTRAK-API-INBOX.md "Jam kerja, pesan otomatis, alokasi").
 * Pengaturan & agen = `settings.workspace.manage` (Owner/Admin, PRD §3.8 "Alokasi agen", "Jam kerja");
 * ketersediaan diri sendiri = `inbox.reply`.
 */
export const workspaceRoutes: FastifyPluginCallbackZod<WorkspaceRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { workspace, limiter, cookieSecure } = options;
  const routes = API_ROUTES.workspace;
  const SETTINGS = requirePermission('settings.workspace.manage');

  app.get(
    routes.settings,
    {
      config: { access: SETTINGS },
      schema: { response: { 200: workspaceSettingsResponseSchema, ...errors } },
    },
    async (request) => ({
      settings: await workspace.getSettings(requireAuth(request).organizationId),
    }),
  );

  app.put(
    routes.settings,
    {
      config: { access: SETTINGS },
      schema: {
        body: updateWorkspaceSettingsRequestSchema,
        response: { 200: workspaceSettingsResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, WRITE_RULE, auth.user.id, limitMessage);
      return {
        settings: await workspace.updateSettings(auth, request.body, {
          client: clientInfo(request),
          log: request.log,
          presentedDeviceToken: readDeviceToken(request.headers.cookie, cookieSecure),
        }),
      };
    },
  );

  app.get(
    routes.agents,
    {
      config: { access: SETTINGS },
      schema: { response: { 200: allocationAgentListResponseSchema, ...errors } },
    },
    async (request) => ({
      agents: await workspace.agents(requireAuth(request).organizationId),
    }),
  );

  app.patch(
    routes.agent,
    {
      config: { access: SETTINGS },
      schema: {
        params: allocationAgentParamsSchema,
        body: updateAllocationAgentRequestSchema,
        response: { 200: allocationAgentResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      if (!UUID.safeParse(request.params.userId).success) {
        throw new AppError('NOT_FOUND', { message: 'Agen tidak ditemukan.' });
      }
      await enforceRateLimit(limiter, WRITE_RULE, auth.user.id, limitMessage);
      return {
        agent: await workspace.updateAgent(
          auth,
          request.params.userId,
          request.body,
          clientInfo(request),
        ),
      };
    },
  );

  app.get(
    API_ROUTES.inbox.availability,
    {
      config: { access: requirePermission('inbox.reply') },
      schema: { response: { 200: availabilityResponseSchema, ...errors } },
    },
    async (request) => ({ availability: await workspace.availability(requireAuth(request)) }),
  );

  app.put(
    API_ROUTES.inbox.availability,
    {
      config: { access: requirePermission('inbox.reply') },
      schema: {
        body: availabilitySchema,
        response: { 200: availabilityResponseSchema, ...errors },
      },
    },
    async (request) => {
      const auth = requireAuth(request);
      await enforceRateLimit(limiter, AVAILABILITY_RULE, auth.user.id, limitMessage);
      return {
        availability: await workspace.setAvailability(auth, request.body.available),
      };
    },
  );

  done();
};
