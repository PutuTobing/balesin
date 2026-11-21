import { AppError } from '@balesin/core';
import {
  API_ROUTES,
  createQuickReplyRequestSchema,
  deletedResponseSchema,
  errorEnvelopeSchema,
  quickReplyIdParamsSchema,
  quickReplyListQuerySchema,
  quickReplyListResponseSchema,
  quickReplyResponseSchema,
  updateQuickReplyRequestSchema,
  useQuickReplyRequestSchema,
  useQuickReplyResponseSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import { permissionGrant } from '../auth/permission-grant';
import { PANEL_WRITE_RULE } from '../contacts/contacts.routes';
import {
  QUICK_REPLY_NOT_FOUND,
  type QuickRepliesService,
  type QuickReplyContext,
} from './quick-replies.service';

export interface QuickRepliesRoutesOptions {
  quickReplies: QuickRepliesService;
  limiter: RateLimiter;
}

/**
 * Quick reply `/` (Fase 2 butir 9): daftar/cari & pakai = `inbox.reply`; buat/ubah/hapus =
 * `quick_replies.manage`. CSRF lewat hook auth.
 */
export const QUICK_REPLY_USE_RULE: RateLimitRule = {
  name: 'quick-reply-pakai',
  limit: 240,
  windowSeconds: 60,
};
const UUID = z.uuid();
const limitMessage = (wait: string) =>
  `Terlalu banyak permintaan dalam waktu singkat. Coba lagi dalam ${wait}.`;

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
};

function idOf(request: { params: { quickReplyId: string } }): string {
  if (!UUID.safeParse(request.params.quickReplyId).success) {
    throw new AppError('NOT_FOUND', { message: QUICK_REPLY_NOT_FOUND });
  }
  return request.params.quickReplyId;
}

export const quickRepliesRoutes: FastifyPluginCallbackZod<QuickRepliesRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { quickReplies, limiter } = options;
  const routes = API_ROUTES.quickReplies;
  const MANAGE = requirePermission('quick_replies.manage');

  async function contextOf(request: FastifyRequest): Promise<QuickReplyContext> {
    const auth = requireAuth(request);
    await enforceRateLimit(limiter, PANEL_WRITE_RULE, auth.user.id, limitMessage);
    return { auth, client: clientInfo(request) };
  }

  app.get(
    routes.list,
    {
      config: { access: requirePermission('inbox.reply') },
      schema: {
        querystring: quickReplyListQuerySchema,
        response: { 200: quickReplyListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const grant = await permissionGrant(request, 'inbox.reply');
      return { quickReplies: await quickReplies.list(grant.organizationId, request.query.q) };
    },
  );

  app.post(
    routes.list,
    {
      config: { access: MANAGE },
      schema: {
        body: createQuickReplyRequestSchema,
        response: { 201: quickReplyResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const quickReply = await quickReplies.create(await contextOf(request), request.body);
      void reply.code(201);
      return { quickReply };
    },
  );

  app.patch(
    routes.quickReply,
    {
      config: { access: MANAGE },
      schema: {
        params: quickReplyIdParamsSchema,
        body: updateQuickReplyRequestSchema,
        response: { 200: quickReplyResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = idOf(request);
      const quickReply = await quickReplies.update(await contextOf(request), id, request.body);
      return { quickReply };
    },
  );

  app.delete(
    routes.quickReply,
    {
      config: { access: MANAGE },
      schema: {
        params: quickReplyIdParamsSchema,
        response: { 200: deletedResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = idOf(request);
      await quickReplies.remove(await contextOf(request), id);
      return { deleted: true as const };
    },
  );

  app.post(
    routes.use,
    {
      config: { access: requirePermission('inbox.reply') },
      schema: {
        params: quickReplyIdParamsSchema,
        body: useQuickReplyRequestSchema,
        response: { 200: useQuickReplyResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = idOf(request);
      const auth = requireAuth(request);
      const grant = await permissionGrant(request, 'inbox.reply');
      await enforceRateLimit(limiter, QUICK_REPLY_USE_RULE, auth.user.id, limitMessage);
      const text = await quickReplies.use(grant, auth.user.name, id, request.body.conversationId);
      return { text };
    },
  );

  done();
};
