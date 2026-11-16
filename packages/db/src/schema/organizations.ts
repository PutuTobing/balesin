import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text } from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, updatedAtColumn } from './columns';

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
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    check(
      'organizations_brand_color_hex',
      sql`${table.brandColor} is null or ${table.brandColor} ~ '^#[0-9a-f]{6}$'`,
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
