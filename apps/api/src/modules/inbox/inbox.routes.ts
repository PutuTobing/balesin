import { AppError } from '@balesin/core';
import { PG_ERROR_CODES, getPgError, type Database, type DbExecutor } from '@balesin/db';
import {
  API_ROUTES,
  INBOX_PAGE_DEFAULT,
  contactIdParamsSchema,
  contactResponseSchema,
  conversationIdParamsSchema,
  conversationListQuerySchema,
  conversationListResponseSchema,
  conversationResponseSchema,
  errorEnvelopeSchema,
  messageListQuerySchema,
  messageListResponseSchema,
} from '@balesin/shared';
import { sql } from 'drizzle-orm';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import { requirePermission } from '../../http/route-access';
import { permissionGrant } from '../auth/permission-grant';
import {
  decodeCursor,
  encodeCursor,
  findContact,
  findConversation,
  lastMessagesOf,
  listConversations,
  listMessages,
  type Cursor,
} from './inbox.repo';
import { toContact, toConversation, toMessage } from './inbox-view';

export interface InboxRoutesOptions {
  db: Database;
  limiter: RateLimiter;
  now?: () => Date;
  /** Batas waktu query pencarian (bawaan `SEARCH_TIMEOUT_MS`). */
  searchTimeoutMs?: number;
}

/**
 * Batas laju per pengguna (review kontak R3): daftar dimuat ulang oleh web secara wajar (polling,
 * ganti tab), pencarian `ILIKE` jauh lebih mahal sehingga punya ember sendiri yang lebih ketat.
 */
export const INBOX_LIST_RULE: RateLimitRule = {
  name: 'inbox-daftar',
  limit: 240,
  windowSeconds: 60,
};
export const INBOX_SEARCH_RULE: RateLimitRule = {
  name: 'inbox-cari',
  limit: 60,
  windowSeconds: 60,
};

/** `statement_timeout` lokal untuk query pencarian: pencarian lambat tidak menahan koneksi DB. */
export const SEARCH_TIMEOUT_MS = 3_000;

const listLimitMessage = (wait: string) =>
  `Daftar percakapan dimuat terlalu sering. Coba lagi dalam ${wait}.`;
const searchLimitMessage = (wait: string) =>
  `Terlalu banyak pencarian dalam waktu singkat. Coba lagi dalam ${wait}.`;
const SEARCH_TOO_SLOW = 'Pencarian terlalu lama. Persempit kata kuncinya lalu coba lagi.';

/**
 * Menjalankan `work` di transaksi dengan `statement_timeout` lokal (`SET LOCAL`, hanya transaksi
 * ini). Query yang dibatalkan Postgres (57014) → 503 dengan pesan yang bisa ditindaklanjuti.
 */
export async function withStatementTimeout<T>(
  db: Database,
  timeoutMs: number,
  work: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`set local statement_timeout = ${String(Math.max(1, Math.floor(timeoutMs)))}`),
      );
      return work(tx);
    });
  } catch (error) {
    if (getPgError(error)?.code === PG_ERROR_CODES.queryCanceled) {
      throw new AppError('SERVICE_UNAVAILABLE', { message: SEARCH_TOO_SLOW });
    }
    throw error;
  }
}

/**
 * Inbox — baca saja (Fase 2 butir 4, docs/KONTRAK-API-INBOX.md).
 *
 * - `GET /conversations`                  daftar: tab (status), channel, cari, kursor
 * - `GET /conversations/:conversationId`  satu percakapan
 * - `GET /conversations/:conversationId/messages` pesan, terbaru dulu (kursor = lebih lama)
 * - `GET /contacts/:contactId`            satu kontak
 *
 * PRD §4: "Lihat semua percakapan" = `inbox.view` (Teknisi: hanya yang di-assign); "Lihat & ubah
 * kontak" = `contacts.view` (Teknisi: kontak terkait percakapannya). Cakupan disaring di SQL; data di
 * luar cakupan, ID tak dikenal, dan ID bukan UUID semuanya 404 yang sama.
 */
const VIEW_INBOX = requirePermission('inbox.view');
const VIEW_CONTACTS = requirePermission('contacts.view');

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

const UUID = z.uuid();
const CONVERSATION_NOT_FOUND = 'Percakapan tidak ditemukan.';
const CONTACT_NOT_FOUND = 'Kontak tidak ditemukan.';

function notFound(message: string): AppError {
  return new AppError('NOT_FOUND', { message });
}

/** Bukan UUID → 404 yang sama dengan ID tak dikenal (Postgres tidak pernah menerima teks lain). */
function requireUuid(value: string, message: string): string {
  if (!UUID.safeParse(value).success) throw notFound(message);
  return value;
}

