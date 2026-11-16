import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';

/**
 * Organisasi = perusahaan pemakai Balesin (satu per instalasi di v1).
 * Tabel ini adalah akar tenant: `id`-nya adalah `organization_id` di semua tabel lain.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: idColumn(),
    name: text('name').notNull(),
    /** Zona waktu IANA untuk jam kerja, jadwal, dan laporan. */
    timezone: text('timezone').notNull().default('Asia/Jakarta'),
    /** Branding white-label: nama aplikasi yang tampil. Kosong = nama bawaan produk. */
    productName: text('product_name'),
    /** Branding white-label: warna utama `#rrggbb` (huruf kecil). Kosong = warna bawaan. */
    brandColor: text('brand_color'),
    /**
     * Retensi payload kejadian webhook (hari, review webhook S4): isi pesan di `webhook_events`
     * dikosongkan setelah sekian hari (kunci dedup tetap). Diatur lewat UI (PENGATURAN-UI), bukan
     * `.env`. Batas = `WEBHOOK_PAYLOAD_RETENTION_DAYS` di `@balesin/shared`.
     */
    webhookPayloadRetentionDays: integer('webhook_payload_retention_days').notNull().default(8),
    /**
     * Retensi salinan lokal media (unggahan & unduhan) dalam hari (`MEDIA_RETENTION_DAYS`,
     * SECURITY.md §10 "retensi media dapat diatur"). UI menyusul; nilai di DB, bukan `.env`.
     */
    mediaRetentionDays: integer('media_retention_days').notNull().default(30),
    // ── Rem pengiriman (SECURITY.md §5, review ruang chat S2; `SENDING_LIMIT_BOUNDS`) ──
    /** Pesan keluar per pengguna per 24 jam bergulir. */
    sendDailyLimitPerUser: integer('send_daily_limit_per_user').notNull().default(500),
    /** Pesan keluar seluruh organisasi per 24 jam bergulir. */
    sendDailyLimitPerOrganization: integer('send_daily_limit_per_organization')
      .notNull()
      .default(5000),
    /** Pesan keluar ke satu percakapan per menit. */
    sendPerConversationPerMinute: integer('send_per_conversation_per_minute').notNull().default(20),
    /** Rem darurat ditarik (semua pengiriman keluar berhenti); `null` = berjalan. */
    sendingPausedAt: timestamptz('sending_paused_at'),
    sendingPausedByUserId: uuid('sending_paused_by_user_id'),
    sendingPauseReason: text('sending_pause_reason'),
    /** Tampilkan cuplikan isi pesan di notifikasi push (layar kunci). Bawaan MATI (butir 10). */
    notificationPreview: boolean('notification_preview').notNull().default(false),
    /** Tampilkan nama kontak di notifikasi push. Bawaan MATI (review push R1). */
    notificationContactName: boolean('notification_contact_name').notNull().default(false),
    /** Halaman dokumentasi API publik `/api/docs` aktif (Pengaturan → API, Fase 3). */
    apiDocsEnabled: boolean('api_docs_enabled').notNull().default(true),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    check(
      'organizations_brand_color_hex',
      sql`${table.brandColor} is null or ${table.brandColor} ~ '^#[0-9a-f]{6}$'`,
    ),
    check(
      'organizations_send_limits_range',
      sql`${table.sendDailyLimitPerUser} between 1 and 100000 and ${table.sendDailyLimitPerOrganization} between 1 and 1000000 and ${table.sendPerConversationPerMinute} between 1 and 120`,
    ),
    check(
      'organizations_sending_pause_consistent',
      sql`(${table.sendingPausedAt} is not null or (${table.sendingPausedByUserId} is null and ${table.sendingPauseReason} is null)) and (${table.sendingPauseReason} is null or char_length(${table.sendingPauseReason}) <= 200)`,
    ),
    check(
      'organizations_media_retention_days_range',
      sql`${table.mediaRetentionDays} between 1 and 365`,
    ),
    check(
      'organizations_webhook_payload_retention_days_range',
      sql`${table.webhookPayloadRetentionDays} between 1 and 90`,
    ),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
