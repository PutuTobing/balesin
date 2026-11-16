import { CONTACT_EDITABLE_FIELDS, CONTACT_EVENT_KINDS } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { apiKeys } from './api-keys';
import { createdAtColumn, idColumn, updatedAtColumn } from './columns';
import { contacts } from './contacts';
import { organizations } from './organizations';
import { users } from './users';

export const contactEventKind = pgEnum('contact_event_kind', CONTACT_EVENT_KINDS);

const fieldList = CONTACT_EDITABLE_FIELDS.map((field) => `'${field}'`).join(', ');

/**
 * Riwayat perubahan data kontak oleh tim (Fase 2 butir 8) — tampil di tab "Log" percakapan kontak
 * itu. TIDAK menyimpan nilai data pelanggan (nama, email, catatan, atribut): hanya nama isian yang
 * berubah (`fields`) dan nama/warna tag saat kejadian (`tag_name`/`tag_color` — nama tag adalah
 * label internal tim, bukan data pribadi). Ikut terhapus saat kontak dihapus (UU PDP).
 */
export const contactEvents = pgTable(
  'contact_events',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    contactId: uuid('contact_id').notNull(),
    kind: contactEventKind('kind').notNull(),
    /** `null` = sistem/bot/API. */
    actorUserId: uuid('actor_user_id'),
    /** Perubahan lewat API publik: key pelakunya (review API publik R2). */
    apiKeyId: uuid('api_key_id'),
    tagName: text('tag_name'),
    tagColor: text('tag_color'),
    fields: text('fields').array(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'contact_events_organization_id_contact_id_fk',
      columns: [table.organizationId, table.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contact_events_organization_id_actor_user_id_fk',
      columns: [table.organizationId, table.actorUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'contact_events_organization_id_api_key_id_fk',
      columns: [table.organizationId, table.apiKeyId],
      foreignColumns: [apiKeys.organizationId, apiKeys.id],
    }).onDelete('restrict'),
    index('contact_events_contact_id_created_at_idx').on(table.contactId, table.createdAt),
    check(
      'contact_events_tag_has_name',
      sql`${table.kind} not in ('tag_added', 'tag_removed') or (${table.tagName} is not null and ${table.tagColor} is not null)`,
    ),
    check(
      'contact_events_update_has_fields',
      sql.raw(
        `kind <> 'contact_updated' or (fields is not null and cardinality(fields) between 1 and 4 and fields <@ array[${fieldList}]::text[])`,
      ),
    ),
  ],
);

export type ContactEventRow = typeof contactEvents.$inferSelect;
export type NewContactEventRow = typeof contactEvents.$inferInsert;
