import { AppError } from '@balesin/core';
import type { Database } from '@balesin/db';
import {
  API_ROUTES,
  TICKET_LIMITS,
  attributeDefinitionResponseSchema,
  createAttributeDefinitionRequestSchema,
  createTicketBoardRequestSchema,
  createTicketColumnRequestSchema,
  createTicketCommentRequestSchema,
  createTicketRequestSchema,
  deleteTicketColumnRequestSchema,
  errorEnvelopeSchema,
  moveTicketRequestSchema,
  ticketActionResponseSchema,
  ticketBoardAttributeParamsSchema,
  ticketBoardIdParamsSchema,
  ticketBoardListQuerySchema,
  ticketBoardListResponseSchema,
  ticketBoardResponseSchema,
  ticketColumnParamsSchema,
  ticketCommentListResponseSchema,
  ticketCommentParamsSchema,
  ticketCommentResponseSchema,
  ticketEventListResponseSchema,
  ticketIdParamsSchema,
  ticketKanbanQuerySchema,
  ticketKanbanResponseSchema,
  ticketListQuerySchema,
  ticketListResponseSchema,
  ticketResponseSchema,
  updateAttributeDefinitionRequestSchema,
  updateTicketBoardRequestSchema,
  updateTicketColumnRequestSchema,
  updateTicketRequestSchema,
} from '@balesin/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { ATTRIBUTE_NOT_FOUND, type AttributesService } from '../attributes/attributes.service';
import { requireAuth } from '../auth/auth.hook';
import { permissionGrant } from '../auth/permission-grant';
import { decodeCursor, encodeCursor } from '../inbox/inbox.repo';
import { findTicket, kanbanTickets, listTickets, loadBoards } from './tickets.repo';
import {
  BOARD_NOT_FOUND,
  COLUMN_NOT_FOUND,
  TICKET_NOT_FOUND,
  type TicketActor,
  type TicketsService,
} from './tickets.service';

export interface TicketsRoutesOptions {
  db: Database;
  tickets: TicketsService;
  attributes: AttributesService;
  limiter: RateLimiter;
  now?: () => Date;
}

const WRITE_RULE: RateLimitRule = { name: 'tiket-tulis', limit: 120, windowSeconds: 60 };
const CONFIGURE_RULE: RateLimitRule = { name: 'tiket-atur', limit: 60, windowSeconds: 60 };
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
 * Tiket Fase 5 (docs/KONTRAK-API-CRM-TIKET.md "Tiket"). Lihat/ubah = `tickets.manage` (bercakupan:
 * Teknisi = miliknya; pengguna bertanda departemen = departemennya); board/kolom/atribut/hapus tiket
 * = `tickets.configure`. Tulis = CSRF (hook auth).
 */
