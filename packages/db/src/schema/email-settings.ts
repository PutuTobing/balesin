import { SMTP_SECURITY_MODES } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { organizations } from './organizations';
import { users } from './users';

/** Keamanan sambungan SMTP. Daftarnya dari `@balesin/shared` supaya api, web, dan DB sama. */
export const smtpSecurity = pgEnum('smtp_security', SMTP_SECURITY_MODES);

/**
 * Email pengirim sistem per organisasi (docs/PENGATURAN-UI.md §1) — sumber utama; `SMTP_*`
 * di .env hanya cadangan.
 *
 * `password_encrypted` berisi hasil `SecretBox.encrypt` (AES-256-GCM, SECURITY.md §3) dengan
 * konteks organisasi + `email_settings.smtp_password`. Password polos tidak pernah disimpan.
 * `password_tail` adalah ekor password untuk petunjuk tersamar di UI (lihat `secretTail`).
 */
export const emailSettings = pgTable(
  'email_settings',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    fromName: text('from_name').notNull(),
    /** Bentuk baku (huruf kecil, tanpa spasi tepi). */
    fromAddress: text('from_address').notNull(),
    replyTo: text('reply_to'),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    security: smtpSecurity('security').notNull(),
    /** Kosong = server tanpa login. */
    username: text('username'),
    passwordEncrypted: text('password_encrypted'),
    passwordTail: text('password_tail'),
    /** Hasil tes koneksi terakhir atas pengaturan yang tersimpan; kosong = belum pernah dites. */
    lastTestOk: boolean('last_test_ok'),
    /** Kode hasil tes (`EMAIL_TEST_CODES` di `@balesin/shared`) — bukan balasan mentah server. */
    lastTestCode: text('last_test_code'),
    lastTestedAt: timestamptz('last_tested_at'),
    updatedByUserId: uuid('updated_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // Satu pengaturan per organisasi.
    unique('email_settings_organization_id_unique').on(table.organizationId),
    // FK komposit: pengubah terakhir harus dari organisasi yang sama.
    foreignKey({
      name: 'email_settings_organization_id_updated_by_user_id_fk',
      columns: [table.organizationId, table.updatedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check('email_settings_port_range', sql`${table.port} between 1 and 65535`),
    check(
      'email_settings_from_address_normalized',
      sql`${table.fromAddress} = lower(btrim(${table.fromAddress}))`,
    ),
    // Username dan password selalu berpasangan: keduanya ada, atau keduanya kosong.
    check(
      'email_settings_credentials_paired',
      sql`(${table.username} is null) = (${table.passwordEncrypted} is null)`,
    ),
    // Hasil tes selalu lengkap: status, kode, dan waktunya.
    check(
      'email_settings_last_test_complete',
      sql`(${table.lastTestOk} is null) = (${table.lastTestedAt} is null) and (${table.lastTestOk} is null) = (${table.lastTestCode} is null)`,
    ),
  ],
);

export type EmailSettings = typeof emailSettings.$inferSelect;
export type NewEmailSettings = typeof emailSettings.$inferInsert;
