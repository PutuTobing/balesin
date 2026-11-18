import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

import { channels } from './channels';
import { createdAtColumn, timestamptz, updatedAtColumn } from './columns';
import { messages } from './messages';
import { organizations } from './organizations';

/**
 * Keadaan pengambilan kotak masuk channel Email (Fase 6). TERPISAH dari `channels` supaya pemroses
 * kotak masuk tidak pernah meng-`UPDATE channels` (review webhook N1: transaksi webhook memegang
 * `FOR SHARE` pada baris channel).
 *
 * - `uid_validity` + `last_uid`: posisi terakhir di folder IMAP (RFC 3501). `UIDVALIDITY` berubah →
 *   posisi diulang dari email TERBARU (bukan seluruh isi kotak), supaya kotak lama tidak membanjiri
 *   inbox; email yang sudah pernah diambil tetap tidak tergandakan (`Message-ID` idempoten).
 * - `next_poll_at`: kapan boleh diambil lagi (interval channel; gagal → mundur bertahap).
 * - `last_poll_code`: `CONNECTION_TEST_CODES` (`@balesin/shared`) — bukan pesan mentah server.
 */
export const emailMailboxStates = pgTable(
  'email_mailbox_states',
  {
    channelId: uuid('channel_id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    uidValidity: bigint('uid_validity', { mode: 'number' }),
    lastUid: bigint('last_uid', { mode: 'number' }).notNull().default(0),
    lastPolledAt: timestamptz('last_polled_at'),
    lastPollOk: boolean('last_poll_ok'),
    lastPollCode: text('last_poll_code'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** Email dilewati (terlalu besar, balasan otomatis/bounce, loop) sejak channel dibuat. */
    skippedMessages: integer('skipped_messages').notNull().default(0),
    nextPollAt: timestamptz('next_poll_at').notNull().defaultNow(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'email_mailbox_states_organization_id_channel_id_fk',
      columns: [table.organizationId, table.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete('restrict'),
    index('email_mailbox_states_next_poll_at_idx').on(table.nextPollAt),
    check(
      'email_mailbox_states_counters',
      sql`${table.lastUid} >= 0 and ${table.consecutiveFailures} >= 0 and ${table.skippedMessages} >= 0 and (${table.uidValidity} is null or ${table.uidValidity} > 0)`,
    ),
    check(
      'email_mailbox_states_code_format',
      sql`${table.lastPollCode} is null or ${table.lastPollCode} ~ '^[a-z_]{1,64}$'`,
    ),
  ],
);

export type EmailMailboxState = typeof emailMailboxStates.$inferSelect;
export type NewEmailMailboxState = typeof emailMailboxStates.$inferInsert;

/**
 * HTML email masuk yang SUDAH disanitasi server (Fase 6) — dipisah dari `messages` supaya daftar
 * pesan tetap ringan. Hanya dibaca lewat endpoint `email-html` (cakupan percakapan) dan selalu
 * ditampilkan web di `<iframe sandbox>`. Ikut terhapus bersama pesannya (hapus kontak, UU PDP).
 */
export const messageEmailBodies = pgTable(
  'message_email_bodies',
  {
    messageId: uuid('message_id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    html: text('html').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'message_email_bodies_organization_id_message_id_fk',
      columns: [table.organizationId, table.messageId],
      foreignColumns: [messages.organizationId, messages.id],
    }).onDelete('cascade'),
    check('message_email_bodies_html_size', sql`octet_length(${table.html}) between 1 and 524288`),
  ],
);

export type MessageEmailBody = typeof messageEmailBodies.$inferSelect;
