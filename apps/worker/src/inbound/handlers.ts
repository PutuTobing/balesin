import {
  WebhookPayloadError,
  cleanCustomerText,
  cleanFileName,
  safeHttpUrl,
  isStatusAdvance,
  whatsAppContactIdentity,
  type InboundMessageType,
  type MessageStatusValue,
  type NormalizedInboundMessage,
} from '@balesin/core';
import {
  apiKeys,
  channels,
  conversations,
  messages,
  organizations,
  webhookEndpoints,
  webhookEvents,
  type ConversationRow,
  type DbExecutor,
  type MessageExtras,
  type NewMessageRow,
  recordOutgoingEvent,
} from '@balesin/db';
import {
  CUSTOMER_SERVICE_WINDOW_MS,
  botHoursSchema,
  isWithinBotHours,
  type ConversationStatus,
  type MessageType,
} from '@balesin/shared';
import { and, desc, eq, ne, sql } from 'drizzle-orm';

import type { InboundEventContext, InboundEventHandlers } from '../queues/webhooks';
import { recordBroadcastReply } from './broadcast-replies';
import { lockContactIdentities, resolveWhatsAppContact } from './contacts';
import { matchCsatAnswer, recordCsatComment } from './csat-replies';

/**
 * Pemroses kejadian webhook → kontak, percakapan, pesan (Fase 2 butir 4, docs/KONTRAK-API-INBOX.md).
 *
 * Berjalan DI DALAM transaksi worker yang mengunci baris `webhook_events` (FOR UPDATE) dan channel
 * (FOR SHARE). Aturan:
 *  - **N1 (review webhook)**: JANGAN `UPDATE channels` di sini — dua worker yang sama-sama memegang
 *    `FOR SHARE` lalu meminta kunci eksklusif akan deadlock. Data channel (kualitas nomor, waktu
 *    pesan terakhir) diperbarui lewat job tersendiri.
 *  - Urutan kunci: kejadian → channel (share) → advisory identitas kontak → kontak → percakapan →
 *    pesan. Modul lain yang mengunci kontak dan percakapan sekaligus WAJIB memakai urutan ini.
 *  - Jendela 24 jam & SLA dari `receivedAt` (jam server), bukan cap waktu Meta (R4).
 *  - Tidak ada isi pesan, nomor, atau nama pelanggan di log — hanya ID.
 *  - Pekerjaan lambat (unduh media, siaran WebSocket, kirim ke bot) TIDAK di sini: antrekan job
 *    berisi ID setelah butir terkait dibangun.
 */

/** Interval SQL jendela 24 jam (konstanta, bukan input). */
const WINDOW_INTERVAL = sql.raw(`interval '${String(CUSTOMER_SERVICE_WINDOW_MS / 1000)} seconds'`);

export interface InboundHandlerOptions {
  /**
   * Status percakapan BARU. Bawaan (`botAwareInitialStatus`): `bot` bila saklar bot channel aktif
   * DAN sekarang dalam jam kerja bot (zona organisasi), selain itu `unserved` (antrian terbuka).
   * Pesan diteruskan ke bot lewat webhook keluar (outbox `message.received`), bukan dari sini.
   */
  initialConversationStatus?: (
    context: InboundEventContext,
  ) => ConversationStatus | Promise<ConversationStatus>;
}

/**
 * Status awal percakapan baru menurut saklar bot channel + jam kerja bot (Fase 3). Jam kerja dari
 * `receivedAt` (jam server); `bot_hours` rusak → dianggap di luar jam kerja (aman: ke tim).
 */
export async function botAwareInitialStatus(
  context: InboundEventContext,
): Promise<ConversationStatus> {
  const [row] = await context.tx
    .select({
      enabled: channels.botEnabled,
      hours: channels.botHours,
      timezone: organizations.timezone,
    })
    .from(channels)
    .innerJoin(organizations, eq(organizations.id, channels.organizationId))
    .where(
      and(eq(channels.organizationId, context.organizationId), eq(channels.id, context.channelId)),
    )
    .limit(1);
  if (!row?.enabled) return 'unserved';
  const hours = botHoursSchema.safeParse(row.hours);
  if (!hours.success) return 'unserved';
  if (!isWithinBotHours(hours.data, row.timezone, context.receivedAt)) return 'unserved';
  // Review bot R1: tanpa penerima yang benar-benar aktif (endpoint aktif yang melanggan pesan masuk;
  // format MobiChat: key-nya masih aktif) pelanggan langsung ke tim, bukan diparkir di bot.
  const [receiver] = await context.tx
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
        eq(webhookEndpoints.organizationId, context.organizationId),
        eq(webhookEndpoints.enabled, true),
        sql`'message.received' = any(${webhookEndpoints.events})`,
        sql`(${webhookEndpoints.format} <> 'mobichat' or (${apiKeys.revokedAt} is null and ${apiKeys.id} is not null and (${apiKeys.expiresAt} is null or ${apiKeys.expiresAt} > ${context.receivedAt})))`,
      ),
    )
    .limit(1);
  return receiver ? 'bot' : 'unserved';
}

