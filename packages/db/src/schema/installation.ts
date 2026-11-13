import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, timestamptz, updatedAtColumn } from './columns';
import { organizations } from './organizations';

/**
 * Status instalasi — paling banyak SATU baris (v1: satu instalasi = satu organisasi).
 *
 * Baris ini dibuat wizard setup dalam transaksi yang sama dengan Owner pertama. Primary key
 * `singleton` hanya boleh bernilai `true`, jadi database sendiri yang menjamin setup tidak
 * bisa selesai dua kali, juga saat dua permintaan datang bersamaan (SECURITY.md §1).
 * Baris ini juga menjawab "organisasi mana milik instalasi ini" untuk permintaan yang belum
 * punya sesi (login, branding halaman masuk).
 */
export const installation = pgTable(
  'installation',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    setupCompletedAt: timestamptz('setup_completed_at').notNull().defaultNow(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [check('installation_singleton', sql`${table.singleton}`)],
);

export type Installation = typeof installation.$inferSelect;
export type NewInstallation = typeof installation.$inferInsert;
