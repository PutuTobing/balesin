import {
  cleanCustomerText,
  contactIdentityLockKeys,
  type ChannelInboundMessage,
  type ChannelInboundStatus,
} from '@balesin/core';
import {
  contacts,
  conversationEvents,
  conversations,
  lockAdvisoryKeys,
  messageEmailBodies,
  messages,
  recordOutgoingEvent,
  type ContactRow,
  type DbExecutor,
  type MessageExtras,
  type NewMessageRow,
} from '@balesin/db';
import {
  channelHasCustomerWindow,
  type ChannelType,
  type ConversationStatus,
} from '@balesin/shared';
import { createHash } from 'node:crypto';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';

import type { InboundEventContext } from '../queues/webhooks';
import {
  WINDOW_INTERVAL,
  botAwareInitialStatus,
  createInboundConversation,
  inboundOccurredAt,
  linkEventToContact,
  messageIdByWamid,
  openConversation,
} from './handlers';

/**
 * Pesan masuk channel selain WhatsApp (Fase 6) → kontak, percakapan, pesan. Berjalan DI DALAM
 * transaksi worker webhook (lihat aturan di `handlers.ts`: urutan kunci kejadian → channel (share) →
 * advisory identitas → kontak → percakapan → pesan; JANGAN `UPDATE channels`; tanpa isi pesan di log).
 *
 * - Kontak = (organisasi, jenis channel, `external_user_id`) — ID Telegram, alamat email, PSID/IGSID.
 * - Satu percakapan terbuka per kontak × channel (pola sama dengan WhatsApp), status awal
 *   bot/antrian lewat `createInboundConversation` (departemen bawaan channel ikut).
 * - Jendela 24 jam hanya dicatat untuk channel yang memakainya (Messenger/Instagram); Telegram & Email
 *   hanya `last_inbound_at`.
 * - Email: lampiran (sudah disimpan pengambil kotak masuk) menjadi pesan media tersendiri setelah
 *   pesan teksnya; HTML tersanitasi disalin ke `message_email_bodies`.
 */

/** Di-export untuk tes: status awal percakapan baru (bawaan bot/antrian). */
export interface ChannelInboundOptions {
  initialConversationStatus?: (
    context: InboundEventContext,
  ) => ConversationStatus | Promise<ConversationStatus>;
}

async function resolveChannelContact(
  tx: DbExecutor,
  input: {
    organizationId: string;
    channelType: ChannelType;
    externalUserId: string;
    handle: string | null;
    displayName: string | null;
  },
): Promise<ContactRow> {
  await lockAdvisoryKeys(
    tx,
    contactIdentityLockKeys(input.organizationId, input.channelType, {
      bsuid: null,
      phone: null,
      externalUserId: input.externalUserId,
    }),
  );
  const [existing] = await tx
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, input.organizationId),
        eq(contacts.channelType, input.channelType),
        eq(contacts.externalUserId, input.externalUserId),
      ),
    )
    .limit(1)
    .for('update');
  const handle = cleanCustomerText(input.handle, 320);
  const displayName = cleanCustomerText(input.displayName);
  if (existing) {
    // Nama profil & @username boleh berubah di platform; nilai `null` tidak menghapus yang lama.
    const changes: Partial<ContactRow> = {};
    if (displayName !== null && displayName !== existing.profileName)
      changes.profileName = displayName;
    if (handle !== null && handle !== existing.channelHandle) changes.channelHandle = handle;
    if (Object.keys(changes).length === 0) return existing;
    const [updated] = await tx
      .update(contacts)
      .set(changes)
      .where(and(eq(contacts.organizationId, input.organizationId), eq(contacts.id, existing.id)))
      .returning();
    return updated ?? existing;
  }
  const [created] = await tx
    .insert(contacts)
    .values({
      organizationId: input.organizationId,
      channelType: input.channelType,
      externalUserId: input.externalUserId,
      channelHandle: handle,
      profileName: displayName,
      // Email: alamatnya juga isian email kontak (bisa diedit tim; identitas tetap `external_user_id`).
      ...(input.channelType === 'email' ? { email: input.externalUserId } : {}),
    })
    .returning();
  if (!created) throw new Error('INSERT kontak tidak mengembalikan baris');
  await recordOutgoingEvent(tx, {
    organizationId: input.organizationId,
    type: 'contact.created',
    contactId: created.id,
  });
  return created;
}

