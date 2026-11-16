import { contactIdentityLockKeys, type Logger, type WhatsAppContactIdentity } from '@balesin/core';
import {
  contacts,
  lockAdvisoryKeys,
  recordOutgoingEvent,
  type ContactRow,
  type DbExecutor,
} from '@balesin/db';
import type { ChannelType } from '@balesin/shared';
import { and, eq } from 'drizzle-orm';

/**
 * Kontak dari pesan masuk WhatsApp (docs/DECISIONS.md 2026-11-16 "Kontak WhatsApp").
 *
 * Urutan pencocokan: BSUID dulu (stabil walau pelanggan ganti nomor), lalu nomor E.164.
 *  - Keduanya cocok ke kontak yang SAMA, atau hanya salah satu yang ada di Balesin → kontak itu;
 *    identitas yang belum tercatat dilengkapi.
 *  - Nomor tercatat di kontak lain yang BSUID-nya BERBEDA → nomor sudah berpindah tangan (didaur
 *    ulang operator): nomor dilepas dari kontak lama, dipasang ke kontak BSUID ini (atau kontak baru).
 *  - Nomor tercatat di kontak lain TANPA BSUID (dibuat sebelum BSUID diketahui) → keduanya
 *    dibiarkan; penggabungan duplikat adalah fitur CRM tersendiri (bukan otomatis).
 *
 * Konkurensi: semua jalur yang membuat/mengubah identitas kontak WAJIB lebih dulu memanggil
 * `lockContactIdentities` (advisory lock transaksi per identitas, urutan tetap) — dua pesan pertama
 * dari pelanggan yang sama di dua worker tidak membuat dua kontak. Baris kontak yang dipakai
 * dikunci `FOR UPDATE` (urutan kunci: kontak → percakapan).
 */

/**
 * Mengunci identitas kontak (advisory lock transaksi). Format kunci dari `contactIdentityLockKeys`
 * (`@balesin/core`) — sama dengan hapus kontak di api.
 */
export async function lockContactIdentities(
  tx: DbExecutor,
  organizationId: string,
  channelType: ChannelType,
  identity: WhatsAppContactIdentity,
): Promise<void> {
  await lockAdvisoryKeys(tx, contactIdentityLockKeys(organizationId, channelType, identity));
}

export interface ResolveContactInput {
  organizationId: string;
  identity: WhatsAppContactIdentity;
  /** Sudah dibersihkan (`cleanCustomerText`). `null` = tidak dikirim Meta (nilai lama dipertahankan). */
  profileName: string | null;
  username: string | null;
  logger: Logger;
}

const CHANNEL_TYPE: ChannelType = 'whatsapp';

async function findBy(
  tx: DbExecutor,
  organizationId: string,
  column: typeof contacts.waBsuid | typeof contacts.phone,
  value: string | null,
): Promise<ContactRow | undefined> {
  if (value === null) return undefined;
  const [row] = await tx
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, organizationId),
        eq(contacts.channelType, CHANNEL_TYPE),
        eq(column, value),
      ),
    )
    .limit(1)
    .for('update');
  return row;
}

/**
 * Cari/buat kontak untuk identitas ini (PEMANGGIL sudah memegang `lockContactIdentities`). Baris
 * yang dikembalikan terkunci sampai transaksi selesai.
 */
export async function resolveWhatsAppContact(
  tx: DbExecutor,
  input: ResolveContactInput,
): Promise<ContactRow> {
  const { organizationId, identity, logger } = input;
  if (!identity.bsuid && !identity.phone) {
    throw new Error('Kontak WhatsApp butuh BSUID atau nomor');
  }
  const byBsuid = await findBy(tx, organizationId, contacts.waBsuid, identity.bsuid);
  let byPhone = await findBy(tx, organizationId, contacts.phone, identity.phone);

  // Nomor berpindah tangan: kontak pemegang nomor punya BSUID lain.
  if (byPhone && identity.bsuid && byPhone.waBsuid !== null && byPhone.waBsuid !== identity.bsuid) {
    await tx
      .update(contacts)
      .set({ phone: null })
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, byPhone.id)));
    logger.info(
      { organizationId, previousContactId: byPhone.id },
      'Nomor kontak berpindah ke pelanggan lain (BSUID berbeda) — dilepas dari kontak lama',
    );
    byPhone = undefined;
  }

  const existing = byBsuid ?? byPhone;
  if (!existing) {
    const [created] = await tx
      .insert(contacts)
      .values({
        organizationId,
        channelType: CHANNEL_TYPE,
        waBsuid: identity.bsuid,
        phone: identity.phone,
        profileName: input.profileName,
        waUsername: input.username,
      })
      .returning();
    if (!created) throw new Error('INSERT kontak tidak mengembalikan baris');
    // Webhook keluar (Fase 3): outbox di transaksi yang sama.
    await recordOutgoingEvent(tx, {
      organizationId,
      type: 'contact.created',
      contactId: created.id,
    });
    return created;
  }

  if (byBsuid && byPhone && byBsuid.id !== byPhone.id) {
    // Kontak hanya-nomor lama + kontak BSUID: tidak digabung otomatis (lihat komentar modul).
    logger.info(
      { organizationId, contactId: byBsuid.id, duplicateContactId: byPhone.id },
      'Kontak ganda (BSUID dan nomor di kontak berbeda) — dibiarkan untuk digabung manual',
    );
  }

  const changes: Partial<Pick<ContactRow, 'waBsuid' | 'phone' | 'profileName' | 'waUsername'>> = {};
  if (identity.bsuid && existing.waBsuid === null) changes.waBsuid = identity.bsuid;
  // Nomor baru dipasang hanya bila tidak dipegang kontak lain (byPhone sudah dilepas di atas bila
  // berpindah tangan; kontak hanya-nomor yang berbeda tetap memegangnya).
  if (
    identity.phone &&
    existing.phone !== identity.phone &&
    (!byPhone || byPhone.id === existing.id)
  ) {
    changes.phone = identity.phone;
  }
  if (input.profileName !== null && input.profileName !== existing.profileName) {
    changes.profileName = input.profileName;
  }
  if (input.username !== null && input.username !== existing.waUsername) {
    changes.waUsername = input.username;
  }
  if (Object.keys(changes).length === 0) return existing;

  const [updated] = await tx
    .update(contacts)
    .set(changes)
    .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, existing.id)))
    .returning();
  if (!updated) throw new Error('UPDATE kontak tidak mengembalikan baris');
  return updated;
}
