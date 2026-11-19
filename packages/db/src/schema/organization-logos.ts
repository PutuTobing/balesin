import { BRAND_ICON_FILES, LOGO_CONTENT_TYPES, LOGO_MAX_BYTES } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, updatedAtColumn } from './columns';
import { organizations } from './organizations';

/** Kolom biner Postgres (`bytea`) ↔ `Buffer`. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const CONTENT_TYPE_LIST = sql.raw(LOGO_CONTENT_TYPES.map((type) => `'${type}'`).join(', '));
const ICON_FILE_LIST = sql.raw(BRAND_ICON_FILES.map((file) => `'${file}'`).join(', '));
/** Batas atas satu ikon PNG (512×512 terkompresi jauh di bawah ini). */
const ICON_MAX_BYTES = 1024 * 1024;

/**
 * Logo organisasi (branding white-label). Disimpan di database — bukan di disk — supaya ikut
 * backup dan tidak bergantung pada folder media. Dipisah dari `organizations` supaya isi
 * binernya tidak ikut terbaca setiap kali organisasi di-query.
 *
 * `content_type` berasal dari pemeriksaan ISI berkas di server (bukan dari klien), dan hanya
 * gambar raster: SVG tidak pernah diterima (SECURITY.md §7).
 */
export const organizationLogos = pgTable(
  'organization_logos',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    contentType: text('content_type').notNull(),
    data: bytea('data').notNull(),
    byteSize: integer('byte_size').notNull(),
    /** SHA-256 isi berkas (heksadesimal) — dipakai sebagai ETag dan parameter versi di URL. */
    sha256: text('sha256').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    check('organization_logos_content_type', sql`${table.contentType} in (${CONTENT_TYPE_LIST})`),
    check(
      'organization_logos_byte_size',
      sql`${table.byteSize} = octet_length(${table.data}) and ${table.byteSize} between 1 and ${sql.raw(String(LOGO_MAX_BYTES))}`,
    ),
  ],
);

export type OrganizationLogo = typeof organizationLogos.$inferSelect;
export type NewOrganizationLogo = typeof organizationLogos.$inferInsert;

/**
 * Ikon PNG yang dibuat server dari logo organisasi (favicon, apple-touch-icon, ikon PWA 192/512 dan
 * maskable; daftar `BRAND_ICONS` di `@balesin/shared`). Dibuat sekali saat logo diunggah — bukan di
 * setiap permintaan — dan ikut terhapus saat logo dihapus/diganti. `logo_sha256` mencatat logo
 * sumbernya: ikon yang tidak cocok dengan logo sekarang dianggap basi dan dibuat ulang.
 */
export const organizationLogoIcons = pgTable(
  'organization_logo_icons',
  {
    organizationId: uuid('organization_id').notNull(),
    file: text('file').notNull(),
    logoSha256: text('logo_sha256').notNull(),
    data: bytea('data').notNull(),
    byteSize: integer('byte_size').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    primaryKey({ name: 'organization_logo_icons_pk', columns: [table.organizationId, table.file] }),
    // Ikut terhapus bersama logonya (dan organisasinya, lewat logo).
    foreignKey({
      name: 'organization_logo_icons_logo_fk',
      columns: [table.organizationId],
      foreignColumns: [organizationLogos.organizationId],
    }).onDelete('cascade'),
    check('organization_logo_icons_file', sql`${table.file} in (${ICON_FILE_LIST})`),
    check(
      'organization_logo_icons_byte_size',
      sql`${table.byteSize} = octet_length(${table.data}) and ${table.byteSize} between 1 and ${sql.raw(String(ICON_MAX_BYTES))}`,
    ),
  ],
);

export type OrganizationLogoIcon = typeof organizationLogoIcons.$inferSelect;
