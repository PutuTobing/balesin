import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { apiKeys } from './api-keys';
import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { conversations } from './conversations';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Catatan sesi (Fase 2 butir 8): catatan INTERNAL per percakapan, tidak pernah terkirim ke pelanggan.
 * Isinya tidak pernah ditulis ke log/audit/event real-time. Ikut terhapus saat kontak dihapus.
 * Penulis = pengguna (`author_user_id`) ATAU API key (`api_key_id`, catatan dari bot lewat lapisan
 * kompatibel MobiChat) — tepat salah satu.
 */
export const conversationNotes = pgTable(
  'conversation_notes',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').notNull(),
    authorUserId: uuid('author_user_id'),
    apiKeyId: uuid('api_key_id'),
    body: text('body').notNull(),
    /** Terakhir diubah isinya (bukan `updated_at` yang ikut berubah oleh hal lain). */
    editedAt: timestamptz('edited_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'conversation_notes_organization_id_conversation_id_fk',
      columns: [table.organizationId, table.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'conversation_notes_organization_id_author_user_id_fk',
      columns: [table.organizationId, table.authorUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'conversation_notes_organization_id_api_key_id_fk',
      columns: [table.organizationId, table.apiKeyId],
      foreignColumns: [apiKeys.organizationId, apiKeys.id],
    }).onDelete('restrict'),
    index('conversation_notes_conversation_id_created_at_idx').on(
      table.conversationId,
      table.createdAt,
    ),
    check('conversation_notes_body_length', sql`char_length(${table.body}) between 1 and 2000`),
    check(
      'conversation_notes_single_author',
      sql`(${table.authorUserId} is null) <> (${table.apiKeyId} is null)`,
    ),
  ],
);

export type ConversationNoteRow = typeof conversationNotes.$inferSelect;
export type NewConversationNoteRow = typeof conversationNotes.$inferInsert;