/** Jenis pesan Meta → jenis Balesin. */
export function messageTypeOf(type: InboundMessageType): MessageType {
  switch (type) {
    case 'text':
    case 'image':
    case 'audio':
    case 'video':
    case 'document':
    case 'sticker':
    case 'location':
    case 'contacts':
    case 'interactive':
    case 'reaction':
    case 'system':
      return type;
    case 'button':
      return 'interactive';
    case 'order':
    case 'unsupported':
    case 'unknown':
      return 'unsupported';
  }
}

/**
 * Pesan yang dihitung sebagai "pelanggan mengirim pesan": membuka/memperpanjang jendela 24 jam,
 * menambah belum dibaca, dan membuka percakapan baru bila belum ada yang terbuka. Reaksi dan pesan
 * sistem (mis. pelanggan ganti nomor) TIDAK — keduanya hanya ditempelkan ke percakapan yang ada
 * (DECISIONS 2026-11-16: sikap hati-hati; Meta tidak menjamin reaksi membuka jendela layanan).
 */
export function countsAsCustomerMessage(type: MessageType): boolean {
  return type !== 'reaction' && type !== 'system';
}

/** Cap waktu tampilan pesan masuk: cap waktu Meta, dijepit ke ≤ waktu diterima server. */
export function inboundOccurredAt(sentAt: Date, receivedAt: Date): Date {
  return Number.isNaN(sentAt.getTime()) || sentAt > receivedAt ? receivedAt : sentAt;
}

function extrasOf(message: NormalizedInboundMessage): MessageExtras {
  const extras: MessageExtras = {};
  if (message.reply) extras.interactive = message.reply;
  if (message.referral) {
    // R2 (review kontak): URL iklan hanya http(s); teks iklan dari pengiklan tidak tepercaya.
    extras.referral = { ...message.referral, sourceUrl: safeHttpUrl(message.referral.sourceUrl) };
  }
  if (message.sharedContacts > 0) extras.sharedContacts = message.sharedContacts;
  if (message.context?.forwarded) extras.forwarded = true;
  if (message.context?.frequentlyForwarded) extras.frequentlyForwarded = true;
  return extras;
}

/**
 * ID pesan ber-wamid ini di channel yang sama; bila `contactId` diberikan, hanya pesan KONTAK ITU
 * (review kontak R1: balas-kutip/reaksi tidak boleh menaut pesan pelanggan lain — tanpa kecocokan,
 * hanya wamid sasarannya yang disimpan).
 */
async function messageIdByWamid(
  tx: DbExecutor,
  organizationId: string,
  channelId: string,
  wamid: string | null | undefined,
  contactId?: string,
): Promise<string | null> {
  if (!wamid) return null;
  const [row] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.channelId, channelId),
        eq(messages.wamid, wamid),
        contactId === undefined ? undefined : eq(messages.contactId, contactId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** Percakapan terbuka kontak × channel (terkunci), atau `undefined`. */
async function openConversation(
  tx: DbExecutor,
  organizationId: string,
  contactId: string,
  channelId: string,
): Promise<ConversationRow | undefined> {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        eq(conversations.contactId, contactId),
        eq(conversations.channelId, channelId),
        ne(conversations.status, 'resolved'),
      ),
    )
    .limit(1)
    .for('update');
  return row;
}

/** Percakapan terbaru kontak × channel (apa pun statusnya, terkunci), atau `undefined`. */
async function latestConversation(
  tx: DbExecutor,
  organizationId: string,
  contactId: string,
  channelId: string,
): Promise<ConversationRow | undefined> {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, organizationId),
        eq(conversations.contactId, contactId),
        eq(conversations.channelId, channelId),
      ),
    )
    .orderBy(desc(conversations.createdAt), desc(conversations.id))
    .limit(1)
    .for('update');
  return row;
}

async function linkEventToContact(context: InboundEventContext, contactId: string): Promise<void> {
  await context.tx
    .update(webhookEvents)
    .set({ contactId })
    .where(
      and(
        eq(webhookEvents.organizationId, context.organizationId),
        eq(webhookEvents.id, context.eventId),
      ),
    );
}

