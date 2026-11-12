import { sql } from 'drizzle-orm';
import { foreignKey, index, inet, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn } from './columns';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Audit log: siapa melakukan apa, kapan, dari IP mana (PRD §3.1, SECURITY.md §10).
 *
 * Hanya-tambah (append-only): baris tidak pernah diubah, karena itu TIDAK ada `updated_at`.
 * `metadata` tidak boleh memuat rahasia — saring dulu dengan `redactSecrets` dari
 * `@balesin/core`.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Kosong untuk aksi sistem atau pelaku yang belum dikenal (mis. login gagal). */
    actorUserId: uuid('actor_user_id'),
    /** Nama aksi bertitik, mis. `auth.login.success`, `user.invite`. */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    // FK komposit: pelaku harus dari organisasi yang sama. RESTRICT: pengguna yang sudah
    // punya jejak audit tidak bisa dihapus (nonaktifkan saja), supaya jejaknya tetap utuh.
    foreignKey({
      name: 'audit_logs_organization_id_actor_user_id_fk',
      columns: [table.organizationId, table.actorUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    index('audit_logs_organization_id_created_at_idx').on(table.organizationId, table.createdAt),
    index('audit_logs_organization_id_actor_user_id_idx').on(
      table.organizationId,
      table.actorUserId,
    ),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
