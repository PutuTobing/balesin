import { MESSAGE_MEDIA_KINDS } from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { apiKeys } from './api-keys';
import { channels } from './channels';
import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { organizations } from './organizations';
import { users } from './users';

export const mediaKind = pgEnum('media_kind', MESSAGE_MEDIA_KINDS);
export const mediaSource = pgEnum('media_source', ['upload', 'inbound']);

/**
 * Salinan LOKAL berkas media (Fase 2 butir 6): unggahan agen (untuk dikirim) dan unduhan media
 * masuk dari Meta (cache). Berkasnya di disk `MEDIA_DIR` dengan nama acak buatan server
 * (`storage_key`), BUKAN di database dan BUKAN nama dari klien.
 *
 * - `mime_type` = hasil deteksi isi (magic bytes), bukan dari klien/Meta.
 * - `filename` = nama tampilan yang sudah dibersihkan (`cleanFileName`) — hanya untuk ditampilkan
 *   dan `Content-Disposition` (`filename*` RFC 5987).
 * - `meta_media_ref` = ID media di Meta (hasil unggah, atau ID media pesan masuk).
 * - Retensi: `expires_at` (dari `organizations.media_retention_days`). Pembersih api menghapus
 *   berkasnya lalu mengisi `deleted_at` + mengosongkan `storage_key`. Hapus kontak (UU PDP)
 *   memajukan `expires_at` berkas pesan-pesannya.
 */
export const mediaFiles = pgTable(
  'media_files',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    channelId: uuid('channel_id').notNull(),
    source: mediaSource('source').notNull(),
    kind: mediaKind('kind').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    filename: text('filename'),
    storageKey: text('storage_key'),
    metaMediaRef: text('meta_media_ref'),
    uploadedByUserId: uuid('uploaded_by_user_id'),
    /** Unggahan lewat API publik (API key). */
    uploadedByApiKeyId: uuid('uploaded_by_api_key_id'),
    expiresAt: timestamptz('expires_at').notNull(),
    deletedAt: timestamptz('deleted_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('media_files_organization_id_id_unique').on(table.organizationId, table.id),
    foreignKey({
      name: 'media_files_organization_id_channel_id_fk',
      columns: [table.organizationId, table.channelId],
      foreignColumns: [channels.organizationId, channels.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'media_files_organization_id_uploaded_by_user_id_fk',
      columns: [table.organizationId, table.uploadedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'media_files_organization_id_uploaded_by_api_key_id_fk',
      columns: [table.organizationId, table.uploadedByApiKeyId],
      foreignColumns: [apiKeys.organizationId, apiKeys.id],
    }).onDelete('restrict'),
    index('media_files_expires_at_idx')
      .on(table.expiresAt)
      .where(sql`${table.deletedAt} is null`),
    check('media_files_size_nonnegative', sql`${table.sizeBytes} >= 0`),
    check(
      'media_files_storage_key_format',
      sql`${table.storageKey} is null or ${table.storageKey} ~ '^[a-z]+/[0-9a-f-]{36}$'`,
    ),
    check(
      'media_files_deleted_without_storage',
      sql`${table.deletedAt} is null or ${table.storageKey} is null`,
    ),
    check(
      'media_files_text_lengths',
      sql`char_length(${table.mimeType}) between 3 and 128 and char_length(${table.sha256}) = 64 and (${table.filename} is null or char_length(${table.filename}) between 1 and 255) and (${table.metaMediaRef} is null or char_length(${table.metaMediaRef}) between 1 and 256)`,
    ),
  ],
);

export type MediaFileRow = typeof mediaFiles.$inferSelect;
export type NewMediaFileRow = typeof mediaFiles.$inferInsert;
