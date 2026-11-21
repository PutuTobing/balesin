import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  inet,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { emailDeliveryStatus } from './invitations';
import { users } from './users';

/**
 * Tujuan token akun:
 * - `password_reset` — tautan atur ulang password (30 menit);
 * - `email_verification` — tautan verifikasi alamat email (24 jam). Kolom `email` adalah alamat
 *   YANG DIVERIFIKASI — sama dengan email akun sekarang, atau (nanti, ubah email di profil)
 *   alamat baru yang baru dipakai setelah tautannya dibuka.
 */
export const ACCOUNT_TOKEN_PURPOSES = ['password_reset', 'email_verification'] as const;
export const accountTokenPurpose = pgEnum('account_token_purpose', ACCOUNT_TOKEN_PURPOSES);
export type AccountTokenPurpose = (typeof ACCOUNT_TOKEN_PURPOSES)[number];

/**
 * Token sekali pakai milik pengguna yang sudah ada (SECURITY.md §1).
 *
 * - Hanya HASH token yang disimpan; `delivery_token_encrypted` (salinan terenkripsi untuk worker)
 *   dikosongkan begitu email terkirim atau gagal permanen.
 * - Paling banyak SATU token hidup per pengguna per tujuan (indeks unik parsial): meminta tautan
 *   baru membatalkan yang lama (`revoked_at`).
 * - `failed_attempts`: kode 2FA salah saat menyelesaikan atur ulang password; token hangus
 *   setelah batasnya.
 */
export const accountTokens = pgTable(
  'account_tokens',
  {
    id: idColumn(),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    purpose: accountTokenPurpose('purpose').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Alamat tujuan email (bentuk baku). Token tidak berlaku bila email akun berubah sejak itu. */
    email: text('email').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    usedAt: timestamptz('used_at'),
    revokedAt: timestamptz('revoked_at'),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    deliveryStatus: emailDeliveryStatus('delivery_status').notNull().default('queued'),
    deliveredAt: timestamptz('delivered_at'),
    deliveryTokenEncrypted: text('delivery_token_encrypted'),
    requestedIp: inet('requested_ip'),
    requestedUserAgent: text('requested_user_agent'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'account_tokens_organization_id_user_id_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    unique('account_tokens_token_hash_unique').on(table.tokenHash),
    uniqueIndex('account_tokens_live_unique')
      .on(table.organizationId, table.userId, table.purpose)
      .where(sql`${table.usedAt} is null and ${table.revokedAt} is null`),
    index('account_tokens_organization_id_user_id_idx').on(table.organizationId, table.userId),
    check('account_tokens_email_normalized', sql`${table.email} = lower(btrim(${table.email}))`),
    check('account_tokens_failed_attempts_range', sql`${table.failedAttempts} >= 0`),
  ],
);

export type AccountToken = typeof accountTokens.$inferSelect;
export type NewAccountToken = typeof accountTokens.$inferInsert;
