import {
  EMAIL_FAILURE_REASONS,
  EMAIL_OUTBOUND_SOURCES,
  EMAIL_OUTBOUND_STATUSES,
  EMAIL_SENDER_BLOCKED_REASONS,
  EMAIL_TEMPLATE_VERSION_STATES,
  type EmailBounce,
  type EmailTemplateVariable,
} from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { apiKeys } from './api-keys';
import { channels } from './channels';
import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { contacts } from './contacts';
import { mailAccounts } from './mail';
import { conversations } from './conversations';
import { messages } from './messages';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Tahap 9.1 — kirim email lewat API untuk n8n/billing (docs/KONTRAK-API-EMAIL-KIRIM.md §9).
 *
 *  - `email_templates` + `email_template_versions`: template email (draf = versi 0, `draft`; versi
 *    terbit ≥ 1). Template tidak pernah dihapus (diarsip).
 *  - `email_outbound`: SATU baris per email (catatan kirim, antrean worker, idempotensi). Worker
 *    `email-outbound` memolling tabel ini (pola outbox) — api tidak bergantung pada Redis.
 *  - `email_outbound_attachments`: berkas di media store (`email-out/…`), termasuk QRIS & logo.
 *  - `email_sender_settings`: batas per jam + keadaan pengirim (dibuat malas; tanpa baris = `ok`).
 *  - `api_key_email_senders`: pengirim yang boleh dipakai sebuah API key.
 *
 * Isi email/subjek/variabel/metadata TIDAK PERNAH di-log; isi & lampiran dipangkas 30 hari setelah
 * status final, baris dihapus setelah 180 hari.
 */

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

export interface EmailRecipientRow {
  email: string;
  name: string | null;
}

