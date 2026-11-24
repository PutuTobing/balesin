import { CHANNEL_TYPES, type BotHours, type WhatsAppNumberSummary } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { departments } from './departments';
import { organizations } from './organizations';
import { users } from './users';

/** Jenis channel. Daftarnya dari `@balesin/shared` supaya api, web, dan DB sama. */
export const channelType = pgEnum('channel_type', CHANNEL_TYPES);

/**
 * Channel inbox per organisasi (PRD §3.2, ARCHITECTURE.md §3). Tiap jenis channel punya kolomnya
 * sendiri berawalan jenisnya: `wa_*` WhatsApp Cloud API, `tg_*` Telegram Bot, `email_*` Email
 * (IMAP + SMTP), `meta_*` Messenger/Instagram (Fase 6, docs/KONTRAK-API-CHANNEL-LAIN.md).
 *
 * Rahasia (SECURITY.md §3) hanya disimpan sebagai hasil `SecretBox.encrypt` (AES-256-GCM) dengan
 * konteks organisasi + `channels.<kolom>` + ID channel ini (`subjectId`): teks sandi yang disalin
 * ke channel/organisasi/kolom lain tidak bisa dibuka. Kolom `*_tail` = ekor untuk petunjuk tersamar
 * di UI (`secretTail`). Verify token webhook juga dienkripsi (bukan di-hash) karena harus bisa
 * ditampilkan lagi kepada Owner/Admin untuk disalin ke Meta.
 *
 * Hapus = HAPUS LUNAK: `deleted_at` diisi dan semua kolom rahasia dikosongkan (dimusnahkan),
 * barisnya tetap supaya percakapan/pesan (fase berikutnya) masih bisa merujuknya.
 */
