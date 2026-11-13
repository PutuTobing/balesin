import { LOGO_CONTENT_TYPES, LOGO_MAX_BYTES } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import { check, customType, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, updatedAtColumn } from './columns';
import { organizations } from './organizations';

/** Kolom biner Postgres (`bytea`) ↔ `Buffer`. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const CONTENT_TYPE_LIST = sql.raw(LOGO_CONTENT_TYPES.map((type) => `'${type}'`).join(', '));

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
