import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { apiKeys } from './api-keys';
import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { organizations } from './organizations';
import { users } from './users';

/**
 * Webhook keluar (Fase 3, docs/KONTRAK-WEBHOOK-KELUAR.md).
 *
 * Alur (transactional outbox): modul yang mengubah data menulis `outgoing_events` (HANYA ID +
 * jenis) di transaksi yang SAMA → worker `webhooks-out` (tiap 5 dtk) mengambil kejadian, membangun
 * payload dari database, membuat `webhook_deliveries` per endpoint yang melanggan, lalu mengirim
 * dengan tanda tangan HMAC dan percobaan ulang bertahap.
 */

export const outgoingEvents = pgTable(
  'outgoing_events',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    conversationId: uuid('conversation_id'),
    messageId: uuid('message_id'),
    contactId: uuid('contact_id'),
    /** Pelaku pengguna (bila ada) — untuk `data.actor`. */
    actorUserId: uuid('actor_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    index('outgoing_events_created_at_idx').on(table.createdAt),
    check('outgoing_events_type_format', sql`${table.type} ~ '^[a-z]+\\.[a-z_]+$'`),
  ],
);

export type OutgoingEventRow = typeof outgoingEvents.$inferSelect;
export type NewOutgoingEventRow = typeof outgoingEvents.$inferInsert;

export const webhookEndpointDisabledReason = pgEnum('webhook_endpoint_disabled_reason', [
  'manual',
  'auto_failures',
]);

/**
 * Endpoint webhook keluar. Rahasia penandatangan terenkripsi kotak rahasia
 * (`webhook_endpoints.secret`, AAD = organisasi + ID endpoint); rahasia lama disimpan selama masa
 * tumpang tindih rotasi.
 *
 * `format = 'mobichat'` (lapisan kompatibel MobiChat, docs/KONTRAK-API-MOBICHAT.md): body berbentuk
 * webhook MobiChat + `mobichat_base_url`/`mobichat_api_key` yang DISISIPKAN SAAT KIRIM (tidak pernah
 * tersimpan di `webhook_deliveries.payload`). API key-nya disimpan terenkripsi kotak rahasia
 * (`mobichat_api_key_encrypted`, AAD = organisasi + ID endpoint) + ID key-nya (dicek masih aktif saat
 * kirim) + 4 karakter terakhir untuk tampilan. `format` tidak bisa diubah setelah dibuat.
 */
export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    url: text('url').notNull(),
    description: text('description'),
    events: text('events').array().notNull(),
    format: text('format').notNull().default('native'),
    /** Mode MobiChat: alamat Balesin yang dipanggil balik workflow (`null` = `APP_URL`). */
    mobichatBaseUrl: text('mobichat_base_url'),
    mobichatApiKeyEncrypted: text('mobichat_api_key_encrypted'),
    mobichatApiKeyId: uuid('mobichat_api_key_id'),
    mobichatApiKeyLast4: text('mobichat_api_key_last4'),
    secretEncrypted: text('secret_encrypted').notNull(),
    secretRotatedAt: timestamptz('secret_rotated_at').notNull().defaultNow(),
    previousSecretEncrypted: text('previous_secret_encrypted'),
    previousSecretExpiresAt: timestamptz('previous_secret_expires_at'),
    enabled: boolean('enabled').notNull().default(true),
    disabledReason: webhookEndpointDisabledReason('disabled_reason'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastDeliveryAt: timestamptz('last_delivery_at'),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('webhook_endpoints_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'webhook_endpoints_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check('webhook_endpoints_url_length', sql`char_length(${table.url}) between 8 and 2048`),
    foreignKey({
      name: 'webhook_endpoints_organization_id_mobichat_api_key_id_fk',
      columns: [table.organizationId, table.mobichatApiKeyId],
      foreignColumns: [apiKeys.organizationId, apiKeys.id],
    }).onDelete('restrict'),
    check('webhook_endpoints_format_known', sql`${table.format} in ('native', 'mobichat')`),
    check(
      'webhook_endpoints_mobichat_consistent',
      sql`case when ${table.format} = 'mobichat' then ${table.mobichatApiKeyEncrypted} is not null and ${table.mobichatApiKeyId} is not null and ${table.mobichatApiKeyLast4} is not null else ${table.mobichatApiKeyEncrypted} is null and ${table.mobichatApiKeyId} is null and ${table.mobichatApiKeyLast4} is null and ${table.mobichatBaseUrl} is null end`,
    ),
    check(
      'webhook_endpoints_mobichat_base_url_length',
      sql`${table.mobichatBaseUrl} is null or char_length(${table.mobichatBaseUrl}) between 8 and 2048`,
    ),
    check('webhook_endpoints_events_count', sql`cardinality(${table.events}) between 1 and 50`),
    check(
      'webhook_endpoints_disabled_consistent',
      sql`${table.enabled} = (${table.disabledReason} is null)`,
    ),
  ],
);

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;

export const webhookDeliveryStatus = pgEnum('webhook_delivery_status', [
  'pending',
  'succeeded',
  'failed',
]);

/**
 * Riwayat pengiriman. `payload` = body JSON yang dikirim (memuat data pelanggan seperlunya) —
 * dikosongkan setelah `OUTGOING_WEBHOOK_PAYLOAD_RETENTION_DAYS` bersama `response_snippet`; baris
 * dihapus setelah 30 hari. Kirim ulang = baris BARU (`redelivery_of_id`).
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    endpointId: uuid('endpoint_id').notNull(),
    /** ID kejadian (`id` di body; sama untuk kirim ulang). */
    eventId: uuid('event_id').notNull(),
    event: text('event').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    payloadPurgedAt: timestamptz('payload_purged_at'),
    status: webhookDeliveryStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamptz('next_attempt_at'),
    httpStatus: integer('http_status'),
    durationMs: integer('duration_ms'),
    errorCode: text('error_code'),
    responseSnippet: text('response_snippet'),
    deliveredAt: timestamptz('delivered_at'),
    redeliveryOfId: uuid('redelivery_of_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'webhook_deliveries_organization_id_endpoint_id_fk',
      columns: [table.organizationId, table.endpointId],
      foreignColumns: [webhookEndpoints.organizationId, webhookEndpoints.id],
    }).onDelete('cascade'),
    index('webhook_deliveries_endpoint_id_created_at_idx').on(table.endpointId, table.createdAt),
    index('webhook_deliveries_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`),
    index('webhook_deliveries_created_at_idx').on(table.createdAt),
    check(
      'webhook_deliveries_snippet_length',
      sql`${table.responseSnippet} is null or char_length(${table.responseSnippet}) <= 500`,
    ),
    check(
      'webhook_deliveries_error_code_length',
      sql`${table.errorCode} is null or char_length(${table.errorCode}) <= 64`,
    ),
  ],
);

export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
