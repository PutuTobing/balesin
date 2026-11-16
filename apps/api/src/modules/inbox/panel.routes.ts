import { AppError } from '@balesin/core';
import type { Database } from '@balesin/db';
import {
  API_ROUTES,
  conversationIdParamsSchema,
  conversationNoteListResponseSchema,
  conversationNoteParamsSchema,
  conversationNoteRequestSchema,
  conversationNoteResponseSchema,
  deletedResponseSchema,
  errorEnvelopeSchema,
  messageIdParamsSchema,
  messageResponseSchema,
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
import { senderNameOf } from './inbox.repo';
import { toMessage } from './inbox-view';
import type { PanelContext, PanelService } from './panel.service';

export interface PanelRoutesOptions {
  db: Database;
  panel: PanelService;
  limiter: RateLimiter;
}

/**
 * Panel detail (Fase 2 butir 8): catatan sesi & pesan ditandai. Media/file/pesan ditandai dibaca
 * lewat `GET /conversations/:id/messages?only=media|files|starred`; log lewat `/events`.
 */
const UUID = z.uuid();
const CONVERSATION_NOT_FOUND = 'Percakapan tidak ditemukan.';
const NOTE_NOT_FOUND = 'Catatan tidak ditemukan.';
const MESSAGE_NOT_FOUND = 'Pesan tidak ditemukan.';
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

export const panelRoutes: FastifyPluginCallbackZod<PanelRoutesOptions> = (app, options, done) => {
  const { db, panel, limiter } = options;
  const routes = API_ROUTES.inbox;
  const REPLY = requirePermission('inbox.reply');

  async function contextOf(request: FastifyRequest): Promise<PanelContext> {
    const auth = requireAuth(request);
    await enforceRateLimit(limiter, PANEL_WRITE_RULE, auth.user.id, limitMessage);
    return { auth, client: clientInfo(request) };
  }

  app.get(
    routes.notes,
    {
      config: { access: requirePermission('inbox.view') },
      schema: {
        params: conversationIdParamsSchema,
        response: { 200: conversationNoteListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.conversationId, CONVERSATION_NOT_FOUND);
      const grant = await permissionGrant(request, 'inbox.view');
      const notes = await panel.notes(grant, requireAuth(request).user.role, id);
      if (!notes) throw new AppError('NOT_FOUND', { message: CONVERSATION_NOT_FOUND });
      return { notes };
    },
  );

  app.post(
    routes.notes,
    {
      config: { access: REPLY },
      schema: {
        params: conversationIdParamsSchema,
        body: conversationNoteRequestSchema,
        response: { 201: conversationNoteResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const id = uuidOr404(request.params.conversationId, CONVERSATION_NOT_FOUND);
      const note = await panel.addNote(await contextOf(request), id, request.body.body);
      void reply.code(201);
      return { note };
    },
  );

  app.patch(
    routes.note,
    {
      config: { access: REPLY },
      schema: {
        params: conversationNoteParamsSchema,
        body: conversationNoteRequestSchema,
        response: { 200: conversationNoteResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.conversationId, CONVERSATION_NOT_FOUND);
      const noteId = uuidOr404(request.params.noteId, NOTE_NOT_FOUND);
      const note = await panel.editNote(await contextOf(request), id, noteId, request.body.body);
      return { note };
    },
  );

  app.delete(
    routes.note,
    {
      config: { access: REPLY },
      schema: {
        params: conversationNoteParamsSchema,
        response: { 200: deletedResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.conversationId, CONVERSATION_NOT_FOUND);
      const noteId = uuidOr404(request.params.noteId, NOTE_NOT_FOUND);
      await panel.deleteNote(await contextOf(request), id, noteId);
      return { deleted: true as const };
    },
  );

  for (const [method, starred] of [
    ['PUT', true],
    ['DELETE', false],
  ] as const) {
    app.route({
      method,
      url: routes.star,
      config: { access: REPLY },
      schema: {
        params: messageIdParamsSchema,
        response: { 200: messageResponseSchema, ...errors },
      },
      handler: async (request) => {
        const id = uuidOr404(request.params.messageId, MESSAGE_NOT_FOUND);
        const row = await panel.star(await contextOf(request), id, starred);
        return {
          message: toMessage({
            ...row,
            occurredAtExact: row.occurredAt.toISOString(),
            senderName: await senderNameOf(db, row),
          }),
        };
      },
    });
  }

  done();
};
