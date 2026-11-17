import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, updatedAtColumn } from './columns';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Departemen (Fase 5, PRD §3.6/§3.8). Nama unik per organisasi tanpa beda huruf besar/kecil.
 * Dirujuk `conversations.department_id`, `ticket_boards.department_id`, dan
 * `channels.default_department_id` (FK restrict — service mengosongkan rujukannya sebelum hapus).
 */
export const departments = pgTable(
  'departments',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('departments_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('departments_organization_id_name_unique').on(
      table.organizationId,
      sql`lower(${table.name})`,
    ),
    check(
      'departments_text_lengths',
      sql`char_length(${table.name}) between 1 and 60 and (${table.description} is null or char_length(${table.description}) between 1 and 300)`,
    ),
  ],
);

export type DepartmentRow = typeof departments.$inferSelect;

/**
 * Anggota departemen. Satu pengguna boleh di beberapa departemen. Tanda "akses hanya departemen
 * sendiri" ada di `users.department_restricted`.
 */
export const departmentMembers = pgTable(
  'department_members',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    departmentId: uuid('department_id').notNull(),
    userId: uuid('user_id').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    primaryKey({
      name: 'department_members_pk',
      columns: [table.departmentId, table.userId],
    }),
    foreignKey({
      name: 'department_members_organization_id_department_id_fk',
      columns: [table.organizationId, table.departmentId],
      foreignColumns: [departments.organizationId, departments.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'department_members_organization_id_user_id_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    index('department_members_user_id_idx').on(table.organizationId, table.userId),
  ],
);

export type DepartmentMemberRow = typeof departmentMembers.$inferSelect;