function cursorOf(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  const cursor = decodeCursor(value);
  if (!cursor) {
    throw new AppError('VALIDATION_ERROR', {
      message: 'Kursor halaman tidak valid. Muat ulang daftar dari awal.',
      details: [{ location: 'query', field: 'cursor', message: 'Kursor halaman tidak valid.' }],
    });
  }
  return cursor;
}

export const inboxRoutes: FastifyPluginCallbackZod<InboxRoutesOptions> = (app, options, done) => {
  const { db, limiter } = options;
  const now = options.now ?? (() => new Date());
  const searchTimeoutMs = options.searchTimeoutMs ?? SEARCH_TIMEOUT_MS;
  const routes = API_ROUTES.inbox;

  app.get(
    routes.conversations,
    {
      config: { access: VIEW_INBOX },
      schema: {
        querystring: conversationListQuerySchema,
        response: { 200: conversationListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const grant = await permissionGrant(request, 'inbox.view');
      const { cursor, limit, ...filter } = request.query;
      const pageSize = limit ?? INBOX_PAGE_DEFAULT;
      const page = { limit: pageSize + 1, cursor: cursorOf(cursor) };
      await enforceRateLimit(limiter, INBOX_LIST_RULE, grant.userId, listLimitMessage);
      let rows;
      if (filter.q === undefined) {
        rows = await listConversations(db, grant, filter, page);
      } else {
        await enforceRateLimit(limiter, INBOX_SEARCH_RULE, grant.userId, searchLimitMessage);
        rows = await withStatementTimeout(db, searchTimeoutMs, (tx) =>
          listConversations(tx, grant, filter, page),
        );
      }
      const visible = rows.slice(0, pageSize);
      const lastMessages = await lastMessagesOf(
        db,
        grant.organizationId,
        visible.map((row) => row.id),
      );
      const at = now();
      const last = visible.at(-1);
      return {
        conversations: visible.map((row) => toConversation(row, lastMessages.get(row.id), at)),
        nextCursor:
          rows.length > pageSize && last
            ? encodeCursor({ atExact: last.lastMessageAtExact, id: last.id })
            : null,
      };
    },
  );

  app.get(
    routes.conversation,
    {
      config: { access: VIEW_INBOX },
      schema: {
        params: conversationIdParamsSchema,
        response: { 200: conversationResponseSchema, ...errors },
      },
    },
    async (request) => {
      const grant = await permissionGrant(request, 'inbox.view');
      const id = requireUuid(request.params.conversationId, CONVERSATION_NOT_FOUND);
      const row = await findConversation(db, grant, id);
      if (!row) throw notFound(CONVERSATION_NOT_FOUND);
      const lastMessages = await lastMessagesOf(db, grant.organizationId, [row.id]);
      return { conversation: toConversation(row, lastMessages.get(row.id), now()) };
    },
  );

  app.get(
    routes.messages,
    {
      config: { access: VIEW_INBOX },
      schema: {
        params: conversationIdParamsSchema,
        querystring: messageListQuerySchema,
        response: { 200: messageListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const grant = await permissionGrant(request, 'inbox.view');
      const id = requireUuid(request.params.conversationId, CONVERSATION_NOT_FOUND);
      const cursor = cursorOf(request.query.cursor);
      // Cakupan diperiksa lewat percakapannya: di luar cakupan = 404, pesan tidak pernah dibaca.
      const conversation = await findConversation(db, grant, id);
      if (!conversation) throw notFound(CONVERSATION_NOT_FOUND);
      const pageSize = request.query.limit ?? INBOX_PAGE_DEFAULT;
      const rows = await listMessages(db, grant.organizationId, conversation.id, {
        limit: pageSize + 1,
        cursor,
      });
      const page = rows.slice(0, pageSize);
      const last = page.at(-1);
      return {
        messages: page.map(toMessage),
        nextCursor:
          rows.length > pageSize && last
            ? encodeCursor({ atExact: last.occurredAtExact, id: last.id })
            : null,
      };
    },
  );

  app.get(
    routes.contact,
    {
      config: { access: VIEW_CONTACTS },
      schema: {
        params: contactIdParamsSchema,
        response: { 200: contactResponseSchema, ...errors },
      },
    },
    async (request) => {
      const grant = await permissionGrant(request, 'contacts.view');
      const id = requireUuid(request.params.contactId, CONTACT_NOT_FOUND);
      const row = await findContact(db, grant, id);
      if (!row) throw notFound(CONTACT_NOT_FOUND);
      return { contact: toContact(row) };
    },
  );

  done();
};
