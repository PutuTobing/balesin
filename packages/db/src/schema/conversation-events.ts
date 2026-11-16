import { CONVERSATION_EVENT_KINDS } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgEnum, pgTable, uuid } from 'drizzle-orm/pg-core';

import { apiKeys } from './api-keys';
import { createdAtColumn, idColumn, updatedAtColumn } from './columns';
import { conversations } from './conversations';
import { organizations } from './organizations';
import { users } from './users';

export const conversationEventKind = pgEnum('conversation_event_kind', CONVERSATION_EVENT_KINDS);

/**
 * Riwayat penanganan percakapan (Fase 2 butir 7) — untuk tab "Log" panel detail dan laporan
 * (bukan audit log keamanan). Hanya SIAPA melakukan APA terhadap SIAPA dan KAPAN: tidak pernah isi
 * pesan, nama/nomor pelanggan, atau catatan.
 *
 * - `actor_user_id` = pelaku (`null` = sistem/bot, mis. penugasan otomatis kelak).
 * - `api_key_id` = pelaku API key (lapisan kompatibel MobiChat / bot, Fase 3); tidak pernah bersamaan
 *   dengan `actor_user_id`.
 * - `assignee_user_id` = agen sesudah kejadian; `previous_assignee_user_id` = agen sebelumnya.
 * - Ikut terhapus saat kontak dihapus (UU PDP, `deleteContactData`).
 */
export const conversationEvents = pgTable(
  'conversation_events',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').notNull(),
    kind: conversationEventKind('kind').notNull(),
    actorUserId: uuid('actor_user_id'),
    apiKeyId: uuid('api_key_id'),
    assigneeUserId: uuid('assignee_user_id'),
    previousAssigneeUserId: uuid('previous_assignee_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'conversation_events_organization_id_conversation_id_fk',
      columns: [table.organizationId, table.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'conversation_events_organization_id_actor_user_id_fk',
      columns: [table.organizationId, table.actorUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'conversation_events_organization_id_api_key_id_fk',
      columns: [table.organizationId, table.apiKeyId],
      foreignColumns: [apiKeys.organizationId, apiKeys.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'conversation_events_organization_id_assignee_user_id_fk',
      columns: [table.organizationId, table.assigneeUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'conversation_events_organization_id_previous_assignee_user_id_fk',
      columns: [table.organizationId, table.previousAssigneeUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    index('conversation_events_conversation_id_created_at_idx').on(
      table.conversationId,
      table.createdAt,
    ),
    check(
      'conversation_events_assignment_has_assignee',
      sql`${table.kind} not in ('claimed', 'assigned') or ${table.assigneeUserId} is not null`,
    ),
    check(
      'conversation_events_single_actor',
      sql`${table.actorUserId} is null or ${table.apiKeyId} is null`,
    ),
  ],
);

export type ConversationEventRow = typeof conversationEvents.$inferSelect;
export type NewConversationEventRow = typeof conversationEvents.$inferInsert;
