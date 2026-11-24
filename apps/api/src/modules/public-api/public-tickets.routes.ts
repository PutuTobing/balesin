import { AppError } from '@balesin/core';
import type { Database } from '@balesin/db';
import {
  API_ROUTES,
  TICKET_LIMITS,
  createTicketCommentRequestSchema,
  errorEnvelopeSchema,
  publicCreateTicketRequestSchema,
  publicUpdateTicketRequestSchema,
  ticketBoardListResponseSchema,
  ticketCommentResponseSchema,
  ticketIdParamsSchema,
  ticketListQuerySchema,
  ticketListResponseSchema,
  ticketResponseSchema,
} from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireApiKeyScope } from '../../http/route-access';
import { requireApiKey, type ApiKeyPrincipal } from '../api-keys/api-key-auth';
import type { PermissionGrant } from '../auth/permission-grant';
import { decodeCursor, encodeCursor } from '../inbox/inbox.repo';
import { findTicket, listTickets, loadBoards } from '../tickets/tickets.repo';
import {
  TICKET_NOT_FOUND,
  type TicketActor,
  type TicketsService,
} from '../tickets/tickets.service';

export interface PublicTicketsRoutesOptions {
  db: Database;
  tickets: TicketsService;
  now?: () => Date;
}

const UUID = z.uuid();
const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
};

function uuidOr404(value: string): string {
  if (!UUID.safeParse(value).success)
    throw new AppError('NOT_FOUND', { message: TICKET_NOT_FOUND });
  return value;
}

/** Cakupan organisasi penuh untuk key (scope API sudah diperiksa hook). */
function grantOf(key: ApiKeyPrincipal): PermissionGrant {
  return {
    permission: 'tickets.manage',
    scope: 'all',
    userId: key.id,
    organizationId: key.organizationId,
    principal: 'apiKey',
  };
}

const actorOf = (key: ApiKeyPrincipal): TicketActor => ({
  kind: 'api_key',
  organizationId: key.organizationId,
  apiKeyId: key.id,
});

/**
 * API tiket untuk bot/n8n (Fase 5, docs/KONTRAK-API-CRM-TIKET.md "API publik"): `tickets:read`
 * (cari, detail, board) dan `tickets:write` (buat, ubah/pindah kolom, komentar). Cakupan = SELURUH
 * organisasi pemilik key; aturan bisnis sama dengan web (atribut wajib, penanggung jawab aktif,
 * tautan ke kontak/percakapan organisasi itu). Pelaku = API key (riwayat & webhook `actor` kosong).
 */
export const publicTicketsRoutes: FastifyPluginCallbackZod<PublicTicketsRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { db, tickets } = options;
  const now = options.now ?? (() => new Date());
  const routes = API_ROUTES.publicApi;

  async function respond(key: ApiKeyPrincipal, id: string) {
    const ticket = await findTicket(db, grantOf(key), id, now());
    if (!ticket) throw new AppError('NOT_FOUND', { message: TICKET_NOT_FOUND });
    return { ticket };
  }

  app.get(
    routes.ticketBoards,
    {
      config: { access: requireApiKeyScope('tickets:read') },
      schema: { response: { 200: ticketBoardListResponseSchema, ...errors } },
    },
    async (request) => ({ boards: await loadBoards(db, requireApiKey(request).organizationId) }),
  );

  app.get(
    routes.tickets,
    {
      config: { access: requireApiKeyScope('tickets:read') },
      schema: {
        querystring: ticketListQuerySchema,
        response: { 200: ticketListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const { cursor: rawCursor, limit, ...query } = request.query;
      if (query.assignee === 'me') {
        throw new AppError('VALIDATION_ERROR', {
          message: 'API key tidak punya "me" — pakai ID pengguna atau none.',
        });
      }
      const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
      if (rawCursor !== undefined && !cursor) {
        throw new AppError('VALIDATION_ERROR', { message: 'Kursor halaman tidak valid.' });
      }
      const pageSize = limit ?? TICKET_LIMITS.pageDefault;
      const rows = await listTickets(db, grantOf(key), query, {
        limit: pageSize + 1,
        cursor,
        now: now(),
      });
      const visible = rows.slice(0, pageSize);
      const last = visible.at(-1);
      return {
        tickets: visible.map(({ updatedAtExact: _exact, ...ticket }) => ticket),
        nextCursor:
          rows.length > pageSize && last
            ? encodeCursor({ atExact: last.updatedAtExact, id: last.id })
            : null,
      };
    },
  );

  app.post(
    routes.tickets,
    {
      config: { access: requireApiKeyScope('tickets:write') },
      schema: {
        body: publicCreateTicketRequestSchema,
        response: { 201: ticketResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const key = requireApiKey(request);
      const { columnName, contactPhone, boardId: requestedBoard, ...rest } = request.body;
      const boardId = requestedBoard ?? (await tickets.defaultBoardId(key.organizationId));
      if (!boardId) {
        throw new AppError('CONFLICT', {
          message: 'Belum ada board tiket aktif. Buat board dulu di aplikasi.',
        });
      }
      const columnId =
        rest.columnId ??
        (columnName
          ? await tickets.columnIdByName(key.organizationId, boardId, columnName)
          : undefined);
      const contactId =
        rest.contactId ??
        (contactPhone ? await tickets.contactIdByPhone(key.organizationId, contactPhone) : null);
      const id = await tickets.create(actorOf(key), {
        ...rest,
        boardId,
        ...(columnId ? { columnId } : {}),
        contactId,
      });
      void reply.code(201);
      return respond(key, id);
    },
  );

  app.get(
    routes.ticket,
    {
      config: { access: requireApiKeyScope('tickets:read') },
      schema: { params: ticketIdParamsSchema, response: { 200: ticketResponseSchema, ...errors } },
    },
    async (request) => respond(requireApiKey(request), uuidOr404(request.params.ticketId)),
  );

  app.patch(
    routes.ticket,
    {
      config: { access: requireApiKeyScope('tickets:write') },
      schema: {
        params: ticketIdParamsSchema,
        body: publicUpdateTicketRequestSchema,
        response: { 200: ticketResponseSchema, ...errors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const id = uuidOr404(request.params.ticketId);
      const { columnId, columnName, ...fields } = request.body;
      if (Object.values(fields).some((value) => value !== undefined)) {
        await tickets.update(actorOf(key), id, fields);
      }
      if (columnId !== undefined || columnName !== undefined) {
        const current = await findTicket(db, grantOf(key), id, now());
        if (!current) throw new AppError('NOT_FOUND', { message: TICKET_NOT_FOUND });
        const target =
          columnId ??
          (await tickets.columnIdByName(key.organizationId, current.boardId, columnName ?? ''));
        await tickets.move(actorOf(key), id, { columnId: target });
      }
      return respond(key, id);
    },
  );

  app.post(
    routes.ticketComments,
    {
      config: { access: requireApiKeyScope('tickets:write') },
      schema: {
        params: ticketIdParamsSchema,
        body: createTicketCommentRequestSchema,
        response: { 201: ticketCommentResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const key = requireApiKey(request);
      const id = uuidOr404(request.params.ticketId);
      const commentId = await tickets.addComment(actorOf(key), id, request.body.body);
      const comment = (await tickets.comments(grantOf(key), id))?.find(
        (item) => item.id === commentId,
      );
      if (!comment) throw new AppError('NOT_FOUND', { message: TICKET_NOT_FOUND });
      void reply.code(201);
      return { comment };
    },
  );

  done();
};
