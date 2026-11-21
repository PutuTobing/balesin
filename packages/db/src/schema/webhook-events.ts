import { WEBHOOK_EVENT_KINDS, WEBHOOK_EVENT_STATUSES } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { channelType, channels } from './channels';
import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { contacts } from './contacts';
import { organizations } from './organizations';

export const webhookEventKind = pgEnum('webhook_event_kind', WEBHOOK_EVENT_KINDS);
export const webhookEventStatus = pgEnum('webhook_event_status', WEBHOOK_EVENT_STATUSES);

/**
 * Kejadian webhook masuk (ARCHITECTURE.md §4 langkah 2, SECURITY.md §4): satu baris per pesan masuk /
 * status / error / perubahan field lain, hasil pemecahan satu notifikasi Meta yang SUDAH lolos
 * verifikasi tanda tangan.
 *
 * - `payload` = bagian notifikasi yang sudah divalidasi skema (`@balesin/core` `splitWhatsAppWebhook`).
 *   TIDAK PERNAH memuat header, tanda tangan, App Secret, atau rahasia lain. Isi pesan pelanggan ada
 *   di sini (data pribadi, UU PDP): jangan di-log. Retensi (review webhook S4): job `maintenance`
 *   worker mengosongkan `payload` (`{}` + `payload_purged_at`) kejadian yang sudah selesai setelah N
 *   hari (`organizations.webhook_payload_retention_days`); baris `other` hanya menyimpan hash isinya.
 * - `contact_id` diisi worker saat kejadian pesan/status dikaitkan ke kontak — hapus kontak (UU PDP)
 *   ikut mengosongkan kejadiannya.
 * - Idempotensi: `(channel_id, dedup_key)` unik. `dedup_key` = `m:<wamid>` (pesan), `s:<wamid>:<status>`
 *   (status), `e:`/`o:` + hash isi (tanpa ID dari Meta). Kiriman ulang Meta = `ON CONFLICT DO NOTHING`.
 * - Retensi baris minimal 8 hari (lebih lama dari jendela kirim ulang Meta 7 hari, dan dari batas
 *   umur kejadian yang diterima penerima): kalau dihapus lebih cepat, kiriman ulang yang sah bisa
 *   tersimpan dua kali.
 * - `channel_id` adalah channel yang BENAR-BENAR memiliki nomornya (dicocokkan dari
 *   `metadata.phone_number_id` + WABA), bukan sekadar channel di URL.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id').notNull(),
    /** Jenis channel sumber (saat ini hanya `whatsapp`). */
    source: channelType('source').notNull(),
    kind: webhookEventKind('kind').notNull(),
    /** Field langganan Meta (`messages`, `account_update`, …). */
    field: text('field').notNull(),
    dedupKey: text('dedup_key').notNull(),
    /** wamid pesan (pesan masuk & status); `null` untuk error/field lain. */
    externalId: text('external_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** Waktu kejadian menurut Meta (`timestamp`), bila ada. */
    occurredAt: timestamptz('occurred_at'),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    status: webhookEventStatus('status').notNull().default('pending'),
    /** Berapa kali worker sudah mencoba memproses. */
    attempts: integer('attempts').notNull().default(0),
    /** Kode/nama kesalahan singkat terakhir (BUKAN pesan error mentah — bisa memuat isi pesan). */
    lastError: text('last_error'),
    processedAt: timestamptz('processed_at'),
    /** Kontak terkait (diisi worker). */
    contactId: uuid('contact_id'),
    /** Kapan `payload` dikosongkan (retensi / hapus kontak / baris yang ditolak database). */
    payloadPurgedAt: timestamptz('payload_purged_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // Channel milik organisasi yang sama (FK komposit, catatan F.11 review Fase 0).
    foreignKey({
      name: 'webhook_events_organization_id_channel_id_fk',
      columns: [table.organizationId, table.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'webhook_events_organization_id_contact_id_fk',
      columns: [table.organizationId, table.contactId],
      foreignColumns: [contacts.organizationId, contacts.id],
    }).onDelete('restrict'),
    uniqueIndex('webhook_events_channel_id_dedup_key_unique').on(table.channelId, table.dedupKey),
    // Antrean kerja / pemulihan: kejadian yang belum selesai per organisasi.
    index('webhook_events_organization_id_status_received_at_idx').on(
      table.organizationId,
      table.status,
      table.receivedAt,
    ),
    // Status pesan keluar dicocokkan lewat wamid (butir pesan keluar).
    index('webhook_events_organization_id_channel_id_external_id_idx').on(
      table.organizationId,
      table.channelId,
      table.externalId,
    ),
    // Retensi: kejadian yang payload-nya belum dikosongkan, tertua dulu.
    index('webhook_events_retention_idx')
      .on(table.receivedAt)
      .where(sql`${table.payloadPurgedAt} is null`),
    // Penghapusan baris lama (review kontak R5): tertua dulu, lintas organisasi.
    index('webhook_events_received_at_idx').on(table.receivedAt),
    index('webhook_events_organization_id_contact_id_idx')
      .on(table.organizationId, table.contactId)
      .where(sql`${table.contactId} is not null`),
    check('webhook_events_dedup_key_length', sql`char_length(${table.dedupKey}) between 3 and 320`),
    check('webhook_events_field_format', sql`${table.field} ~ '^[a-z_]{1,64}$'`),
    check(
      'webhook_events_external_id_length',
      sql`${table.externalId} is null or char_length(${table.externalId}) between 1 and 256`,
    ),
    check('webhook_events_attempts_nonnegative', sql`${table.attempts} >= 0`),
    check(
      'webhook_events_last_error_length',
      sql`${table.lastError} is null or char_length(${table.lastError}) <= 200`,
    ),
    // Pesan & status selalu punya wamid.
    check(
      'webhook_events_external_id_required',
      sql`${table.kind} not in ('message', 'status') or ${table.externalId} is not null`,
    ),
    // Selesai (diproses/dilewati) selalu bercap waktu; yang belum selesai tidak.
    check(
      'webhook_events_processed_at_matches_status',
      sql`(${table.status} in ('processed', 'skipped')) = (${table.processedAt} is not null)`,
    ),
  ],
);

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
