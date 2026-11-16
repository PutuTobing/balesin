import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  smallint,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { organizations } from './organizations';
import { userSessions } from './user-sessions';
import { users } from './users';

/**
 * Notifikasi Web Push (Fase 2 butir 10, docs/KONTRAK-API-NOTIFIKASI.md).
 */

/**
 * Kunci VAPID per organisasi — dibuat otomatis saat pertama dibutuhkan. Kunci privat terenkripsi
 * kotak rahasia (`push_vapid_keys.private_key`, AAD = organisasi), tidak pernah ke browser/log.
 */
export const pushVapidKeys = pgTable(
  'push_vapid_keys',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    publicKey: text('public_key').notNull(),
    privateKeyEncrypted: text('private_key_encrypted').notNull(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    check('push_vapid_keys_public_key_format', sql`${table.publicKey} ~ '^[A-Za-z0-9_-]{87}$'`),
  ],
);

export type PushVapidKeyRow = typeof pushVapidKeys.$inferSelect;

/**
 * Langganan push per perangkat, terikat ke SESI yang mendaftarkannya: sesi dicabut/kedaluwarsa,
 * pengguna dinonaktifkan → langganan dihapus (saat pencabutan, dan diperiksa ulang worker sebelum
 * setiap kirim). Kunci browser (`p256dh` + `auth`) terenkripsi kotak rahasia. `endpoint` unik global
 * (browser yang sama didaftarkan ulang oleh pengguna lain = dipindah ke pengguna itu).
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').notNull(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => userSessions.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    keysEncrypted: text('keys_encrypted').notNull(),
    lastSuccessAt: timestamptz('last_success_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('push_subscriptions_endpoint_unique').on(table.endpoint),
    foreignKey({
      name: 'push_subscriptions_organization_id_user_id_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    index('push_subscriptions_organization_id_user_id_idx').on(table.organizationId, table.userId),
    index('push_subscriptions_session_id_idx').on(table.sessionId),
    check(
      'push_subscriptions_endpoint_format',
      sql`char_length(${table.endpoint}) between 9 and 1024 and ${table.endpoint} like 'http%'`,
    ),
  ],
);

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/**
 * Preferensi notifikasi per pengguna. Tidak ada baris = bawaan (semua menyala, tanpa jam tenang).
 * Jam tenang dalam menit sejak 00:00 zona waktu organisasi; boleh melewati tengah malam.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: uuid('user_id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    queue: boolean('queue').notNull().default(true),
    assignedMessage: boolean('assigned_message').notNull().default(true),
    assignedToMe: boolean('assigned_to_me').notNull().default(true),
    quietStartMinute: smallint('quiet_start_minute'),
    quietEndMinute: smallint('quiet_end_minute'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'notification_preferences_organization_id_user_id_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('cascade'),
    check(
      'notification_preferences_quiet_hours',
      sql`(${table.quietStartMinute} is null) = (${table.quietEndMinute} is null) and (${table.quietStartMinute} is null or (${table.quietStartMinute} between 0 and 1439 and ${table.quietEndMinute} between 0 and 1439 and ${table.quietStartMinute} <> ${table.quietEndMinute}))`,
    ),
  ],
);

export type NotificationPreferencesRow = typeof notificationPreferences.$inferSelect;
