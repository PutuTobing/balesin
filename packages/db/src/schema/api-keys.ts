import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { organizations } from './organizations';
import { users } from './users';

/**
 * API key untuk API publik (Fase 3, docs/KONTRAK-API-PUBLIK.md). Kunci utuh
 * `blsn_live_<id>_<rahasia>`: `lookup_key` (bagian `<id>`, 16 hex) disimpan polos untuk pencarian, rahasia HANYA
 * sebagai HMAC-SHA256 berlada (`secret_hash`, pepper turunan `BALESIN_MASTER_KEY`). Dicabut =
 * `revoked_at` terisi (baris disimpan untuk jejak audit & pesan yang pernah dikirimnya).
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    lookupKey: text('lookup_key').notNull(),
    secretHash: text('secret_hash').notNull(),
    scopes: text('scopes').array().notNull(),
    /** `null` = semua IP. Isi: IP tunggal atau CIDR. */
    allowedIps: text('allowed_ips').array(),
    dailySendLimit: integer('daily_send_limit').notNull().default(500),
    /**
     * Tahap 9.1: allowlist host URL lampiran email (`host` persis / `*.domain` / IP literal, ≤ 20).
     * Kosong = lampiran `url` ditolak. Pengirim email yang diizinkan: `api_key_email_senders`.
     */
    emailAttachmentHosts: text('email_attachment_hosts').array().notNull().default([]),
    expiresAt: timestamptz('expires_at'),
    revokedAt: timestamptz('revoked_at'),
    revokedByUserId: uuid('revoked_by_user_id'),
    createdByUserId: uuid('created_by_user_id'),
    lastUsedAt: timestamptz('last_used_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('api_keys_organization_id_id_unique').on(table.organizationId, table.id),
    unique('api_keys_lookup_key_unique').on(table.lookupKey),
    foreignKey({
      name: 'api_keys_organization_id_created_by_user_id_fk',
      columns: [table.organizationId, table.createdByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'api_keys_organization_id_revoked_by_user_id_fk',
      columns: [table.organizationId, table.revokedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    index('api_keys_organization_id_created_at_idx').on(table.organizationId, table.createdAt),
    check('api_keys_lookup_key_format', sql`${table.lookupKey} ~ '^[0-9a-f]{16}$'`),
    check('api_keys_secret_hash_format', sql`${table.secretHash} ~ '^[0-9a-f]{64}$'`),
    check('api_keys_name_length', sql`char_length(${table.name}) between 1 and 80`),
    check(
      'api_keys_scopes_count',
      sql`cardinality(${table.scopes}) between 1 and 20 and (${table.allowedIps} is null or cardinality(${table.allowedIps}) <= 20)`,
    ),
    check('api_keys_daily_send_limit_range', sql`${table.dailySendLimit} between 1 and 100000`),
    check(
      'api_keys_email_attachment_hosts_count',
      sql`cardinality(${table.emailAttachmentHosts}) <= 20`,
    ),
  ],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type NewApiKeyRow = typeof apiKeys.$inferInsert;
