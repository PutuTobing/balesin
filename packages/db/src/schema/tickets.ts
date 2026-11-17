import { TICKET_EDITABLE_FIELDS, TICKET_EVENT_KINDS, TICKET_PRIORITIES } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { apiKeys } from './api-keys';
import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { contacts } from './contacts';
import { conversations } from './conversations';
import { departments } from './departments';
import { organizations } from './organizations';
import { users } from './users';

export const ticketPriority = pgEnum('ticket_priority', TICKET_PRIORITIES);
export const ticketEventKind = pgEnum('ticket_event_kind', TICKET_EVENT_KINDS);

/**
 * Board tiket = proyek (Fase 5, PRD §3.6). `department_id` = tiket board ini ikut departemen itu
 * (cakupan "akses departemen sendiri"). Diarsipkan, tidak dihapus (tiket & riwayat tetap ada).
 */
export const ticketBoards = pgTable(
  'ticket_boards',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    departmentId: uuid('department_id'),
    position: integer('position').notNull().default(0),
    archivedAt: timestamptz('archived_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('ticket_boards_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'ticket_boards_organization_id_department_id_fk',
      columns: [table.organizationId, table.departmentId],
      foreignColumns: [departments.organizationId, departments.id],
    }).onDelete('restrict'),
    index('ticket_boards_organization_id_position_idx').on(table.organizationId, table.position),
    check(
      'ticket_boards_text_lengths',
      sql`char_length(${table.name}) between 1 and 80 and (${table.description} is null or char_length(${table.description}) between 1 and 300)`,
    ),
  ],
);

export type TicketBoardRow = typeof ticketBoards.$inferSelect;

/** Kolom status board (urut `position`). `is_done` = kolom selesai (tiket diberi `closed_at`). */
export const ticketColumns = pgTable(
  'ticket_columns',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    boardId: uuid('board_id').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    isDone: boolean('is_done').notNull().default(false),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('ticket_columns_organization_id_id_unique').on(table.organizationId, table.id),
    // Sasaran FK tiket (board, kolom): kolom tiket selalu milik board tiketnya.
    unique('ticket_columns_board_id_id_unique').on(table.boardId, table.id),
    foreignKey({
      name: 'ticket_columns_organization_id_board_id_fk',
      columns: [table.organizationId, table.boardId],
      foreignColumns: [ticketBoards.organizationId, ticketBoards.id],
    }).onDelete('restrict'),
    index('ticket_columns_board_id_position_idx').on(table.boardId, table.position),
    check('ticket_columns_name_length', sql`char_length(${table.name}) between 1 and 40`),
  ],
);

export type TicketColumnRow = typeof ticketColumns.$inferSelect;

/**
 * Tiket (Fase 5). `contact_id` SELALU diisi bila `conversation_id` diisi (kontak percakapan itu) —
 * dasar cakupan Teknisi "percakapan terkait tiketnya": tiket TERBUKA (`closed_at` kosong) yang ia
 * pegang memberi akses ke percakapan kontak tautannya. `number` = nomor publik berurutan.
 * Hapus kontak (UU PDP) mengosongkan tautan kontak/percakapan (isi tiket = data internal tim).
 */
