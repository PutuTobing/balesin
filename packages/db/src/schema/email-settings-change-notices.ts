import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, updatedAtColumn } from './columns';
import { smtpSecurity } from './email-settings';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Pemberitahuan ke Owner: sambungan/alamat email pengirim diubah oleh pengguna selain Owner
 * (review keamanan RBAC S1 — Admin bisa membelokkan semua email keamanan ke server SMTP miliknya).
 *
 * Satu baris per perubahan, memuat SALINAN pengaturan SEBELUM perubahan (`previous_*`). Worker
 * mengirim pemberitahuannya lewat salinan itu — bukan lewat pengaturan baru yang mungkin milik
 * penyerang — supaya pemberitahuannya tidak bisa ditelan diam-diam. Satu baris per perubahan (bukan
 * kolom "sebelumnya" di `email_settings`): dua perubahan beruntun tidak boleh membuat pemberitahuan
 * pertama ikut terkirim lewat pengaturan perubahan pertama.
 *
 * - `previous_password_encrypted` = teks sandi yang sama persis dengan `email_settings` (konteks
 *   `SecretBox` organisasi + `email_settings.smtp_password`), dikosongkan begitu semua job
 *   pemberitahuannya selesai (`pending_deliveries` = 0). Baris lain tetap sebagai riwayat.
 * - `previous_host` kosong = belum ada pengaturan tersimpan sebelumnya (worker memakai pengaturan
 *   yang berlaku saat mengirim).
 */
export const emailSettingsChangeNotices = pgTable(
  'email_settings_change_notices',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    actorUserId: uuid('actor_user_id').notNull(),
    /** Baris audit `settings.email.updated` perubahan ini (IP/perangkat untuk isi email). */
    auditLogId: uuid('audit_log_id').notNull(),
    previousFromName: text('previous_from_name'),
    previousFromAddress: text('previous_from_address'),
    previousReplyTo: text('previous_reply_to'),
    previousHost: text('previous_host'),
    previousPort: integer('previous_port'),
    previousSecurity: smtpSecurity('previous_security'),
    previousUsername: text('previous_username'),
    previousPasswordEncrypted: text('previous_password_encrypted'),
    newHost: text('new_host').notNull(),
    newPort: integer('new_port').notNull(),
    newFromAddress: text('new_from_address').notNull(),
    /** Job pemberitahuan (satu per Owner) yang belum selesai. */
    pendingDeliveries: integer('pending_deliveries').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'email_settings_change_notices_organization_id_actor_user_id_fk',
      columns: [table.organizationId, table.actorUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    index('email_settings_change_notices_organization_id_idx').on(table.organizationId),
    check(
      'email_settings_change_notices_pending_nonnegative',
      sql`${table.pendingDeliveries} >= 0`,
    ),
    // Salinan "sebelumnya" lengkap atau kosong sama sekali.
    check(
      'email_settings_change_notices_previous_complete',
      sql`(${table.previousHost} is null) = (${table.previousPort} is null) and (${table.previousHost} is null) = (${table.previousSecurity} is null) and (${table.previousHost} is null) = (${table.previousFromAddress} is null) and (${table.previousHost} is null) = (${table.previousFromName} is null)`,
    ),
  ],
);

export type EmailSettingsChangeNotice = typeof emailSettingsChangeNotices.$inferSelect;
export type NewEmailSettingsChangeNotice = typeof emailSettingsChangeNotices.$inferInsert;
