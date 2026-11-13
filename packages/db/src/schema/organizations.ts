import { sql } from 'drizzle-orm';
import { check, pgTable, text } from 'drizzle-orm/pg-core';

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
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    check(
      'organizations_brand_color_hex',
      sql`${table.brandColor} is null or ${table.brandColor} ~ '^#[0-9a-f]{6}$'`,
    ),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
