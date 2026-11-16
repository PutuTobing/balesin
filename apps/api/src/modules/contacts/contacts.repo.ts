import { contactIdentityLockKeys } from '@balesin/core';
import {
  contacts,
  conversations,
  lockAdvisoryKeys,
  mediaFiles,
  messages,
  webhookEvents,
  type DbExecutor,
} from '@balesin/db';
import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';

/**
 * Data kontak (CRM). Fungsi hapus di sini dipakai endpoint "Hapus kontak (UU PDP)" yang menyusul
 * (izin `contacts.delete`, konfirmasi identitas, audit — butir CRM).
 */

export interface DeletedContactData {
  messages: number;
  conversations: number;
  /** Kejadian webhook yang payload-nya dikosongkan (baris + kunci dedup tetap). */
  webhookEvents: number;
}

/**
 * Kondisi "kejadian webhook ini milik identitas kontak tersebut" untuk baris yang BELUM dikaitkan
 * worker (`contact_id` kosong: masih `pending`, gagal, atau dilewati). `wa_id` di payload Meta =
 * nomor tanpa `+`.
 */
function payloadMatchesIdentity(waBsuid: string | null, phone: string | null): SQL | undefined {
  const conditions: SQL[] = [];
  const message = sql`${webhookEvents.payload} -> 'message'`;
  const contact = sql`${webhookEvents.payload} -> 'contact'`;
  const status = sql`${webhookEvents.payload} -> 'status'`;
  if (waBsuid) {
    conditions.push(
      sql`${message} ->> 'from_user_id' = ${waBsuid}`,
      sql`${contact} ->> 'user_id' = ${waBsuid}`,
      sql`${status} ->> 'recipient_user_id' = ${waBsuid}`,
    );
  }
  if (phone) {
    const waId = phone.replace(/^\+/, '');
    // Kontak ber-BSUID: kejadian dengan nomor yang sama tetapi BSUID LAIN milik orang lain (nomor
    // didaur ulang) tidak ikut dikosongkan (review kontak Info 1).
    const sameOrNoBsuid = (bsuidField: SQL) =>
      waBsuid ? sql`(${bsuidField} is null or ${bsuidField} = ${waBsuid})` : sql`true`;
    conditions.push(
      sql`(${message} ->> 'from' = ${waId} and ${sameOrNoBsuid(sql`${message} ->> 'from_user_id'`)})`,
      sql`(${contact} ->> 'wa_id' = ${waId} and ${sameOrNoBsuid(sql`${contact} ->> 'user_id'`)})`,
      sql`(${status} ->> 'recipient_id' = ${waId} and ${sameOrNoBsuid(sql`${status} ->> 'recipient_user_id'`)})`,
    );
  }
  return conditions.length > 0 ? or(...conditions) : undefined;
}

/**
 * Menghapus kontak beserta data pribadinya (UU PDP, SECURITY.md §10, review webhook S4):
 * pesan, percakapan, kontak — dan MENGOSONGKAN payload `webhook_events` terkait (dikaitkan worker
 * lewat `contact_id`, atau dicocokkan dari identitas untuk kejadian yang belum diproses). Baris
 * kejadian + kunci dedup tetap ada supaya kiriman ulang Meta tidak menghidupkan kontak lagi;
 * kejadian `pending` ditandai `skipped` (`contact_deleted`) sehingga worker tidak memprosesnya.
 *
 * WAJIB dipanggil di dalam transaksi. Urutan kunci (bebas deadlock dengan worker webhook, yang
 * mengunci kejadian → identitas → kontak): kejadian webhook (lewat UPDATE) → advisory identitas →
 * kontak → percakapan/pesan. `undefined` bila kontak tidak ada di organisasi ini.
 */
export async function deleteContactData(
  tx: DbExecutor,
  organizationId: string,
  contactId: string,
): Promise<DeletedContactData | undefined> {
  const [contact] = await tx
    .select({
      id: contacts.id,
      channelType: contacts.channelType,
      waBsuid: contacts.waBsuid,
      phone: contacts.phone,
    })
    .from(contacts)
    .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)))
    .limit(1);
  if (!contact) return undefined;

  const now = new Date();
  const identityMatch = payloadMatchesIdentity(contact.waBsuid, contact.phone);
  const purgedEvents = await tx
    .update(webhookEvents)
    .set({
      payload: {},
      payloadPurgedAt: now,
      contactId: null,
      // Kejadian yang belum diproses tidak boleh membuat kontaknya lagi.
      status: sql`case when ${webhookEvents.status} = 'pending' then 'skipped'::webhook_event_status else ${webhookEvents.status} end`,
      lastError: sql`case when ${webhookEvents.status} = 'pending' then 'contact_deleted' else ${webhookEvents.lastError} end`,
      processedAt: sql`case when ${webhookEvents.status} = 'pending' then ${now}::timestamptz else ${webhookEvents.processedAt} end`,
    })
    .where(
      and(
        eq(webhookEvents.organizationId, organizationId),
        or(
          eq(webhookEvents.contactId, contactId),
          identityMatch === undefined
            ? undefined
            : and(
                isNull(webhookEvents.contactId),
                isNull(webhookEvents.payloadPurgedAt),
                inArray(webhookEvents.kind, ['message', 'status']),
                identityMatch,
              ),
        ),
      ),
    )
    .returning({ id: webhookEvents.id });

  await lockAdvisoryKeys(
    tx,
    contactIdentityLockKeys(organizationId, contact.channelType, {
      bsuid: contact.waBsuid,
      phone: contact.phone,
    }),
  );

  const [locked] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)))
    .for('update');
  if (!locked) return undefined;

  // Kejadian yang sempat dikaitkan worker setelah UPDATE di atas (pesan baru yang masuk bersamaan).
  const lateEvents = await tx
    .update(webhookEvents)
    .set({ payload: {}, payloadPurgedAt: now, contactId: null })
    .where(
      and(eq(webhookEvents.organizationId, organizationId), eq(webhookEvents.contactId, contactId)),
    )
    .returning({ id: webhookEvents.id });

  // Salinan media lokal (unggahan & cache unduhan) pesan kontak ini: dimajukan kedaluwarsanya
  // supaya pembersih media menghapus berkasnya dari disk (UU PDP).
  await tx
    .update(mediaFiles)
    .set({ expiresAt: now })
    .where(
      and(
        eq(mediaFiles.organizationId, organizationId),
        inArray(
          mediaFiles.id,
          tx
            .select({ id: sql<string>`${messages.mediaFileId}` })
            .from(messages)
            .where(
              and(
                eq(messages.organizationId, organizationId),
                eq(messages.contactId, contactId),
                isNotNull(messages.mediaFileId),
              ),
            ),
        ),
      ),
    );

  const deletedMessages = await tx
    .delete(messages)
    .where(and(eq(messages.organizationId, organizationId), eq(messages.contactId, contactId)))
    .returning({ id: messages.id });
  const deletedConversations = await tx
    .delete(conversations)
    .where(
      and(eq(conversations.organizationId, organizationId), eq(conversations.contactId, contactId)),
    )
    .returning({ id: conversations.id });
  await tx
    .delete(contacts)
    .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)));

  return {
    messages: deletedMessages.length,
    conversations: deletedConversations.length,
    webhookEvents: new Set([...purgedEvents, ...lateEvents].map((row) => row.id)).size,
  };
}
