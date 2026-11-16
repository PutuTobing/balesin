import {
  AppError,
  checkOutboundMedia,
  cleanFileName,
  detectMedia,
  isMetaApiError,
  openWhatsAppCredentials,
  readWhatsAppMediaUrl,
  uploadWhatsAppMedia,
  type InboxEventPublisher,
  type Logger,
  type MetaApiError,
  type MetaGraphClient,
  type SecretBox,
} from '@balesin/core';
import {
  PG_ERROR_CODES,
  channels,
  conversations,
  isPgError,
  mediaFiles,
  messages,
  organizations,
  type Channel,
  type Database,
  type MediaFileRow,
  type MessageRow,
} from '@balesin/db';
import {
  MAX_INBOUND_MEDIA_BYTES,
  MAX_SEND_ATTEMPTS,
  META_ERROR_MESSAGES,
  isRetryableFailure,
  outboundFailureReasonSchema,
  type MessageMediaKind,
  type SendMessageRequest,
  type UploadedMedia,
} from '@balesin/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { OutboundMessageEnqueuer } from '../../queues/message-queue';
import type { PermissionGrant } from '../auth/permission-grant';
import { conversationScope, findConversation, type MessageRowView } from '../inbox/inbox.repo';
import type { MediaStore } from './media-store';

/**
 * Ruang chat — kirim pesan, kirim ulang, unggah & unduh media (Fase 2 butir 6,
 * docs/KONTRAK-API-INBOX.md "Ruang chat").
 *
 * - Semua akses lewat `grant` + cakupan percakapan (Teknisi: hanya yang di-assign kepadanya).
 *   Data di luar cakupan / organisasi lain / ID asing = 404 yang sama.
 * - Jendela 24 jam ditegakkan DI SERVER (di sini dan diperiksa ulang worker saat mengirim).
 * - Pesan disimpan `pending`, lalu ID-nya diantre (worker mengirim ke Meta). Idempoten per
 *   (pengirim, `clientMessageId`).
 * - Media: isi berkas dideteksi dari magic bytes; nama berkas dibersihkan; disimpan dengan nama
 *   acak di `MEDIA_DIR`; tidak pernah mengambil URL dari klien (tanpa SSRF).
 * - Log tanpa isi pesan, nomor, atau nama berkas.
 */

export interface OutboundServiceDeps {
  db: Database;
  store: MediaStore;
  meta: MetaGraphClient;
  secretBox: SecretBox | null;
  queue: OutboundMessageEnqueuer;
  publisher: InboxEventPublisher;
  logger: Logger;
  now?: () => Date;
}

const CONVERSATION_NOT_FOUND = 'Percakapan tidak ditemukan.';
const MESSAGE_NOT_FOUND = 'Pesan tidak ditemukan.';
const MEDIA_NOT_FOUND =
  'Berkas tidak ditemukan atau sudah kedaluwarsa. Unggah ulang berkasnya lalu kirim lagi.';
const MEDIA_UNAVAILABLE = 'Media pesan ini tidak tersedia lagi.';
const DAY_MS = 24 * 60 * 60 * 1000;
/** ID media hasil unggah ke Meta berlaku ±30 hari; salinan unggahan tidak disimpan lebih lama. */
const UPLOAD_MAX_RETENTION_DAYS = 29;

const notFound = (message: string) => new AppError('NOT_FOUND', { message });

function metaFailure(error: MetaApiError): AppError {
  return new AppError('META_REQUEST_FAILED', {
    message: META_ERROR_MESSAGES[error.kind],
    cause: error,
    ...(error.retryAfterSeconds !== null ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  });
}

/** Satu emoji (satu grapheme bergambar) — atau string kosong untuk menghapus reaksi. */
export function isSingleEmoji(value: string): boolean {
  if (value === '') return true;
  const segments = [...new Intl.Segmenter('id', { granularity: 'grapheme' }).segment(value)];
  return segments.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value);
}

export interface OutboundService {
  send(
    grant: PermissionGrant,
    conversationId: string,
    input: SendMessageRequest,
  ): Promise<{ message: MessageRowView; created: boolean }>;
  retry(grant: PermissionGrant, messageId: string): Promise<MessageRowView>;
  upload(
    grant: PermissionGrant,
    conversationId: string,
    file: { bytes: Buffer; filename: string | null },
  ): Promise<UploadedMedia>;
  /** Media pesan (unduh dari Meta bila belum ada salinan lokal). */
  media(
    grant: PermissionGrant,
    messageId: string,
  ): Promise<{ file: MediaFileRow; stream: NodeJS.ReadableStream; sizeBytes: number }>;
  /** Hapus salinan lokal yang kedaluwarsa (pembersih berkala). */
  purgeExpiredMedia(limit?: number): Promise<number>;
}

