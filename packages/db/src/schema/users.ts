import { USER_ROLES } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import { check, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

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
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
