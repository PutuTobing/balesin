import { pgTable, text } from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, updatedAtColumn } from './columns';

/**
 * Organisasi = perusahaan pemakai Balesin (satu per instalasi di v1).
 * Tabel ini adalah akar tenant: `id`-nya adalah `organization_id` di semua tabel lain.
 */
export const organizations = pgTable('organizations', {
  id: idColumn(),
  name: text('name').notNull(),
  /** Zona waktu IANA untuk jam kerja, jadwal, dan laporan. */
  timezone: text('timezone').notNull().default('Asia/Jakarta'),
  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