export function createOutboundService(deps: OutboundServiceDeps): OutboundService {
  const { db, store, meta, secretBox, queue, publisher, logger } = deps;
  const now = deps.now ?? (() => new Date());

  async function scopedConversation(grant: PermissionGrant, conversationId: string) {
    const conversation = await findConversation(db, grant, conversationId);
    if (!conversation) throw notFound(CONVERSATION_NOT_FOUND);
    return conversation;
  }

  async function liveChannel(organizationId: string, channelId: string): Promise<Channel> {
    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.organizationId, organizationId), eq(channels.id, channelId)))
      .limit(1);
    if (!channel || !channel.enabled || channel.deletedAt !== null || !channel.waPhoneNumberId) {
      throw new AppError('CONFLICT', {
        message:
          'Nomor WhatsApp pengirim sedang dinonaktifkan atau sudah dihapus. Aktifkan lagi di Pengaturan → Channel.',
      });
    }
    return channel;
  }

  function credentialsOf(channel: Channel) {
    if (!secretBox) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        message:
          'Kredensial channel tidak bisa dibuka di server. Hubungi admin untuk memeriksa BALESIN_MASTER_KEY.',
      });
    }
    try {
      return openWhatsAppCredentials(secretBox, channel);
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE', {
        message: 'Kredensial channel tidak bisa dibuka di server. Hubungi admin.',
      });
    }
  }

  /** Pesan dalam cakupan (lewat percakapannya) atau 404. */
  async function scopedMessage(grant: PermissionGrant, messageId: string): Promise<MessageRow> {
    const [row] = await db
      .select({ message: messages })
      .from(messages)
      .innerJoin(
        conversations,
        and(
          eq(conversations.organizationId, messages.organizationId),
          eq(conversations.id, messages.conversationId),
        ),
      )
      .where(
        and(
          eq(messages.organizationId, grant.organizationId),
          eq(messages.id, messageId),
          conversationScope(grant),
        ),
      )
      .limit(1);
    if (!row) throw notFound(MESSAGE_NOT_FOUND);
    return row.message;
  }

  /** Sasaran kutip/reaksi: pesan kontak & channel yang sama, sudah punya wamid. */
  async function target(
    grant: PermissionGrant,
    contactId: string,
    channelId: string,
    messageId: string,
  ): Promise<{ id: string; wamid: string }> {
    const [row] = await db
      .select({ id: messages.id, wamid: messages.wamid })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, grant.organizationId),
          eq(messages.contactId, contactId),
          eq(messages.channelId, channelId),
          eq(messages.id, messageId),
        ),
      )
      .limit(1);
    if (!row) throw notFound(MESSAGE_NOT_FOUND);
    if (!row.wamid) {
      throw new AppError('CONFLICT', {
        message:
          'Pesan itu belum terkirim ke WhatsApp, jadi belum bisa dibalas atau diberi reaksi.',
      });
    }
    return { id: row.id, wamid: row.wamid };
  }

  async function byIdempotencyKey(grant: PermissionGrant, key: string) {
    const [row] = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, grant.organizationId),
          eq(messages.senderUserId, grant.userId),
          eq(messages.idempotencyKey, key),
        ),
      )
      .limit(1);
    return row;
  }

  async function view(row: MessageRow): Promise<MessageRowView> {
    const [exact] = await db
      .select({
        at: sql<string>`to_char(${messages.occurredAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(messages)
      .where(and(eq(messages.organizationId, row.organizationId), eq(messages.id, row.id)));
    return { ...row, occurredAtExact: exact?.at ?? row.occurredAt.toISOString() };
  }

  async function enqueue(row: MessageRow, attempt: number): Promise<MessageRow> {
    try {
      await queue.enqueue({ organizationId: row.organizationId, messageId: row.id }, attempt);
      return row;
    } catch (err) {
      logger.warn({ err, messageId: row.id }, 'Pesan keluar tersimpan tetapi gagal diantrekan');
      const [failed] = await db
        .update(messages)
        .set({ status: 'failed', failureReason: 'queue_unavailable', statusUpdatedAt: now() })
        .where(
          and(
            eq(messages.organizationId, row.organizationId),
            eq(messages.id, row.id),
            eq(messages.status, 'pending'),
          ),
        )
        .returning();
      return failed ?? row;
    }
  }

  async function publishFor(row: MessageRow, created: boolean) {
    await publisher.publish([
      created
        ? {
            type: 'message.created',
            organizationId: row.organizationId,
            conversationId: row.conversationId,
            messageId: row.id,
          }
        : {
            type: 'message.status',
            organizationId: row.organizationId,
            conversationId: row.conversationId,
            messageId: row.id,
          },
      {
        type: 'conversation.updated',
        organizationId: row.organizationId,
        conversationId: row.conversationId,
      },
    ]);
  }

  async function mediaRetentionDays(organizationId: string): Promise<number> {
    const [organization] = await db
      .select({ days: organizations.mediaRetentionDays })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    return organization?.days ?? 30;
  }

  return {
    async send(grant, conversationId, input) {
      const existing = await byIdempotencyKey(grant, input.clientMessageId);
      if (existing) {
        if (existing.conversationId !== conversationId) {
          throw new AppError('CONFLICT', {
            message: 'ID pesan ini sudah dipakai untuk percakapan lain. Muat ulang halaman.',
          });
        }
        await scopedConversation(grant, conversationId);
        return { message: await view(existing), created: false };
      }

      const conversation = await scopedConversation(grant, conversationId);
      const at = now();
      await liveChannel(grant.organizationId, conversation.channel.id);
      if (!conversation.windowExpiresAt || conversation.windowExpiresAt.getTime() <= at.getTime()) {
        // TITIK KAIT template (fase berikutnya): di luar jendela hanya template yang boleh.
        throw new AppError('WINDOW_CLOSED');
      }

      const [conversationRow] = await db
        .select({ contactId: conversations.contactId })
        .from(conversations)
        .where(
          and(
            eq(conversations.organizationId, grant.organizationId),
            eq(conversations.id, conversation.id),
          ),
        );
      const contactId = conversationRow?.contactId ?? conversation.contact.id;
      const channelId = conversation.channel.id;

      const values: typeof messages.$inferInsert = {
        organizationId: grant.organizationId,
        conversationId: conversation.id,
        contactId,
        channelId,
        direction: 'outbound',
        senderKind: 'agent',
        senderUserId: grant.userId,
        type: 'text',
        status: 'pending',
        statusUpdatedAt: at,
        idempotencyKey: input.clientMessageId,
        sendAttempts: 1,
        occurredAt: at,
      };

      if ('replyToMessageId' in input && input.replyToMessageId) {
        const quoted = await target(grant, contactId, channelId, input.replyToMessageId);
        values.replyToMessageId = quoted.id;
        values.replyToWamid = quoted.wamid;
      }

      switch (input.type) {
        case 'text':
          values.type = 'text';
          values.text = input.text;
          break;
        case 'location':
          values.type = 'location';
          values.location = {
            latitude: input.latitude,
            longitude: input.longitude,
            name: input.name?.trim() || null,
            address: input.address?.trim() || null,
          };
          break;
        case 'reaction': {
          if (!isSingleEmoji(input.emoji)) {
            throw new AppError('VALIDATION_ERROR', {
              message: 'Reaksi harus satu emoji.',
              details: [{ location: 'body', field: 'emoji', message: 'Reaksi harus satu emoji.' }],
            });
          }
          const reacted = await target(grant, contactId, channelId, input.targetMessageId);
          values.type = 'reaction';
          values.reactionEmoji = input.emoji === '' ? null : input.emoji;
          values.reactionToMessageId = reacted.id;
          values.reactionToWamid = reacted.wamid;
          break;
        }
        case 'media': {
          const [file] = await db
            .select()
            .from(mediaFiles)
            .where(
              and(
                eq(mediaFiles.organizationId, grant.organizationId),
                eq(mediaFiles.id, input.mediaId),
                eq(mediaFiles.source, 'upload'),
                eq(mediaFiles.uploadedByUserId, grant.userId),
                eq(mediaFiles.channelId, channelId),
                isNull(mediaFiles.deletedAt),
              ),
            )
            .limit(1);
          if (!file || !file.metaMediaRef || file.expiresAt.getTime() <= at.getTime()) {
            throw notFound(MEDIA_NOT_FOUND);
          }
          values.type = file.kind;
          values.text = input.caption?.trim() ? input.caption : null;
          values.mediaFileId = file.id;
          values.media = {
            kind: file.kind,
            metaMediaId: file.metaMediaRef,
            mimeType: file.mimeType,
            sha256: null,
            filename: file.filename,
            voice: false,
            animated: false,
          };
          break;
        }
      }

      let row: MessageRow;
      try {
        row = await db.transaction(async (tx) => {
          const [inserted] = await tx.insert(messages).values(values).returning();
          if (!inserted) throw new Error('INSERT pesan keluar tidak mengembalikan baris');
          await tx
            .update(conversations)
            .set({
              lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${at})`,
              // Membalas = sudah membaca percakapan ini.
              unreadCount: 0,
            })
            .where(
              and(
                eq(conversations.organizationId, grant.organizationId),
                eq(conversations.id, conversation.id),
              ),
            );
          return inserted;
        });
      } catch (error) {
        if (!isPgError(error, PG_ERROR_CODES.uniqueViolation, 'messages_idempotency_unique')) {
          throw error;
        }
        const raced = await byIdempotencyKey(grant, input.clientMessageId);
        if (!raced) throw error;
        return { message: await view(raced), created: false };
      }

      row = await enqueue(row, 1);
      await publishFor(row, true);
      logger.info({ messageId: row.id, type: row.type }, 'Pesan keluar diantrekan');
      return { message: await view(row), created: true };
    },

    async retry(grant, messageId) {
      const message = await scopedMessage(grant, messageId);
      const reason = outboundFailureReasonSchema.safeParse(message.failureReason);
      if (
        message.direction !== 'outbound' ||
        message.status !== 'failed' ||
        !reason.success ||
        !isRetryableFailure(reason.data, message.errorCode) ||
        message.sendAttempts >= MAX_SEND_ATTEMPTS
      ) {
        throw new AppError('CONFLICT', { message: 'Pesan ini tidak bisa dikirim ulang.' });
      }
      const conversation = await scopedConversation(grant, message.conversationId);
      await liveChannel(grant.organizationId, message.channelId);
      if (
        !conversation.windowExpiresAt ||
        conversation.windowExpiresAt.getTime() <= now().getTime()
      ) {
        throw new AppError('WINDOW_CLOSED');
      }
      const [updated] = await db
        .update(messages)
        .set({
          status: 'pending',
          failureReason: null,
          errorCode: null,
          wamid: null,
          // Yang menekan "Kirim ulang" menjadi pengirimnya (diperiksa ulang worker saat kirim).
          senderUserId: grant.userId,
          sendAttempts: sql`${messages.sendAttempts} + 1`,
          statusUpdatedAt: now(),
        })
        .where(
          and(
            eq(messages.organizationId, grant.organizationId),
            eq(messages.id, message.id),
            eq(messages.status, 'failed'),
          ),
        )
        .returning();
      if (!updated) throw new AppError('CONFLICT', { message: 'Pesan ini sedang dikirim ulang.' });
      const row = await enqueue(updated, updated.sendAttempts);
      await publishFor(row, false);
      logger.info({ messageId: row.id, attempt: row.sendAttempts }, 'Pesan keluar dikirim ulang');
      return view(row);
    },

    async upload(grant, conversationId, file) {
      const conversation = await scopedConversation(grant, conversationId);
      const channel = await liveChannel(grant.organizationId, conversation.channel.id);
      const filename = cleanFileName(file.filename);
      const detected = detectMedia(file.bytes, filename);
      const verdict = checkOutboundMedia(detected, file.bytes.byteLength);
      if (!verdict.ok) {
        if (verdict.reason === 'too_large') {
          throw new AppError('PAYLOAD_TOO_LARGE', {
            message: `Berkas terlalu besar untuk jenis ini (maks. ${String(Math.floor((verdict.maxBytes ?? 0) / (1024 * 1024)))} MB).`,
          });
        }
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
          message:
            'Jenis berkas tidak didukung WhatsApp. Kirim gambar JPG/PNG, video MP4/3GP, audio (OGG, MP3, AAC, M4A, AMR), atau dokumen (PDF, Word, Excel, PowerPoint, TXT).',
        });
      }
      const credentials = credentialsOf(channel);
      const stored = await store.save('uploads', file.bytes);
      let metaId: string;
      try {
        ({ id: metaId } = await uploadWhatsAppMedia(
          meta,
          credentials,
          channel.waPhoneNumberId ?? '',
          {
            bytes: file.bytes,
            mimeType: verdict.mimeType,
            filename: filename ?? `berkas-${stored.storageKey.slice(-12)}`,
          },
          { signal: AbortSignal.timeout(60_000) },
        ));
      } catch (error) {
        await store.remove(stored.storageKey).catch(() => undefined);
        if (isMetaApiError(error)) throw metaFailure(error);
        throw error;
      }
      const days = Math.min(
        await mediaRetentionDays(grant.organizationId),
        UPLOAD_MAX_RETENTION_DAYS,
      );
      const [row] = await db
        .insert(mediaFiles)
        .values({
          organizationId: grant.organizationId,
          channelId: channel.id,
          source: 'upload',
          kind: verdict.kind,
          mimeType: verdict.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          filename,
          storageKey: stored.storageKey,
          metaMediaRef: metaId,
          uploadedByUserId: grant.userId,
          expiresAt: new Date(now().getTime() + days * DAY_MS),
        })
        .returning();
      if (!row) throw new Error('INSERT media tidak mengembalikan baris');
      logger.info({ mediaId: row.id, kind: row.kind, bytes: row.sizeBytes }, 'Media diunggah');
      return {
        id: row.id,
        kind: row.kind,
        mimeType: row.mimeType,
        filename: row.filename,
        sizeBytes: row.sizeBytes,
      };
    },

    async media(grant, messageId) {
      const message = await scopedMessage(grant, messageId);
      if (message.mediaFileId) {
        const [file] = await db
          .select()
          .from(mediaFiles)
          .where(
            and(
              eq(mediaFiles.organizationId, grant.organizationId),
              eq(mediaFiles.id, message.mediaFileId),
            ),
          )
          .limit(1);
        if (file?.storageKey && file.deletedAt === null) {
          const opened = await store.open(file.storageKey);
          if (opened) return { file, ...opened };
        }
        // Salinan unggahan pesan keluar tidak bisa diunduh ulang dari Meta.
        if (message.direction === 'outbound') throw notFound(MEDIA_UNAVAILABLE);
      }
      const media = message.media;
      if (message.direction !== 'inbound' || !media?.metaMediaId) {
        throw notFound(MEDIA_UNAVAILABLE);
      }
      const [channel] = await db
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.organizationId, grant.organizationId),
            eq(channels.id, message.channelId),
          ),
        )
        .limit(1);
      if (!channel || channel.deletedAt !== null) throw notFound(MEDIA_UNAVAILABLE);
      const credentials = credentialsOf(channel);
      const signal = AbortSignal.timeout(90_000);
      let bytes: Buffer;
      try {
        const info = await readWhatsAppMediaUrl(meta, credentials, media.metaMediaId, { signal });
        if (info.fileSize !== null && info.fileSize > MAX_INBOUND_MEDIA_BYTES) {
          throw notFound('Media terlalu besar untuk diunduh lewat Balesin.');
        }
        ({ bytes } = await meta.download(credentials, {
          operation: 'media.download',
          url: info.url,
          maxBytes: MAX_INBOUND_MEDIA_BYTES,
          signal,
        }));
      } catch (error) {
        if (isMetaApiError(error)) {
          if (error.kind === 'not_found') throw notFound(MEDIA_UNAVAILABLE);
          throw metaFailure(error);
        }
        throw error;
      }
      const filename = cleanFileName(media.filename);
      const detected = detectMedia(bytes, filename);
      const kind: MessageMediaKind = detected?.kind ?? media.kind;
      const stored = await store.save('inbound', bytes);
      const days = await mediaRetentionDays(grant.organizationId);
      const [file] = await db
        .insert(mediaFiles)
        .values({
          organizationId: grant.organizationId,
          channelId: channel.id,
          source: 'inbound',
          kind,
          // Tidak dikenali = disajikan sebagai unduhan biner, tidak pernah ditampilkan inline.
          mimeType: detected?.mimeType ?? 'application/octet-stream',
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          filename,
          storageKey: stored.storageKey,
          metaMediaRef: media.metaMediaId,
          expiresAt: new Date(now().getTime() + days * DAY_MS),
        })
        .returning();
      if (!file) throw new Error('INSERT media tidak mengembalikan baris');
      await db
        .update(messages)
        .set({ mediaFileId: file.id })
        .where(and(eq(messages.organizationId, grant.organizationId), eq(messages.id, message.id)));
      const opened = await store.open(stored.storageKey);
      if (!opened) throw notFound(MEDIA_UNAVAILABLE);
      logger.info({ messageId: message.id, bytes: stored.sizeBytes }, 'Media masuk diunduh');
      return { file, ...opened };
    },

    async purgeExpiredMedia(limit = 500) {
      const due = await db
        .select({ id: mediaFiles.id, storageKey: mediaFiles.storageKey })
        .from(mediaFiles)
        .where(and(isNull(mediaFiles.deletedAt), sql`${mediaFiles.expiresAt} <= ${now()}`))
        .limit(limit);
      let removed = 0;
      for (const file of due) {
        try {
          if (file.storageKey) await store.remove(file.storageKey);
          await db
            .update(mediaFiles)
            .set({ storageKey: null, deletedAt: now() })
            .where(eq(mediaFiles.id, file.id));
          removed += 1;
        } catch (err) {
          logger.warn({ err, mediaId: file.id }, 'Salinan media kedaluwarsa gagal dihapus');
        }
      }
      return removed;
    },
  };
}
