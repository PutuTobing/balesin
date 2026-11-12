import { sql } from 'drizzle-orm';
import { check, foreignKey, index, inet, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { users } from './users';

/**
 * Sesi login (SECURITY.md §1). `id` hanya pengenal baris (aman ditampilkan di daftar
 * "sesi aktif"); rahasianya adalah token acak 256-bit di cookie, yang di sini hanya
 * disimpan HASH-nya — isi database yang bocor tidak bisa dipakai untuk membajak sesi.
 *
 * Sesi berlaku bila: `revoked_at` kosong, `idle_expires_at` dan `absolute_expires_at`
 * belum lewat.
 */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: idColumn(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    /** Digeser maju setiap ada aktivitas (kedaluwarsa idle). */
    idleExpiresAt: timestamptz('idle_expires_at').notNull(),
    /** Batas mutlak sejak login; tidak pernah digeser. */
    absoluteExpiresAt: timestamptz('absolute_expires_at').notNull(),
    /** Terisi = sesi dicabut (logout, ganti password/peran, dikeluarkan admin). */
    revokedAt: timestamptz('revoked_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // FK komposit: sesi tidak mungkin merujuk pengguna dari organisasi lain.
    foreignKey({
      name: 'user_sessions_organization_id_user_id_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    unique('user_sessions_token_hash_unique').on(table.tokenHash),
    index('user_sessions_organization_id_user_id_idx').on(table.organizationId, table.userId),
    check(
      'user_sessions_idle_within_absolute',
      sql`${table.idleExpiresAt} <= ${table.absoluteExpiresAt}`,
    ),
  ],
);

export type UserSession = typeof userSessions.$inferSelect;
export type NewUserSession = typeof userSessions.$inferInsert;
