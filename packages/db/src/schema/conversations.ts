import { CONVERSATION_STATUSES } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { channels } from './channels';
import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { contacts } from './contacts';
import { organizations } from './organizations';
import { users } from './users';

export const conversationStatus = pgEnum('conversation_status', CONVERSATION_STATUSES);

/**
 * Percakapan = satu SESI layanan kontak × channel (PRD §3.3).
 *
 * - Paling banyak SATU percakapan terbuka (status ≠ `resolved`) per (kontak, channel) — indeks unik
 *   parsial. Pesan masuk ke kontak yang percakapan terakhirnya `resolved` membuka percakapan BARU,
 *   jadi waktu respons/resolusi dihitung per sesi (docs/DECISIONS.md 2026-11-16).
 * - Jendela 24 jam: `last_inbound_at` = waktu pesan masuk terakhir menurut JAM SERVER (`received_at`
 *   kejadian webhook, bukan cap waktu Meta — review webhook R4); `window_expires_at` =
 *   `last_inbound_at` + 24 jam (dihitung aplikasi; kolom biasa supaya bisa diindeks/difilter).
 * - `assignee_user_id` = agen utama (cakupan `assigned` Teknisi). Perubahan status/assign menyusul
 *   (butir assign/antrian); urutan kunci: kontak → percakapan.
 * - `number` = nomor publik berurutan (`conversation_id` numerik mode kompatibel MobiChat, URL
 *   `/inbox/<number>`).
 */
export const conversations = pgTable(
  'conversations',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    number: bigint('number', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    contactId: uuid('contact_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    status: conversationStatus('status').notNull(),
    assigneeUserId: uuid('assignee_user_id'),
    /** Pesan pelanggan yang belum dibaca agen (direset saat dibaca — butir ruang chat). */
    unreadCount: integer('unread_count').notNull().default(0),
    lastMessageAt: timestamptz('last_message_at').notNull(),
    lastInboundAt: timestamptz('last_inbound_at'),
    windowExpiresAt: timestamptz('window_expires_at'),
    resolvedAt: timestamptz('resolved_at'),
    /** Laporan: pertama kali diambil/ditugaskan ke agen (diisi sekali). */
    firstAssignedAt: timestamptz('first_assigned_at'),
    /** Laporan: pesan keluar pertama oleh agen (diisi sekali, saat pesan dikirim). */
    firstResponseAt: timestamptz('first_response_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('conversations_organization_id_id_unique').on(table.organizationId, table.id),
    unique('conversations_number_unique').on(table.number),
    foreignKey({
      name: 'conversations_organization_id_contact_id_fk',
      columns: [table.organizationId, table.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'conversations_organization_id_channel_id_fk',
      columns: [table.organizationId, table.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'conversations_organization_id_assignee_user_id_fk',
      columns: [table.organizationId, table.assigneeUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    uniqueIndex('conversations_open_contact_channel_unique')
      .on(table.organizationId, table.contactId, table.channelId)
      .where(sql`${table.status} <> 'resolved'`),
    // Daftar inbox: terbaru dulu, per tab, per agen.
    index('conversations_organization_id_last_message_at_idx').on(
      table.organizationId,
      table.lastMessageAt,
      table.id,
    ),
    index('conversations_organization_id_status_last_message_at_idx').on(
      table.organizationId,
      table.status,
      table.lastMessageAt,
    ),
    index('conversations_organization_id_assignee_user_id_idx').on(
      table.organizationId,
      table.assigneeUserId,
    ),
    index('conversations_organization_id_contact_id_idx').on(table.organizationId, table.contactId),
    check('conversations_unread_count_nonnegative', sql`${table.unreadCount} >= 0`),
    check(
      'conversations_window_matches_inbound',
      sql`(${table.lastInboundAt} is null) = (${table.windowExpiresAt} is null)`,
    ),
    check(
      'conversations_resolved_at_matches_status',
      sql`(${table.status} = 'resolved') = (${table.resolvedAt} is not null)`,
    ),
  ],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type NewConversationRow = typeof conversations.$inferInsert;
