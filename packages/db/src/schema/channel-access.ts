import { foreignKey, index, pgTable, primaryKey, uuid } from 'drizzle-orm/pg-core';

import { channels } from './channels';
import { createdAtColumn, updatedAtColumn } from './columns';
import { departments } from './departments';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Akses per channel (tahap 9.0, PRD-EMAIL §4.10; docs/KONTRAK-API-CHANNEL.md "Akses per channel").
 * Berlaku hanya bila `channels.access_restricted = true`: pengguna Supervisor/CS/Teknisi melihat
 * percakapan channel itu bila ia ada di `channel_access_users` ATAU anggota salah satu departemen di
 * `channel_access_departments`. Owner/Admin selalu melihat semua. Daftar kosong + mode terbatas =
 * hanya Owner/Admin (gagal tertutup, mis. setelah departemen satu-satunya dihapus).
 *
 * FK komposit (organisasi, id) → baris organisasi lain tidak bisa dirujuk. Hapus departemen/pengguna
 * → barisnya ikut terhapus (cascade); channel dihapus lunak, jadi barisnya tetap (tidak berbahaya).
 */
export const channelAccessDepartments = pgTable(
  'channel_access_departments',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id').notNull(),
    departmentId: uuid('department_id').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    primaryKey({
      name: 'channel_access_departments_pk',
      columns: [table.channelId, table.departmentId],
    }),
    foreignKey({
      name: 'channel_access_departments_organization_id_channel_id_fk',
      columns: [table.organizationId, table.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'channel_access_departments_organization_id_department_id_fk',
      columns: [table.organizationId, table.departmentId],
      foreignColumns: [departments.organizationId, departments.id],
    }).onDelete('cascade'),
    index('channel_access_departments_department_id_idx').on(
      table.organizationId,
      table.departmentId,
    ),
  ],
);

export type ChannelAccessDepartmentRow = typeof channelAccessDepartments.$inferSelect;

export const channelAccessUsers = pgTable(
  'channel_access_users',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id').notNull(),
    userId: uuid('user_id').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    primaryKey({
      name: 'channel_access_users_pk',
      columns: [table.channelId, table.userId],
    }),
    foreignKey({
      name: 'channel_access_users_organization_id_channel_id_fk',
      columns: [table.organizationId, table.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'channel_access_users_organization_id_user_id_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    index('channel_access_users_user_id_idx').on(table.organizationId, table.userId),
  ],
);

export type ChannelAccessUserRow = typeof channelAccessUsers.$inferSelect;
