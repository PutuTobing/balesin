import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { channelType } from './channels';
import { createdAtColumn, idColumn, updatedAtColumn } from './columns';
import { organizations } from './organizations';

/**
 * Kontak pelanggan per organisasi (PRD §3.6), dibuat otomatis dari pesan masuk (Fase 2 butir 4).
 *
 * Identitas WhatsApp (docs/DECISIONS.md 2026-11-16 "Kontak WhatsApp"):
 *  - `wa_bsuid` = BSUID Meta (`from_user_id`/`user_id`): selalu ada di webhook sejak username
 *    WhatsApp, stabil walau pelanggan ganti nomor. Kunci utama.
 *  - `phone` = nomor E.164 (`+62…`) dari `from`/`wa_id` bila lolos validasi; BISA tidak ada
 *    (pelanggan memakai username tanpa nomor). Balasan hanya pernah dikirim ke nomor yang lolos.
 *  - Unik per (organisasi, jenis channel, identitas) — masing-masing lewat indeks unik parsial.
 *    Minimal salah satu ada (CHECK). Worker menserialkan pembuatan kontak lewat advisory lock per
 *    identitas; modul lain yang membuat kontak WAJIB memakai kunci yang sama (`contactIdentityLockKey`
 *    di worker).
 *
 * `name` = nama yang diedit tim (format bebas, mis. `ID+NAMA@AREA`); `profile_name` = nama profil
 * WhatsApp kiriman pelanggan (tidak tepercaya, karakter tak terlihat sudah dibuang) — keduanya
 * TERPISAH supaya pembaruan profil dari Meta tidak menimpa nama dari tim.
 *
 * `number` = nomor publik berurutan (identity) untuk mode kompatibel MobiChat (ID kontak numerik).
 * Data pribadi (UU PDP): hapus kontak lewat `deleteContactData` (api `contacts.repo`) yang juga
 * mengosongkan `webhook_events` terkait.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    number: bigint('number', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    channelType: channelType('channel_type').notNull(),
    waBsuid: text('wa_bsuid'),
    phone: text('phone'),
    waUsername: text('wa_username'),
    profileName: text('profile_name'),
    name: text('name'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // Sasaran FK komposit (organization_id, id) untuk percakapan/pesan/kejadian webhook.
    unique('contacts_organization_id_id_unique').on(table.organizationId, table.id),
    unique('contacts_number_unique').on(table.number),
    uniqueIndex('contacts_organization_id_channel_type_wa_bsuid_unique')
      .on(table.organizationId, table.channelType, table.waBsuid)
      .where(sql`${table.waBsuid} is not null`),
    uniqueIndex('contacts_organization_id_channel_type_phone_unique')
      .on(table.organizationId, table.channelType, table.phone)
      .where(sql`${table.phone} is not null`),
    index('contacts_organization_id_created_at_idx').on(table.organizationId, table.createdAt),
    check(
      'contacts_whatsapp_identity_required',
      sql`${table.channelType} <> 'whatsapp' or ${table.waBsuid} is not null or ${table.phone} is not null`,
    ),
    check(
      'contacts_phone_e164',
      sql`${table.phone} is null or ${table.phone} ~ '^\\+[1-9][0-9]{6,14}$'`,
    ),
    check(
      'contacts_wa_bsuid_format',
      sql`${table.waBsuid} is null or (${table.waBsuid} ~ '^[A-Za-z0-9._:-]+$' and char_length(${table.waBsuid}) <= 256)`,
    ),
    check(
      'contacts_text_lengths',
      sql`(${table.name} is null or char_length(${table.name}) between 1 and 256) and (${table.profileName} is null or char_length(${table.profileName}) between 1 and 256) and (${table.waUsername} is null or char_length(${table.waUsername}) between 1 and 256)`,
    ),
  ],
);

export type ContactRow = typeof contacts.$inferSelect;
export type NewContactRow = typeof contacts.$inferInsert;
