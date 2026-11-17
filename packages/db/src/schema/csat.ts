import { CSAT_SKIP_REASONS, CSAT_SURVEY_STATUSES } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { organizations } from './organizations';
import { users } from './users';

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/**
 * Pengaturan CSAT per organisasi (Fase 5, docs/KONTRAK-API-LAPORAN.md). Baris tidak ada = bawaan
 * `DEFAULT_CSAT_SETTINGS` (MATI).
 */
export const csatSettings = pgTable(
  'csat_settings',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    enabled: boolean('enabled').notNull().default(false),
    question: text('question').notNull(),
    thanks: text('thanks').notNull(),
    minIntervalHours: integer('min_interval_hours').notNull().default(24),
    /** Terakhir diaktifkan: hanya percakapan yang diselesaikan SETELAH ini yang disurvei. */
    enabledAt: timestamptz('enabled_at'),
    updatedByUserId: uuid('updated_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'csat_settings_organization_id_updated_by_user_id_fk',
      columns: [table.organizationId, table.updatedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check(
      'csat_settings_lengths',
      sql`char_length(${table.question}) between 1 and 300 and char_length(${table.thanks}) between 1 and 300 and ${table.minIntervalHours} between 1 and 720`,
    ),
  ],
);

export type CsatSettingsRow = typeof csatSettings.$inferSelect;

/**
 * Satu survei CSAT per percakapan (sesi) yang ditandai selesai oleh agen. `agent_user_id` = agen
 * pemegang saat diselesaikan (atribusi laporan). `conversation_id`/`contact_id`/`message_id` TANPA FK:
 * hapus kontak (UU PDP) menghapus surveinya lewat `deleteContactData`, laporan tidak menghalangi.
 * Skor & komentar = kiriman pelanggan (tidak tepercaya; komentar dibersihkan, maks. 500).
 */
export const csatSurveys = pgTable(
  'csat_surveys',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    agentUserId: uuid('agent_user_id'),
    resolvedByUserId: uuid('resolved_by_user_id'),
    status: text('status').notNull().default('pending'),
    skipReason: text('skip_reason'),
    score: integer('score'),
    comment: text('comment'),
    messageId: uuid('message_id'),
    thanksMessageId: uuid('thanks_message_id'),
    resolvedAt: timestamptz('resolved_at').notNull(),
    sentAt: timestamptz('sent_at'),
    answeredAt: timestamptz('answered_at'),
    commentedAt: timestamptz('commented_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('csat_surveys_conversation_id_unique').on(table.conversationId),
    index('csat_surveys_organization_id_created_at_idx').on(table.organizationId, table.createdAt),
    // Pengirim berkala: survei yang masih perlu dikerjakan.
    index('csat_surveys_open_idx')
      .on(table.status, table.createdAt)
      .where(sql`${table.status} in ('pending', 'sent', 'answered')`),
    // Anti-spam & komentar: survei terakhir per kontak.
    index('csat_surveys_contact_id_created_at_idx').on(
      table.organizationId,
      table.contactId,
      table.createdAt,
    ),
    foreignKey({
      name: 'csat_surveys_organization_id_agent_user_id_fk',
      columns: [table.organizationId, table.agentUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'csat_surveys_organization_id_resolved_by_user_id_fk',
      columns: [table.organizationId, table.resolvedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check(
      'csat_surveys_status_known',
      sql.raw(
        `status in (${list(CSAT_SURVEY_STATUSES)}) and (skip_reason is null or skip_reason in (${list(CSAT_SKIP_REASONS)})) and ((status = 'skipped') = (skip_reason is not null))`,
      ),
    ),
    check(
      'csat_surveys_score_range',
      sql`(${table.score} is null or ${table.score} between 1 and 5) and (${table.status} <> 'answered' or (${table.score} is not null and ${table.answeredAt} is not null)) and (${table.comment} is null or char_length(${table.comment}) between 1 and 500)`,
    ),
  ],
);

export type CsatSurveyRow = typeof csatSurveys.$inferSelect;
