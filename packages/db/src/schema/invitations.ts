import { EMAIL_DELIVERY_STATUSES } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { organizations } from './organizations';
import { userRole, users } from './users';

/**
 * Status pengiriman email bertoken (undangan, atur ulang password, verifikasi). Daftarnya dari
 * `@balesin/shared` supaya api, worker, web, dan DB sama.
 */
export const emailDeliveryStatus = pgEnum('email_delivery_status', EMAIL_DELIVERY_STATUSES);

/**
 * Undangan pengguna (SECURITY.md §1): satu-satunya jalan membuat pengguna selain Owner.
 *
 * - Rahasianya token acak 256-bit di tautan email; di sini hanya HASH-nya (`token_hash`).
 * - Sekali pakai (`accepted_at`), berlaku 72 jam (`expires_at`), terikat ke `email` — peran dan
 *   email diambil dari baris ini saat diterima, bukan dari isian penerima.
 * - Kirim ulang = token BARU (hash diganti, `send_count` naik): tautan lama langsung batal.
 * - `delivery_token_encrypted`: salinan token terenkripsi (`SecretBox`, konteks undangan +
 *   `send_count`) HANYA selama email belum dikirim worker — payload antrian tidak boleh memuat
 *   token. Dikosongkan setelah terkirim/gagal permanen/dibatalkan/diterima.
 * - Paling banyak satu undangan terbuka per email per organisasi (indeks unik parsial).
 */
export const userInvitations = pgTable(
  'user_invitations',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Bentuk baku (huruf kecil, tanpa spasi tepi). */
    email: text('email').notNull(),
    role: userRole('role').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Waktu token yang berlaku sekarang dibuat (dibuat/dikirim ulang terakhir). */
    tokenIssuedAt: timestamptz('token_issued_at').notNull().defaultNow(),
    expiresAt: timestamptz('expires_at').notNull(),
    /** Berapa kali token dibuat. Job email membawa angka ini; job untuk token lama diabaikan. */
    sendCount: integer('send_count').notNull().default(1),
    deliveryStatus: emailDeliveryStatus('delivery_status').notNull(),
    deliveredAt: timestamptz('delivered_at'),
    deliveryTokenEncrypted: text('delivery_token_encrypted'),
    invitedByUserId: uuid('invited_by_user_id').notNull(),
    lastSentByUserId: uuid('last_sent_by_user_id').notNull(),
    acceptedAt: timestamptz('accepted_at'),
    acceptedUserId: uuid('accepted_user_id'),
    revokedAt: timestamptz('revoked_at'),
    revokedByUserId: uuid('revoked_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // FK komposit: pengundang, pengirim ulang, pembatal, dan akun hasilnya selalu dari organisasi
    // yang sama dengan undangannya. RESTRICT: jejaknya tidak boleh hilang.
    foreignKey({
      name: 'user_invitations_organization_id_invited_by_user_id_fk',
      columns: [table.organizationId, table.invitedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'user_invitations_organization_id_last_sent_by_user_id_fk',
      columns: [table.organizationId, table.lastSentByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'user_invitations_organization_id_accepted_user_id_fk',
      columns: [table.organizationId, table.acceptedUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'user_invitations_organization_id_revoked_by_user_id_fk',
      columns: [table.organizationId, table.revokedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    unique('user_invitations_token_hash_unique').on(table.tokenHash),
    uniqueIndex('user_invitations_open_email_unique')
      .on(table.organizationId, table.email)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
    index('user_invitations_organization_id_created_at_idx').on(
      table.organizationId,
      table.createdAt,
    ),
    check('user_invitations_email_normalized', sql`${table.email} = lower(btrim(${table.email}))`),
    // Owner hanya dibuat wizard setup.
    check('user_invitations_role_not_owner', sql`${table.role} <> 'owner'`),
    check('user_invitations_send_count_positive', sql`${table.sendCount} >= 1`),
    check(
      'user_invitations_accepted_paired',
      sql`(${table.acceptedAt} is null) = (${table.acceptedUserId} is null)`,
    ),
    check(
      'user_invitations_revoked_paired',
      sql`(${table.revokedAt} is null) = (${table.revokedByUserId} is null)`,
    ),
    check(
      'user_invitations_closed_once',
      sql`${table.acceptedAt} is null or ${table.revokedAt} is null`,
    ),
  ],
);

export type UserInvitation = typeof userInvitations.$inferSelect;
export type NewUserInvitation = typeof userInvitations.$inferInsert;