export const emailTemplates = pgTable(
  'email_templates',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    presetKey: text('preset_key'),
    publishedVersion: integer('published_version'),
    archivedAt: timestamptz('archived_at'),
    lastUsedAt: timestamptz('last_used_at'),
    createdByUserId: uuid('created_by_user_id'),
    updatedByUserId: uuid('updated_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('email_templates_organization_id_id_unique').on(table.organizationId, table.id),
    unique('email_templates_organization_id_slug_unique').on(table.organizationId, table.slug),
    index('email_templates_organization_id_archived_at_name_idx').on(
      table.organizationId,
      table.archivedAt,
      table.name,
    ),
    foreignKey({
      name: 'email_templates_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'email_templates_organization_id_updated_by_user_id_fk',
      columns: [table.organizationId, table.updatedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check(
      'email_templates_text_lengths',
      sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(${table.slug}) between 2 and 64 and char_length(${table.name}) between 1 and 80 and (${table.description} is null or char_length(${table.description}) <= 200) and (${table.presetKey} is null or char_length(${table.presetKey}) <= 64) and (${table.publishedVersion} is null or ${table.publishedVersion} >= 1)`,
    ),
  ],
);

export type EmailTemplateRow = typeof emailTemplates.$inferSelect;

export const emailTemplateVersions = pgTable(
  'email_template_versions',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    templateId: uuid('template_id').notNull(),
    /** Draf = `0`; versi terbit 1, 2, … */
    version: integer('version').notNull(),
    state: text('state').notNull(),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    text: text('text'),
    variables: jsonb('variables').$type<EmailTemplateVariable[]>().notNull(),
    layout: text('layout').notNull(),
    footerText: text('footer_text'),
    createdByUserId: uuid('created_by_user_id'),
    publishedByUserId: uuid('published_by_user_id'),
    publishedAt: timestamptz('published_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('email_template_versions_template_id_version_unique').on(
      table.templateId,
      table.version,
    ),
    uniqueIndex('email_template_versions_one_draft')
      .on(table.templateId)
      .where(sql`${table.state} = 'draft'`),
    foreignKey({
      name: 'email_template_versions_organization_id_template_id_fk',
      columns: [table.organizationId, table.templateId],
      foreignColumns: [emailTemplates.organizationId, emailTemplates.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'email_template_versions_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'email_template_versions_organization_id_published_by_user_id_fk',
      columns: [table.organizationId, table.publishedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check(
      'email_template_versions_known',
      sql.raw(
        `state in (${list(EMAIL_TEMPLATE_VERSION_STATES)}) and layout in ('brand', 'none') and version >= 0 and ((state = 'draft') = (version = 0))`,
      ),
    ),
    check(
      'email_template_versions_sizes',
      sql`char_length(${table.subject}) <= 1000 and octet_length(${table.html}) <= 524288 and (${table.text} is null or octet_length(${table.text}) <= 262144) and jsonb_array_length(${table.variables}) <= 30 and (${table.footerText} is null or char_length(${table.footerText}) <= 500)`,
    ),
  ],
);

export type EmailTemplateVersionRow = typeof emailTemplateVersions.$inferSelect;

export const emailOutbound = pgTable(
  'email_outbound',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    source: text('source').notNull(),
    apiKeyId: uuid('api_key_id'),
    createdByUserId: uuid('created_by_user_id'),
    senderKind: text('sender_kind').notNull(),
    channelId: uuid('channel_id'),
    /** Akun Email bersama (9B+). Belum ada tabelnya — tanpa FK sampai 9B. */
    mailAccountId: uuid('mail_account_id'),
    fromAddress: text('from_address').notNull(),
    fromName: text('from_name').notNull(),
    replyTo: text('reply_to'),
    to: jsonb('to').$type<EmailRecipientRow[]>().notNull(),
    cc: jsonb('cc').$type<EmailRecipientRow[]>().notNull().default([]),
    /** HANYA amplop SMTP; tidak pernah di header/webhook (webhook: `bcc_count`). */
    bcc: jsonb('bcc').$type<EmailRecipientRow[]>().notNull().default([]),
    recipientCount: integer('recipient_count').notNull(),
    subject: text('subject').notNull(),
    html: text('html'),
    text: text('text'),
    sanitized: boolean('sanitized').notNull().default(false),
    templateId: uuid('template_id'),
    templateVersionId: uuid('template_version_id').references(() => emailTemplateVersions.id, {
      onDelete: 'set null',
    }),
    templateVersion: integer('template_version'),
    idempotencyKey: text('idempotency_key'),
    requestHash: text('request_hash'),
    metadata: jsonb('metadata').$type<Record<string, string | number | boolean | null>>(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    /** Pesan Inbox yang mencatat email ini (`conversation: "create"` / balasan). */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    /** Pesan Inbox email MASUK yang dibalas (`POST …/messages/:id/reply`). */
    replyToMessageId: uuid('reply_to_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    /** `In-Reply-To` + `References` (balasan), tanpa `<>`. */
    inReplyTo: text('in_reply_to'),
    references: text('references').array().notNull().default([]),
    /** `Message-ID` keluar tanpa `<>` (bagian acak 128 bit) — dicocokkan bounce & balasan. */
    messageIdHeader: text('message_id_header').notNull(),
    status: text('status').notNull(),
    scheduledAt: timestamptz('scheduled_at'),
    nextAttemptAt: timestamptz('next_attempt_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    sendingStartedAt: timestamptz('sending_started_at'),
    sentAt: timestamptz('sent_at'),
    failedAt: timestamptz('failed_at'),
    failureReason: text('failure_reason'),
    smtpCode: integer('smtp_code'),
    rejectedRecipients: jsonb('rejected_recipients').$type<string[]>().notNull().default([]),
    bounces: jsonb('bounces').$type<EmailBounce[]>().notNull().default([]),
    bouncedAt: timestamptz('bounced_at'),
    repliedAt: timestamptz('replied_at'),
    canceledAt: timestamptz('canceled_at'),
    bodyPurgedAt: timestamptz('body_purged_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('email_outbound_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('email_outbound_idempotency_unique')
      .on(table.organizationId, table.apiKeyId, table.idempotencyKey)
      .where(sql`${table.apiKeyId} is not null and ${table.idempotencyKey} is not null`),
    unique('email_outbound_organization_id_message_id_header_unique').on(
      table.organizationId,
      table.messageIdHeader,
    ),
    index('email_outbound_due_idx')
      .on(table.status, table.nextAttemptAt)
      .where(sql`${table.status} in ('queued', 'scheduled')`),
    index('email_outbound_organization_id_channel_id_sent_at_idx').on(
      table.organizationId,
      table.channelId,
      table.sentAt,
    ),
    index('email_outbound_waiting_idx')
      .on(table.organizationId, table.channelId, table.createdAt)
      .where(sql`${table.status} in ('queued', 'scheduled', 'sending')`),
    index('email_outbound_organization_id_api_key_id_created_at_idx').on(
      table.organizationId,
      table.apiKeyId,
      table.createdAt,
    ),
    index('email_outbound_organization_id_created_at_id_idx').on(
      table.organizationId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index('email_outbound_message_id_idx')
      .on(table.messageId)
      .where(sql`${table.messageId} is not null`),
    index('email_outbound_contact_id_idx')
      .on(table.contactId)
      .where(sql`${table.contactId} is not null`),
    foreignKey({
      name: 'email_outbound_organization_id_api_key_id_fk',
      columns: [table.organizationId, table.apiKeyId],
      foreignColumns: [apiKeys.organizationId, apiKeys.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'email_outbound_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'email_outbound_organization_id_channel_id_fk',
      columns: [table.organizationId, table.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'email_outbound_organization_id_template_id_fk',
      columns: [table.organizationId, table.templateId],
      foreignColumns: [emailTemplates.organizationId, emailTemplates.id],
    }).onDelete('restrict'),
    check(
      'email_outbound_known',
      sql.raw(
        `status in (${list(EMAIL_OUTBOUND_STATUSES)}) and source in (${list(EMAIL_OUTBOUND_SOURCES)}) and (failure_reason is null or failure_reason in (${list(EMAIL_FAILURE_REASONS)}))`,
      ),
    ),
    check(
      'email_outbound_sender_one',
      sql`(${table.senderKind} = 'channel' and ${table.channelId} is not null and ${table.mailAccountId} is null) or (${table.senderKind} = 'account' and ${table.mailAccountId} is not null and ${table.channelId} is null)`,
    ),
    check(
      'email_outbound_source_actor',
      sql`(${table.source} = 'api' and ${table.apiKeyId} is not null) or (${table.source} = 'test' and ${table.createdByUserId} is not null)`,
    ),
    check(
      'email_outbound_sizes',
      sql`${table.recipientCount} between 1 and 50 and char_length(${table.subject}) between 1 and 200 and char_length(${table.fromAddress}) between 3 and 254 and char_length(${table.fromName}) <= 100 and (${table.html} is null or octet_length(${table.html}) <= 1572864) and (${table.text} is null or octet_length(${table.text}) <= 524288) and (${table.idempotencyKey} is null or char_length(${table.idempotencyKey}) between 1 and 100) and (${table.requestHash} is null or ${table.requestHash} ~ '^[0-9a-f]{64}$') and (${table.metadata} is null or octet_length(${table.metadata}::text) <= 4096) and char_length(${table.messageIdHeader}) between 3 and 300 and ${table.attempts} >= 0 and cardinality(${table.references}) <= 20`,
    ),
  ],
);

export type EmailOutboundRow = typeof emailOutbound.$inferSelect;
export type NewEmailOutboundRow = typeof emailOutbound.$inferInsert;

export const emailOutboundAttachments = pgTable(
  'email_outbound_attachments',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    emailOutboundId: uuid('email_outbound_id').notNull(),
    position: integer('position').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key'),
    /** `base64` · `media` · `url` · `qris` · `logo`. */
    source: text('source').notNull(),
    /** Host URL saja (tanpa path/query) untuk sumber `url`. */
    sourceHost: text('source_host'),
    inline: boolean('inline').notNull().default(false),
    contentId: text('cid'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index('email_outbound_attachments_email_outbound_id_idx').on(table.emailOutboundId),
    foreignKey({
      name: 'email_outbound_attachments_organization_id_email_outbound_id_fk',
      columns: [table.organizationId, table.emailOutboundId],
      foreignColumns: [emailOutbound.organizationId, emailOutbound.id],
    }).onDelete('cascade'),
    check(
      'email_outbound_attachments_known',
      sql`${table.source} in ('base64', 'media', 'url', 'qris', 'logo') and ${table.sizeBytes} between 0 and 20971520 and ${table.position} >= 0 and char_length(${table.filename}) between 1 and 255 and char_length(${table.contentType}) between 3 and 128 and char_length(${table.sha256}) = 64 and (${table.storageKey} is null or ${table.storageKey} ~ '^email-out/[0-9a-f-]{36}$') and (${table.contentId} is null or ${table.contentId} ~ '^[A-Za-z0-9._-]{1,64}$') and (${table.sourceHost} is null or char_length(${table.sourceHost}) <= 253)`,
    ),
  ],
);

export type EmailOutboundAttachmentRow = typeof emailOutboundAttachments.$inferSelect;

export const emailSenderSettings = pgTable(
  'email_sender_settings',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    senderKind: text('sender_kind').notNull(),
    channelId: uuid('channel_id'),
    mailAccountId: uuid('mail_account_id'),
    hourlyLimit: integer('hourly_limit').notNull().default(100),
    /** `ok` · `throttled` · `paused` · `blocked` (`disabled` diturunkan dari channel). */
    state: text('state').notNull().default('ok'),
    throttledUntil: timestamptz('throttled_until'),
    throttleStreak: integer('throttle_streak').notNull().default(0),
    blockedReason: text('blocked_reason'),
    blockedAt: timestamptz('blocked_at'),
    pausedByUserId: uuid('paused_by_user_id'),
    pausedAt: timestamptz('paused_at'),
    pauseReason: text('pause_reason'),
    updatedByUserId: uuid('updated_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('email_sender_settings_channel_id_unique').on(table.channelId),
    unique('email_sender_settings_mail_account_id_unique').on(table.mailAccountId),
    foreignKey({
      name: 'email_sender_settings_organization_id_channel_id_fk',
      columns: [table.organizationId, table.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete('cascade'),
    // 9B: FK yang tertinggal dari 9.1.
    foreignKey({
      name: 'email_sender_settings_organization_id_mail_account_id_fk',
      columns: [table.organizationId, table.mailAccountId],
      foreignColumns: [mailAccounts.organizationId, mailAccounts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'email_sender_settings_organization_id_paused_by_user_id_fk',
      columns: [table.organizationId, table.pausedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'email_sender_settings_organization_id_updated_by_user_id_fk',
      columns: [table.organizationId, table.updatedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check(
      'email_sender_settings_known',
      sql.raw(
        `state in ('ok', 'throttled', 'paused', 'blocked') and hourly_limit between 1 and 5000 and throttle_streak >= 0 and (blocked_reason is null or blocked_reason in (${list(EMAIL_SENDER_BLOCKED_REASONS)})) and (pause_reason is null or char_length(pause_reason) <= 200)`,
      ),
    ),
    check(
      'email_sender_settings_sender_one',
      sql`(${table.senderKind} = 'channel' and ${table.channelId} is not null and ${table.mailAccountId} is null) or (${table.senderKind} = 'account' and ${table.mailAccountId} is not null and ${table.channelId} is null)`,
    ),
  ],
);

export type EmailSenderSettingsRow = typeof emailSenderSettings.$inferSelect;

export const apiKeyEmailSenders = pgTable(
  'api_key_email_senders',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    apiKeyId: uuid('api_key_id').notNull(),
    senderKind: text('sender_kind').notNull(),
    channelId: uuid('channel_id'),
    mailAccountId: uuid('mail_account_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('api_key_email_senders_api_key_id_channel_id_unique').on(
      table.apiKeyId,
      table.channelId,
    ),
    unique('api_key_email_senders_api_key_id_mail_account_id_unique').on(
      table.apiKeyId,
      table.mailAccountId,
    ),
    foreignKey({
      name: 'api_key_email_senders_organization_id_api_key_id_fk',
      columns: [table.organizationId, table.apiKeyId],
      foreignColumns: [apiKeys.organizationId, apiKeys.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'api_key_email_senders_organization_id_channel_id_fk',
      columns: [table.organizationId, table.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'api_key_email_senders_organization_id_mail_account_id_fk',
      columns: [table.organizationId, table.mailAccountId],
      foreignColumns: [mailAccounts.organizationId, mailAccounts.id],
    }).onDelete('cascade'),
    check(
      'api_key_email_senders_sender_one',
      sql`(${table.senderKind} = 'channel' and ${table.channelId} is not null and ${table.mailAccountId} is null) or (${table.senderKind} = 'account' and ${table.mailAccountId} is not null and ${table.channelId} is null)`,
    ),
  ],
);

export type ApiKeyEmailSenderRow = typeof apiKeyEmailSenders.$inferSelect;
