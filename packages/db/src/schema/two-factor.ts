import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  inet,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { users } from './users';

/**
 * Kode cadangan 2FA (SECURITY.md §1): sekali pakai, disimpan sebagai HASH argon2id — kode
 * aslinya hanya ditampilkan sekali saat dibuat. Membuat ulang = menghapus semua kode lama
 * pengguna itu lalu menyisipkan yang baru dalam satu transaksi.
 */
export const userBackupCodes = pgTable(
  'user_backup_codes',
  {
    id: idColumn(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    codeHash: text('code_hash').notNull(),
    /** Terisi = sudah dipakai (tidak berlaku lagi). */
    usedAt: timestamptz('used_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // FK komposit: kode tidak mungkin merujuk pengguna dari organisasi lain.
    foreignKey({
      name: 'user_backup_codes_organization_id_user_id_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    index('user_backup_codes_organization_id_user_id_idx').on(table.organizationId, table.userId),
  ],
);

export type UserBackupCode = typeof userBackupCodes.$inferSelect;
export type NewUserBackupCode = typeof userBackupCodes.$inferInsert;

/**
 * Tantangan langkah kedua saat masuk: dibuat setelah password benar untuk akun yang 2FA-nya
 * aktif. Selama tantangan belum diselesaikan TIDAK ada sesi.
 *
 * - Rahasianya token acak 256-bit yang dikirim di body respons login; di sini hanya HASH-nya.
 * - Sekali pakai (`used_at`), umur pendek (`expires_at`), dan hangus setelah
 *   `TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS` kode salah (`failed_attempts`).
 * - `binding_hash` = hash user agent + asal jaringan saat dibuat: token yang dipakai dari
 *   browser/jaringan lain ditolak.
 */
export const twoFactorChallenges = pgTable(
  'two_factor_challenges',
  {
    id: idColumn(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    bindingHash: text('binding_hash').notNull(),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    ipAddress: inet('ip_address'),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'two_factor_challenges_organization_id_user_id_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    unique('two_factor_challenges_token_hash_unique').on(table.tokenHash),
    index('two_factor_challenges_organization_id_user_id_idx').on(
      table.organizationId,
      table.userId,
    ),
    check('two_factor_challenges_failed_attempts_range', sql`${table.failedAttempts} >= 0`),
  ],
);

export type TwoFactorChallenge = typeof twoFactorChallenges.$inferSelect;
export type NewTwoFactorChallenge = typeof twoFactorChallenges.$inferInsert;
