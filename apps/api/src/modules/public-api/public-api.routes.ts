import { createHash } from 'node:crypto';

import multipart from '@fastify/multipart';
import { AppError } from '@balesin/core';
import { contacts, messages, type Database } from '@balesin/db';
import {
  API_ROUTES,
  INBOX_PAGE_DEFAULT,
  MAX_UPLOAD_BYTES,
  contactIdParamsSchema,
  contactResponseSchema,
  conversationIdParamsSchema,
  conversationListQuerySchema,
  conversationListResponseSchema,
  conversationResponseSchema,
  errorEnvelopeSchema,
  idempotencyKeyHeaderSchema,
  messageIdParamsSchema,
  messageListQuerySchema,
  messageListResponseSchema,
  messageResponseSchema,
  publicContactSearchQuerySchema,
  publicContactTagsRequestSchema,
  publicCreateContactRequestSchema,
  publicSendMessageRequestSchema,
  updateContactRequestSchema,
  uploadMediaResponseSchema,
  type SendMessageRequest,
} from '@balesin/shared';
import { and, desc, eq, ilike, or, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { clientInfo } from '../../http/client-info';
import { requireApiKeyScope } from '../../http/route-access';
import { requireApiKey, type ApiKeyPrincipal } from '../api-keys/api-key-auth';
import type { PermissionGrant } from '../auth/permission-grant';
import type { ContactsService } from '../contacts/contacts.service';
import {
  contactTagsOf,
  conversationExtras,
  decodeCursor,
  encodeCursor,
  findContact,
  findConversation,
  likePattern,
  listConversations,
  listMessages,
  senderNameOf,
  type Cursor,
} from '../inbox/inbox.repo';
import { toContact, toConversation, toMessage } from '../inbox/inbox-view';
import type { OutboundService } from '../messages/outbound.service';

export interface PublicApiRoutesOptions {
  db: Database;
  outbound: OutboundService;
  contacts: ContactsService;
  now?: () => Date;
}

/**
 * API publik v1 (Fase 3, docs/KONTRAK-API-PUBLIK.md). `Authorization: Bearer blsn_live_…`; scope per
 * rute lewat `requireApiKeyScope` (hook auth). Cakupan data = SELURUH organisasi pemilik key; aturan
 * bisnis sama dengan web: jendela 24 jam, rem darurat & batas kirim (harian PER KEY), validasi media.
 * Tidak ada cookie/CSRF — browser lintas origin ditolak hook (Origin asing pada metode tulis).
 */

const UUID = z.uuid();
const CONVERSATION_NOT_FOUND = 'Percakapan tidak ditemukan.';
const MESSAGE_NOT_FOUND = 'Pesan tidak ditemukan.';
const CONTACT_NOT_FOUND = 'Kontak tidak ditemukan.';

const errors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
  413: errorEnvelopeSchema,
  415: errorEnvelopeSchema,
  423: errorEnvelopeSchema,
  429: errorEnvelopeSchema,
  503: errorEnvelopeSchema,
};

function uuidOr404(value: string, message: string): string {
  if (!UUID.safeParse(value).success) throw new AppError('NOT_FOUND', { message });
  return value;
}

/** Cakupan organisasi penuh untuk key (scope API sudah diperiksa di hook). */
function grantOf(key: ApiKeyPrincipal): PermissionGrant {
  return {
    permission: 'inbox.view',
    scope: 'all',
    userId: key.id,
    organizationId: key.organizationId,
  };
}

function cursorOf(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  const cursor = decodeCursor(value);
  if (!cursor) {
    throw new AppError('VALIDATION_ERROR', { message: 'Kursor halaman tidak valid.' });
  }
  return cursor;
}

/**
 * `Idempotency-Key` → UUID tetap per key (versi 8, dari SHA-256). Tanpa header → UUID acak
 * (permintaan yang diulang klien bisa menggandakan pesan).
 */
