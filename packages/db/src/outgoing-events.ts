import type { ChannelType } from '@balesin/shared';
import { and, eq, sql } from 'drizzle-orm';

import type { DbExecutor } from './client';
import { newId } from './ids';
import { apiKeys, outgoingEvents, webhookEndpoints } from './schema';

/**
 * Catat kejadian untuk webhook keluar (transactional outbox, Fase 3) — panggil di DALAM transaksi
 * yang membuat perubahannya, supaya kejadian ada bila dan hanya bila perubahannya commit. HANYA ID +
 * jenis (payload dibangun worker). Baris hanya ditulis bila ada endpoint AKTIF organisasi itu yang
 * melanggan jenis tersebut (tanpa langganan = tanpa biaya).
 */
export async function recordOutgoingEvent(
  db: DbExecutor,
  event: {
    organizationId: string;
    type: string;
    conversationId?: string | null;
    messageId?: string | null;
    contactId?: string | null;
    ticketId?: string | null;
    actorUserId?: string | null;
    /** Tahap 9.1: email lewat API (`email.*`). */
    emailOutboundId?: string | null;
  },
): Promise<void> {
  await db.execute(sql`
    insert into ${outgoingEvents}
      (id, organization_id, type, conversation_id, message_id, contact_id, ticket_id, actor_user_id,
       email_outbound_id)
    select ${newId()}, ${event.organizationId}, ${event.type}, ${event.conversationId ?? null},
      ${event.messageId ?? null}, ${event.contactId ?? null}, ${event.ticketId ?? null},
      ${event.actorUserId ?? null}, ${event.emailOutboundId ?? null}
    where exists (
      select 1 from ${webhookEndpoints}
      where ${webhookEndpoints.organizationId} = ${event.organizationId}
        and ${webhookEndpoints.enabled}
        and ${event.type} = any(${webhookEndpoints.events})
    )`);
}

/**
 * Ada penerima bot yang BENAR-BENAR aktif untuk percakapan baru di channel berjenis `channelType`
 * (review bot R1 + generalisasi bot per channel, DECISIONS 2026-11-19): endpoint webhook aktif yang
 * melanggan `message.received` dan
 *  - format `native` → semua jenis channel (body memuat `conversation.channel.type`);
 *  - format `mobichat` → HANYA channel WhatsApp, dan API key tersisipnya masih aktif. Body MobiChat
 *    berbasis nomor WhatsApp, jadi pesan Telegram/Email/Messenger/Instagram TIDAK dikirim ke sana
 *    (`buildMobichatBody` → `null`) — channel itu tidak boleh diparkir di bot yang tidak menerima.
 * Dipakai worker (`botAwareInitialStatus`) dan api (`receiverReady` di pengaturan bot channel).
 */
export async function hasActiveBotReceiver(
  db: DbExecutor,
  input: { organizationId: string; channelType: ChannelType; at: Date },
): Promise<boolean> {
  // Format MobiChat hanya untuk WhatsApp; channel lain hanya dilayani endpoint `native`.
  const mobichatClause =
    input.channelType === 'whatsapp'
      ? sql`(${webhookEndpoints.format} <> 'mobichat' or (${apiKeys.id} is not null and ${apiKeys.revokedAt} is null and (${apiKeys.expiresAt} is null or ${apiKeys.expiresAt} > ${input.at})))`
      : sql`${webhookEndpoints.format} <> 'mobichat'`;
  const [receiver] = await db
    .select({ id: webhookEndpoints.id })
    .from(webhookEndpoints)
    .leftJoin(
      apiKeys,
      and(
        eq(apiKeys.organizationId, webhookEndpoints.organizationId),
        eq(apiKeys.id, webhookEndpoints.mobichatApiKeyId),
      ),
    )
    .where(
      and(
        eq(webhookEndpoints.organizationId, input.organizationId),
        eq(webhookEndpoints.enabled, true),
        sql`'message.received' = any(${webhookEndpoints.events})`,
        mobichatClause,
      ),
    )
    .limit(1);
  return receiver !== undefined;
}
