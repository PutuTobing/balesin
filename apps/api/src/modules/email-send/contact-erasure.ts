import {
  contacts,
  emailOutbound,
  emailOutboundAttachments,
  outgoingEvents,
  webhookDeliveries,
  type DbExecutor,
  type EmailRecipientRow,
} from '@balesin/db';
import { maskEmailAddress } from '@balesin/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Hapus kontak (UU PDP) × email lewat API (tahap 9.1, docs/KONTRAK-API-EMAIL-KIRIM.md §11). Dipanggil
 * DI DALAM transaksi hapus kontak, SEBELUM baris kontak dihapus. Email yang terkait kontak itu
 * (`contact_id` — `conversation: "create"`/balasan API — atau, untuk kontak Email, alamatnya ada di
 * Kepada/Cc/Bcc):
 *  - isi dipangkas: subjek → "(dihapus)", HTML/teks/metadata dikosongkan (`body_purged_at`);
 *  - SEMUA alamat penerima (+ penolakan & bounce) disamarkan, nama dibuang;
 *  - lampiran: nama berkas diganti, berkas di media store dihapus SETELAH commit (kunci dikembalikan);
 *  - yang belum terkirim (`scheduled`/`queued`) dibatalkan supaya tidak terkirim tanpa isi;
 *  - kejadian outbox `email.*` dibuang dan payload riwayat pengiriman webhook dikosongkan.
 * Baris & status tetap ada (jumlah, batas harian key, laporan tidak berubah).
 */

const PURGED_SUBJECT = '(dihapus)';
const PURGED_FILENAME = 'lampiran-dihapus';

const maskRecipients = (items: readonly EmailRecipientRow[]): EmailRecipientRow[] =>
  items.map((item) => ({ email: maskEmailAddress(item.email), name: null }));

export async function eraseContactEmails(
  tx: DbExecutor,
  organizationId: string,
  contactId: string,
  at: Date,
): Promise<{ emails: number; storageKeys: string[] }> {
  const [contact] = await tx
    .select({ channelType: contacts.channelType, externalUserId: contacts.externalUserId })
    .from(contacts)
    .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)))
    .limit(1);
  if (!contact) return { emails: 0, storageKeys: [] };
  const address =
    contact.channelType === 'email' && contact.externalUserId
      ? contact.externalUserId.toLowerCase()
      : null;
  const containing = (column: AnyPgColumn) =>
    sql`${column} @> ${JSON.stringify([{ email: address }])}::jsonb`;
  const rows = await tx
    .select()
    .from(emailOutbound)
    .where(
      and(
        eq(emailOutbound.organizationId, organizationId),
        isNull(emailOutbound.bodyPurgedAt),
        or(
          eq(emailOutbound.contactId, contactId),
          ...(address
            ? [
                containing(emailOutbound.to),
                containing(emailOutbound.cc),
                containing(emailOutbound.bcc),
              ]
            : []),
        ),
      ),
    )
    .for('update');
  // Baris yang SUDAH dipangkas isinya (retensi 30 hari) tetap disamarkan penerimanya.
  const purgedBefore = address
    ? await tx
        .select()
        .from(emailOutbound)
        .where(
          and(
            eq(emailOutbound.organizationId, organizationId),
            sql`${emailOutbound.bodyPurgedAt} is not null`,
            or(
              containing(emailOutbound.to),
              containing(emailOutbound.cc),
              containing(emailOutbound.bcc),
            ),
          ),
        )
        .for('update')
    : [];
  const all = [...rows, ...purgedBefore];
  if (all.length === 0) return { emails: 0, storageKeys: [] };
  const ids = all.map((row) => row.id);

  for (const row of all) {
    const pending = row.status === 'scheduled' || row.status === 'queued';
    await tx
      .update(emailOutbound)
      .set({
        subject: PURGED_SUBJECT,
        html: null,
        text: null,
        metadata: null,
        to: maskRecipients(row.to),
        cc: maskRecipients(row.cc),
        bcc: maskRecipients(row.bcc),
        rejectedRecipients: row.rejectedRecipients.map(maskEmailAddress),
        bounces: row.bounces.map((bounce) => ({
          ...bounce,
          recipient: maskEmailAddress(bounce.recipient),
        })),
        contactId: null,
        bodyPurgedAt: row.bodyPurgedAt ?? at,
        ...(pending ? { status: 'canceled', canceledAt: at } : {}),
      })
      .where(eq(emailOutbound.id, row.id));
  }

  const files = await tx
    .select({ storageKey: emailOutboundAttachments.storageKey })
    .from(emailOutboundAttachments)
    .where(
      and(
        eq(emailOutboundAttachments.organizationId, organizationId),
        inArray(emailOutboundAttachments.emailOutboundId, ids),
      ),
    );
  await tx
    .update(emailOutboundAttachments)
    .set({ storageKey: null, filename: PURGED_FILENAME })
    .where(
      and(
        eq(emailOutboundAttachments.organizationId, organizationId),
        inArray(emailOutboundAttachments.emailOutboundId, ids),
      ),
    );

  await tx
    .delete(outgoingEvents)
    .where(
      and(
        eq(outgoingEvents.organizationId, organizationId),
        inArray(outgoingEvents.emailOutboundId, ids),
      ),
    );
  await tx
    .update(webhookDeliveries)
    .set({ payload: null, payloadPurgedAt: at, responseSnippet: null })
    .where(
      and(
        eq(webhookDeliveries.organizationId, organizationId),
        isNull(webhookDeliveries.payloadPurgedAt),
        sql`${webhookDeliveries.payload} -> 'data' -> 'email' ->> 'id' in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    );

  return {
    emails: all.length,
    storageKeys: files.map((file) => file.storageKey).filter((key): key is string => key !== null),
  };
}
