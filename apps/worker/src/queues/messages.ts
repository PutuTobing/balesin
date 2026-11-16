import {
  MESSAGE_JOBS,
  NOOP_INBOX_EVENT_PUBLISHER,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  SEND_CLAIM_STALE_MS,
  isMetaApiError,
  isStatusAdvance,
  normalizeStatusUpdate,
  openWhatsAppCredentials,
  sendMessageJobPayloadSchema,
  sendWhatsAppMessage,
  type InboxBusEventInput,
  type InboxEventPublisher,
  type Logger,
  type MessageStatusValue,
  type MetaCredentials,
  type MetaGraphClient,
  type OutboundContent,
  type SecretBox,
} from '@balesin/core';
import {
  apiKeys,
  channels,
  contacts,
  conversations,
  mediaFiles,
  messages,
  organizations,
  users,
  webhookEvents,
  type Database,
  type DbExecutor,
  type MessageRow,
} from '@balesin/db';
import {
  apiKeyHasScope,
  isWithinScope,
  permissionScope,
  type OutboundFailureReason,
} from '@balesin/shared';
import { UnrecoverableError, Worker } from 'bullmq';
import { and, asc, eq, isNull } from 'drizzle-orm';

import type { QueueConnectionOptions } from './system';

/**
 * Antrian `messages`: kirim pesan keluar ke Graph API (Fase 2 butir 6, docs/KONTRAK-API-INBOX.md
 * "Ruang chat").
 *
 * Alur satu job (payload hanya ID):
 *  1. Baca pesan `pending` + percakapan, kontak, channel, pengirim, media, sasaran kutip/reaksi.
 *  2. Pemeriksaan ULANG saat kirim (bukan saat antre — review akhir Fase 1 R3/G.3): channel aktif,
 *     pengirim masih aktif & masih memegang `inbox.reply` dalam cakupan percakapan itu, jendela 24
 *     jam masih terbuka (jam server), media masih ada, pelanggan punya nomor. Gagal → `failed` +
 *     alasan (`OUTBOUND_FAILURE_REASONS`), tanpa memanggil Meta.
 *  3. Kirim lewat klien Graph terpusat (kelompok laju `messaging`). TIDAK ada transaksi/kunci yang
 *     ditahan selama panggilan HTTP; pembaruan hasil hanya untuk baris yang masih `pending`.
 *  4. Sukses → simpan wamid (status tetap `pending` sampai webhook `sent`), lalu putar ulang status
 *     webhook yang telanjur datang sebelum wamid tersimpan (`webhook_events.external_id`).
 *     Batas laju / gangguan sementara Meta → diulang BullMQ (Meta belum memproses). Koneksi putus →
 *     `delivery_unknown` (bisa saja sudah terkirim — tidak diulang otomatis). Penolakan lain →
 *     `meta_rejected` + kode Meta.
 *  5. Event real-time (ID saja) diterbitkan setelah commit.
 *
 * Log hanya ID + kode; tidak pernah isi pesan, nomor, atau token.
 */

export interface MessageJob {
  id?: string;
  name: string;
  data: unknown;
  attemptsMade?: number;
  opts?: { attempts?: number };
}

export interface MessageJobDeps {
  db: Database;
  logger: Logger;
  meta: MetaGraphClient;
  secretBox: SecretBox | null;
  publisher?: InboxEventPublisher;
  now?: () => Date;
}

export type SendMessageResult =
  | { status: 'sent'; wamid: string }
  | { status: 'failed'; reason: OutboundFailureReason; errorCode: number | null }
  | { status: 'skipped'; reason: 'not_found' | 'not_pending' };

interface Prepared {
  message: MessageRow;
  phoneNumberId: string;
  credentials: MetaCredentials;
  to: string;
  content: OutboundContent;
  replyToWamid: string | null;
}

async function targetWamid(
  tx: DbExecutor,
  message: MessageRow,
  targetId: string | null,
): Promise<string | null> {
  if (!targetId) return null;
  const [target] = await tx
    .select({ wamid: messages.wamid })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, message.organizationId),
        eq(messages.channelId, message.channelId),
        eq(messages.contactId, message.contactId),
        eq(messages.id, targetId),
      ),
    )
    .limit(1);
  return target?.wamid ?? null;
}

