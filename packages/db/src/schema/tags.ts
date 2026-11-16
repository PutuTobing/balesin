import { TAG_COLORS } from '@balesin/shared';
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
import { contacts } from './contacts';
import { organizations } from './organizations';
import { users } from './users';

const colorList = TAG_COLORS.map((color) => `'${color}'`).join(', ');

/**
 * Master tag per organisasi (Fase 2 butir 8). Nama unik TANPA membedakan huruf besar/kecil;
 * `color` = kunci palet (`TAG_COLORS`), bukan hex — web memetakannya ke token desain.
 */
export const tags = pgTable(
  'tags',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('tags_organization_id_id_unique').on(table.organizationId, table.id),
    uniqueIndex('tags_organization_id_name_unique').on(
      table.organizationId,
      sql`lower(${table.name})`,
    ),
    foreignKey({
      name: 'tags_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check('tags_name_length', sql`char_length(${table.name}) between 1 and 40`),
    check('tags_color_known', sql.raw(`color in (${colorList})`)),
  ],
);

export type TagRow = typeof tags.$inferSelect;
export type NewTagRow = typeof tags.$inferInsert;

/**
 * Tag yang terpasang di kontak. Hapus tag → lepas dari semua kontak (cascade); hapus kontak (UU PDP)
 * menghapus barisnya lewat `deleteContactData`.
 */
export const contactTags = pgTable(
  'contact_tags',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    contactId: uuid('contact_id').notNull(),
    tagId: uuid('tag_id').notNull(),
    /** `null` = sistem/bot/API. */
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    primaryKey({ name: 'contact_tags_pk', columns: [table.contactId, table.tagId] }),
    foreignKey({
      name: 'contact_tags_organization_id_contact_id_fk',
      columns: [table.organizationId, table.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contact_tags_organization_id_tag_id_fk',
      columns: [table.organizationId, table.tagId],
      foreignColumns: [tags.organizationId, tags.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'contact_tags_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    // Saringan daftar percakapan per tag.
    index('contact_tags_organization_id_tag_id_idx').on(table.organizationId, table.tagId),
  ],
);

export type ContactTagRow = typeof contactTags.$inferSelect;