export function createInboundHandlers(options: InboundHandlerOptions = {}): InboundEventHandlers {
  const initialStatus = options.initialConversationStatus ?? botAwareInitialStatus;

  return {
    async message(message, context) {
      const { tx, organizationId, channelId, receivedAt, logger } = context;
      const identity = whatsAppContactIdentity(message.sender);
      if (!identity.bsuid && !identity.phone) {
        // Skema penerima mewajibkan `from`/`from_user_id`, tetapi nilainya bisa bukan pengenal sah.
        throw new WebhookPayloadError('Pesan masuk tanpa BSUID/nomor yang sah');
      }

      // Idempoten: wamid yang sama di channel ini sudah tersimpan → tidak ada yang diubah.
      if (await messageIdByWamid(tx, organizationId, channelId, message.wamid)) {
        logger.debug({ eventId: context.eventId }, 'Pesan masuk sudah tersimpan sebelumnya');
        return;
      }

      await lockContactIdentities(tx, organizationId, 'whatsapp', identity);
      const contact = await resolveWhatsAppContact(tx, {
        organizationId,
        identity,
        profileName: cleanCustomerText(message.sender.profileName),
        username: cleanCustomerText(message.sender.username),
        logger,
        now: receivedAt,
      });
      await linkEventToContact(context, contact.id);

      const type = messageTypeOf(message.type);
      const counts = countsAsCustomerMessage(type);
      // Jawaban survei CSAT (Fase 5): ditempel ke percakapan survei yang sudah selesai, tanpa
      // membukanya lagi / menambah antrian / meneruskan ke bot.
      const csatConversation =
        type === 'interactive'
          ? await matchCsatAnswer(tx, {
              organizationId,
              contactId: contact.id,
              channelId,
              replyId: message.reply?.id,
              receivedAt,
            })
          : null;
      let conversation =
        csatConversation ?? (await openConversation(tx, organizationId, contact.id, channelId));
      if (!conversation && !counts) {
        conversation = await latestConversation(tx, organizationId, contact.id, channelId);
        if (!conversation) {
          logger.debug(
            { eventId: context.eventId, type },
            'Reaksi/pesan sistem tanpa percakapan sebelumnya — tidak disimpan',
          );
          return;
        }
      }
      if (!conversation) {
        // Fase 5: percakapan baru langsung masuk departemen bawaan channel (bila diatur).
        const [routing] = await tx
          .select({ departmentId: channels.defaultDepartmentId })
          .from(channels)
          .where(and(eq(channels.organizationId, organizationId), eq(channels.id, channelId)));
        const [created] = await tx
          .insert(conversations)
          .values({
            organizationId,
            contactId: contact.id,
            channelId,
            status: await initialStatus(context),
            lastMessageAt: receivedAt,
            departmentId: routing?.departmentId ?? null,
          })
          .returning();
        if (!created) throw new Error('INSERT percakapan tidak mengembalikan baris');
        conversation = created;
        await recordOutgoingEvent(tx, {
          organizationId,
          type: 'conversation.created',
          conversationId: created.id,
          contactId: contact.id,
        });
      }

      const row: NewMessageRow = {
        organizationId,
        conversationId: conversation.id,
        contactId: contact.id,
        channelId,
        direction: 'inbound',
        senderKind: 'customer',
        type,
        rawType: message.rawType,
        wamid: message.wamid,
        text: message.text,
        media: message.media
          ? {
              kind: message.media.kind,
              metaMediaId: message.media.id,
              mimeType: message.media.mimeType,
              sha256: message.media.sha256,
              filename: cleanFileName(message.media.filename),
              voice: message.media.voice,
              animated: message.media.animated,
            }
          : null,
        location: message.location,
        extras: extrasOf(message),
        replyToWamid: message.context?.messageId ?? null,
        replyToMessageId: await messageIdByWamid(
          tx,
          organizationId,
          channelId,
          message.context?.messageId,
          contact.id,
        ),
        reactionEmoji: message.reaction?.emoji ?? null,
        reactionToWamid: message.reaction?.messageId ?? null,
        reactionToMessageId: await messageIdByWamid(
          tx,
          organizationId,
          channelId,
          message.reaction?.messageId,
          contact.id,
        ),
        errorCode: message.errors[0]?.code ?? null,
        occurredAt: inboundOccurredAt(message.sentAt, receivedAt),
        receivedAt,
      };
      const inserted = await tx
        .insert(messages)
        .values(row)
        .onConflictDoNothing({ target: [messages.channelId, messages.wamid] })
        .returning({ id: messages.id });
      const [created] = inserted;
      if (!created) return;
      if (!csatConversation) {
        await recordOutgoingEvent(tx, {
          organizationId,
          type: 'message.received',
          conversationId: conversation.id,
          messageId: created.id,
          contactId: contact.id,
        });
      }
      context.emit({
        type: 'message.created',
        organizationId,
        conversationId: conversation.id,
        messageId: created.id,
      });
      if (csatConversation) {
        // Pesan pelanggan membuka jendela 24 jam (ucapan terima kasih CSAT), status tetap `resolved`.
        await tx
          .update(conversations)
          .set({
            lastInboundAt: sql`greatest(${conversations.lastInboundAt}, ${receivedAt})`,
            windowExpiresAt: sql`greatest(${conversations.lastInboundAt}, ${receivedAt}) + ${WINDOW_INTERVAL}`,
            lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${receivedAt})`,
          })
          .where(
            and(
              eq(conversations.organizationId, organizationId),
              eq(conversations.id, conversation.id),
            ),
          );
        context.emit({
          type: 'conversation.updated',
          organizationId,
          conversationId: conversation.id,
        });
        return;
      }
      if (!counts) return;
      context.emit({
        type: 'conversation.updated',
        organizationId,
        conversationId: conversation.id,
      });

      // Jendela 24 jam dari jam server; `greatest` menjaga urutan bila kejadian diproses tidak urut.
      await tx
        .update(conversations)
        .set({
          lastInboundAt: sql`greatest(${conversations.lastInboundAt}, ${receivedAt})`,
          windowExpiresAt: sql`greatest(${conversations.lastInboundAt}, ${receivedAt}) + ${WINDOW_INTERVAL}`,
          lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${receivedAt})`,
          unreadCount: sql`${conversations.unreadCount} + 1`,
          // Bot memegang: pesan pelanggan pertama yang belum dibalas bot (dasar batas waktu bot).
          botAwaitingSince: sql`case when ${conversations.status} = 'bot' then coalesce(${conversations.botAwaitingSince}, ${receivedAt}) else null end`,
        })
        .where(
          and(
            eq(conversations.organizationId, organizationId),
            eq(conversations.id, conversation.id),
          ),
        );

      // Balasan atas broadcast: laporan "dibalas" + tag otomatis kampanye (Fase 4).
      if (
        await recordBroadcastReply(tx, {
          organizationId,
          contactId: contact.id,
          channelId,
          receivedAt,
        })
      ) {
        context.emit({
          type: 'conversation.detail',
          organizationId,
          conversationId: conversation.id,
          section: 'tags',
        });
      }
      // Komentar CSAT: pesan teks pertama ≤ 30 menit setelah menilai (pesan tetap diproses biasa).
      if (type === 'text') {
        await recordCsatComment(tx, {
          organizationId,
          contactId: contact.id,
          channelId,
          text: message.text,
          receivedAt,
        });
      }
    },

    async status(update, context) {
      const { tx, organizationId, channelId, receivedAt, logger } = context;
      if (update.status === 'unknown') return;
      const [message] = await tx
        .select({
          id: messages.id,
          status: messages.status,
          contactId: messages.contactId,
          conversationId: messages.conversationId,
        })
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, organizationId),
            eq(messages.channelId, channelId),
            eq(messages.wamid, update.wamid),
            eq(messages.direction, 'outbound'),
          ),
        )
        .limit(1)
        .for('update');
      if (!message) {
        // Pesan keluar belum ada (belum dibangun / dikirim di luar Balesin). TITIK KAIT butir pesan
        // keluar: setelah wamid tersimpan, putar ulang status dari `webhook_events` (external_id).
        logger.debug(
          { eventId: context.eventId },
          'Status untuk pesan yang tidak dikenal — diabaikan',
        );
        return;
      }
      await linkEventToContact(context, message.contactId);
      const current: MessageStatusValue | null =
        message.status === null || message.status === 'pending' ? null : message.status;
      if (!isStatusAdvance(current, update.status)) return;
      await tx
        .update(messages)
        .set({
          status: update.status,
          statusUpdatedAt: receivedAt,
          ...(update.status === 'failed'
            ? { errorCode: update.errors[0]?.code ?? null, failureReason: 'delivery_failed' }
            : {}),
        })
        .where(and(eq(messages.organizationId, organizationId), eq(messages.id, message.id)));
      await recordOutgoingEvent(tx, {
        organizationId,
        type: 'message.status',
        conversationId: message.conversationId,
        messageId: message.id,
        contactId: message.contactId,
      });
      context.emit({
        type: 'message.status',
        organizationId,
        conversationId: message.conversationId,
        messageId: message.id,
      });
    },

    error(failure, context) {
      // Hanya kode: judul/detail error Meta bisa memuat data. Alarm/diagnosis menyusul.
      context.logger.warn(
        { channelId: context.channelId, eventId: context.eventId, code: failure.error.code },
        'Meta melaporkan error tingkat akun/aplikasi lewat webhook',
      );
      return Promise.resolve();
    },
  };
}
