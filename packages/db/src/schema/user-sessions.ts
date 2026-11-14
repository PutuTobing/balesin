import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  inet,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { users } from './users';

/**
 * Sesi login (SECURITY.md §1). `id` hanya pengenal baris (aman ditampilkan di daftar
 * "sesi aktif"); rahasianya adalah token acak 256-bit di cookie, yang di sini hanya
 * disimpan HASH-nya — isi database yang bocor tidak bisa dipakai untuk membajak sesi.
 *
 * Sesi berlaku bila: `revoked_at` kosong, `idle_expires_at` dan `absolute_expires_at`
 * belum lewat, dan — bila 2FA pengguna aktif — `two_factor_verified_at` terisi.
 */
/**
 * Jenis sesi, ditetapkan saat sesi dibuat dan tidak pernah berubah:
 * - `standard` — sesi biasa (login selesai).
 * - `two_factor_enrollment` — sesi terbatas berumur pendek untuk peran wajib 2FA yang belum
 *   mendaftar, dibuat TEPAT setelah password dimasukkan (login/setup). Hanya sesi jenis ini yang
 *   boleh mulai mendaftar 2FA tanpa memasukkan password lagi.
 */
export const SESSION_KINDS = ['standard', 'two_factor_enrollment'] as const;
export const sessionKind = pgEnum('session_kind', SESSION_KINDS);
export type SessionKind = (typeof SESSION_KINDS)[number];

export const userSessions = pgTable(
  'user_sessions',
  {
    id: idColumn(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    kind: sessionKind('kind').notNull().default('standard'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
    /** Digeser maju setiap ada aktivitas (kedaluwarsa idle). */
    idleExpiresAt: timestamptz('idle_expires_at').notNull(),
    /** Batas mutlak sejak login; tidak pernah digeser. */
    absoluteExpiresAt: timestamptz('absolute_expires_at').notNull(),
    /** Terisi = sesi dicabut (logout, ganti password/peran, dikeluarkan admin). */
    revokedAt: timestamptz('revoked_at'),
    /**
     * Terisi = sesi ini dibuat setelah langkah kedua (kode TOTP / kode cadangan, atau aktivasi
     * 2FA) berhasil. Pengguna yang 2FA-nya aktif hanya diterima dengan sesi yang kolom ini terisi.
     */
    twoFactorVerifiedAt: timestamptz('two_factor_verified_at'),
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