/** Pemeriksaan sebelum kirim. `failure` = alasan gagal tanpa memanggil Meta. */
async function prepare(
  tx: DbExecutor,
  message: MessageRow,
  deps: MessageJobDeps,
  now: Date,
): Promise<{ prepared: Prepared } | { failure: OutboundFailureReason }> {
  const org = message.organizationId;
  // Rem darurat (review ruang chat S2): antrean berhenti seketika, pesan gagal dengan alasan yang
  // bisa dikirim ulang setelah pengiriman dilanjutkan.
  const [organization] = await tx
    .select({ pausedAt: organizations.sendingPausedAt })
    .from(organizations)
    .where(eq(organizations.id, org));
  if (organization?.pausedAt) return { failure: 'sending_paused' };
  const [channel] = await tx
    .select()
    .from(channels)
    .where(and(eq(channels.organizationId, org), eq(channels.id, message.channelId)))
    .limit(1);
  if (!channel || !channel.enabled || channel.deletedAt !== null || !channel.waPhoneNumberId) {
    return { failure: 'channel_unavailable' };
  }
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.organizationId, org), eq(conversations.id, message.conversationId)))
    .limit(1);
  if (!conversation) return { failure: 'channel_unavailable' };

  // Pengirim masih aktif dan masih boleh membalas percakapan ini (cakupan peran SAAT INI).
  // Yang memicu pengiriman ini: penekan "Kirim ulang" terakhir, atau penulis asli (review R2).
  const actorUserId = message.lastSentByUserId ?? message.senderUserId;
  if (actorUserId) {
    const [sender] = await tx
      .select({ role: users.role })
      .from(users)
      .where(
        and(eq(users.organizationId, org), eq(users.id, actorUserId), isNull(users.disabledAt)),
      )
      .limit(1);
    const scope = sender ? permissionScope(sender.role, 'inbox.reply') : null;
    const holders = conversation.assigneeUserId ? [conversation.assigneeUserId] : [];
    if (!scope || !isWithinScope(scope, actorUserId, { holderUserIds: holders })) {
      return { failure: 'sender_not_allowed' };
    }
  } else if (message.apiKeyId) {
    // Pesan lewat API publik: key-nya masih berlaku (tidak dicabut/kedaluwarsa, masih `messages:send`).
    const [key] = await tx
      .select({ scopes: apiKeys.scopes, expiresAt: apiKeys.expiresAt })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.organizationId, org),
          eq(apiKeys.id, message.apiKeyId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .limit(1);
    if (
      !key ||
      (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime()) ||
      !apiKeyHasScope(key.scopes, 'messages:send')
    ) {
      return { failure: 'sender_not_allowed' };
    }
  }

  // Jendela 24 jam (jam server). Template (di luar jendela) = fase berikutnya.
  if (!conversation.windowExpiresAt || conversation.windowExpiresAt.getTime() <= now.getTime()) {
    return { failure: 'window_closed' };
  }

  const [contact] = await tx
    .select({ phone: contacts.phone })
    .from(contacts)
    .where(and(eq(contacts.organizationId, org), eq(contacts.id, message.contactId)))
    .limit(1);
  // TITIK KAIT: kirim ke BSUID (pelanggan username tanpa nomor) bila Meta sudah mendukungnya.
  if (!contact?.phone) return { failure: 'recipient_unavailable' };

  let content: OutboundContent;
  switch (message.type) {
    case 'text':
      if (!message.text) return { failure: 'meta_rejected' };
      content = { type: 'text', text: message.text };
      break;
    case 'location': {
      const location = message.location;
      if (!location) return { failure: 'meta_rejected' };
      content = {
        type: 'location',
        latitude: location.latitude,
        longitude: location.longitude,
        name: location.name,
        address: location.address,
      };
      break;
    }
    case 'reaction': {
      const wamid = await targetWamid(tx, message, message.reactionToMessageId);
      if (!wamid) return { failure: 'meta_rejected' };
      content = { type: 'reaction', targetWamid: wamid, emoji: message.reactionEmoji ?? '' };
      break;
    }
    case 'image':
    case 'audio':
    case 'video':
    case 'document': {
      if (!message.mediaFileId) return { failure: 'media_unavailable' };
      const [file] = await tx
        .select()
        .from(mediaFiles)
        .where(and(eq(mediaFiles.organizationId, org), eq(mediaFiles.id, message.mediaFileId)))
        .limit(1);
      if (
        !file ||
        file.deletedAt !== null ||
        !file.metaMediaRef ||
        file.channelId !== message.channelId ||
        file.expiresAt.getTime() <= now.getTime()
      ) {
        return { failure: 'media_unavailable' };
      }
      content = {
        type: 'media',
        kind: message.type,
        metaMediaId: file.metaMediaRef,
        caption: message.text,
        filename: file.filename,
      };
      break;
    }
    default:
      return { failure: 'meta_rejected' };
  }

  if (!deps.secretBox) return { failure: 'credentials_unavailable' };
  let credentials: MetaCredentials;
  try {
    credentials = openWhatsAppCredentials(deps.secretBox, channel);
  } catch {
    return { failure: 'credentials_unavailable' };
  }
  return {
    prepared: {
      message,
      phoneNumberId: channel.waPhoneNumberId,
      credentials,
      to: contact.phone.replace(/^\+/, ''),
      content,
      replyToWamid:
        message.type === 'reaction'
          ? null
          : await targetWamid(tx, message, message.replyToMessageId),
    },
  };
}

