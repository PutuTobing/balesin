import {
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_SENDER_KINDS,
  MESSAGE_TYPES,
  type MessageMediaKind,
} from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { channels } from './channels';
import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { contacts } from './contacts';
import { mediaFiles } from './media-files';
import { conversations } from './conversations';
import { organizations } from './organizations';
import { users } from './users';

export const messageDirection = pgEnum('message_direction', MESSAGE_DIRECTIONS);
export const messageSenderKind = pgEnum('message_sender_kind', MESSAGE_SENDER_KINDS);
export const messageType = pgEnum('message_type', MESSAGE_TYPES);
export const messageDeliveryStatus = pgEnum('message_delivery_status', MESSAGE_DELIVERY_STATUSES);

/** Metadata media dari webhook. HANYA ID media Meta — berkasnya diunduh di butir ruang chat. */
export interface MessageMedia {
  kind: MessageMediaKind;
  /** ID media Meta (diunduh lewat Graph API, host tetap — jangan pernah mengikuti URL payload). */
  metaMediaId: string;
  /** Dari pelanggan — tidak tepercaya (validasi dengan sniffing saat diunduh). */
  mimeType: string | null;
  sha256: string | null;
  filename: string | null;
  voice: boolean;
  animated: boolean;
}

export interface MessageLocation {
  latitude: number;
  longitude: number;
  name: string | null;
  address: string | null;
}

/** Isian tambahan yang jarang ada (dibaca api lewat skema Zod; isian rusak dibuang). */
export interface MessageExtras {
  interactive?: {
    kind: 'button' | 'button_reply' | 'list_reply' | 'nfm_reply' | 'other';
    id: string | null;
    title: string | null;
    description: string | null;
  };
  referral?: {
    sourceUrl: string | null;
    sourceId: string | null;
    sourceType: string | null;
    headline: string | null;
    body: string | null;
    ctwaClid: string | null;
  };
  sharedContacts?: number;
  forwarded?: boolean;
  frequentlyForwarded?: boolean;
}

/**
 * Pesan masuk & keluar (PRD §3.3).
 *
 * - `wamid` unik per channel (indeks unik biasa: banyak `NULL` boleh — pesan keluar sebelum diterima
 *   Meta). Pesan masuk disimpan idempoten lewat wamid.
 * - `occurred_at` = urutan tampilan: pesan masuk memakai cap waktu Meta yang DIJEPIT ke ≤ waktu
 *   diterima server (cap waktu payload tidak dipakai untuk jendela 24 jam / SLA — R4).
 * - Status hanya untuk pesan keluar dan hanya maju (`isStatusAdvance`); pesan masuk `status = null`.
 * - `reply_to_*` = balas-kutip (`context.id`); `reaction_to_*` = sasaran reaksi. `*_wamid` selalu
 *   disimpan; `*_message_id` diisi bila pesan sasarannya ada di channel yang sama.
 * - `contact_id` disimpan langsung (bukan lewat percakapan) supaya hapus/ekspor per kontak (UU PDP)
 *   cukup satu query.
 * - `number` = nomor publik berurutan (`message_id` numerik mode kompatibel MobiChat).
 */
