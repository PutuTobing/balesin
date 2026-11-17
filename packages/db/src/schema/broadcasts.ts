import {
  ALARM_KINDS,
  BROADCAST_DEDUPE_SCOPES,
  BROADCAST_PAUSE_REASONS,
  BROADCAST_RECIPIENT_STATUSES,
  BROADCAST_SKIP_REASONS,
  BROADCAST_SOURCE_KINDS,
  BROADCAST_STATUSES,
  BROADCAST_WAIT_REASONS,
  type BroadcastEstimate,
  type BroadcastMapping,
  type BroadcastRates,
} from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
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

import { channels } from './channels';
import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { organizations } from './organizations';
import { users } from './users';

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/**
 * Kampanye broadcast (Fase 4, docs/KONTRAK-API-BROADCAST.md).
 *
 * - `template_id` / `auto_tag_id` TANPA FK (template/tag boleh dihapus; diperiksa ulang saat kirim).
 * - `runner_lease_until` = sewa pemroses worker (satu pemroses per kampanye; sewa kedaluwarsa = proses
 *   mati → diambil alih). Status `running` + sewa = sumber kebenaran, jadi worker restart aman.
 * - `estimate` = salinan estimasi saat diajukan (dasar persetujuan); laporan memakai tarif yang sama.
 * - `data_purged_at` = data kolom penerima dikosongkan (retensi setelah selesai).
 */
