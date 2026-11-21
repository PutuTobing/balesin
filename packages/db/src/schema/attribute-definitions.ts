import { ATTRIBUTE_TYPES } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, updatedAtColumn } from './columns';
import { organizations } from './organizations';
import { ticketBoards } from './tickets';

export const attributeType = pgEnum('attribute_type', ATTRIBUTE_TYPES);
export const attributeEntity = pgEnum('attribute_entity', ['contact', 'ticket']);

/**
 * Definisi atribut kustom (Fase 5): KONTAK per organisasi (`board_id` kosong) atau TIKET per board.
 * Nilainya tetap disimpan sebagai daftar `{ key, value }` di baris kontak/tiket; definisi hanya
 * menambah label, jenis (validasi), wajib, dan pilihan. Kunci unik tanpa beda huruf besar/kecil.
 */
export const attributeDefinitions = pgTable(
  'attribute_definitions',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    entity: attributeEntity('entity').notNull(),
    boardId: uuid('board_id'),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: attributeType('type').notNull(),
    required: boolean('required').notNull().default(false),
    options: jsonb('options')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    position: integer('position').notNull().default(0),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'attribute_definitions_organization_id_board_id_fk',
      columns: [table.organizationId, table.boardId],
      foreignColumns: [ticketBoards.organizationId, ticketBoards.id],
    }).onDelete('cascade'),
    uniqueIndex('attribute_definitions_contact_key_unique')
      .on(table.organizationId, sql`lower(${table.key})`)
      .where(sql`${table.entity} = 'contact'`),
    uniqueIndex('attribute_definitions_ticket_key_unique')
      .on(table.boardId, sql`lower(${table.key})`)
      .where(sql`${table.entity} = 'ticket'`),
    check(
      'attribute_definitions_entity_board',
      sql`(${table.entity} = 'contact') = (${table.boardId} is null)`,
    ),
    check(
      'attribute_definitions_lengths',
      sql`char_length(${table.key}) between 1 and 40 and char_length(${table.label}) between 1 and 60 and jsonb_typeof(${table.options}) = 'array' and jsonb_array_length(${table.options}) <= 50`,
    ),
    check(
      'attribute_definitions_select_options',
      sql`(${table.type} = 'select') = (jsonb_array_length(${table.options}) > 0)`,
    ),
  ],
);

export type AttributeDefinitionRow = typeof attributeDefinitions.$inferSelect;