export const channels = pgTable(
  'channels',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    type: channelType('type').notNull(),
    name: text('name').notNull(),
    /** `false` = dinonaktifkan Owner/Admin: tidak menerima/mengirim pesan. */
    enabled: boolean('enabled').notNull().default(true),
    /**
     * Kapan dinonaktifkan (UI: "dinonaktifkan sejak …"); `null` saat aktif. Diisi bersama
     * `enabled = false` dan dikosongkan saat diaktifkan kembali. Bisa `null` untuk channel nonaktif
     * yang dibuat langsung di database (data uji), jadi tidak dikunci CHECK.
     */
    disabledAt: timestamptz('disabled_at'),

    // ── WhatsApp Cloud API ────────────────────────────────────────────────
    /** Phone Number ID dari Meta (angka; BUKAN UUID). */
    waPhoneNumberId: text('wa_phone_number_id'),
    /** WhatsApp Business Account ID dari Meta (angka; BUKAN UUID). */
    waBusinessAccountId: text('wa_business_account_id'),
    /** Token System User — konteks `channels.wa_access_token`. */
    waAccessTokenEncrypted: text('wa_access_token_encrypted'),
    waAccessTokenTail: text('wa_access_token_tail'),
    /** App Secret aplikasi Meta — konteks `channels.wa_app_secret`. */
    waAppSecretEncrypted: text('wa_app_secret_encrypted'),
    waAppSecretTail: text('wa_app_secret_tail'),
    /** Verify token webhook (acak, dibuat server) — konteks `channels.wa_webhook_verify_token`. */
    waVerifyTokenEncrypted: text('wa_verify_token_encrypted'),
    waVerifyTokenRotatedAt: timestamptz('wa_verify_token_rotated_at'),
    /** Data nomor dari tes BERHASIL terakhir (divalidasi `whatsAppNumberSummarySchema` saat dibaca). */
    waNumberSummary: jsonb('wa_number_summary').$type<WhatsAppNumberSummary>(),

    // ── Telegram Bot (Fase 6) ─────────────────────────────────────────────
    /** ID bot (angka sebelum `:` di token, dibenarkan `getMe`). */
    tgBotId: text('tg_bot_id'),
    /** `@username` bot tanpa `@` (dari `getMe`; tampilan saja). */
    tgBotUsername: text('tg_bot_username'),
    /** Token bot — konteks `channels.tg_bot_token`. TERPISAH dari token alarm Telegram. */
    tgBotTokenEncrypted: text('tg_bot_token_encrypted'),
    tgBotTokenTail: text('tg_bot_token_tail'),
    /** `secret_token` webhook (acak, dibuat server) — konteks `channels.tg_webhook_secret`. */
    tgWebhookSecretEncrypted: text('tg_webhook_secret_encrypted'),
    /** Terakhir `setWebhook` berhasil (secret di atas sudah dipakai Telegram). */
    tgWebhookRegisteredAt: timestamptz('tg_webhook_registered_at'),

    // ── Email IMAP + SMTP (Fase 6) ────────────────────────────────────────
    /** Alamat kotak masuk channel (huruf kecil). Juga alamat "From" balasan (SMTP terpisah). */
    emailAddress: text('email_address'),
    emailFromName: text('email_from_name'),
    emailImapHost: text('email_imap_host'),
    emailImapPort: integer('email_imap_port'),
    /** `ssl` | `starttls` (TLS wajib). */
    emailImapSecurity: text('email_imap_security'),
    emailImapUsername: text('email_imap_username'),
    /** Konteks `channels.email_imap_password`. */
    emailImapPasswordEncrypted: text('email_imap_password_encrypted'),
    emailImapPasswordTail: text('email_imap_password_tail'),
    emailImapFolder: text('email_imap_folder'),
    emailPollIntervalMinutes: integer('email_poll_interval_minutes'),
    /**
     * Review Fase 6 R1: `authserv-id` server penerima yang hasil `Authentication-Results`-nya
     * dipercaya untuk verifikasi pengirim. `null` = bawaan dari host IMAP
     * (`defaultTrustedAuthServIds`). Entri berawalan `.` = domain itu beserta subdomainnya.
     */
    emailTrustedAuthServIds: text('email_trusted_auth_serv_ids').array(),
    /**
     * Tahap 9.0: alias lain yang masuk ke kotak surat channel ini (huruf kecil, maks. 20; selain
     * `email_address`). Dipakai menentukan "alamat tujuan" email masuk dan dibuang dari "Balas semua".
     */
    emailAliases: text('email_aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    emailMarkAsRead: boolean('email_mark_as_read'),
    /** `system` = pakai Pengaturan → Email pengirim; `custom` = akun SMTP di bawah. */
    emailSmtpMode: text('email_smtp_mode'),
    emailSmtpHost: text('email_smtp_host'),
    emailSmtpPort: integer('email_smtp_port'),
    /** `ssl` | `starttls` | `none` (`none` ditolak api di production). */
    emailSmtpSecurity: text('email_smtp_security'),
    emailSmtpUsername: text('email_smtp_username'),
    /** Konteks `channels.email_smtp_password`. */
    emailSmtpPasswordEncrypted: text('email_smtp_password_encrypted'),
    emailSmtpPasswordTail: text('email_smtp_password_tail'),

    // ── Messenger & Instagram DM (Fase 6, nonaktif bawaan — butuh App Review Meta) ──
    /** ID Halaman Facebook (Messenger; Instagram: Halaman yang terhubung). */
    metaPageId: text('meta_page_id'),
    /** ID akun Instagram profesional (Instagram saja). */
    metaIgAccountId: text('meta_ig_account_id'),
    /** Page Access Token — konteks `channels.meta_page_token`. */
    metaPageTokenEncrypted: text('meta_page_token_encrypted'),
    metaPageTokenTail: text('meta_page_token_tail'),
    /** App Secret aplikasi Meta — konteks `channels.meta_app_secret`. */
    metaAppSecretEncrypted: text('meta_app_secret_encrypted'),
    metaAppSecretTail: text('meta_app_secret_tail'),
    /** Verify token webhook — konteks `channels.meta_webhook_verify_token`. */
    metaVerifyTokenEncrypted: text('meta_verify_token_encrypted'),
    metaVerifyTokenRotatedAt: timestamptz('meta_verify_token_rotated_at'),

    // ── Hasil tes koneksi terakhir ────────────────────────────────────────
    lastTestOk: boolean('last_test_ok'),
    /** `CHANNEL_TEST_CODES` — bukan jawaban mentah Meta. */
    lastTestCode: text('last_test_code'),
    lastTestedAt: timestamptz('last_tested_at'),

    /**
     * Terakhir kredensial/ID diganti. Hasil tes hanya dicatat bila nilai ini belum berubah sejak tes
     * dimulai (tes atas kredensial lama tidak menimpa status kredensial baru).
     */
    credentialsUpdatedAt: timestamptz('credentials_updated_at').notNull().defaultNow(),
    createdByUserId: uuid('created_by_user_id'),
    updatedByUserId: uuid('updated_by_user_id'),
    deletedAt: timestamptz('deleted_at'),
    /**
     * Bot eksternal (Fase 3): percakapan BARU masuk status `bot` bila aktif + dalam jam kerja bot
     * (`bot_hours`, zona organisasi). `bot_timeout_minutes` = menit tanpa balasan bot sebelum
     * otomatis ke antrian (`null` = tanpa batas).
     */
    botEnabled: boolean('bot_enabled').notNull().default(false),
    botHours: jsonb('bot_hours').$type<BotHours>().notNull().default({ mode: 'always' }),
    botTimeoutMinutes: integer('bot_timeout_minutes'),
    botSettingsUpdatedAt: timestamptz('bot_settings_updated_at'),
    /**
     * Email saja (DECISIONS 2026-11-19 P2-1): bot hanya melayani email yang lolos verifikasi pengirim
     * (`pass`); `unverified` ikut langsung ke antrian manusia. Bawaan mati.
     */
    botRequireVerifiedSender: boolean('bot_require_verified_sender').notNull().default(false),
    /**
     * Fase 5: percakapan BARU dari pelanggan di channel ini langsung masuk departemen ini
     * (diatur dari Pengaturan → Departemen). Kosong = tanpa departemen.
     */
    defaultDepartmentId: uuid('default_department_id'),
    /**
     * Tahap 9.0 "Akses per channel": `false` = semua tim (bawaan); `true` = hanya departemen/pengguna
     * di `channel_access_departments`/`channel_access_users` (Owner/Admin selalu melihat semua).
     * Ditegakkan `channelAccessSql` (packages/db `access.ts`) di semua query percakapan sesi.
     */
    accessRestricted: boolean('access_restricted').notNull().default(false),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    check(
      'channels_bot_timeout_range',
      sql`${table.botTimeoutMinutes} is null or ${table.botTimeoutMinutes} between 1 and 1440`,
    ),
    check(
      'channels_bot_verified_sender_email_only',
      sql`${table.type} = 'email' or not ${table.botRequireVerifiedSender}`,
    ),
    // Review bot R1: bot aktif selalu punya batas waktu (pelanggan tidak terjebak di bot).
    check(
      'channels_bot_enabled_has_timeout',
      sql`not ${table.botEnabled} or ${table.botTimeoutMinutes} is not null`,
    ),
    // Sasaran FK komposit (organization_id, id) untuk tabel percakapan/pesan nanti.
    unique('channels_organization_id_id_unique').on(table.organizationId, table.id),
    // Satu nomor hanya boleh menjadi satu channel hidup per organisasi.
    uniqueIndex('channels_organization_id_wa_phone_number_id_live_unique')
      .on(table.organizationId, table.waPhoneNumberId)
      .where(sql`${table.deletedAt} is null and ${table.type} = 'whatsapp'`),
    index('channels_organization_id_created_at_idx').on(table.organizationId, table.createdAt),
    foreignKey({
      name: 'channels_organization_id_default_department_id_fk',
      columns: [table.organizationId, table.defaultDepartmentId],
      foreignColumns: [departments.organizationId, departments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'channels_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'channels_organization_id_updated_by_user_id_fk',
      columns: [table.organizationId, table.updatedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check('channels_name_length', sql`char_length(${table.name}) between 1 and 60`),
    check(
      'channels_wa_ids_numeric',
      sql`(${table.waPhoneNumberId} is null or ${table.waPhoneNumberId} ~ '^[0-9]{1,32}$') and (${table.waBusinessAccountId} is null or ${table.waBusinessAccountId} ~ '^[0-9]{1,32}$')`,
    ),
    // Channel WhatsApp yang hidup selalu lengkap: ID, token, App Secret, verify token.
    check(
      'channels_whatsapp_live_complete',
      sql`${table.type} <> 'whatsapp' or ${table.deletedAt} is not null or (${table.waPhoneNumberId} is not null and ${table.waBusinessAccountId} is not null and ${table.waAccessTokenEncrypted} is not null and ${table.waAppSecretEncrypted} is not null and ${table.waVerifyTokenEncrypted} is not null and ${table.waVerifyTokenRotatedAt} is not null)`,
    ),
    // Channel terhapus tidak menyimpan rahasia apa pun (semua jenis channel).
    check(
      'channels_deleted_without_secrets',
      sql`${table.deletedAt} is null or (${table.waAccessTokenEncrypted} is null and ${table.waAppSecretEncrypted} is null and ${table.waVerifyTokenEncrypted} is null and ${table.tgBotTokenEncrypted} is null and ${table.tgWebhookSecretEncrypted} is null and ${table.emailImapPasswordEncrypted} is null and ${table.emailSmtpPasswordEncrypted} is null and ${table.metaPageTokenEncrypted} is null and ${table.metaAppSecretEncrypted} is null and ${table.metaVerifyTokenEncrypted} is null)`,
    ),
    // ── Fase 6: kelengkapan & format per jenis channel ──
    uniqueIndex('channels_organization_id_tg_bot_id_live_unique')
      .on(table.organizationId, table.tgBotId)
      .where(sql`${table.deletedAt} is null and ${table.type} = 'telegram'`),
    uniqueIndex('channels_organization_id_email_address_live_unique')
      .on(table.organizationId, table.emailAddress)
      .where(sql`${table.deletedAt} is null and ${table.type} = 'email'`),
    uniqueIndex('channels_organization_id_meta_page_id_live_unique')
      .on(table.organizationId, table.type, table.metaPageId)
      .where(sql`${table.deletedAt} is null and ${table.type} in ('messenger', 'instagram')`),
    // Pemeriksa kotak masuk email (tiap menit): channel email yang hidup & aktif.
    index('channels_email_live_idx')
      .on(table.id)
      .where(sql`${table.type} = 'email' and ${table.deletedAt} is null and ${table.enabled}`),
    check(
      'channels_telegram_live_complete',
      sql`${table.type} <> 'telegram' or ${table.deletedAt} is not null or (${table.tgBotId} is not null and ${table.tgBotTokenEncrypted} is not null and ${table.tgWebhookSecretEncrypted} is not null)`,
    ),
    check(
      'channels_email_live_complete',
      sql`${table.type} <> 'email' or ${table.deletedAt} is not null or (${table.emailAddress} is not null and ${table.emailFromName} is not null and ${table.emailImapHost} is not null and ${table.emailImapPort} is not null and ${table.emailImapSecurity} is not null and ${table.emailImapUsername} is not null and ${table.emailImapPasswordEncrypted} is not null and ${table.emailImapFolder} is not null and ${table.emailPollIntervalMinutes} is not null and ${table.emailMarkAsRead} is not null and ${table.emailSmtpMode} is not null and (${table.emailSmtpMode} = 'system' or (${table.emailSmtpHost} is not null and ${table.emailSmtpPort} is not null and ${table.emailSmtpSecurity} is not null and ${table.emailSmtpUsername} is not null and ${table.emailSmtpPasswordEncrypted} is not null)))`,
    ),
    check(
      'channels_meta_social_live_complete',
      sql`${table.type} not in ('messenger', 'instagram') or ${table.deletedAt} is not null or (${table.metaPageId} is not null and ${table.metaPageTokenEncrypted} is not null and ${table.metaAppSecretEncrypted} is not null and ${table.metaVerifyTokenEncrypted} is not null and ${table.metaVerifyTokenRotatedAt} is not null and (${table.type} <> 'instagram' or ${table.metaIgAccountId} is not null))`,
    ),
    check(
      'channels_fase6_formats',
      sql`(${table.tgBotId} is null or ${table.tgBotId} ~ '^[0-9]{5,16}$') and (${table.tgBotUsername} is null or ${table.tgBotUsername} ~ '^[A-Za-z0-9_]{1,64}$') and (${table.metaPageId} is null or ${table.metaPageId} ~ '^[0-9]{5,32}$') and (${table.metaIgAccountId} is null or ${table.metaIgAccountId} ~ '^[0-9]{5,32}$') and (${table.emailAddress} is null or char_length(${table.emailAddress}) between 3 and 254) and (${table.emailFromName} is null or char_length(${table.emailFromName}) between 1 and 100) and (${table.emailImapHost} is null or char_length(${table.emailImapHost}) between 1 and 253) and (${table.emailSmtpHost} is null or char_length(${table.emailSmtpHost}) between 1 and 253) and (${table.emailImapUsername} is null or char_length(${table.emailImapUsername}) between 1 and 255) and (${table.emailSmtpUsername} is null or char_length(${table.emailSmtpUsername}) between 1 and 255) and (${table.emailImapFolder} is null or char_length(${table.emailImapFolder}) between 1 and 200) and (${table.emailImapPort} is null or ${table.emailImapPort} between 1 and 65535) and (${table.emailSmtpPort} is null or ${table.emailSmtpPort} between 1 and 65535) and (${table.emailPollIntervalMinutes} is null or ${table.emailPollIntervalMinutes} between 1 and 60) and (${table.emailImapSecurity} is null or ${table.emailImapSecurity} in ('ssl', 'starttls')) and (${table.emailSmtpSecurity} is null or ${table.emailSmtpSecurity} in ('ssl', 'starttls', 'none')) and (${table.emailSmtpMode} is null or ${table.emailSmtpMode} in ('system', 'custom')) and (${table.emailTrustedAuthServIds} is null or (cardinality(${table.emailTrustedAuthServIds}) between 1 and 5 and char_length(array_to_string(${table.emailTrustedAuthServIds}, ',')) <= 1300 and array_to_string(${table.emailTrustedAuthServIds}, ',') ~ '^[a-z0-9.,-]+$')) and cardinality(${table.emailAliases}) <= 20`,
    ),
    check(
      'channels_last_test_complete',
      sql`(${table.lastTestOk} is null) = (${table.lastTestedAt} is null) and (${table.lastTestOk} is null) = (${table.lastTestCode} is null)`,
    ),
  ],
);

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
