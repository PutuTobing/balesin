import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Template percakapan / quick reply `/` (Fase 2 butir 9). Shortcut unik per organisasi (sudah huruf
 * kecil). `usage_count` dinaikkan setiap dipakai di composer (urutan "paling sering dipakai").
 */
export const quickReplies = pgTable(
  'quick_replies',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    shortcut: text('shortcut').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    usageCount: integer('usage_count').notNull().default(0),
    lastUsedAt: timestamptz('last_used_at'),
    createdByUserId: uuid('created_by_user_id'),
    updatedByUserId: uuid('updated_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('quick_replies_organization_id_shortcut_unique').on(
      table.organizationId,
      table.shortcut,
    ),
    foreignKey({
      name: 'quick_replies_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'quick_replies_organization_id_updated_by_user_id_fk',
      columns: [table.organizationId, table.updatedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check('quick_replies_shortcut_format', sql`${table.shortcut} ~ '^[a-z0-9][a-z0-9_-]{0,31}$'`),
    check(
      'quick_replies_text_lengths',
      sql`char_length(${table.title}) between 1 and 80 and char_length(${table.body}) between 1 and 3500`,
    ),
    check('quick_replies_usage_count_nonnegative', sql`${table.usageCount} >= 0`),
  ],
);

export type QuickReplyRow = typeof quickReplies.$inferSelect;
export type NewQuickReplyRow = typeof quickReplies.$inferInsert;