export const tickets = pgTable(
  'tickets',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    number: bigint('number', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    boardId: uuid('board_id').notNull(),
    columnId: uuid('column_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    priority: ticketPriority('priority').notNull().default('normal'),
    assigneeUserId: uuid('assignee_user_id'),
    dueAt: timestamptz('due_at'),
    contactId: uuid('contact_id'),
    conversationId: uuid('conversation_id'),
    attributes: jsonb('attributes')
      .$type<{ key: string; value: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    position: doublePrecision('position').notNull().default(0),
    closedAt: timestamptz('closed_at'),
    createdByUserId: uuid('created_by_user_id'),
    createdByApiKeyId: uuid('created_by_api_key_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('tickets_organization_id_id_unique').on(table.organizationId, table.id),
    unique('tickets_number_unique').on(table.number),
    foreignKey({
      name: 'tickets_organization_id_board_id_fk',
      columns: [table.organizationId, table.boardId],
      foreignColumns: [ticketBoards.organizationId, ticketBoards.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tickets_board_id_column_id_fk',
      columns: [table.boardId, table.columnId],
      foreignColumns: [ticketColumns.boardId, ticketColumns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tickets_organization_id_assignee_user_id_fk',
      columns: [table.organizationId, table.assigneeUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tickets_organization_id_contact_id_fk',
      columns: [table.organizationId, table.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tickets_organization_id_conversation_id_fk',
      columns: [table.organizationId, table.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tickets_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'tickets_organization_id_created_by_api_key_id_fk',
      columns: [table.organizationId, table.createdByApiKeyId],
      foreignColumns: [apiKeys.organizationId, apiKeys.id],
    }).onDelete('restrict'),
    index('tickets_board_column_position_idx').on(
      table.organizationId,
      table.boardId,
      table.columnId,
      table.position,
    ),
    index('tickets_organization_id_updated_at_idx').on(
      table.organizationId,
      table.updatedAt,
      table.id,
    ),
    // Cakupan "terkait tiketnya" (dipakai setiap query inbox Teknisi).
    index('tickets_open_assignee_contact_idx')
      .on(table.organizationId, table.assigneeUserId, table.contactId)
      .where(sql`${table.closedAt} is null`),
    index('tickets_organization_id_contact_id_idx').on(table.organizationId, table.contactId),
    index('tickets_organization_id_conversation_id_idx').on(
      table.organizationId,
      table.conversationId,
    ),
    check(
      'tickets_conversation_has_contact',
      sql`${table.conversationId} is null or ${table.contactId} is not null`,
    ),
    check(
      'tickets_single_creator',
      sql`${table.createdByUserId} is null or ${table.createdByApiKeyId} is null`,
    ),
    check(
      'tickets_text_lengths',
      sql`char_length(${table.title}) between 1 and 200 and (${table.description} is null or char_length(${table.description}) between 1 and 5000) and jsonb_typeof(${table.attributes}) = 'array' and jsonb_array_length(${table.attributes}) <= 30 and octet_length(${table.attributes}::text) <= 65536`,
    ),
  ],
);

export type TicketRow = typeof tickets.$inferSelect;

/** Komentar tiket (internal tim / bot). Ikut terhapus bersama tiket. */
export const ticketComments = pgTable(
  'ticket_comments',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    ticketId: uuid('ticket_id').notNull(),
    body: text('body').notNull(),
    authorUserId: uuid('author_user_id'),
    authorApiKeyId: uuid('author_api_key_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'ticket_comments_organization_id_ticket_id_fk',
      columns: [table.organizationId, table.ticketId],
      foreignColumns: [tickets.organizationId, tickets.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ticket_comments_organization_id_author_user_id_fk',
      columns: [table.organizationId, table.authorUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ticket_comments_organization_id_author_api_key_id_fk',
      columns: [table.organizationId, table.authorApiKeyId],
      foreignColumns: [apiKeys.organizationId, apiKeys.id],
    }).onDelete('restrict'),
    index('ticket_comments_ticket_id_created_at_idx').on(table.ticketId, table.createdAt),
    check('ticket_comments_body_length', sql`char_length(${table.body}) between 1 and 5000`),
    check(
      'ticket_comments_single_author',
      sql`${table.authorUserId} is null or ${table.authorApiKeyId} is null`,
    ),
  ],
);

export type TicketCommentRow = typeof ticketComments.$inferSelect;

const ticketFieldList = TICKET_EDITABLE_FIELDS.map((field) => `'${field}'`).join(', ');

/**
 * Riwayat tiket — TANPA isi (judul/deskripsi/komentar/nilai atribut): hanya nama isian, nama kolom
 * saat kejadian, dan penanggung jawab. Ikut terhapus bersama tiket.
 */
export const ticketEvents = pgTable(
  'ticket_events',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    ticketId: uuid('ticket_id').notNull(),
    kind: ticketEventKind('kind').notNull(),
    actorUserId: uuid('actor_user_id'),
    apiKeyId: uuid('api_key_id'),
    fields: text('fields').array(),
    fromColumn: text('from_column'),
    toColumn: text('to_column'),
    assigneeUserId: uuid('assignee_user_id'),
    previousAssigneeUserId: uuid('previous_assignee_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'ticket_events_organization_id_ticket_id_fk',
      columns: [table.organizationId, table.ticketId],
      foreignColumns: [tickets.organizationId, tickets.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'ticket_events_organization_id_actor_user_id_fk',
      columns: [table.organizationId, table.actorUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ticket_events_organization_id_api_key_id_fk',
      columns: [table.organizationId, table.apiKeyId],
      foreignColumns: [apiKeys.organizationId, apiKeys.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ticket_events_organization_id_assignee_user_id_fk',
      columns: [table.organizationId, table.assigneeUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'ticket_events_organization_id_previous_assignee_user_id_fk',
      columns: [table.organizationId, table.previousAssigneeUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    index('ticket_events_ticket_id_created_at_idx').on(table.ticketId, table.createdAt),
    check(
      'ticket_events_single_actor',
      sql`${table.actorUserId} is null or ${table.apiKeyId} is null`,
    ),
    check(
      'ticket_events_update_has_fields',
      sql.raw(
        `kind <> 'updated' or (fields is not null and cardinality(fields) between 1 and 7 and fields <@ array[${ticketFieldList}]::text[])`,
      ),
    ),
  ],
);

export type TicketEventRow = typeof ticketEvents.$inferSelect;
