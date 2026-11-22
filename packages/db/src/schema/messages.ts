import {
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_SENDER_KINDS,
  MESSAGE_TYPES,
  type InteractiveMessage,
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

import { apiKeys } from './api-keys';
import { broadcastCampaigns } from './broadcasts';
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

/**
 * Metadata media dari webhook. HANYA rujukan media di platform — berkasnya diunduh saat diminta.
 * `metaMediaId` (nama historis) = rujukan per channel: WhatsApp = ID media Meta; Telegram =
 * `file_id`; Messenger/Instagram = URL lampiran CDN Meta (host di-allowlist saat diunduh); Email =
 * `email:<id berkas>` (lampiran sudah disimpan saat diambil dari IMAP, lihat `media_file_id`).
 */
export interface MessageMedia {
  kind: MessageMediaKind;
  /** Rujukan media di platform (lihat di atas) — jangan pernah mengikuti URL payload tanpa allowlist. */
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
  /** Pesan interaktif KELUAR (tombol/daftar) — dibangun ulang worker jadi payload Meta. */
  interactiveMessage?: InteractiveMessage;
  /**
   * Template KELUAR (Fase 4): nama + bahasa + kategori saat dikirim, nilai variabel yang SUDAH
   * divalidasi, ID media judul (unggahan). Worker membangun `template.components` dari sini.
   */
  template?: {
    templateId: string;
    name: string;
    language: string;
    category: string;
    named: boolean;
    headerFormat: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null;
    headerVariable: string | null;
    headerText: string | null;
    headerMediaFileId: string | null;
    bodyVariables: string[];
    values: Record<string, string>;
    buttons: { index: number; type: 'URL' | 'COPY_CODE'; value: string }[];
    /**
     * Nilai rahasia (kode OTP template AUTHENTICATION, review template S1): `values`/`buttons`
     * dikosongkan worker SEGERA setelah percobaan kirim selesai (berhasil/gagal final); teks pesan
     * disamarkan sejak awal. Pesan seperti ini tidak bisa dikirim ulang (minta kode baru).
     */
    sensitive?: boolean;
  };
  forwarded?: boolean;
  frequentlyForwarded?: boolean;
  /**
   * Fase 6 — email (masuk & keluar). `subject` subjek email; `references` = rantai `Message-ID`
   * utas (maks. 20, untuk header balasan); `inReplyTo` = `Message-ID` yang dibalas; `authWarning` =
   * `Authentication-Results` server penerima melaporkan SPF/DKIM/DMARC gagal; `skippedAttachments` =
   * lampiran yang tidak disimpan. HTML tersanitasi ada di `message_email_bodies`.
   */
  email?: {
    subject: string | null;
    inReplyTo: string | null;
    references: string[];
    authWarning: boolean;
    /** Review Fase 6 R1 — `pass`/`fail`/`unverified` (data lama: tidak ada → dari `authWarning`). */
    senderVerification?: 'pass' | 'fail' | 'unverified';
    skippedAttachments: number;
    hasHtml: boolean;
    /**
     * Tahap 9.0 (huruf kecil; data lama tidak ada). Masuk: header `To`/`Cc` (maks. 50 masing-masing)
     * + `replyAll` (To + Cc tanpa alamat/alias channel & pengirim). Keluar: `to` = pelanggan,
     * `cc`/`bcc` = alamat tambahan (diisi api saat membuat pesan; `bcc` TIDAK PERNAH jadi header),
     * `rejectedCopies` = alamat Cc/Bcc yang ditolak server SMTP (pesan tetap terkirim ke lainnya).
     */
    to?: string[];
    cc?: string[];
    bcc?: string[];
    replyAll?: string[];
    rejectedCopies?: string[];
    /**
     * Review 9.0 R8: penerima utama ditolak SMTP tetapi tembusan ini sudah menerima email-nya —
     * kirim ulang tidak mengirimi mereka lagi (tetap tertulis di header Cc).
     */
    deliveredCopies?: string[];
  };
  /** Fase 6 — Telegram: ID `callback_query` (tombol inline) yang sudah dijawab. */
  telegramCallback?: { data: string | null };
}

/**
 * Pesan masuk & keluar (PRD §3.3).
 *
 * - `wamid` unik per channel (indeks unik biasa: banyak `NULL` boleh — pesan keluar sebelum diterima
 *   Meta). Pesan masuk disimpan idempoten lewat wamid. Fase 6: kolom ini = ID pesan EKSTERNAL per
 *   channel (nama historis): WhatsApp wamid, Telegram `<chat_id>:<message_id>`, Email `Message-ID`
 *   (tanpa `<>`; > 256 karakter → `sha256:<hex>`), Messenger/Instagram `mid`.
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
    /**
     * Klaim atomik worker SEBELUM memanggil Meta (review ruang chat R3). Job yang menemukan klaim
     * tanpa wamid tidak mengirim lagi (→ `delivery_unknown`). Dikosongkan saat kirim ulang.
     */
    sendClaimedAt: timestamptz('send_claimed_at'),
    /**
     * Pengguna yang terakhir menekan "Kirim ulang" (review ruang chat R2). `sender_user_id` tetap
     * PENULIS ASLI (pemilik kunci idempotensi).
     */
    lastSentByUserId: uuid('last_sent_by_user_id'),
    /** Pesan ditandai (bintang) — dipakai bersama tim, satu tanda per pesan (butir 8). */
    starredAt: timestamptz('starred_at'),
    starredByUserId: uuid('starred_by_user_id'),
    /**
     * Template yang dikirim (Fase 4) + kategorinya SAAT dikirim (dasar laporan biaya per kategori;
     * tanpa FK: template boleh dihapus, riwayat pesan tetap).
     */
    templateId: uuid('template_id'),
    templateCategory: text('template_category'),
    /** Pesan keluar yang dikirim lewat API publik (API key; `sender_user_id` kosong). */
    apiKeyId: uuid('api_key_id'),
    /** Pesan keluar dari kampanye broadcast (Fase 4; `sender_kind = 'broadcast'`, tanpa pengirim). */
    broadcastId: uuid('broadcast_id'),
    /** Salinan lokal media (unggahan untuk pesan keluar / cache unduhan pesan masuk). */
    mediaFileId: uuid('media_file_id'),
    /**
     * Tahap 9.0 — email MASUK: alamat tujuan (huruf kecil) = `Delivered-To`/`X-Original-To`/`To`/`Cc`
     * pertama yang cocok dengan alamat/alias channel; `null` = tidak cocok / data lama. Saringan
     * "Alamat tujuan" daftar percakapan. Kepada/Cc lengkap ada di `extras.email`.
     */
    emailRecipient: text('email_recipient'),
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
    // Idempotensi pesan lewat API publik: per API key (`Idempotency-Key`).
    uniqueIndex('messages_api_key_idempotency_unique')
      .on(table.organizationId, table.apiKeyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null and ${table.apiKeyId} is not null`),
    check(
      'messages_single_sender',
      sql`${table.senderUserId} is null or ${table.apiKeyId} is null`,
    ),
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
    // Batas kirim harian (24 jam bergulir) per organisasi & per pengirim.
    index('messages_outbound_created_at_idx')
      .on(table.organizationId, table.createdAt)
      .where(sql`${table.direction} = 'outbound'`),
    index('messages_outbound_sender_created_at_idx')
      .on(table.organizationId, table.senderUserId, table.createdAt)
      .where(sql`${table.direction} = 'outbound'`),
    // Pemeriksa klaim kirim macet (`stale-send-claims`, review R5): hanya baris yang sedang diklaim.
    index('messages_pending_send_claim_idx')
      .on(table.sendClaimedAt)
      .where(
        sql`${table.status} = 'pending' and ${table.wamid} is null and ${table.sendClaimedAt} is not null`,
      ),
    foreignKey({
      name: 'messages_organization_id_last_sent_by_user_id_fk',
      columns: [table.organizationId, table.lastSentByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'messages_organization_id_starred_by_user_id_fk',
      columns: [table.organizationId, table.starredByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'messages_organization_id_api_key_id_fk',
      columns: [table.organizationId, table.apiKeyId],
      foreignColumns: [apiKeys.organizationId, apiKeys.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'messages_organization_id_broadcast_id_fk',
      columns: [table.organizationId, table.broadcastId],
      foreignColumns: [broadcastCampaigns.organizationId, broadcastCampaigns.id],
    }).onDelete('restrict'),
    // Jaring pengaman kode OTP (review template Info 1): template sensitif yang nilainya belum
    // (tanpa syarat kolom `type`: nilai enum `template` baru ditambah 0024 di transaksi yang sama;
    // `extras.template` hanya ada di pesan template)
    // dikosongkan — keluar dari indeks begitu dikosongkan job `sensitive-template-wipe`.
    index('messages_sensitive_template_idx')
      .on(table.createdAt)
      .where(
        sql`(${table.extras} -> 'template' ->> 'sensitive') = 'true' and (${table.extras} -> 'template' -> 'values') <> '{}'::jsonb`,
      ),
    index('messages_broadcast_id_idx')
      .on(table.broadcastId)
      .where(sql`${table.broadcastId} is not null`),
    // Batas kirim harian per API key (24 jam bergulir).
    index('messages_outbound_api_key_created_at_idx')
      .on(table.organizationId, table.apiKeyId, table.createdAt)
      .where(sql`${table.direction} = 'outbound' and ${table.apiKeyId} is not null`),
    // Saringan "Alamat tujuan" (tahap 9.0): percakapan yang pernah menerima email ke alias itu.
    index('messages_email_recipient_idx')
      .on(table.organizationId, table.emailRecipient, table.conversationId)
      .where(sql`${table.emailRecipient} is not null`),
    check(
      'messages_email_recipient_valid',
      sql`${table.emailRecipient} is null or (${table.direction} = 'inbound' and char_length(${table.emailRecipient}) between 3 and 254)`,
    ),
    // Tab "Pesan ditandai" panel detail.
    index('messages_conversation_id_starred_idx')
      .on(table.conversationId, table.occurredAt)
      .where(sql`${table.starredAt} is not null`),
    check(
      'messages_star_consistent',
      sql`(${table.starredAt} is null) = (${table.starredByUserId} is null)`,
    ),
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
