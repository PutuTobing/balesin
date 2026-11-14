import { USER_ROLES } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import { bigint, check, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { organizations } from './organizations';

/** Lima peran (PRD §4). Daftarnya berasal dari `@balesin/shared` supaya api, web, dan DB sama. */
export const userRole = pgEnum('user_role', USER_ROLES);

export const users = pgTable(
  'users',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Selalu dalam bentuk baku (huruf kecil, tanpa spasi tepi) — lihat `normalizeEmail`. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** Hash argon2id (SECURITY.md §1). Password asli tidak pernah disimpan. */
    passwordHash: text('password_hash').notNull(),
    role: userRole('role').notNull(),
    emailVerifiedAt: timestamptz('email_verified_at'),
    /** Terisi = akun dinonaktifkan (tidak bisa masuk). Pengguna tidak dihapus agar audit utuh. */
    disabledAt: timestamptz('disabled_at'),
    /**
     * Terisi dan belum lewat = akun dikunci sementara karena gagal masuk berulang
     * (SECURITY.md §1: 15 menit setelah 5 kali gagal). Hitungan gagalnya ada di Redis.
     */
    lockedUntil: timestamptz('locked_until'),
    lastLoginAt: timestamptz('last_login_at'),
    /**
     * Verifikasi dua langkah (TOTP, SECURITY.md §1). Rahasia hanya disimpan TERENKRIPSI
     * (`SecretBox`, AES-256-GCM) dengan konteks organisasi + `users.totp_secret` + ID pengguna.
     * Terisi bersama `totp_enabled_at` = 2FA aktif.
     */
    totpSecretEncrypted: text('totp_secret_encrypted'),
    totpEnabledAt: timestamptz('totp_enabled_at'),
    /**
     * Langkah waktu TOTP (detik/30) terakhir yang berhasil dipakai. Kode untuk langkah ini atau
     * sebelumnya ditolak, jadi satu kode tidak bisa dipakai dua kali (cegah replay).
     */
    totpLastUsedStep: bigint('totp_last_used_step', { mode: 'number' }),
    /**
     * Rahasia yang sedang didaftarkan (QR sudah ditampilkan, kode pertama belum dikonfirmasi).
     * Terenkripsi dengan konteks `users.totp_pending_secret`. Kosong = tidak ada pendaftaran
     * berjalan. Dipisah dari rahasia aktif supaya mendaftar ulang tidak mematikan 2FA lama.
     */
    totpPendingSecretEncrypted: text('totp_pending_secret_encrypted'),
    totpPendingCreatedAt: timestamptz('totp_pending_created_at'),
    /**
     * Waktu rahasia pendaftaran yang sekarang PERTAMA kali dibuat. `totp_pending_created_at`
     * digeser setiap kali QR ditampilkan ulang (masa berlaku 15 menit sejak tampil); kolom ini
     * tidak, jadi pemakaian ulang rahasia yang sama punya batas mutlak (review 2FA Info 17).
     */
    totpPendingIssuedAt: timestamptz('totp_pending_issued_at'),
    /**
     * Terakhir password diganti (atur ulang password; nanti ganti password di profil). Cookie
     * "perangkat dikenal" yang terbit sebelum waktu ini tidak diakui lagi (review 2FA G.3).
     */
    passwordChangedAt: timestamptz('password_changed_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // Email unik per organisasi. Karena email wajib baku (constraint di bawah), keunikan ini
    // otomatis tidak peduli huruf besar/kecil.
    unique('users_organization_id_email_unique').on(table.organizationId, table.email),
    // Target foreign key komposit dari tabel anak: menjamin baris anak selalu berada di
    // organisasi yang sama dengan pengguna yang dirujuknya.
    unique('users_organization_id_id_unique').on(table.organizationId, table.id),
    check('users_email_normalized', sql`${table.email} = lower(btrim(${table.email}))`),
    // Rahasia aktif dan waktu aktifnya selalu berpasangan; begitu juga rahasia pendaftaran.
    check(
      'users_totp_enabled_paired',
      sql`(${table.totpSecretEncrypted} is null) = (${table.totpEnabledAt} is null)`,
    ),
    check(
      'users_totp_pending_paired',
      sql`(${table.totpPendingSecretEncrypted} is null) = (${table.totpPendingCreatedAt} is null)`,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
