import {
  MAIL_ACCESS_LEVELS,
  MAIL_ACCOUNT_COLORS,
  MAIL_ATTACHMENT_SOURCES,
  MAIL_COMPOSE_FORMATS,
  MAIL_DRAFT_ATTACHMENT_STATES,
  MAIL_DRAFT_MODES,
  MAIL_DRAFT_SERVER_SYNC_STATES,
  MAIL_DRAFT_STATES,
  MAIL_IDENTITY_VERIFICATION_STATES,
  MAIL_IDENTITY_VERIFIED_METHODS,
  MAIL_OUTBOX_HOLD_REASONS,
  MAIL_OUTBOX_STATUSES,
  MAIL_SEND_FAILURE_REASONS,
  MAIL_SENT_COPY_MODES,
  MAIL_SENT_COPY_STATES,
  MAIL_ACCOUNT_KINDS,
  MAIL_AVATAR_STORED_MAX_BYTES,
  MAIL_FOLDER_ROLE_SOURCES,
  MAIL_FOLDER_ROLES,
  MAIL_PROVIDERS,
  MAIL_SYNC_STATES,
} from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  type AnyPgColumn,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { channels } from './channels';
import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { departments } from './departments';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Modul Email (Fase 9 tahap 9A, docs/KONTRAK-API-EMAIL.md §3): kotak surat multi-akun IMAP/SMTP,
 * terpisah dari Inbox (`channels`). Semua tabel ber-`organization_id` dengan FK komposit
 * `(organization_id, <induk>)` → baris organisasi lain tidak bisa dirujuk (isolasi tenant dijaga
 * database). Rahasia = `*_encrypted` (`SecretBox`, konteks `mail_accounts.<kolom>` + ID akun) +
 * `*_tail` (≤ 4 karakter terakhir). Hapus akun (putuskan) = cascade ke semua anak.
 *
 * Isi email TIDAK PERNAH di-log; header/cuplikan/isi adalah data pribadi (UU PDP) — dipangkas
 * `cache_retention_days`, dihapus seluruhnya saat akun diputus.
 *
 * Ditunda: `thread_id`/`search_vector`/label (9C), draf/outbox (9B), kolom OAuth (9E).
 */

const list = (values: readonly (string | number)[]) =>
  values.map((value) => (typeof value === 'number' ? String(value) : `'${value}'`)).join(', ');