export const ticketsRoutes: FastifyPluginCallbackZod<TicketsRoutesOptions> = (
  app,
  options,
  done,
) => {
  const { db, tickets, attributes, limiter } = options;
  const now = options.now ?? (() => new Date());
  const routes = API_ROUTES.tickets;
  const MANAGE = requirePermission('tickets.manage');
  const CONFIGURE = requirePermission('tickets.configure');

  const actorOf = (request: FastifyRequest): TicketActor => ({
    kind: 'user',
    auth: requireAuth(request),
    client: clientInfo(request),
  });

  async function write(request: FastifyRequest, rule: RateLimitRule = WRITE_RULE) {
    await enforceRateLimit(limiter, rule, requireAuth(request).user.id, limitMessage);
  }

  async function respond(request: FastifyRequest, ticketId: string) {
    const grant = await permissionGrant(request, 'tickets.manage');
    return { ticket: (await findTicket(db, grant, ticketId, now())) ?? null };
  }

  async function board(request: FastifyRequest, boardId: string) {
    const [found] = await loadBoards(db, requireAuth(request).organizationId, {
      boardId,
      includeArchived: true,
    });
    if (!found) throw new AppError('NOT_FOUND', { message: BOARD_NOT_FOUND });
    return { board: found };
  }

  // ── Tiket ─────────────────────────────────────────────────────────────────

  app.get(
    routes.list,
    {
      config: { access: MANAGE },
      schema: {
        querystring: ticketListQuerySchema,
        response: { 200: ticketListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const grant = await permissionGrant(request, 'tickets.manage');
      const { cursor: rawCursor, limit, ...query } = request.query;
      const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
      if (rawCursor !== undefined && !cursor) {
        throw new AppError('VALIDATION_ERROR', { message: 'Kursor halaman tidak valid.' });
      }
      const pageSize = limit ?? TICKET_LIMITS.pageDefault;
      const rows = await listTickets(db, grant, query, { limit: pageSize + 1, cursor, now: now() });
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
    routes.list,
    {
      config: { access: MANAGE },
      schema: {
        body: createTicketRequestSchema,
        response: { 201: ticketActionResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      await write(request);
      const id = await tickets.create(actorOf(request), request.body);
      void reply.code(201);
      return respond(request, id);
    },
  );

  app.get(
    routes.ticket,
    {
      config: { access: MANAGE },
      schema: { params: ticketIdParamsSchema, response: { 200: ticketResponseSchema, ...errors } },
    },
    async (request) => {
      const id = uuidOr404(request.params.ticketId, TICKET_NOT_FOUND);
      const { ticket } = await respond(request, id);
      if (!ticket) throw new AppError('NOT_FOUND', { message: TICKET_NOT_FOUND });
      return { ticket };
    },
  );

  app.patch(
    routes.ticket,
    {
      config: { access: MANAGE },
      schema: {
        params: ticketIdParamsSchema,
        body: updateTicketRequestSchema,
        response: { 200: ticketActionResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.ticketId, TICKET_NOT_FOUND);
      await write(request);
      await tickets.update(actorOf(request), id, request.body);
      return respond(request, id);
    },
  );

  app.delete(
    routes.ticket,
    {
      config: { access: CONFIGURE },
      schema: {
        params: ticketIdParamsSchema,
        response: { 200: z.object({ deleted: z.literal(true) }), ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.ticketId, TICKET_NOT_FOUND);
      await write(request, CONFIGURE_RULE);
      await tickets.remove(requireAuth(request), id, clientInfo(request));
      return { deleted: true as const };
    },
  );

  app.post(
    routes.move,
    {
      config: { access: MANAGE },
      schema: {
        params: ticketIdParamsSchema,
        body: moveTicketRequestSchema,
        response: { 200: ticketActionResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.ticketId, TICKET_NOT_FOUND);
      await write(request);
      await tickets.move(actorOf(request), id, request.body);
      return respond(request, id);
    },
  );

  app.get(
    routes.comments,
    {
      config: { access: MANAGE },
      schema: {
        params: ticketIdParamsSchema,
        response: { 200: ticketCommentListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.ticketId, TICKET_NOT_FOUND);
      const grant = await permissionGrant(request, 'tickets.manage');
      const comments = await tickets.comments(grant, id);
      if (!comments) throw new AppError('NOT_FOUND', { message: TICKET_NOT_FOUND });
      return { comments };
    },
  );

  app.post(
    routes.comments,
    {
      config: { access: MANAGE },
      schema: {
        params: ticketIdParamsSchema,
        body: createTicketCommentRequestSchema,
        response: { 201: ticketCommentResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const id = uuidOr404(request.params.ticketId, TICKET_NOT_FOUND);
      await write(request);
      const commentId = await tickets.addComment(actorOf(request), id, request.body.body);
      const grant = await permissionGrant(request, 'tickets.manage');
      const comment = (await tickets.comments(grant, id))?.find((item) => item.id === commentId);
      if (!comment) throw new AppError('NOT_FOUND', { message: TICKET_NOT_FOUND });
      void reply.code(201);
      return { comment };
    },
  );

  app.delete(
    routes.comment,
    {
      config: { access: MANAGE },
      schema: {
        params: ticketCommentParamsSchema,
        response: { 200: z.object({ deleted: z.literal(true) }), ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.ticketId, TICKET_NOT_FOUND);
      const commentId = uuidOr404(request.params.commentId, 'Komentar tidak ditemukan.');
      await write(request);
      await tickets.deleteComment(requireAuth(request), id, commentId, clientInfo(request));
      return { deleted: true as const };
    },
  );

  app.get(
    routes.events,
    {
      config: { access: MANAGE },
      schema: {
        params: ticketIdParamsSchema,
        response: { 200: ticketEventListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.ticketId, TICKET_NOT_FOUND);
      const grant = await permissionGrant(request, 'tickets.manage');
      const events = await tickets.events(grant, id);
      if (!events) throw new AppError('NOT_FOUND', { message: TICKET_NOT_FOUND });
      return { events };
    },
  );

  // ── Board ─────────────────────────────────────────────────────────────────

  app.get(
    routes.boards,
    {
      config: { access: MANAGE },
      schema: {
        querystring: ticketBoardListQuerySchema,
        response: { 200: ticketBoardListResponseSchema, ...errors },
      },
    },
    async (request) => ({
      boards: await loadBoards(db, requireAuth(request).organizationId, {
        includeArchived: request.query.archived === true,
      }),
    }),
  );

  app.post(
    routes.boards,
    {
      config: { access: CONFIGURE },
      schema: {
        body: createTicketBoardRequestSchema,
        response: { 201: ticketBoardResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      await write(request, CONFIGURE_RULE);
      const id = await tickets.createBoard(requireAuth(request), request.body, clientInfo(request));
      void reply.code(201);
      return board(request, id);
    },
  );

  app.patch(
    routes.board,
    {
      config: { access: CONFIGURE },
      schema: {
        params: ticketBoardIdParamsSchema,
        body: updateTicketBoardRequestSchema,
        response: { 200: ticketBoardResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.boardId, BOARD_NOT_FOUND);
      await write(request, CONFIGURE_RULE);
      await tickets.updateBoard(requireAuth(request), id, request.body, clientInfo(request));
      return board(request, id);
    },
  );

  app.get(
    routes.kanban,
    {
      config: { access: MANAGE },
      schema: {
        params: ticketBoardIdParamsSchema,
        querystring: ticketKanbanQuerySchema,
        response: { 200: ticketKanbanResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.boardId, BOARD_NOT_FOUND);
      const grant = await permissionGrant(request, 'tickets.manage');
      const { board: found } = await board(request, id);
      const { tickets: rows, totals } = await kanbanTickets(db, grant, id, request.query, now());
      return {
        board: found,
        columns: found.columns.map((column) => ({
          column,
          total: totals.get(column.id) ?? 0,
          tickets: rows
            .filter((ticket) => ticket.column.id === column.id)
            .map(({ updatedAtExact: _exact, ...ticket }) => ticket),
        })),
      };
    },
  );

  app.post(
    routes.columns,
    {
      config: { access: CONFIGURE },
      schema: {
        params: ticketBoardIdParamsSchema,
        body: createTicketColumnRequestSchema,
        response: { 201: ticketBoardResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const id = uuidOr404(request.params.boardId, BOARD_NOT_FOUND);
      await write(request, CONFIGURE_RULE);
      await tickets.createColumn(requireAuth(request), id, request.body, clientInfo(request));
      void reply.code(201);
      return board(request, id);
    },
  );

  app.patch(
    routes.column,
    {
      config: { access: CONFIGURE },
      schema: {
        params: ticketColumnParamsSchema,
        body: updateTicketColumnRequestSchema,
        response: { 200: ticketBoardResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.boardId, BOARD_NOT_FOUND);
      const columnId = uuidOr404(request.params.columnId, COLUMN_NOT_FOUND);
      await write(request, CONFIGURE_RULE);
      await tickets.updateColumn(
        requireAuth(request),
        id,
        columnId,
        request.body,
        clientInfo(request),
      );
      return board(request, id);
    },
  );

  app.delete(
    routes.column,
    {
      config: { access: CONFIGURE },
      schema: {
        params: ticketColumnParamsSchema,
        body: deleteTicketColumnRequestSchema,
        response: { 200: ticketBoardResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.boardId, BOARD_NOT_FOUND);
      const columnId = uuidOr404(request.params.columnId, COLUMN_NOT_FOUND);
      await write(request, CONFIGURE_RULE);
      await tickets.deleteColumn(
        requireAuth(request),
        id,
        columnId,
        request.body.moveToColumnId,
        clientInfo(request),
      );
      return board(request, id);
    },
  );

  app.post(
    routes.attributes,
    {
      config: { access: CONFIGURE },
      schema: {
        params: ticketBoardIdParamsSchema,
        body: createAttributeDefinitionRequestSchema,
        response: { 201: attributeDefinitionResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const id = uuidOr404(request.params.boardId, BOARD_NOT_FOUND);
      await write(request, CONFIGURE_RULE);
      const attribute = await attributes.create(
        requireAuth(request),
        { entity: 'ticket', boardId: id },
        request.body,
        clientInfo(request),
      );
      void reply.code(201);
      return { attribute };
    },
  );

  app.patch(
    routes.attribute,
    {
      config: { access: CONFIGURE },
      schema: {
        params: ticketBoardAttributeParamsSchema,
        body: updateAttributeDefinitionRequestSchema,
        response: { 200: attributeDefinitionResponseSchema, ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.boardId, BOARD_NOT_FOUND);
      const attributeId = uuidOr404(request.params.attributeId, ATTRIBUTE_NOT_FOUND);
      await write(request, CONFIGURE_RULE);
      return {
        attribute: await attributes.update(
          requireAuth(request),
          { entity: 'ticket', boardId: id },
          attributeId,
          request.body,
          clientInfo(request),
        ),
      };
    },
  );

  app.delete(
    routes.attribute,
    {
      config: { access: CONFIGURE },
      schema: {
        params: ticketBoardAttributeParamsSchema,
        response: { 200: z.object({ deleted: z.literal(true) }), ...errors },
      },
    },
    async (request) => {
      const id = uuidOr404(request.params.boardId, BOARD_NOT_FOUND);
      const attributeId = uuidOr404(request.params.attributeId, ATTRIBUTE_NOT_FOUND);
      await write(request, CONFIGURE_RULE);
      await attributes.remove(
        requireAuth(request),
        { entity: 'ticket', boardId: id },
        attributeId,
        clientInfo(request),
      );
      return { deleted: true as const };
    },
  );

  done();
};