export const messages = pgTable(
  'messages',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    number: bigint('number', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    conversationId: uuid('conversation_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    direction: messageDirection('direction').notNull(),
    senderKind: messageSenderKind('sender_kind').notNull(),
    /** Agen pengirim (pesan keluar oleh manusia). */
    senderUserId: uuid('sender_user_id'),
    type: messageType('type').notNull(),
    /** Jenis asli dari Meta (`button`, `order`, jenis baru, …). */
    rawType: text('raw_type'),
    wamid: text('wamid'),
    text: text('text'),
    media: jsonb('media').$type<MessageMedia>(),
    location: jsonb('location').$type<MessageLocation>(),
    extras: jsonb('extras').$type<MessageExtras>().notNull().default({}),
    replyToWamid: text('reply_to_wamid'),
    replyToMessageId: uuid('reply_to_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
    reactionEmoji: text('reaction_emoji'),
    reactionToWamid: text('reaction_to_wamid'),
    reactionToMessageId: uuid('reaction_to_message_id').references((): AnyPgColumn => messages.id, {
      onDelete: 'set null',
    }),
    status: messageDeliveryStatus('status'),
    statusUpdatedAt: timestamptz('status_updated_at'),
    /** Kode error Meta (pesan gagal / jenis belum didukung) — bukan teks error mentah. */
    errorCode: integer('error_code'),
    /** Pesan keluar `failed`: `OUTBOUND_FAILURE_REASONS` (`@balesin/shared`). */
    failureReason: text('failure_reason'),
    /** Kunci idempotensi dari klien (`clientMessageId`), unik per pengirim. */
    idempotencyKey: text('idempotency_key'),
    /** Berapa kali pesan keluar sudah dicoba kirim (termasuk kirim ulang). */
    sendAttempts: integer('send_attempts').notNull().default(0),
    /** Salinan lokal media (unggahan untuk pesan keluar / cache unduhan pesan masuk). */
    mediaFileId: uuid('media_file_id'),
    occurredAt: timestamptz('occurred_at').notNull(),
    /** Pesan masuk: waktu kejadian webhook diterima server. */
    receivedAt: timestamptz('received_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('messages_organization_id_id_unique').on(table.organizationId, table.id),
    unique('messages_number_unique').on(table.number),
    foreignKey({
      name: 'messages_organization_id_conversation_id_fk',
      columns: [table.organizationId, table.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'messages_organization_id_contact_id_fk',
      columns: [table.organizationId, table.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'messages_organization_id_channel_id_fk',
      columns: [table.organizationId, table.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'messages_organization_id_sender_user_id_fk',
      columns: [table.organizationId, table.senderUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    uniqueIndex('messages_channel_id_wamid_unique').on(table.channelId, table.wamid),
    uniqueIndex('messages_idempotency_unique')
      .on(table.organizationId, table.senderUserId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    foreignKey({
      name: 'messages_organization_id_media_file_id_fk',
      columns: [table.organizationId, table.mediaFileId],
      foreignColumns: [mediaFiles.organizationId, mediaFiles.id],
    }).onDelete('restrict'),
    // Ruang chat: pesan satu percakapan, terbaru dulu.
    index('messages_conversation_id_occurred_at_idx').on(
      table.conversationId,
      table.occurredAt,
      table.id,
    ),
    index('messages_organization_id_contact_id_idx').on(table.organizationId, table.contactId),
    check(
      'messages_inbound_has_no_status',
      sql`${table.direction} <> 'inbound' or (${table.status} is null and ${table.senderKind} = 'customer')`,
    ),
    check(
      'messages_outbound_has_status',
      sql`${table.direction} <> 'outbound' or ${table.status} is not null`,
    ),
    check(
      'messages_wamid_length',
      sql`(${table.wamid} is null or char_length(${table.wamid}) between 1 and 256) and (${table.replyToWamid} is null or char_length(${table.replyToWamid}) between 1 and 256) and (${table.reactionToWamid} is null or char_length(${table.reactionToWamid}) between 1 and 256)`,
    ),
    check(
      'messages_text_length',
      sql`${table.text} is null or char_length(${table.text}) <= 65536`,
    ),
    check(
      'messages_raw_type_format',
      sql`${table.rawType} is null or ${table.rawType} ~ '^[a-z_]{1,64}$'`,
    ),
    check(
      'messages_failure_reason_format',
      sql`${table.failureReason} is null or ${table.failureReason} ~ '^[a-z_]{1,64}$'`,
    ),
    check(
      'messages_idempotency_key_format',
      sql`${table.idempotencyKey} is null or ${table.idempotencyKey} ~ '^[0-9a-f-]{36}$'`,
    ),
    check('messages_send_attempts_nonnegative', sql`${table.sendAttempts} >= 0`),
    check(
      'messages_reaction_emoji_length',
      sql`${table.reactionEmoji} is null or char_length(${table.reactionEmoji}) between 1 and 64`,
    ),
  ],
);

export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
