import { AppError } from '@balesin/core';
import {
  API_ROUTES,
  createTagRequestSchema,
  deletedResponseSchema,
  errorEnvelopeSchema,
  tagIdParamsSchema,
  tagListResponseSchema,
  tagResponseSchema,
  updateTagRequestSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { enforceRateLimit, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { requireAuth } from '../auth/auth.hook';
import { permissionGrant } from '../auth/permission-grant';
import { PANEL_WRITE_RULE } from '../contacts/contacts.routes';
import { TAG_NOT_FOUND, type TagContext, type TagsService } from './tags.service';

export interface TagsRoutesOptions {
  tags: TagsService;
  limiter: RateLimiter;
}

/**
 * Master tag (Fase 2 butir 8): `GET /tags` (`inbox.view` — saringan & panel), `POST /tags`
 * (`contacts.manage`), `PATCH`/`DELETE /tags/:id` (`settings.workspace.manage`). CSRF lewat hook.
 */
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

function tagIdOf(request: { params: { tagId: string } }): string {
  if (!UUID.safeParse(request.params.tagId).success) {
    throw new AppError('NOT_FOUND', { message: TAG_NOT_FOUND });
  }
  return request.params.tagId;
}

export const tagsRoutes: FastifyPluginCallbackZod<TagsRoutesOptions> = (app, options, done) => {
  const { tags, limiter } = options;
  const routes = API_ROUTES.tags;

  async function contextOf(request: FastifyRequest): Promise<TagContext> {
    const auth = requireAuth(request);
    await enforceRateLimit(limiter, PANEL_WRITE_RULE, auth.user.id, limitMessage);
    return { auth, client: clientInfo(request) };
  }

  app.get(
    routes.list,
    {
      config: { access: requirePermission('inbox.view') },
      schema: { response: { 200: tagListResponseSchema, ...errors } },
    },
    async (request) => {
      const grant = await permissionGrant(request, 'inbox.view');
      return { tags: await tags.list(grant.organizationId) };
    },
  );

  app.post(
    routes.list,
    {
      config: { access: requirePermission('contacts.manage') },
      schema: {
        body: createTagRequestSchema,
        response: { 201: tagResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const tag = await tags.create(await contextOf(request), request.body);
      void reply.code(201);
      return { tag };
    },
  );

  app.patch(
    routes.tag,
    {
      config: { access: requirePermission('settings.workspace.manage') },
      schema: {
        params: tagIdParamsSchema,
        body: updateTagRequestSchema,
        response: { 200: tagResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = tagIdOf(request);
      return { tag: await tags.update(await contextOf(request), id, request.body) };
    },
  );

  app.delete(
    routes.tag,
    {
      config: { access: requirePermission('settings.workspace.manage') },
      schema: {
        params: tagIdParamsSchema,
        response: { 200: deletedResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = tagIdOf(request);
      await tags.remove(await contextOf(request), id);
      return { deleted: true as const };
    },
  );

  done();
};