async function markFailed(
  db: Database,
  message: MessageRow,
  reason: OutboundFailureReason,
  errorCode: number | null,
  now: Date,
): Promise<boolean> {
  const updated = await db
    .update(messages)
    .set({ status: 'failed', failureReason: reason, errorCode, statusUpdatedAt: now })
    .where(
      and(
        eq(messages.organizationId, message.organizationId),
        eq(messages.id, message.id),
        eq(messages.status, 'pending'),
      ),
    )
    .returning({ id: messages.id });
  return updated.length > 0;
}

/**
 * Status webhook yang datang SEBELUM wamid tersimpan (Meta bisa mengirim `sent` lebih cepat dari
 * jawaban API kita) diputar ulang dari `webhook_events` supaya tidak hilang.
 */
async function replayEarlyStatuses(
  tx: DbExecutor,
  message: MessageRow,
  wamid: string,
): Promise<MessageStatusValue | null> {
  const rows = await tx
    .select({ id: webhookEvents.id, payload: webhookEvents.payload })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.organizationId, message.organizationId),
        eq(webhookEvents.channelId, message.channelId),
        eq(webhookEvents.kind, 'status'),
        eq(webhookEvents.externalId, wamid),
        isNull(webhookEvents.payloadPurgedAt),
      ),
    )
    .orderBy(asc(webhookEvents.receivedAt));
  let current: MessageStatusValue | null = null;
  let errorCode: number | null = null;
  for (const row of rows) {
    let update;
    try {
      update = normalizeStatusUpdate(row.payload);
    } catch {
      continue;
    }
    if (update.status === 'unknown' || !isStatusAdvance(current, update.status)) continue;
    current = update.status;
    errorCode = update.status === 'failed' ? (update.errors[0]?.code ?? null) : errorCode;
    await tx
      .update(webhookEvents)
      .set({ contactId: message.contactId })
      .where(
        and(eq(webhookEvents.organizationId, message.organizationId), eq(webhookEvents.id, row.id)),
      );
  }
  if (current === null) return null;
  await tx
    .update(messages)
    .set({
      status: current,
      statusUpdatedAt: new Date(),
      ...(current === 'failed' ? { failureReason: 'delivery_failed', errorCode } : {}),
    })
    .where(and(eq(messages.organizationId, message.organizationId), eq(messages.id, message.id)));
  return current;
}

