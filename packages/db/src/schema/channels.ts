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
import { organizations } from './organizations';
import { users } from './users';

/** Jenis channel. Daftarnya dari `@balesin/shared` supaya api, web, dan DB sama. */
export const channelType = pgEnum('channel_type', CHANNEL_TYPES);

/**
 * Channel inbox per organisasi (PRD §3.2, ARCHITECTURE.md §3). Baru WhatsApp Cloud API yang
 * diisi; jenis lain menambah kolomnya sendiri (berawalan jenisnya) saat dibangun.
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
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    check(
      'channels_bot_timeout_range',
      sql`${table.botTimeoutMinutes} is null or ${table.botTimeoutMinutes} between 1 and 1440`,
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
    // Channel terhapus tidak menyimpan rahasia apa pun.
    check(
      'channels_deleted_without_secrets',
      sql`${table.deletedAt} is null or (${table.waAccessTokenEncrypted} is null and ${table.waAppSecretEncrypted} is null and ${table.waVerifyTokenEncrypted} is null)`,
    ),
    check(
      'channels_last_test_complete',
      sql`(${table.lastTestOk} is null) = (${table.lastTestedAt} is null) and (${table.lastTestOk} is null) = (${table.lastTestCode} is null)`,
    ),
  ],
);

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
