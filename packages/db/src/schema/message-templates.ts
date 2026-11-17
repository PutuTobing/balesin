import type { TemplateContent } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { channels } from './channels';
import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Template pesan WhatsApp (Fase 4, docs/KONTRAK-API-TEMPLATE.md). Template milik WABA; dikelola lewat
 * channel (kredensial). Satu baris = satu (channel, nama, bahasa).
 *
 * - `status` = `DRAFT` (hanya Balesin) atau status Meta; diperbarui sinkron (manual/berkala) dan
 *   webhook `message_template_status_update`.
 * - `content` = format Balesin (`TemplateContent`); `meta_components` = komponen mentah Meta (hasil
 *   sinkron, tanpa data pelanggan) untuk pemeriksaan.
 * - `local_changes` = isi diubah di Balesin dan belum diajukan.
 * Isi template bukan data pribadi pelanggan.
 */
export const messageTemplates = pgTable(
  'message_templates',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id').notNull(),
    wabaId: text('waba_id').notNull(),
    metaTemplateId: text('meta_template_id'),
    name: text('name').notNull(),
    language: text('language').notNull(),
    category: text('category').notNull(),
    status: text('status').notNull().default('DRAFT'),
    rejectedReason: text('rejected_reason'),
    qualityScore: text('quality_score'),
    content: jsonb('content').$type<TemplateContent>().notNull(),
    metaComponents: jsonb('meta_components').$type<Record<string, unknown>[]>(),
    source: text('source').notNull().default('balesin'),
    presetKey: text('preset_key'),
    localChanges: boolean('local_changes').notNull().default(false),
    lastSyncedAt: timestamptz('last_synced_at'),
    submittedAt: timestamptz('submitted_at'),
    statusUpdatedAt: timestamptz('status_updated_at'),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('message_templates_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'message_templates_organization_id_channel_id_fk',
      columns: [table.organizationId, table.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'message_templates_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    uniqueIndex('message_templates_channel_name_language_unique').on(
      table.channelId,
      table.name,
      table.language,
    ),
    index('message_templates_organization_id_status_idx').on(table.organizationId, table.status),
    index('message_templates_waba_meta_id_idx').on(table.wabaId, table.metaTemplateId),
    check(
      'message_templates_category_known',
      sql`${table.category} in ('MARKETING', 'UTILITY', 'AUTHENTICATION')`,
    ),
    check(
      'message_templates_status_known',
      sql`${table.status} in ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION', 'DELETED', 'LIMIT_EXCEEDED', 'ARCHIVED')`,
    ),
    check('message_templates_source_known', sql`${table.source} in ('meta', 'balesin', 'preset')`),
    check(
      'message_templates_name_format',
      sql`${table.name} ~ '^[a-z0-9_]+$' and char_length(${table.name}) <= 512 and char_length(${table.language}) between 2 and 16`,
    ),
    check(
      'message_templates_draft_without_meta',
      sql`${table.status} <> 'DRAFT' or ${table.metaTemplateId} is null`,
    ),
  ],
);

export type MessageTemplateRow = typeof messageTemplates.$inferSelect;
export type NewMessageTemplateRow = typeof messageTemplates.$inferInsert;