export const broadcastCampaigns = pgTable(
  'broadcast_campaigns',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    status: text('status').notNull().default('draft'),
    channelId: uuid('channel_id').notNull(),
    templateId: uuid('template_id').notNull(),
    sourceKind: text('source_kind'),
    sourceLabel: text('source_label'),
    sourceImportedAt: timestamptz('source_imported_at'),
    columns: text('columns')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    phoneColumn: text('phone_column'),
    mapping: jsonb('mapping')
      .$type<BroadcastMapping>()
      .notNull()
      .default({ body: {}, header: null, buttons: {} }),
    scheduledAt: timestamptz('scheduled_at'),
    ratePerSecond: integer('rate_per_second').notNull().default(5),
    dedupeHours: integer('dedupe_hours').default(24),
    dedupeScope: text('dedupe_scope').notNull().default('template'),
    autoTagId: uuid('auto_tag_id'),
    sourceRows: integer('source_rows').notNull().default(0),
    rejectedRows: integer('rejected_rows').notNull().default(0),
    approvalRequired: boolean('approval_required').notNull().default(false),
    approvalThreshold: integer('approval_threshold'),
    approvalRequestedAt: timestamptz('approval_requested_at'),
    approvalDecidedAt: timestamptz('approval_decided_at'),
    approvalDecidedByUserId: uuid('approval_decided_by_user_id'),
    rejectionReason: text('rejection_reason'),
    estimate: jsonb('estimate').$type<BroadcastEstimate>(),
    submittedByUserId: uuid('submitted_by_user_id'),
    pausedReason: text('paused_reason'),
    pausedAt: timestamptz('paused_at'),
    pausedByUserId: uuid('paused_by_user_id'),
    waitingReason: text('waiting_reason'),
    waitingUntil: timestamptz('waiting_until'),
    createdByUserId: uuid('created_by_user_id'),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    cancelledAt: timestamptz('cancelled_at'),
    cancelledByUserId: uuid('cancelled_by_user_id'),
    runnerLeaseUntil: timestamptz('runner_lease_until'),
    /**
     * Awal jendela hitung rem otomatis "lonjakan gagal": diisi saat kampanye dilanjutkan, supaya
     * kegagalan sebelum dijeda tidak langsung memicu rem lagi.
     */
    failureWindowFrom: timestamptz('failure_window_from'),
    dataPurgedAt: timestamptz('data_purged_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('broadcast_campaigns_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'broadcast_campaigns_organization_id_channel_id_fk',
      columns: [table.organizationId, table.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'broadcast_campaigns_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'broadcast_campaigns_organization_id_decided_by_user_id_fk',
      columns: [table.organizationId, table.approvalDecidedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'broadcast_campaigns_organization_id_submitted_by_user_id_fk',
      columns: [table.organizationId, table.submittedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'broadcast_campaigns_organization_id_paused_by_user_id_fk',
      columns: [table.organizationId, table.pausedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'broadcast_campaigns_organization_id_cancelled_by_user_id_fk',
      columns: [table.organizationId, table.cancelledByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    index('broadcast_campaigns_organization_id_created_at_idx').on(
      table.organizationId,
      table.createdAt,
    ),
    // Pemroses worker: kampanye terjadwal yang jatuh tempo / sedang berjalan.
    index('broadcast_campaigns_active_idx')
      .on(table.status, table.scheduledAt)
      .where(sql`${table.status} in ('scheduled', 'running')`),
    check('broadcast_campaigns_status_known', sql.raw(`status in (${list(BROADCAST_STATUSES)})`)),
    check(
      'broadcast_campaigns_source_kind_known',
      sql.raw(`source_kind is null or source_kind in (${list(BROADCAST_SOURCE_KINDS)})`),
    ),
    check(
      'broadcast_campaigns_pause_known',
      sql.raw(
        `(paused_reason is null) = (paused_at is null) and (paused_reason is null or paused_reason in (${list(BROADCAST_PAUSE_REASONS)}))`,
      ),
    ),
    check(
      'broadcast_campaigns_paused_has_reason',
      sql`${table.status} <> 'paused' or ${table.pausedReason} is not null`,
    ),
    check(
      'broadcast_campaigns_waiting_known',
      sql.raw(
        `(waiting_reason is null) = (waiting_until is null) and (waiting_reason is null or waiting_reason in (${list(BROADCAST_WAIT_REASONS)}))`,
      ),
    ),
    check(
      'broadcast_campaigns_dedupe_known',
      sql.raw(
        `dedupe_scope in (${list(BROADCAST_DEDUPE_SCOPES)}) and (dedupe_hours is null or dedupe_hours between 1 and 720)`,
      ),
    ),
    check(
      'broadcast_campaigns_rate_range',
      sql`${table.ratePerSecond} between 1 and 20 and ${table.sourceRows} >= 0 and ${table.rejectedRows} >= 0`,
    ),
    check(
      'broadcast_campaigns_text_lengths',
      sql`char_length(${table.name}) between 1 and 80 and (${table.sourceLabel} is null or char_length(${table.sourceLabel}) <= 200) and (${table.rejectionReason} is null or char_length(${table.rejectionReason}) <= 300) and cardinality(${table.columns}) <= 30`,
    ),
  ],
);

export type BroadcastCampaignRow = typeof broadcastCampaigns.$inferSelect;

/**
 * Penerima kampanye. Satu nomor SEKALI per kampanye (indeks unik). `data` = kolom data penerima untuk
 * variabel template (dikosongkan setelah retensi). `message_id`/`contact_id`/`conversation_id` TANPA FK:
 * kontak bisa dihapus (UU PDP) tanpa terhalang laporan. Klaim kirim = `status: pending → queued` di
 * transaksi yang sama dengan pembuatan pesan (idempoten bila worker restart).
 */
export const broadcastRecipients = pgTable(
  'broadcast_recipients',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id').notNull(),
    rowNumber: integer('row_number').notNull(),
    phone: text('phone').notNull(),
    data: jsonb('data').$type<Record<string, string>>().notNull().default({}),
    status: text('status').notNull().default('pending'),
    skipReason: text('skip_reason'),
    contactId: uuid('contact_id'),
    conversationId: uuid('conversation_id'),
    messageId: uuid('message_id'),
    sendAttempts: integer('send_attempts').notNull().default(0),
    processedAt: timestamptz('processed_at'),
    repliedAt: timestamptz('replied_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'broadcast_recipients_organization_id_campaign_id_fk',
      columns: [table.organizationId, table.campaignId],
      foreignColumns: [broadcastCampaigns.organizationId, broadcastCampaigns.id],
    }).onDelete('cascade'),
    uniqueIndex('broadcast_recipients_campaign_id_phone_unique').on(table.campaignId, table.phone),
    index('broadcast_recipients_campaign_id_status_row_idx').on(
      table.campaignId,
      table.status,
      table.rowNumber,
    ),
    // Anti-dobel lintas kampanye (nomor sama dalam N jam).
    index('broadcast_recipients_phone_processed_at_idx')
      .on(table.organizationId, table.phone, table.processedAt)
      .where(sql`${table.status} = 'queued'`),
    // Atribusi balasan + tag otomatis.
    index('broadcast_recipients_contact_processed_at_idx')
      .on(table.organizationId, table.contactId, table.processedAt)
      .where(sql`${table.contactId} is not null and ${table.repliedAt} is null`),
    index('broadcast_recipients_message_id_idx')
      .on(table.messageId)
      .where(sql`${table.messageId} is not null`),
    check(
      'broadcast_recipients_status_known',
      sql.raw(
        `status in (${list(BROADCAST_RECIPIENT_STATUSES)}) and (skip_reason is null or skip_reason in (${list(BROADCAST_SKIP_REASONS)})) and ((status = 'skipped') = (skip_reason is not null))`,
      ),
    ),
    check(
      'broadcast_recipients_queued_has_message',
      sql`${table.status} <> 'queued' or (${table.messageId} is not null and ${table.processedAt} is not null)`,
    ),
    check('broadcast_recipients_phone_e164', sql`${table.phone} ~ '^\\+[1-9][0-9]{6,14}$'`),
    check(
      'broadcast_recipients_data_size',
      sql`jsonb_typeof(${table.data}) = 'object' and octet_length(${table.data}::text) <= 32768 and ${table.rowNumber} > 0 and ${table.sendAttempts} >= 0`,
    ),
  ],
);

export type BroadcastRecipientRow = typeof broadcastRecipients.$inferSelect;

/**
 * Pengaturan broadcast per organisasi (Pengaturan → Batas kirim, PENGATURAN-UI). Baris tidak ada =
 * nilai bawaan `DEFAULT_BROADCAST_SETTINGS`.
 */
export const broadcastSettings = pgTable(
  'broadcast_settings',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    approvalThreshold: integer('approval_threshold').notNull(),
    maxRatePerSecond: integer('max_rate_per_second').notNull(),
    quotaReservePercent: integer('quota_reserve_percent').notNull(),
    autoBrakeEnabled: boolean('auto_brake_enabled').notNull(),
    failureSpikePercent: integer('failure_spike_percent').notNull(),
    failureSpikeMinSample: integer('failure_spike_min_sample').notNull(),
    spikeMultiplier: integer('spike_multiplier').notNull(),
    spikeMinPerMinute: integer('spike_min_per_minute').notNull(),
    spikeAbsolutePerMinute: integer('spike_absolute_per_minute').notNull(),
    rates: jsonb('rates').$type<BroadcastRates>().notNull(),
    updatedByUserId: uuid('updated_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'broadcast_settings_organization_id_updated_by_user_id_fk',
      columns: [table.organizationId, table.updatedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check(
      'broadcast_settings_ranges',
      sql`${table.approvalThreshold} between 1 and 100000 and ${table.maxRatePerSecond} between 1 and 20 and ${table.quotaReservePercent} between 5 and 90 and ${table.failureSpikePercent} between 10 and 100 and ${table.failureSpikeMinSample} between 5 and 1000 and ${table.spikeMultiplier} between 2 and 100 and ${table.spikeMinPerMinute} between 10 and 10000 and ${table.spikeAbsolutePerMinute} between 10 and 100000`,
    ),
  ],
);

export type BroadcastSettingsRow = typeof broadcastSettings.$inferSelect;

/**
 * Konektor REST sumber penerima (mis. aplikasi billing). Header autentikasi dienkripsi SecretBox
 * (konteks `broadcast_connectors.auth_header_value` + ID baris); hanya 4 karakter terakhir yang tampil.
 * Pengambilan memakai aturan SSRF webhook keluar (allowlist IP privat organisasi).
 */
export const broadcastConnectors = pgTable(
  'broadcast_connectors',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    authHeaderName: text('auth_header_name'),
    authHeaderValueEncrypted: text('auth_header_value_encrypted'),
    authHeaderTail: text('auth_header_tail'),
    itemsPath: text('items_path').notNull().default(''),
    phoneField: text('phone_field').notNull(),
    lastTestOk: boolean('last_test_ok'),
    lastTestCode: text('last_test_code'),
    lastTestItems: integer('last_test_items'),
    lastTestedAt: timestamptz('last_tested_at'),
    createdByUserId: uuid('created_by_user_id'),
    updatedByUserId: uuid('updated_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('broadcast_connectors_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'broadcast_connectors_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'broadcast_connectors_organization_id_updated_by_user_id_fk',
      columns: [table.organizationId, table.updatedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    index('broadcast_connectors_organization_id_idx').on(table.organizationId),
    check(
      'broadcast_connectors_auth_consistent',
      sql`(${table.authHeaderName} is null) = (${table.authHeaderValueEncrypted} is null) and (${table.authHeaderName} is null) = (${table.authHeaderTail} is null)`,
    ),
    check(
      'broadcast_connectors_lengths',
      sql`char_length(${table.name}) between 1 and 60 and char_length(${table.url}) between 1 and 2000 and char_length(${table.phoneField}) between 1 and 64 and char_length(${table.itemsPath}) <= 120`,
    ),
    check(
      'broadcast_connectors_last_test_complete',
      sql`(${table.lastTestOk} is null) = (${table.lastTestedAt} is null) and (${table.lastTestOk} is null) = (${table.lastTestCode} is null)`,
    ),
  ],
);

export type BroadcastConnectorRow = typeof broadcastConnectors.$inferSelect;

/**
 * Alarm Telegram organisasi (token bot terenkripsi, konteks `telegram_alarm_settings.bot_token`).
 * `telegram_chat` = ID chat/grup (`-100…`) atau `@kanal` — teks, bukan UUID.
 */
export const telegramAlarmSettings = pgTable(
  'telegram_alarm_settings',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    enabled: boolean('enabled').notNull().default(true),
    botTokenEncrypted: text('bot_token_encrypted').notNull(),
    botTokenTail: text('bot_token_tail').notNull(),
    telegramChat: text('telegram_chat').notNull(),
    lastTestOk: boolean('last_test_ok'),
    lastTestCode: text('last_test_code'),
    lastTestedAt: timestamptz('last_tested_at'),
    updatedByUserId: uuid('updated_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'telegram_alarm_settings_organization_id_updated_by_user_id_fk',
      columns: [table.organizationId, table.updatedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check(
      'telegram_alarm_settings_chat_format',
      sql`${table.telegramChat} ~ '^(-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$'`,
    ),
    check(
      'telegram_alarm_settings_last_test_complete',
      sql`(${table.lastTestOk} is null) = (${table.lastTestedAt} is null) and (${table.lastTestOk} is null) = (${table.lastTestCode} is null)`,
    ),
  ],
);

export type TelegramAlarmSettingsRow = typeof telegramAlarmSettings.$inferSelect;

/**
 * Antrean alarm sistem (outbox): ditulis api/worker di transaksi kejadiannya, dikirim worker ke
 * Telegram (bila diatur). `details` TANPA data pelanggan (jumlah, kode, nama kampanye).
 */
export const alarmEvents = pgTable(
  'alarm_events',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    campaignId: uuid('campaign_id'),
    details: jsonb('details').$type<Record<string, string | number | boolean | null>>().notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    sentAt: timestamptz('sent_at'),
    lastErrorCode: text('last_error_code'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index('alarm_events_pending_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`),
    index('alarm_events_organization_id_created_at_idx').on(table.organizationId, table.createdAt),
    check(
      'alarm_events_known',
      sql.raw(
        `kind in (${list(ALARM_KINDS)}) and status in ('pending', 'sent', 'skipped', 'failed') and attempts >= 0`,
      ),
    ),
  ],
);

export type AlarmEventRow = typeof alarmEvents.$inferSelect;