/** ID eksternal turunan untuk lampiran email (≤ 256). */
function attachmentExternalId(externalId: string, index: number): string {
  const candidate = `${externalId}#lampiran-${String(index + 1)}`;
  return candidate.length <= 256
    ? candidate
    : `sha256:${createHash('sha256').update(candidate).digest('hex')}`;
}

/** Lepas percakapan dari bot ke antrian (pelaku sistem): kejadian `handoff` + webhook. */
async function handOffFromBot(
  context: InboundEventContext,
  conversationId: string,
  contactId: string,
): Promise<void> {
  const { tx, organizationId } = context;
  const moved = await tx
    .update(conversations)
    .set({ status: 'unserved', assigneeUserId: null, botAwaitingSince: null })
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        eq(conversations.id, conversationId),
        eq(conversations.status, 'bot'),
      ),
    )
    .returning({ id: conversations.id });
  if (moved.length === 0) return;
  await tx.insert(conversationEvents).values({
    organizationId,
    conversationId,
    kind: 'handoff',
    actorUserId: null,
    apiKeyId: null,
  });
  await recordOutgoingEvent(tx, {
    organizationId,
    type: 'conversation.handoff',
    conversationId,
    contactId,
  });
}

export async function handleChannelMessage(
  message: ChannelInboundMessage,
  channelType: ChannelType,
  context: InboundEventContext,
  options: ChannelInboundOptions = {},
): Promise<void> {
  const { tx, organizationId, channelId, receivedAt, logger } = context;
  if (await messageIdByWamid(tx, organizationId, channelId, message.externalId)) {
    logger.debug({ eventId: context.eventId }, 'Pesan masuk sudah tersimpan sebelumnya');
    return;
  }
  const contact = await resolveChannelContact(tx, {
    organizationId,
    channelType,
    externalUserId: message.sender.externalUserId,
    handle: message.sender.handle,
    displayName: message.sender.displayName,
  });
  await linkEventToContact(context, contact.id);

  // Review bot semua channel B1: email yang GAGAL verifikasi pengirim (SPF/DKIM/DMARC) tidak boleh
  // dilayani bot otomatis (alamat `From` bisa dipalsukan) — langsung ke antrian manusia.
  const unverifiedEmail = message.email?.senderVerification === 'fail';
  const open = await openConversation(tx, organizationId, contact.id, channelId);
  const conversation =
    open ??
    (await createInboundConversation(
      context,
      contact.id,
      unverifiedEmail
        ? () => 'unserved'
        : (options.initialConversationStatus ?? botAwareInitialStatus),
    ));
  if (open && unverifiedEmail && open.status === 'bot') {
    await handOffFromBot(context, open.id, contact.id);
  }

  const occurredAt = inboundOccurredAt(new Date(message.sentAt), receivedAt);
  const extras: MessageExtras = {};
  if (message.reply) {
    extras.interactive = { ...message.reply, description: null };
  }
  if (message.email) {
    extras.email = {
      subject: message.email.subject,
      inReplyTo: message.email.inReplyTo,
      references: message.email.references,
      authWarning: message.email.authWarning,
      senderVerification: message.email.senderVerification,
      skippedAttachments: message.email.skippedAttachments,
      hasHtml: message.email.html !== null,
    };
  }
  const base = {
    organizationId,
    conversationId: conversation.id,
    contactId: contact.id,
    channelId,
    direction: 'inbound' as const,
    senderKind: 'customer' as const,
    receivedAt,
  };
  const replyToMessageId = await messageIdByWamid(
    tx,
    organizationId,
    channelId,
    message.replyToExternalId ?? message.email?.inReplyTo ?? null,
    contact.id,
  );
  const mediaOf = (media: NonNullable<ChannelInboundMessage['media']>): NewMessageRow['media'] => ({
    kind: media.kind,
    metaMediaId: media.ref,
    mimeType: media.mimeType,
    sha256: null,
    filename: media.filename,
    voice: media.voice,
    animated: media.animated,
  });

  const rows: NewMessageRow[] = [
    {
      ...base,
      type: message.type,
      rawType: message.rawType,
      wamid: message.externalId,
      text: message.text,
      media: message.media ? mediaOf(message.media) : null,
      mediaFileId: message.media?.mediaFileId ?? null,
      location: message.location,
      extras,
      replyToWamid: message.replyToExternalId ?? message.email?.inReplyTo ?? null,
      replyToMessageId,
      occurredAt,
    },
    ...(message.email?.attachments ?? []).map((attachment, index): NewMessageRow => ({
      ...base,
      type: attachment.kind,
      rawType: 'attachment',
      wamid: attachmentExternalId(message.externalId, index),
      text: null,
      media: mediaOf(attachment),
      mediaFileId: attachment.mediaFileId,
      location: null,
      extras: {},
      // Lampiran tampil tepat setelah teks email-nya.
      occurredAt: new Date(occurredAt.getTime() + index + 1),
    })),
  ];
  const inserted = await tx
    .insert(messages)
    .values(rows)
    .onConflictDoNothing({ target: [messages.channelId, messages.wamid] })
    .returning({ id: messages.id, wamid: messages.wamid });
  const main = inserted.find((row) => row.wamid === message.externalId);
  if (!main) return;

  if (message.email?.html) {
    await tx.insert(messageEmailBodies).values({
      organizationId,
      messageId: main.id,
      html: message.email.html,
    });
  }
  await recordOutgoingEvent(tx, {
    organizationId,
    type: 'message.received',
    conversationId: conversation.id,
    messageId: main.id,
    contactId: contact.id,
  });
  for (const row of inserted) {
    context.emit({
      type: 'message.created',
      organizationId,
      conversationId: conversation.id,
      messageId: row.id,
    });
  }
  context.emit({ type: 'conversation.updated', organizationId, conversationId: conversation.id });

  const window = channelHasCustomerWindow(channelType);
  await tx
    .update(conversations)
    .set({
      lastInboundAt: sql`greatest(${conversations.lastInboundAt}, ${receivedAt})`,
      ...(window
        ? {
            windowExpiresAt: sql`greatest(${conversations.lastInboundAt}, ${receivedAt}) + ${WINDOW_INTERVAL}`,
          }
        : {}),
      lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${receivedAt})`,
      unreadCount: sql`${conversations.unreadCount} + 1`,
      botAwaitingSince: sql`case when ${conversations.status} = 'bot' then coalesce(${conversations.botAwaitingSince}, ${receivedAt}) else null end`,
    })
    .where(
      and(eq(conversations.organizationId, organizationId), eq(conversations.id, conversation.id)),
    );
}

/**
 * Status pesan KELUAR Messenger/Instagram: `delivery` (daftar `mid`) dan `read` (watermark: semua
 * pesan keluar ke pelanggan itu sebelum waktu tersebut). Status hanya maju.
 */
export async function handleChannelStatus(
  status: ChannelInboundStatus,
  channelType: ChannelType,
  context: InboundEventContext,
): Promise<void> {
  const { tx, organizationId, channelId, receivedAt } = context;
  const [contact] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.organizationId, organizationId),
        eq(contacts.channelType, channelType),
        eq(contacts.externalUserId, status.recipientExternalUserId),
      ),
    )
    .limit(1);
  if (!contact) return;
  await linkEventToContact(context, contact.id);
  const allowedFrom = status.status === 'read' ? ['sent', 'delivered'] : ['sent'];
  const conditions = [
    eq(messages.organizationId, organizationId),
    eq(messages.channelId, channelId),
    eq(messages.contactId, contact.id),
    eq(messages.direction, 'outbound'),
    inArray(messages.status, allowedFrom as ('sent' | 'delivered')[]),
  ];
  const byIds =
    status.externalIds.length > 0 ? inArray(messages.wamid, status.externalIds) : undefined;
  const byWatermark = status.watermark
    ? lte(messages.occurredAt, new Date(status.watermark))
    : undefined;
  if (!byIds && !byWatermark) return;
  const updated = await tx
    .update(messages)
    .set({ status: status.status, statusUpdatedAt: receivedAt })
    .where(and(...conditions, byIds ?? byWatermark))
    .returning({ id: messages.id, conversationId: messages.conversationId });
  for (const row of updated) {
    await recordOutgoingEvent(tx, {
      organizationId,
      type: 'message.status',
      conversationId: row.conversationId,
      messageId: row.id,
      contactId: contact.id,
    });
    context.emit({
      type: 'message.status',
      organizationId,
      conversationId: row.conversationId,
      messageId: row.id,
    });
  }
}