export async function processSendMessageJob(
  job: MessageJob,
  deps: MessageJobDeps,
): Promise<SendMessageResult> {
  if (job.name !== MESSAGE_JOBS.send) {
    throw new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian messages`);
  }
  const payload = sendMessageJobPayloadSchema.safeParse(job.data);
  if (!payload.success) throw new UnrecoverableError('Payload job messages tidak valid');
  const { organizationId, messageId } = payload.data;
  const { db, logger } = deps;
  const publisher = deps.publisher ?? NOOP_INBOX_EVENT_PUBLISHER;
  const now = (deps.now ?? (() => new Date()))();

  const [message] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.id, messageId),
        eq(messages.direction, 'outbound'),
      ),
    )
    .limit(1);
  if (!message) return { status: 'skipped', reason: 'not_found' };
  if (message.status !== 'pending' || message.wamid !== null) {
    return { status: 'skipped', reason: 'not_pending' };
  }
  const events: InboxBusEventInput[] = [
    { type: 'message.status', organizationId, conversationId: message.conversationId, messageId },
    { type: 'conversation.updated', organizationId, conversationId: message.conversationId },
  ];

  const check = await prepare(db, message, deps, now);
  if ('failure' in check) {
    if (await markFailed(db, message, check.failure, null, now)) await publisher.publish(events);
    logger.info({ messageId, reason: check.failure }, 'Pesan keluar tidak dikirim (pemeriksaan)');
    return { status: 'failed', reason: check.failure, errorCode: null };
  }

  const { prepared } = check;

  // Klaim atomik SEBELUM memanggil Meta (review ruang chat R3). Klaim yang sudah ada tanpa wamid =
  // percobaan sebelumnya berhenti di tengah (proses mati / job tersendat) — Meta mungkin sudah
  // menerima, jadi TIDAK dikirim lagi: `delivery_unknown`, pengguna yang memutuskan.
  const [claimed] = await db
    .update(messages)
    .set({ sendClaimedAt: now })
    .where(
      and(
        eq(messages.organizationId, organizationId),
        eq(messages.id, messageId),
        eq(messages.status, 'pending'),
        isNull(messages.wamid),
        isNull(messages.sendClaimedAt),
      ),
    )
    .returning({ id: messages.id });
  if (!claimed) {
    // R5: klaim yang masih baru = percobaan lain SEDANG memanggil Meta (job ganda/stalled). Jangan
    // ganggu — biarkan ia menyimpan wamid. Klaim yang macet ditandai pemeriksa berkala
    // (`markStaleSendClaims`) atau oleh job berikutnya setelah `SEND_CLAIM_STALE_MS`.
    const [current] = await db
      .select({ claimedAt: messages.sendClaimedAt })
      .from(messages)
      .where(and(eq(messages.organizationId, organizationId), eq(messages.id, messageId)));
    if (current?.claimedAt && now.getTime() - current.claimedAt.getTime() < SEND_CLAIM_STALE_MS) {
      logger.info({ messageId }, 'Pesan keluar sedang dikirim percobaan lain — job ini dilewati');
      return { status: 'skipped', reason: 'not_pending' };
    }
    if (await markFailed(db, message, 'delivery_unknown', null, new Date())) {
      await publisher.publish(events);
    }
    logger.warn(
      { messageId },
      'Pesan keluar sudah diklaim percobaan lain tanpa hasil — tidak dikirim ulang',
    );
    return { status: 'failed', reason: 'delivery_unknown', errorCode: null };
  }
  let wamid: string;
  try {
    ({ wamid } = await sendWhatsAppMessage(
      deps.meta,
      prepared.credentials,
      prepared.phoneNumberId,
      {
        to: prepared.to,
        content: prepared.content,
        replyToWamid: prepared.replyToWamid,
      },
    ));
  } catch (error) {
    if (!isMetaApiError(error)) throw error;
    const maxAttempts = job.opts?.attempts ?? 1;
    const lastAttempt = (job.attemptsMade ?? 0) + 1 >= maxAttempts;
    if (
      (error.kind === 'rate_limited' || error.kind === 'temporarily_unavailable') &&
      !lastAttempt
    ) {
      // Meta belum memproses: aman diulang (BullMQ, jeda eksponensial). Pesan baru: kode saja.
      logger.warn({ messageId, kind: error.kind, metaCode: error.metaCode }, 'Kirim pesan diulang');
      // Meta jelas belum memproses → klaim dilepas supaya percobaan berikutnya boleh mengirim.
      await db
        .update(messages)
        .set({ sendClaimedAt: null })
        .where(and(eq(messages.organizationId, organizationId), eq(messages.id, messageId)));
      throw new Error(`Kirim pesan ditunda (${error.kind})`, { cause: error });
    }
    const reason: OutboundFailureReason =
      error.kind === 'network_error' ? 'delivery_unknown' : 'meta_rejected';
    if (await markFailed(db, message, reason, error.metaCode, new Date())) {
      await publisher.publish(events);
    }
    logger.warn(
      { messageId, reason, kind: error.kind, metaCode: error.metaCode },
      'Kirim pesan gagal',
    );
    return { status: 'failed', reason, errorCode: error.metaCode };
  }

  await db.transaction(async (tx) => {
    const saved = await tx
      .update(messages)
      .set({ wamid, errorCode: null, failureReason: null })
      .where(
        and(
          eq(messages.organizationId, organizationId),
          eq(messages.id, messageId),
          eq(messages.status, 'pending'),
        ),
      )
      .returning({ id: messages.id });
    // R5: pesan sudah ditandai `delivery_unknown` (klaim dianggap macet) padahal Meta MENERIMA →
    // pulihkan: wamid disimpan, status dibetulkan menjadi `sent` supaya status webhook tertaut.
    const recovered =
      saved.length > 0
        ? []
        : await tx
            .update(messages)
            .set({
              wamid,
              status: 'sent',
              errorCode: null,
              failureReason: null,
              statusUpdatedAt: new Date(),
            })
            .where(
              and(
                eq(messages.organizationId, organizationId),
                eq(messages.id, messageId),
                eq(messages.status, 'failed'),
                eq(messages.failureReason, 'delivery_unknown'),
                isNull(messages.wamid),
              ),
            )
            .returning({ id: messages.id });
    if (recovered.length > 0) {
      logger.warn({ messageId }, 'Pesan "mungkin terkirim" ternyata diterima Meta — dipulihkan');
    }
    if (saved.length > 0 || recovered.length > 0) await replayEarlyStatuses(tx, message, wamid);
  });
  await publisher.publish(events);
  logger.info({ messageId }, 'Pesan keluar diterima Meta');
  return { status: 'sent', wamid };
}

export function createMessageWorker(options: QueueConnectionOptions, deps: MessageJobDeps): Worker {
  return new Worker(QUEUE_NAMES.messages, (job) => processSendMessageJob(job, deps), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    concurrency: 10,
  });
}