export function clientMessageIdFor(apiKeyId: string, idempotencyKey: string | undefined): string {
  if (!idempotencyKey) return crypto.randomUUID();
  const hex = createHash('sha256').update(`${apiKeyId}\u0000${idempotencyKey}`).digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const publicApiRoutes: FastifyPluginAsyncZod<PublicApiRoutesOptions> = async (
  app,
  options,
) => {
  const { db, outbound } = options;
  const contactsService = options.contacts;
  const now = options.now ?? (() => new Date());
  const routes = API_ROUTES.publicApi;

  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1, fieldNameSize: 32 },
  });

  async function contactView(key: ApiKeyPrincipal, contactId: string) {
    const row = await findContact(db, { ...grantOf(key), permission: 'contacts.view' }, contactId);
    if (!row) throw new AppError('NOT_FOUND', { message: CONTACT_NOT_FOUND });
    const tagsByContact = await contactTagsOf(db, key.organizationId, [row.id]);
    return { contact: toContact(row, tagsByContact.get(row.id) ?? []) };
  }

  // ── Percakapan ────────────────────────────────────────────────────────────

  app.get(
    routes.conversations,
    {
      config: { access: requireApiKeyScope('conversations:read') },
      schema: {
        querystring: conversationListQuerySchema,
        response: { 200: conversationListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const { cursor, limit, ...filter } = request.query;
      const pageSize = limit ?? INBOX_PAGE_DEFAULT;
      const rows = await listConversations(db, grantOf(key), filter, {
        limit: pageSize + 1,
        cursor: cursorOf(cursor),
        now: now(),
      });
      const visible = rows.slice(0, pageSize);
      const extras = await conversationExtras(db, key.organizationId, visible);
      const at = now();
      const last = visible.at(-1);
      return {
        conversations: visible.map((row) =>
          toConversation(
            row,
            extras.lastMessages.get(row.id),
            at,
            extras.tags.get(row.contact.id) ?? [],
          ),
        ),
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
      config: { access: requireApiKeyScope('conversations:read') },
      schema: {
        params: conversationIdParamsSchema,
        response: { 200: conversationResponseSchema, ...errors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const id = uuidOr404(request.params.conversationId, CONVERSATION_NOT_FOUND);
      const row = await findConversation(db, grantOf(key), id);
      if (!row) throw new AppError('NOT_FOUND', { message: CONVERSATION_NOT_FOUND });
      const extras = await conversationExtras(db, key.organizationId, [row]);
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

  // ── Pesan ─────────────────────────────────────────────────────────────────

  app.get(
    routes.messages,
    {
      config: { access: requireApiKeyScope('messages:read') },
      schema: {
        params: conversationIdParamsSchema,
        querystring: messageListQuerySchema,
        response: { 200: messageListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const id = uuidOr404(request.params.conversationId, CONVERSATION_NOT_FOUND);
      const conversation = await findConversation(db, grantOf(key), id);
      if (!conversation) throw new AppError('NOT_FOUND', { message: CONVERSATION_NOT_FOUND });
      const pageSize = request.query.limit ?? INBOX_PAGE_DEFAULT;
      const rows = await listMessages(db, key.organizationId, conversation.id, {
        limit: pageSize + 1,
        cursor: cursorOf(request.query.cursor),
        only: request.query.only,
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

  app.post(
    routes.messages,
    {
      config: { access: requireApiKeyScope('messages:send') },
      schema: {
        params: conversationIdParamsSchema,
        headers: idempotencyKeyHeaderSchema,
        body: publicSendMessageRequestSchema,
        response: { 200: messageResponseSchema, 202: messageResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const key = requireApiKey(request);
      const id = uuidOr404(request.params.conversationId, CONVERSATION_NOT_FOUND);
      const input = {
        ...request.body,
        clientMessageId: clientMessageIdFor(key.id, request.headers['idempotency-key']),
      } satisfies SendMessageRequest;
      const { message, created } = await outbound.sendAsApiKey(
        {
          organizationId: key.organizationId,
          apiKeyId: key.id,
          dailySendLimit: key.dailySendLimit,
        },
        id,
        input,
        clientInfo(request),
      );
      void reply.code(created ? 202 : 200);
      return { message: toMessage(message) };
    },
  );

  app.post(
    routes.upload,
    {
      config: { access: requireApiKeyScope('messages:send') },
      schema: {
        params: conversationIdParamsSchema,
        response: { 201: uploadMediaResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const key = requireApiKey(request);
      const id = uuidOr404(request.params.conversationId, CONVERSATION_NOT_FOUND);
      const part = await request.file();
      if (!part) {
        throw new AppError('VALIDATION_ERROR', { message: 'Kirim satu berkas di isian "file".' });
      }
      const media = await outbound.uploadAsApiKey(
        {
          organizationId: key.organizationId,
          apiKeyId: key.id,
          dailySendLimit: key.dailySendLimit,
        },
        id,
        {
          stream: part.file,
          filename: part.filename || null,
          truncated: () => part.file.truncated,
        },
      );
      void reply.code(201);
      return { media };
    },
  );

  app.get(
    routes.message,
    {
      config: { access: requireApiKeyScope('messages:read') },
      schema: {
        params: messageIdParamsSchema,
        response: { 200: messageResponseSchema, ...errors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const id = uuidOr404(request.params.messageId, MESSAGE_NOT_FOUND);
      const [row] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.organizationId, key.organizationId), eq(messages.id, id)))
        .limit(1);
      if (!row) throw new AppError('NOT_FOUND', { message: MESSAGE_NOT_FOUND });
      return {
        message: toMessage({
          ...row,
          occurredAtExact: row.occurredAt.toISOString(),
          senderName: await senderNameOf(db, row),
        }),
      };
    },
  );

  // ── Kontak ────────────────────────────────────────────────────────────────

  app.get(
    routes.contacts,
    {
      config: { access: requireApiKeyScope('contacts:read') },
      schema: {
        querystring: publicContactSearchQuerySchema,
        response: {
          200: z.object({ contacts: z.array(contactResponseSchema.shape.contact) }),
          ...errors,
        },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const { q, phone, limit } = request.query;
      const conditions: SQL[] = [eq(contacts.organizationId, key.organizationId)];
      if (phone) conditions.push(eq(contacts.phone, phone));
      if (q) {
        const pattern = likePattern(q);
        conditions.push(
          or(
            ilike(contacts.name, pattern),
            ilike(contacts.profileName, pattern),
            ilike(contacts.waUsername, pattern),
            ilike(contacts.phone, pattern),
          ) as SQL,
        );
      }
      const rows = await db
        .select()
        .from(contacts)
        .where(and(...conditions))
        .orderBy(desc(contacts.createdAt), desc(contacts.id))
        .limit(limit ?? 20);
      const tagsByContact = await contactTagsOf(
        db,
        key.organizationId,
        rows.map((row) => row.id),
      );
      return { contacts: rows.map((row) => toContact(row, tagsByContact.get(row.id) ?? [])) };
    },
  );

  app.post(
    routes.contacts,
    {
      config: { access: requireApiKeyScope('contacts:write') },
      schema: {
        body: publicCreateContactRequestSchema,
        response: { 200: contactResponseSchema, 201: contactResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      const key = requireApiKey(request);
      const { id, created } = await contactsService.createFromApi(key.organizationId, request.body);
      void reply.code(created ? 201 : 200);
      return contactView(key, id);
    },
  );

  app.get(
    routes.contact,
    {
      config: { access: requireApiKeyScope('contacts:read') },
      schema: {
        params: contactIdParamsSchema,
        response: { 200: contactResponseSchema, ...errors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      return contactView(key, uuidOr404(request.params.contactId, CONTACT_NOT_FOUND));
    },
  );

  app.patch(
    routes.contact,
    {
      config: { access: requireApiKeyScope('contacts:write') },
      schema: {
        params: contactIdParamsSchema,
        body: updateContactRequestSchema,
        response: { 200: contactResponseSchema, ...errors },
      },
    },
    async (request) => {
      const key = requireApiKey(request);
      const id = uuidOr404(request.params.contactId, CONTACT_NOT_FOUND);
      await contactsService.updateFromApi(key.organizationId, id, request.body);
      return contactView(key, id);
    },
  );

  for (const [method, operation] of [
    ['POST', 'add'],
    ['DELETE', 'remove'],
  ] as const) {
    app.route({
      method,
      url: routes.contactTags,
      config: { access: requireApiKeyScope('contacts:write') },
      schema: {
        params: contactIdParamsSchema,
        body: publicContactTagsRequestSchema,
        response: { 200: contactResponseSchema, ...errors },
      },
      handler: async (request) => {
        const key = requireApiKey(request);
        const id = uuidOr404(request.params.contactId, CONTACT_NOT_FOUND);
        await contactsService.tagsByNameFromApi(
          key.organizationId,
          id,
          request.body.tags,
          operation,
        );
        return contactView(key, id);
      },
    });
  }
};