/** Kolom biner Postgres (`bytea`) ↔ `Buffer`. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export interface MailCapabilities {
  idle: boolean;
  condstore: boolean;
  qresync: boolean;
  move: boolean;
  uidplus: boolean;
  specialUse: boolean;
  quota: boolean;
}

export interface MailAddressRow {
  address: string;
  name: string | null;
}

export interface MailAuthDetails {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
  authServId: string | null;
}

export const mailAccounts = pgTable(
  'mail_accounts',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    ownerUserId: uuid('owner_user_id'),
    provider: text('provider').notNull(),
    displayName: text('display_name').notNull(),
    /** Huruf kecil (dinormalisasi Zod). */
    emailAddress: text('email_address').notNull(),
    fromName: text('from_name').notNull(),
    color: text('color').notNull(),
    imapHost: text('imap_host'),
    imapPort: integer('imap_port'),
    imapSecurity: text('imap_security'),
    imapUsername: text('imap_username'),
    imapPasswordEncrypted: text('imap_password_encrypted'),
    imapPasswordTail: text('imap_password_tail'),
    smtpHost: text('smtp_host'),
    smtpPort: integer('smtp_port'),
    smtpSecurity: text('smtp_security'),
    smtpUsername: text('smtp_username'),
    smtpPasswordEncrypted: text('smtp_password_encrypted'),
    smtpPasswordTail: text('smtp_password_tail'),
    smtpSameCredentials: boolean('smtp_same_credentials').notNull().default(true),
    /** `null` = bawaan `defaultTrustedAuthServIds(imap_host)`. */
    trustedAuthServIds: text('trusted_auth_serv_ids').array(),
    /** `null` = semua email. */
    syncWindowDays: integer('sync_window_days').default(90),
    periodicSyncMinutes: integer('periodic_sync_minutes').notNull().default(5),
    syncState: text('sync_state').notNull().default('initial_sync'),
    syncPausedByUserId: uuid('sync_paused_by_user_id'),
    lastSyncedAt: timestamptz('last_synced_at'),
    lastErrorCode: text('last_error_code'),
    lastErrorAt: timestamptz('last_error_at'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** Jatuh tempo sinkron berikutnya (tick worker); `null` = tidak dijadwalkan. */
    nextAttemptAt: timestamptz('next_attempt_at'),
    /** Pemindaian folder (LIST) terakhir — diulang tiap 30 menit atau saat "Sinkron sekarang". */
    foldersSyncedAt: timestamptz('folders_synced_at'),
    initialSyncDone: integer('initial_sync_done').notNull().default(0),
    initialSyncTotal: integer('initial_sync_total'),
    capabilities: jsonb('capabilities').$type<MailCapabilities>(),
    /** IDLE Kotak masuk sedang terbuka di worker (diperbarui pengawas IDLE). */
    idleActive: boolean('idle_active').notNull().default(false),
    lastTestAt: timestamptz('last_test_at'),
    lastTestIncomingOk: boolean('last_test_incoming_ok'),
    lastTestOutgoingOk: boolean('last_test_outgoing_ok'),
    messageCount: bigint('message_count', { mode: 'number' }).notNull().default(0),
    unreadCount: bigint('unread_count', { mode: 'number' }).notNull().default(0),
    quotaUsedBytes: bigint('quota_used_bytes', { mode: 'number' }),
    quotaLimitBytes: bigint('quota_limit_bytes', { mode: 'number' }),
    avatarSha256: text('avatar_sha256'),
    /** 9B: salinan email terkirim — `auto` (cari di Terkirim dulu), `append`, `none`. */
    sentCopyMode: text('sent_copy_mode').notNull().default('auto'),
    /** 9B: peringatan penerima di luar domain kantor saat menulis. */
    warnExternalRecipients: boolean('warn_external_recipients').notNull().default(false),
    createdByUserId: uuid('created_by_user_id'),
    /** Terisi saat pemutusan berjalan (kredensial sudah dimusnahkan; job menghapus bertahap). */
    deletedAt: timestamptz('deleted_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('mail_accounts_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('mail_accounts_organization_id_email_address_live_unique')
      .on(table.organizationId, table.emailAddress)
      .where(sql`${table.deletedAt} is null`),
    index('mail_accounts_sync_state_next_attempt_at_idx').on(table.syncState, table.nextAttemptAt),
    index('mail_accounts_organization_id_owner_user_id_idx').on(
      table.organizationId,
      table.ownerUserId,
    ),
    foreignKey({
      name: 'mail_accounts_organization_id_owner_user_id_fk',
      columns: [table.organizationId, table.ownerUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'mail_accounts_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'mail_accounts_organization_id_sync_paused_by_user_id_fk',
      columns: [table.organizationId, table.syncPausedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check(
      'mail_accounts_known',
      sql.raw(
        `kind in (${list(MAIL_ACCOUNT_KINDS)}) and provider in (${list(MAIL_PROVIDERS)}) and color in (${list(MAIL_ACCOUNT_COLORS)}) and sync_state in (${list(MAIL_SYNC_STATES)})`,
      ),
    ),
    check(
      'mail_accounts_sent_copy_mode',
      sql.raw(`sent_copy_mode in (${list(MAIL_SENT_COPY_MODES)})`),
    ),
    check(
      'mail_accounts_owner',
      sql`(${table.kind} = 'personal' and ${table.ownerUserId} is not null) or (${table.kind} = 'shared' and ${table.ownerUserId} is null)`,
    ),
    check(
      'mail_accounts_text_lengths',
      sql`char_length(${table.displayName}) between 1 and 60 and char_length(${table.emailAddress}) between 3 and 254 and ${table.emailAddress} = lower(${table.emailAddress}) and char_length(${table.fromName}) between 1 and 80 and (${table.imapHost} is null or char_length(${table.imapHost}) between 1 and 253) and (${table.smtpHost} is null or char_length(${table.smtpHost}) between 1 and 253) and (${table.imapUsername} is null or char_length(${table.imapUsername}) between 1 and 255) and (${table.smtpUsername} is null or char_length(${table.smtpUsername}) between 1 and 255) and (${table.lastErrorCode} is null or char_length(${table.lastErrorCode}) <= 64) and (${table.avatarSha256} is null or ${table.avatarSha256} ~ '^[0-9a-f]{64}$')`,
    ),
    // TLS wajib (kontrak §4.3). Port dibatasi service (server tiruan tes memakai port lain).
    check(
      'mail_accounts_servers',
      sql`(${table.imapSecurity} is null or ${table.imapSecurity} in ('ssl', 'starttls')) and (${table.smtpSecurity} is null or ${table.smtpSecurity} in ('ssl', 'starttls')) and (${table.imapPort} is null or ${table.imapPort} between 1 and 65535) and (${table.smtpPort} is null or ${table.smtpPort} between 1 and 65535)`,
    ),
    // Akun hidup wajib punya server lengkap; saat diputus kredensial sudah dimusnahkan.
    check(
      'mail_accounts_live_complete',
      sql`${table.deletedAt} is not null or (${table.imapHost} is not null and ${table.imapPort} is not null and ${table.imapSecurity} is not null and ${table.imapUsername} is not null and ${table.imapPasswordEncrypted} is not null and ${table.smtpHost} is not null and ${table.smtpPort} is not null and ${table.smtpSecurity} is not null and (${table.smtpSameCredentials} or (${table.smtpUsername} is not null and ${table.smtpPasswordEncrypted} is not null)))`,
    ),
    check(
      'mail_accounts_numbers',
      sql`(${table.syncWindowDays} is null or ${table.syncWindowDays} in (30, 90, 365)) and ${table.periodicSyncMinutes} between 1 and 60 and ${table.consecutiveFailures} >= 0 and ${table.initialSyncDone} >= 0 and ${table.messageCount} >= 0 and ${table.unreadCount} >= 0 and (${table.trustedAuthServIds} is null or (cardinality(${table.trustedAuthServIds}) between 1 and 5 and char_length(array_to_string(${table.trustedAuthServIds}, ',')) <= 1300 and array_to_string(${table.trustedAuthServIds}, ',') ~ '^[a-z0-9.,-]+$'))`,
    ),
  ],
);

export type MailAccountRow = typeof mailAccounts.$inferSelect;
export type NewMailAccountRow = typeof mailAccounts.$inferInsert;

const avatarChecks = (
  prefix: string,
  table: { contentType: unknown; data: unknown; sha256: unknown },
) => [
  check(`${prefix}_content_type`, sql`${table.contentType} = 'image/png'`),
  check(
    `${prefix}_size`,
    sql`octet_length(${table.data}) between 1 and ${sql.raw(String(MAIL_AVATAR_STORED_MAX_BYTES))} and ${table.sha256} ~ '^[0-9a-f]{64}$'`,
  ),
];

/** Foto akun Email (256×256 PNG). Di database (ikut backup), pola `organization_logos`. */
export const mailAccountAvatars = pgTable(
  'mail_account_avatars',
  {
    accountId: uuid('account_id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    contentType: text('content_type').notNull(),
    data: bytea('data').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'mail_account_avatars_organization_id_account_id_fk',
      columns: [table.organizationId, table.accountId],
      foreignColumns: [mailAccounts.organizationId, mailAccounts.id],
    }).onDelete('cascade'),
    ...avatarChecks('mail_account_avatars', table),
  ],
);

/**
 * Foto channel di Inbox (PRD-EMAIL §4.12). Tabelnya dibuat di 9A bersama foto akun Email; rutenya
 * (`/channels/:channelId/avatar`) menyusul bersama layar Inbox.
 */
export const channelAvatars = pgTable(
  'channel_avatars',
  {
    channelId: uuid('channel_id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    contentType: text('content_type').notNull(),
    data: bytea('data').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'channel_avatars_organization_id_channel_id_fk',
      columns: [table.organizationId, table.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete('cascade'),
    ...avatarChecks('channel_avatars', table),
  ],
);

/**
 * Hak per akun BERSAMA (kontrak §2, §5). Akun pribadi tidak punya baris (ditolak service + tes).
 * Tepat satu principal sesuai `principal_type`. Hapus pengguna/departemen → barisnya ikut terhapus.
 */
export const mailAccountAccess = pgTable(
  'mail_account_access',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').notNull(),
    principalType: text('principal_type').notNull(),
    userId: uuid('user_id'),
    departmentId: uuid('department_id'),
    level: text('level').notNull(),
    grantedByUserId: uuid('granted_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'mail_account_access_organization_id_account_id_fk',
      columns: [table.organizationId, table.accountId],
      foreignColumns: [mailAccounts.organizationId, mailAccounts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'mail_account_access_organization_id_user_id_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'mail_account_access_organization_id_department_id_fk',
      columns: [table.organizationId, table.departmentId],
      foreignColumns: [departments.organizationId, departments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'mail_account_access_organization_id_granted_by_user_id_fk',
      columns: [table.organizationId, table.grantedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    uniqueIndex('mail_account_access_account_user_unique')
      .on(table.accountId, table.userId)
      .where(sql`${table.userId} is not null`),
    uniqueIndex('mail_account_access_account_department_unique')
      .on(table.accountId, table.departmentId)
      .where(sql`${table.departmentId} is not null`),
    index('mail_account_access_user_idx').on(table.organizationId, table.userId),
    index('mail_account_access_department_idx').on(table.organizationId, table.departmentId),
    check(
      'mail_account_access_principal',
      sql`(${table.principalType} = 'user' and ${table.userId} is not null and ${table.departmentId} is null) or (${table.principalType} = 'department' and ${table.departmentId} is not null and ${table.userId} is null)`,
    ),
    check('mail_account_access_level', sql.raw(`level in (${list(MAIL_ACCESS_LEVELS)})`)),
  ],
);

export type MailAccountAccessRow = typeof mailAccountAccess.$inferSelect;

/**
 * Identitas pengirim akun (utama = alamat akun; alias 9B). Kirim HANYA dari identitas `verified`
 * (KONTRAK-API-EMAIL-TULIS §3): bukti = `Message-ID` rahasia ditemukan di kotak surat akun itu
 * sendiri ATAU kode 6 digit. Kode & `Message-ID` disimpan sebagai HMAC/SHA-256 + salinan terenkripsi
 * sementara (dihapus setelah email verifikasi terkirim). Unik org-wide ditegakkan service di bawah
 * advisory lock `email-address:<org>:<alamat>` (akun `deleting` masih punya baris).
 */
export const mailIdentities = pgTable(
  'mail_identities',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').notNull(),
    address: text('address').notNull(),
    displayName: text('display_name').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    verifiedAt: timestamptz('verified_at'),
    replyTo: text('reply_to'),
    verificationState: text('verification_state').notNull().default('unverified'),
    verifiedMethod: text('verified_method'),
    verificationSecretEncrypted: text('verification_secret_encrypted'),
    verificationCodeHash: text('verification_code_hash'),
    verificationMessageIdHash: text('verification_message_id_hash'),
    verificationSentAt: timestamptz('verification_sent_at'),
    verificationExpiresAt: timestamptz('verification_expires_at'),
    verificationAttempts: integer('verification_attempts').notNull().default(0),
    verificationRequestedByUserId: uuid('verification_requested_by_user_id'),
    /** Hanya tanda tangan BERSAMA akun yang sama (service). FK satu kolom: `set null`. */
    defaultSignatureNewId: uuid('default_signature_new_id').references(
      (): AnyPgColumn => mailSignatures.id,
      { onDelete: 'set null' },
    ),
    defaultSignatureReplyId: uuid('default_signature_reply_id').references(
      (): AnyPgColumn => mailSignatures.id,
      { onDelete: 'set null' },
    ),
    /** Alias: pembuat; utama: `null`. */
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('mail_identities_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'mail_identities_organization_id_account_id_fk',
      columns: [table.organizationId, table.accountId],
      foreignColumns: [mailAccounts.organizationId, mailAccounts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'mail_identities_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'mail_identities_organization_id_verification_requested_by_fk',
      columns: [table.organizationId, table.verificationRequestedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    unique('mail_identities_account_id_address_unique').on(table.accountId, table.address),
    uniqueIndex('mail_identities_one_primary')
      .on(table.accountId)
      .where(sql`${table.isPrimary}`),
    index('mail_identities_pending_idx')
      .on(table.accountId, table.verificationMessageIdHash)
      .where(sql`${table.verificationState} = 'pending'`),
    check(
      'mail_identities_text_lengths',
      sql`char_length(${table.address}) between 3 and 254 and ${table.address} = lower(${table.address}) and char_length(${table.displayName}) between 1 and 80 and (${table.replyTo} is null or (char_length(${table.replyTo}) between 3 and 254 and ${table.replyTo} = lower(${table.replyTo})))`,
    ),
    check(
      'mail_identities_verification',
      sql.raw(
        `verification_state in (${list(MAIL_IDENTITY_VERIFICATION_STATES)}) and (verified_method is null or verified_method in (${list(MAIL_IDENTITY_VERIFIED_METHODS)})) and ((verification_state = 'verified') = (verified_at is not null)) and verification_attempts between 0 and 5 and (verification_code_hash is null or char_length(verification_code_hash) <= 64) and (verification_message_id_hash is null or verification_message_id_hash ~ '^[0-9a-f]{64}$')`,
      ),
    ),
  ],
);

export type MailIdentityRow = typeof mailIdentities.$inferSelect;

export const mailFolders = pgTable(
  'mail_folders',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').notNull(),
    /** Nama server mentah (sudah didekode dari UTF-7 termodifikasi oleh klien IMAP). */
    path: text('path').notNull(),
    delimiter: text('delimiter'),
    name: text('name').notNull(),
    role: text('role'),
    roleSource: text('role_source'),
    /** Folder induk (tanpa FK: daftar folder diganti utuh saat LIST). */
    parentId: uuid('parent_id'),
    depth: integer('depth').notNull().default(0),
    selectable: boolean('selectable').notNull().default(true),
    subscribed: boolean('subscribed').notNull().default(true),
    syncEnabled: boolean('sync_enabled').notNull().default(true),
    uidvalidity: bigint('uidvalidity', { mode: 'number' }),
    uidnext: bigint('uidnext', { mode: 'number' }),
    highestModseq: numeric('highest_modseq'),
    totalCount: integer('total_count').notNull().default(0),
    unreadCount: integer('unread_count').notNull().default(0),
    /** Batas bawah `received_at` yang sudah dimuat (jendela sinkron / "Muat email lebih lama"). */
    oldestSyncedAt: timestamptz('oldest_synced_at'),
    /** Masih ada email di server yang lebih lama dari `oldest_synced_at`. */
    hasOlderOnServer: boolean('has_older_on_server').notNull().default(false),
    lastSyncedAt: timestamptz('last_synced_at'),
    lastFullFlagSweepAt: timestamptz('last_full_flag_sweep_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('mail_folders_organization_id_id_unique').on(table.organizationId, table.id),
    unique('mail_folders_account_id_path_unique').on(table.accountId, table.path),
    uniqueIndex('mail_folders_account_id_role_unique')
      .on(table.accountId, table.role)
      .where(sql`${table.role} is not null`),
    foreignKey({
      name: 'mail_folders_organization_id_account_id_fk',
      columns: [table.organizationId, table.accountId],
      foreignColumns: [mailAccounts.organizationId, mailAccounts.id],
    }).onDelete('cascade'),
    check(
      'mail_folders_known',
      sql.raw(
        `(role is null or role in (${list(MAIL_FOLDER_ROLES)})) and (role_source is null or role_source in (${list(MAIL_FOLDER_ROLE_SOURCES)})) and ((role is null) = (role_source is null))`,
      ),
    ),
    check(
      'mail_folders_text_lengths',
      sql`char_length(${table.path}) between 1 and 1000 and char_length(${table.name}) between 1 and 200 and (${table.delimiter} is null or char_length(${table.delimiter}) = 1) and ${table.depth} between 0 and 50 and ${table.totalCount} >= 0 and ${table.unreadCount} >= 0`,
    ),
  ],
);

export type MailFolderRow = typeof mailFolders.$inferSelect;
export type NewMailFolderRow = typeof mailFolders.$inferInsert;

export const MAIL_MESSAGE_WARNINGS = [
  'lookalike_sender',
  'impersonation',
  'link_mismatch',
  'dangerous_attachment',
] as const;
export const MAIL_BODY_STATES = ['none', 'loading', 'ready', 'too_large', 'error'] as const;
export const MAIL_PENDING_ACTIONS = ['flags', 'move', 'delete'] as const;
export type MailPendingAction = (typeof MAIL_PENDING_ACTIONS)[number];

export interface MailPendingRevert {
  isRead: boolean;
  isStarred: boolean;
}

/** Header + status (daftar ringan); isi di `mail_message_bodies`. */
export const mailMessages = pgTable(
  'mail_messages',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').notNull(),
    folderId: uuid('folder_id').notNull(),
    /** Salinan peran folder (saringan Belum dibaca/Berbintang tanpa join). */
    folderRole: text('folder_role'),
    uid: bigint('uid', { mode: 'number' }).notNull(),
    uidvalidity: bigint('uidvalidity', { mode: 'number' }).notNull(),
    messageIdHeader: text('message_id_header'),
    inReplyTo: text('in_reply_to'),
    references: text('references')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    fromAddress: text('from_address'),
    fromName: text('from_name'),
    senderAddress: text('sender_address'),
    replyTo: jsonb('reply_to').$type<MailAddressRow[]>(),
    to: jsonb('to').$type<MailAddressRow[]>().notNull().default([]),
    cc: jsonb('cc').$type<MailAddressRow[]>().notNull().default([]),
    /** Hanya pesan di folder `sent`/`drafts`. */
    bcc: jsonb('bcc').$type<MailAddressRow[]>(),
    toCount: integer('to_count').notNull().default(0),
    ccCount: integer('cc_count').notNull().default(0),
    deliveredTo: text('delivered_to'),
    subject: text('subject'),
    snippet: text('snippet'),
    sentAt: timestamptz('sent_at'),
    receivedAt: timestamptz('received_at').notNull(),
    isRead: boolean('is_read').notNull().default(false),
    isStarred: boolean('is_starred').notNull().default(false),
    isAnswered: boolean('is_answered').notNull().default(false),
    isDraft: boolean('is_draft').notNull().default(false),
    keywords: text('keywords')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    sizeBytes: integer('size_bytes').notNull().default(0),
    hasAttachments: boolean('has_attachments').notNull().default(false),
    senderVerification: text('sender_verification').notNull().default('unverified'),
    authDetails: jsonb('auth_details').$type<MailAuthDetails>(),
    warnings: text('warnings')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    bodyState: text('body_state').notNull().default('none'),
    /**
     * Aksi lokal yang belum tercermin di server (kontrak §9, bagian 2): `flags` (dibaca/bintang),
     * `move` (pindah/arsip/sampah/spam → `pending_target_folder_id`), `delete` (hapus permanen).
     * Pesan `move`/`delete` tidak tampil di daftar mana pun sampai diterapkan worker.
     */
    pendingAction: text('pending_action'),
    pendingActionAt: timestamptz('pending_action_at'),
    /** Folder tujuan aksi `move` yang tertunda (akun yang sama; tanpa FK — folder bisa dihapus LIST). */
    pendingTargetFolderId: uuid('pending_target_folder_id'),
    /** Bendera SEBELUM aksi tertunda pertama — dipakai mengembalikan bila server menolak. */
    pendingRevert: jsonb('pending_revert').$type<MailPendingRevert>(),
    bodystructure: jsonb('bodystructure').$type<unknown>(),
    /** 9B: kunci utas (`references[1]` → `in_reply_to` → `message_id_header` → `'id:' || id`). */
    threadRoot: text('thread_root'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index('mail_messages_thread_root_idx').on(
      table.organizationId,
      table.accountId,
      table.threadRoot,
      table.receivedAt.desc(),
    ),
    unique('mail_messages_organization_id_id_unique').on(table.organizationId, table.id),
    unique('mail_messages_folder_uid_unique').on(table.folderId, table.uidvalidity, table.uid),
    foreignKey({
      name: 'mail_messages_organization_id_account_id_fk',
      columns: [table.organizationId, table.accountId],
      foreignColumns: [mailAccounts.organizationId, mailAccounts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'mail_messages_organization_id_folder_id_fk',
      columns: [table.organizationId, table.folderId],
      foreignColumns: [mailFolders.organizationId, mailFolders.id],
    }).onDelete('cascade'),
    index('mail_messages_folder_received_idx').on(
      table.folderId,
      table.receivedAt.desc(),
      table.id.desc(),
    ),
    index('mail_messages_unread_idx')
      .on(table.organizationId, table.accountId, table.receivedAt.desc(), table.id.desc())
      .where(
        sql`not ${table.isRead} and ${table.folderRole} is distinct from 'junk' and ${table.folderRole} is distinct from 'trash'`,
      ),
    index('mail_messages_starred_idx')
      .on(table.organizationId, table.accountId, table.receivedAt.desc(), table.id.desc())
      .where(
        sql`${table.isStarred} and ${table.folderRole} is distinct from 'junk' and ${table.folderRole} is distinct from 'trash'`,
      ),
    index('mail_messages_account_message_id_idx').on(table.accountId, table.messageIdHeader),
    // Bagian 2: antrean aksi dua arah per akun (worker `mail-action`, tick cadangan).
    index('mail_messages_pending_idx')
      .on(table.accountId, table.pendingActionAt)
      .where(sql`${table.pendingAction} is not null`),
    check(
      'mail_messages_known',
      sql.raw(
        `sender_verification in ('pass', 'fail', 'unverified') and body_state in (${list(MAIL_BODY_STATES)}) and (folder_role is null or folder_role in (${list(MAIL_FOLDER_ROLES)})) and warnings <@ array[${list(MAIL_MESSAGE_WARNINGS)}]::text[] and (pending_action is null or pending_action in (${list(MAIL_PENDING_ACTIONS)})) and ((pending_action is null) = (pending_action_at is null)) and coalesce(pending_action = 'move', false) = (pending_target_folder_id is not null)`,
      ),
    ),
    check(
      'mail_messages_sizes',
      sql`(${table.messageIdHeader} is null or char_length(${table.messageIdHeader}) <= 998) and (${table.inReplyTo} is null or char_length(${table.inReplyTo}) <= 998) and cardinality(${table.references}) <= 20 and (${table.subject} is null or char_length(${table.subject}) <= 998) and (${table.snippet} is null or char_length(${table.snippet}) <= 200) and (${table.fromAddress} is null or char_length(${table.fromAddress}) <= 254) and (${table.fromName} is null or char_length(${table.fromName}) <= 200) and (${table.deliveredTo} is null or char_length(${table.deliveredTo}) <= 254) and jsonb_array_length(${table.to}) <= 100 and jsonb_array_length(${table.cc}) <= 100 and cardinality(${table.keywords}) <= 50 and ${table.uid} > 0 and ${table.sizeBytes} >= 0 and (${table.threadRoot} is null or char_length(${table.threadRoot}) <= 998)`,
    ),
  ],
);

export type MailMessageRow = typeof mailMessages.$inferSelect;
export type NewMailMessageRow = typeof mailMessages.$inferInsert;

/** Isi email (diambil saat dibuka, bagian 2). Dipangkas retensi cache. */
export const mailMessageBodies = pgTable(
  'mail_message_bodies',
  {
    messageId: uuid('message_id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    text: text('text'),
    htmlSanitized: text('html_sanitized'),
    remoteImages: jsonb('remote_images').$type<string[]>().notNull().default([]),
    linkWarnings: integer('link_warnings').notNull().default(0),
    rawHeaders: text('raw_headers'),
    fetchedAt: timestamptz('fetched_at').notNull().defaultNow(),
    lastOpenedAt: timestamptz('last_opened_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'mail_message_bodies_organization_id_message_id_fk',
      columns: [table.organizationId, table.messageId],
      foreignColumns: [mailMessages.organizationId, mailMessages.id],
    }).onDelete('cascade'),
    check(
      'mail_message_bodies_sizes',
      sql`(${table.text} is null or octet_length(${table.text}) <= 1048576) and (${table.htmlSanitized} is null or octet_length(${table.htmlSanitized}) <= 2097152) and jsonb_array_length(${table.remoteImages}) <= 200 and (${table.rawHeaders} is null or octet_length(${table.rawHeaders}) <= 65536) and ${table.linkWarnings} >= 0`,
    ),
  ],
);

export const mailAttachments = pgTable(
  'mail_attachments',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    messageId: uuid('message_id').notNull(),
    partId: text('part_id').notNull(),
    filename: text('filename'),
    declaredType: text('declared_type'),
    detectedType: text('detected_type'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    contentId: text('content_id'),
    isInline: boolean('is_inline').notNull().default(false),
    risk: text('risk').notNull().default('ok'),
    riskReason: text('risk_reason'),
    /** Media store folder `mail/`; `null` = belum diunduh / sudah dipangkas. */
    storageKey: text('storage_key'),
    fetchedAt: timestamptz('fetched_at'),
    expiresAt: timestamptz('expires_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('mail_attachments_organization_id_id_unique').on(table.organizationId, table.id),
    unique('mail_attachments_message_id_part_id_unique').on(table.messageId, table.partId),
    foreignKey({
      name: 'mail_attachments_organization_id_message_id_fk',
      columns: [table.organizationId, table.messageId],
      foreignColumns: [mailMessages.organizationId, mailMessages.id],
    }).onDelete('cascade'),
    index('mail_attachments_expires_at_idx')
      .on(table.expiresAt)
      .where(sql`${table.storageKey} is not null`),
    // Review 9A-2 S7: kuota cache per organisasi/akun dihitung dari baris yang TERSIMPAN saja.
    index('mail_attachments_cached_org_idx')
      .on(table.organizationId, table.messageId)
      .where(sql`${table.storageKey} is not null`),
    check(
      'mail_attachments_known',
      sql`${table.risk} in ('ok', 'warn', 'blocked') and char_length(${table.partId}) between 1 and 64 and (${table.filename} is null or char_length(${table.filename}) <= 255) and (${table.declaredType} is null or char_length(${table.declaredType}) <= 255) and (${table.contentId} is null or char_length(${table.contentId}) <= 998) and ${table.sizeBytes} >= 0`,
    ),
  ],
);

/** "Selalu tampilkan gambar dari pengirim ini" — per PENGGUNA (preferensi privasi pribadi). */
export const mailRemoteImageAllow = pgTable(
  'mail_remote_image_allow',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').notNull(),
    senderAddress: text('sender_address').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'mail_remote_image_allow_organization_id_user_id_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    unique('mail_remote_image_allow_user_sender_unique').on(table.userId, table.senderAddress),
    check(
      'mail_remote_image_allow_sender',
      sql`char_length(${table.senderAddress}) between 3 and 254 and ${table.senderAddress} = lower(${table.senderAddress})`,
    ),
  ],
);

/**
 * Review 9A-2 S5/R8: cache proksi gambar luar email (kontrak §8 "disimpan sementara 24 jam"). Kunci =
 * akun + `sha256(url)` (tanpa URL mentah); berkas di media store folder `mail/`. Kedaluwarsa = 24 jam
 * (dipangkas `mail-cache-retention`, dihapus ikut putus akun). Kuota per organisasi di api.
 */
export const mailRemoteImageCache = pgTable(
  'mail_remote_image_cache',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').notNull(),
    urlHash: text('url_hash').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    fetchedAt: timestamptz('fetched_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'mail_remote_image_cache_organization_id_account_id_fk',
      columns: [table.organizationId, table.accountId],
      foreignColumns: [mailAccounts.organizationId, mailAccounts.id],
    }).onDelete('cascade'),
    unique('mail_remote_image_cache_account_url_unique').on(table.accountId, table.urlHash),
    index('mail_remote_image_cache_org_expires_idx').on(table.organizationId, table.expiresAt),
    index('mail_remote_image_cache_expires_idx').on(table.expiresAt),
    check(
      'mail_remote_image_cache_values',
      sql`${table.urlHash} ~ '^[0-9a-f]{64}$' and ${table.storageKey} ~ '^mail/[0-9a-f-]{36}$' and ${table.contentType} in ('image/png', 'image/jpeg', 'image/gif', 'image/webp') and ${table.sizeBytes} between 0 and 5242880`,
    ),
  ],
);

export type MailRemoteImageCacheRow = typeof mailRemoteImageCache.$inferSelect;

/** Pengaturan email satu organisasi (retensi cache, jendela sinkron bawaan). Tanpa baris = bawaan. */
export const mailSettings = pgTable(
  'mail_settings',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    cacheRetentionDays: integer('cache_retention_days').notNull().default(90),
    defaultSyncWindowDays: integer('default_sync_window_days').default(90),
    /** 9B: Kepada + Cc + Bcc per email (1–100). */
    maxRecipientsPerEmail: integer('max_recipients_per_email').notNull().default(50),
    /** 9B: total lampiran per email (MB, 1–25). */
    maxAttachmentTotalMb: integer('max_attachment_total_mb').notNull().default(20),
    updatedByUserId: uuid('updated_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    primaryKey({ name: 'mail_settings_pk', columns: [table.organizationId] }),
    foreignKey({
      name: 'mail_settings_organization_id_updated_by_user_id_fk',
      columns: [table.organizationId, table.updatedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check(
      'mail_settings_numbers',
      sql`${table.cacheRetentionDays} between 7 and 3650 and (${table.defaultSyncWindowDays} is null or ${table.defaultSyncWindowDays} in (30, 90, 365)) and ${table.maxRecipientsPerEmail} between 1 and 100 and ${table.maxAttachmentTotalMb} between 1 and 25`,
    ),
  ],
);

export type MailSettingsRow = typeof mailSettings.$inferSelect;

// ── Tahap 9B: tulis, balas, teruskan (KONTRAK-API-EMAIL-TULIS §2) ─────────────

/**
 * Tanda tangan: `owner_user_id` `null` = BERSAMA (per akun); terisi = PRIBADI pengguna itu untuk akun
 * itu. HTML sudah lewat profil editor. Logo PNG ≤ 320 px, ≤ 128 KB (inline `cid:sig-logo-<id>`).
 */
export const mailSignatures = pgTable(
  'mail_signatures',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').notNull(),
    ownerUserId: uuid('owner_user_id'),
    name: text('name').notNull(),
    html: text('html').notNull(),
    text: text('text').notNull(),
    logoPng: bytea('logo_png'),
    logoSha256: text('logo_sha256'),
    createdByUserId: uuid('created_by_user_id'),
    updatedByUserId: uuid('updated_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('mail_signatures_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'mail_signatures_organization_id_account_id_fk',
      columns: [table.organizationId, table.accountId],
      foreignColumns: [mailAccounts.organizationId, mailAccounts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'mail_signatures_organization_id_owner_user_id_fk',
      columns: [table.organizationId, table.ownerUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'mail_signatures_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'mail_signatures_organization_id_updated_by_user_id_fk',
      columns: [table.organizationId, table.updatedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    index('mail_signatures_account_owner_idx').on(
      table.organizationId,
      table.accountId,
      table.ownerUserId,
    ),
    check(
      'mail_signatures_sizes',
      sql`char_length(${table.name}) between 1 and 60 and octet_length(${table.html}) <= 32768 and octet_length(${table.text}) <= 8192 and (${table.logoPng} is null or octet_length(${table.logoPng}) between 1 and 131072) and ((${table.logoPng} is null) = (${table.logoSha256} is null)) and (${table.logoSha256} is null or ${table.logoSha256} ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

export type MailSignatureRow = typeof mailSignatures.$inferSelect;

/** Pilihan tanda tangan per identitas: `null` = ikut bawaan identitas; `"none"` = tanpa. */
export type MailSignatureChoicesRow = Record<
  string,
  /** ID tanda tangan, `"none"` (tanpa tanda tangan), atau `null` (ikut bawaan identitas). */
  { new?: string | null; reply?: string | null }
>;

/** Preferensi tulis PRIBADI pengguna (batalkan kirim, format, pilihan tanda tangan). */
export const mailUserPreferences = pgTable(
  'mail_user_preferences',
  {
    userId: uuid('user_id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    undoSendSeconds: integer('undo_send_seconds').notNull().default(10),
    composeFormat: text('compose_format').notNull().default('html'),
    signatureChoices: jsonb('signature_choices')
      .$type<MailSignatureChoicesRow>()
      .notNull()
      .default({}),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'mail_user_preferences_organization_id_user_id_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    check(
      'mail_user_preferences_values',
      sql.raw(
        `undo_send_seconds between 5 and 30 and compose_format in (${list(MAIL_COMPOSE_FORMATS)}) and jsonb_typeof(signature_choices) = 'object'`,
      ),
    ),
  ],
);

/** Salinan email asli di draf (balasan tetap benar walau cache email dipangkas). */
export interface MailSourceSnapshotRow {
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  from: MailAddressRow | null;
  to: MailAddressRow[];
  cc: MailAddressRow[];
  replyTo: MailAddressRow[];
  subject: string | null;
  sentAt: string | null;
  folderRole: string | null;
}

export interface MailSendErrorRow {
  reason: string;
  message: string;
  at: string;
}

/**
 * Draf email: PRIBADI pembuatnya (juga di akun bersama, juga terhadap Owner). Database = kebenaran;
 * salinan di folder Draf server (`server_*`) diganti tiap sinkron. `state = sending` selama ada outbox
 * aktif. `version` naik tiap simpan (konkurensi optimistis).
 */
export const mailDrafts = pgTable(
  'mail_drafts',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').notNull(),
    identityId: uuid('identity_id').notNull(),
    ownerUserId: uuid('owner_user_id').notNull(),
    mode: text('mode').notNull(),
    sourceMessageId: uuid('source_message_id').references((): AnyPgColumn => mailMessages.id, {
      onDelete: 'set null',
    }),
    sourceSnapshot: jsonb('source_snapshot').$type<MailSourceSnapshotRow>(),
    threadRoot: text('thread_root'),
    threadSeenAt: timestamptz('thread_seen_at'),
    to: jsonb('to').$type<MailAddressRow[]>().notNull().default([]),
    cc: jsonb('cc').$type<MailAddressRow[]>().notNull().default([]),
    bcc: jsonb('bcc').$type<MailAddressRow[]>().notNull().default([]),
    subject: text('subject').notNull().default(''),
    format: text('format').notNull().default('html'),
    bodyHtml: text('body_html'),
    bodyText: text('body_text'),
    includeQuote: boolean('include_quote').notNull().default(false),
    state: text('state').notNull().default('editing'),
    version: integer('version').notNull().default(1),
    lastSendError: jsonb('last_send_error').$type<MailSendErrorRow>(),
    /** 128 bit acak (base32) — bagian `Message-ID` salinan di folder Draf server. */
    serverRef: text('server_ref').notNull(),
    /** Folder Draf server (tanpa FK: daftar folder diganti utuh saat LIST). */
    serverFolderId: uuid('server_folder_id'),
    serverUid: bigint('server_uid', { mode: 'number' }),
    serverUidvalidity: bigint('server_uidvalidity', { mode: 'number' }),
    serverMessageId: text('server_message_id'),
    serverSyncedVersion: integer('server_synced_version'),
    serverSyncState: text('server_sync_state').notNull().default('pending'),
    serverSyncedAt: timestamptz('server_synced_at'),
    serverErrorCode: text('server_error_code'),
    /** Template email terakhir yang disisipkan (statistik `last_used_at`; tanpa FK). */
    templateId: uuid('template_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('mail_drafts_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'mail_drafts_organization_id_account_id_fk',
      columns: [table.organizationId, table.accountId],
      foreignColumns: [mailAccounts.organizationId, mailAccounts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'mail_drafts_organization_id_identity_id_fk',
      columns: [table.organizationId, table.identityId],
      foreignColumns: [mailIdentities.organizationId, mailIdentities.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'mail_drafts_organization_id_owner_user_id_fk',
      columns: [table.organizationId, table.ownerUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    index('mail_drafts_owner_updated_idx').on(
      table.organizationId,
      table.ownerUserId,
      table.updatedAt.desc(),
    ),
    index('mail_drafts_account_thread_idx').on(table.accountId, table.threadRoot),
    index('mail_drafts_server_pending_idx')
      .on(table.serverSyncState, table.updatedAt)
      .where(sql`${table.serverSyncState} = 'pending'`),
    unique('mail_drafts_server_ref_unique').on(table.serverRef),
    check(
      'mail_drafts_known',
      sql.raw(
        `mode in (${list(MAIL_DRAFT_MODES)}) and format in (${list(MAIL_COMPOSE_FORMATS)}) and state in (${list(MAIL_DRAFT_STATES)}) and server_sync_state in (${list(MAIL_DRAFT_SERVER_SYNC_STATES)}) and version >= 1`,
      ),
    ),
    check(
      'mail_drafts_sizes',
      sql`char_length(${table.subject}) <= 200 and (${table.bodyHtml} is null or octet_length(${table.bodyHtml}) <= 262144) and (${table.bodyText} is null or octet_length(${table.bodyText}) <= 131072) and jsonb_array_length(${table.to}) <= 100 and jsonb_array_length(${table.cc}) <= 100 and jsonb_array_length(${table.bcc}) <= 100 and (${table.threadRoot} is null or char_length(${table.threadRoot}) <= 998) and ${table.serverRef} ~ '^[a-z2-7]{26}$' and (${table.serverMessageId} is null or char_length(${table.serverMessageId}) <= 998) and (${table.serverErrorCode} is null or char_length(${table.serverErrorCode}) <= 64)`,
    ),
  ],
);

export type MailDraftRow = typeof mailDrafts.$inferSelect;
export type NewMailDraftRow = typeof mailDrafts.$inferInsert;

/**
 * Lampiran draf: berkas di media store (`email-out/<uuid>`, nama acak), jenis dari ISI (daftar izin
 * keluar 9.1), nama dibersihkan. `inline` = gambar di badan (`content_id` `img-<8 hex>`).
 */
export const mailDraftAttachments = pgTable(
  'mail_draft_attachments',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    draftId: uuid('draft_id').notNull(),
    position: integer('position').notNull().default(0),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    sha256: text('sha256'),
    storageKey: text('storage_key'),
    source: text('source').notNull(),
    sourceAttachmentId: uuid('source_attachment_id').references(
      (): AnyPgColumn => mailAttachments.id,
      { onDelete: 'set null' },
    ),
    state: text('state').notNull().default('ready'),
    failureCode: text('failure_code'),
    inline: boolean('inline').notNull().default(false),
    contentId: text('content_id'),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'mail_draft_attachments_organization_id_draft_id_fk',
      columns: [table.organizationId, table.draftId],
      foreignColumns: [mailDrafts.organizationId, mailDrafts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'mail_draft_attachments_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    index('mail_draft_attachments_draft_idx').on(table.draftId, table.position),
    uniqueIndex('mail_draft_attachments_content_id_unique')
      .on(table.draftId, table.contentId)
      .where(sql`${table.contentId} is not null`),
    check(
      'mail_draft_attachments_known',
      sql.raw(
        `source in (${list(MAIL_ATTACHMENT_SOURCES)}) and state in (${list(MAIL_DRAFT_ATTACHMENT_STATES)}) and size_bytes between 0 and 26214400 and char_length(filename) between 1 and 255 and char_length(content_type) between 3 and 128 and (sha256 is null or sha256 ~ '^[0-9a-f]{64}$') and (storage_key is null or storage_key ~ '^(email-out|mail-out)/[0-9a-f-]{36}$') and (content_id is null or content_id ~ '^[A-Za-z0-9._-]{1,64}$') and (failure_code is null or char_length(failure_code) <= 64) and (state <> 'ready' or storage_key is not null)`,
      ),
    ),
  ],
);

export type MailDraftAttachmentRow = typeof mailDraftAttachments.$inferSelect;

/**
 * Outbox kirim menu Email — TERPISAH dari `email_outbound` 9.1 (Riwayat kirim API, webhook `email.*`
 * tidak boleh melihat email pribadi tim). Satu baris per permintaan kirim; `pending` = masa batal
 * (`send_after`). Klaim worker: `FOR UPDATE SKIP LOCKED` hanya bila `send_after <= now()`; batal =
 * pembaruan bersyarat — siapa pun yang commit dulu menang. Isi FINAL dibekukan saat kirim.
 */
export const mailOutbox = pgTable(
  'mail_outbox',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').notNull(),
    identityId: uuid('identity_id').references((): AnyPgColumn => mailIdentities.id, {
      onDelete: 'set null',
    }),
    draftId: uuid('draft_id').references((): AnyPgColumn => mailDrafts.id, {
      onDelete: 'set null',
    }),
    createdByUserId: uuid('created_by_user_id').notNull(),
    mode: text('mode').notNull(),
    fromAddress: text('from_address').notNull(),
    fromName: text('from_name').notNull(),
    replyTo: text('reply_to'),
    envelopeFrom: text('envelope_from').notNull(),
    to: jsonb('to').$type<MailAddressRow[]>().notNull().default([]),
    cc: jsonb('cc').$type<MailAddressRow[]>().notNull().default([]),
    bcc: jsonb('bcc').$type<MailAddressRow[]>().notNull().default([]),
    recipientCount: integer('recipient_count').notNull(),
    newRecipientCount: integer('new_recipient_count').notNull().default(0),
    attachmentCount: integer('attachment_count').notNull().default(0),
    subject: text('subject'),
    html: text('html'),
    text: text('text'),
    messageIdHeader: text('message_id_header').notNull(),
    inReplyTo: text('in_reply_to'),
    references: text('references')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text('status').notNull().default('pending'),
    sendAfter: timestamptz('send_after').notNull(),
    nextAttemptAt: timestamptz('next_attempt_at'),
    attempts: integer('attempts').notNull().default(0),
    sendingStartedAt: timestamptz('sending_started_at'),
    sentAt: timestamptz('sent_at'),
    failedAt: timestamptz('failed_at'),
    canceledAt: timestamptz('canceled_at'),
    failureReason: text('failure_reason'),
    smtpCode: integer('smtp_code'),
    rejectedRecipients: jsonb('rejected_recipients').$type<string[]>().notNull().default([]),
    holdReason: text('hold_reason'),
    /** Media store `email-out/<uuid>`: MIME final ber-Bcc untuk salinan Terkirim (≤ 7 hari). */
    rawStorageKey: text('raw_storage_key'),
    sentCopyState: text('sent_copy_state').notNull().default('pending'),
    sentCopyAttempts: integer('sent_copy_attempts').notNull().default(0),
    sentCopyNextAt: timestamptz('sent_copy_next_at'),
    sentCopyAt: timestamptz('sent_copy_at'),
    sentMessageId: uuid('sent_message_id').references((): AnyPgColumn => mailMessages.id, {
      onDelete: 'set null',
    }),
    /** Jatah `mail-alamat-baru` yang diambil saat kirim (dikembalikan saat batal). */
    newAddressUnits: integer('new_address_units').notNull().default(0),
    templateId: uuid('template_id'),
    bodyPurgedAt: timestamptz('body_purged_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('mail_outbox_organization_id_id_unique').on(table.organizationId, table.id),
    unique('mail_outbox_organization_id_message_id_header_unique').on(
      table.organizationId,
      table.messageIdHeader,
    ),
    foreignKey({
      name: 'mail_outbox_organization_id_account_id_fk',
      columns: [table.organizationId, table.accountId],
      foreignColumns: [mailAccounts.organizationId, mailAccounts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'mail_outbox_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    index('mail_outbox_due_idx')
      .on(table.status, table.sendAfter, table.nextAttemptAt)
      .where(sql`${table.status} in ('pending', 'queued')`),
    // Idempotensi klik ganda: satu outbox AKTIF per draf.
    uniqueIndex('mail_outbox_active_draft_unique')
      .on(table.draftId)
      .where(sql`${table.status} in ('pending', 'queued', 'sending')`),
    index('mail_outbox_account_sent_idx').on(table.organizationId, table.accountId, table.sentAt),
    index('mail_outbox_creator_idx').on(
      table.organizationId,
      table.createdByUserId,
      table.createdAt,
    ),
    index('mail_outbox_sent_copy_idx')
      .on(table.sentCopyState, table.sentCopyNextAt)
      .where(sql`${table.status} = 'sent' and ${table.sentCopyState} = 'pending'`),
    check(
      'mail_outbox_known',
      sql.raw(
        `status in (${list(MAIL_OUTBOX_STATUSES)}) and mode in (${list(MAIL_DRAFT_MODES)}) and (failure_reason is null or failure_reason in (${list(MAIL_SEND_FAILURE_REASONS)})) and (hold_reason is null or hold_reason in (${list(MAIL_OUTBOX_HOLD_REASONS)})) and sent_copy_state in (${list(MAIL_SENT_COPY_STATES)}) and ((status = 'failed') = (failure_reason is not null))`,
      ),
    ),
    check(
      'mail_outbox_sizes',
      sql`${table.recipientCount} between 1 and 100 and ${table.newRecipientCount} >= 0 and ${table.attempts} >= 0 and ${table.attachmentCount} between 0 and 20 and ${table.newAddressUnits} >= 0 and (${table.subject} is null or char_length(${table.subject}) <= 200) and (${table.html} is null or octet_length(${table.html}) <= 524288) and (${table.text} is null or octet_length(${table.text}) <= 262144) and char_length(${table.messageIdHeader}) between 3 and 998 and (${table.inReplyTo} is null or char_length(${table.inReplyTo}) <= 998) and cardinality(${table.references}) <= 20 and char_length(${table.fromAddress}) between 3 and 254 and char_length(${table.fromName}) between 1 and 80 and (${table.rawStorageKey} is null or ${table.rawStorageKey} ~ '^(email-out|mail-out)/[0-9a-f-]{36}$') and jsonb_array_length(${table.rejectedRecipients}) <= 100`,
    ),
  ],
);

export type MailOutboxRow = typeof mailOutbox.$inferSelect;
export type NewMailOutboxRow = typeof mailOutbox.$inferInsert;

/**
 * Korespondensi per akun (pelengkap penerima + "alamat baru"): From email masuk yang tidak `fail`
 * (`received_count`) dan penerima email terkirim (`sent_count`). Maks. 20.000 per akun.
 */
export const mailCorrespondents = pgTable(
  'mail_correspondents',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id').notNull(),
    address: text('address').notNull(),
    name: text('name'),
    sentCount: integer('sent_count').notNull().default(0),
    receivedCount: integer('received_count').notNull().default(0),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'mail_correspondents_organization_id_account_id_fk',
      columns: [table.organizationId, table.accountId],
      foreignColumns: [mailAccounts.organizationId, mailAccounts.id],
    }).onDelete('cascade'),
    unique('mail_correspondents_account_id_address_unique').on(table.accountId, table.address),
    index('mail_correspondents_prefix_idx').on(
      table.organizationId,
      table.accountId,
      table.address.op('text_pattern_ops'),
    ),
    check(
      'mail_correspondents_values',
      sql`char_length(${table.address}) between 3 and 254 and ${table.address} = lower(${table.address}) and (${table.name} is null or char_length(${table.name}) <= 200) and ${table.sentCount} >= 0 and ${table.receivedCount} >= 0`,
    ),
  ],
);
