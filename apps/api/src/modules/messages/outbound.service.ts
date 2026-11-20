import {
  AppError,
  MACRO_MARKER_MAX_BYTES,
  ZIP_TAIL_BYTES,
  checkOutboundMedia,
  cleanFileName,
  containsMacroMarker,
  detectMedia,
  findZipCentralDirectory,
  officeContainerOf,
  officeZipAllowed,
  zipEntryNames,
  type DetectedMedia,
  createTelegramBotClient,
  isMetaApiError,
  isMetaSocialCdnUrl,
  isTelegramApiError,
  openChannelConnectionSecret,
  TELEGRAM_MAX_DOWNLOAD_BYTES,
  type TelegramBotClient,
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
  messageEmailBodies,
  messages,
  organizations,
  recordOutgoingEvent,
  type Channel,
  type Database,
  type MediaFileRow,
  type MessageRow,
} from '@balesin/db';
import {
  CHANNEL_CAPABILITIES,
  channelHasCustomerWindow,
  channelSupportsOutbound,
  MAX_INBOUND_MEDIA_BYTES,
  MAX_SEND_ATTEMPTS,
  MAX_UPLOAD_BYTES,
  OUTBOUND_MEDIA_LIMITS,
  META_ERROR_MESSAGES,
  isRetryableFailure,
  outboundFailureReasonSchema,
  type MessageMediaKind,
  type OutboundMediaKind,
  type SendMessageRequest,
  type TemplateSendParameters,
  type UploadedMedia,
  apiKeyHasScope,
} from '@balesin/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import type { OutboundMessageEnqueuer } from '../../queues/message-queue';
import type { PermissionGrant } from '../auth/permission-grant';
import {
  conversationScope,
  findConversation,
  senderNameOf,
  type MessageRowView,
} from '../inbox/inbox.repo';
import type { SendingLimitsService } from '../sending-limits/sending-limits.service';
import { resolveTemplateSend } from '../templates/template-send';
import { createConcurrencyGate } from './concurrency';
import { MediaTooLargeError, type MediaStore, type StoredFile } from './media-store';

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
  /** Rem pengiriman (batas harian, per percakapan, rem darurat). */
  sendingLimits: Pick<SendingLimitsService, 'assertCanSend'>;
  /** Batas unggahan/unduhan media yang berjalan bersamaan (bawaan 4 per proses, 2 per pengguna). */
  mediaConcurrency?: { global: number; perUser: number };
  store: MediaStore;
  meta: MetaGraphClient;
  secretBox: SecretBox | null;
  queue: OutboundMessageEnqueuer;
  publisher: InboxEventPublisher;
  logger: Logger;
  /** Fase 6: klien Bot API Telegram (unduh media masuk). Bawaan: api.telegram.org. */
  telegram?: TelegramBotClient;
  /** Fase 6: `fetch` untuk lampiran CDN Meta (Messenger/Instagram) — titik ganti tes. */
  fetchCdn?: typeof fetch;
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
const HEAD_BYTES = 64 * 1024;
/** Pengganti `sha256` setelah metadata media dikosongkan (kolom wajib 64 karakter). */
const PURGED_SHA256 = '0'.repeat(64);

const unsupportedMedia = () =>
  new AppError('UNSUPPORTED_MEDIA_TYPE', {
    message:
      'Jenis berkas tidak didukung WhatsApp. Kirim gambar JPG/PNG, video MP4/3GP, audio (OGG, MP3, AAC, M4A, AMR), atau dokumen (PDF, Word, Excel, PowerPoint tanpa makro, TXT).',
  });
const busy = (what: string) =>
  new AppError('RATE_LIMITED', {
    message: `Terlalu banyak ${what} yang sedang berjalan. Tunggu sebentar lalu coba lagi.`,
    retryAfterSeconds: 5,
  });

interface Flight {
  promise: Promise<string>;
  controller: AbortController;
  waiters: number;
}

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

/** Pengirim lewat API publik (API key, Fase 3): bukan pengguna; batas harian per key. */
export interface ApiKeySender {
  organizationId: string;
  apiKeyId: string;
  dailySendLimit: number;
  /**
   * Scope key (audit akhir A1): kirim ke percakapan `resolved` yang berarti MEMULAI percakapan
   * (template, atau channel tanpa jendela 24 jam) butuh `messages:initiate`. Tidak diisi = tidak punya.
   */
  scopes?: readonly string[];
}

/**
 * Izin "mulai percakapan" untuk pengiriman dari sesi pengguna (audit akhir A1/A6): dihitung rute dari
 * peran (`inbox.initiate`) + jatah harian `mulai-percakapan`. Tidak diisi = tidak punya izin.
 */
export interface InitiationGrant {
  allowed: boolean;
  /** Potong jatah harian mulai-percakapan (dipanggil setelah semua pemeriksaan lolos). */
  consume?: () => Promise<void>;
}

type InitiationPolicy =
  { kind: 'preauthorized' } | ({ kind: 'check'; actor: 'user' | 'apiKey' } & InitiationGrant);

/**
 * Pesan ini MEMULAI percakapan lagi (bukan balasan)? Percakapan `resolved` + template (WhatsApp), atau
 * percakapan `resolved` di channel tanpa jendela 24 jam (Email/Telegram — teks bebas kapan saja).
 * Membalas percakapan `resolved` di channel berjendela selama jendela terbuka tetap = balasan
 * (DECISIONS 2026-11-16).
 */
export function isConversationInitiation(
  status: string,
  channelType: Parameters<typeof channelHasCustomerWindow>[0],
  messageType: string,
): boolean {
  if (status !== 'resolved') return false;
  return messageType === 'template' || !channelHasCustomerWindow(channelType);
}

const INITIATION_DENIED = {
  user: 'Percakapan ini sudah selesai. Mengirim pesan baru ke percakapan yang sudah selesai butuh izin memulai percakapan.',
  apiKey:
    'Percakapan ini sudah selesai. Mengirim template atau pesan baru ke percakapan yang sudah selesai butuh scope messages:initiate.',
} as const;

/** Pengirim internal: agen (sesi web) atau API key. `grant` = organisasi + cakupan. */
interface Sender {
  grant: PermissionGrant;
  userId: string | null;
  apiKey: { id: string; dailySendLimit: number } | null;
}

const userSender = (grant: PermissionGrant): Sender => ({
  grant,
  userId: grant.userId,
  apiKey: null,
});

/** API key melihat SEMUA percakapan organisasinya (scope API diperiksa di lapisan auth). */
function apiKeySender(key: ApiKeySender): Sender {
  return {
    grant: {
      permission: 'inbox.reply',
      scope: 'all',
      userId: key.apiKeyId,
      organizationId: key.organizationId,
    },
    userId: null,
    apiKey: { id: key.apiKeyId, dailySendLimit: key.dailySendLimit },
  };
}

type UploadInput = {
  stream: AsyncIterable<unknown> & { resume?: () => unknown };
  filename: string | null;
  /** `true` bila parser multipart memotong berkas (melewati batas global). */
  truncated?: () => boolean;
};

export interface OutboundService {
  /** Fase 6: HTML email tersanitasi milik pesan dalam cakupan (`inbox.view`). 404 bila tidak ada. */
  emailHtml(grant: PermissionGrant, messageId: string): Promise<{ html: string }>;
  /** Kirim lewat API publik (`messages:send`). Jendela 24 jam, rem & batas kirim tetap berlaku. */
  sendAsApiKey(
    key: ApiKeySender,
    conversationId: string,
    input: SendMessageRequest,
    client: ClientInfo,
  ): Promise<{ message: MessageRowView; created: boolean }>;
  /** Unggah media lewat API publik (`messages:send`). */
  uploadAsApiKey(
    key: ApiKeySender,
    conversationId: string,
    file: UploadInput,
  ): Promise<UploadedMedia>;
  send(
    grant: PermissionGrant,
    conversationId: string,
    input: SendMessageRequest,
    client: ClientInfo,
    /** Audit akhir A1/A6: `inbox.initiate` + jatah harian. Tidak diisi = tanpa izin mulai-percakapan. */
    initiation?: InitiationGrant,
  ): Promise<{ message: MessageRowView; created: boolean }>;
  retry(grant: PermissionGrant, messageId: string, client: ClientInfo): Promise<MessageRowView>;
  upload(
    grant: PermissionGrant,
    conversationId: string,
    file: {
      stream: AsyncIterable<unknown> & { resume?: () => unknown };
      filename: string | null;
      /** `true` bila parser multipart memotong berkas (melewati batas global). */
      truncated?: () => boolean;
    },
  ): Promise<UploadedMedia>;
  /** Media pesan (unduh dari Meta bila belum ada salinan lokal). */
  media(
    grant: PermissionGrant,
    messageId: string,
    /** Dibatalkan saat klien memutus (unduhan dihentikan bila semua peminta sudah pergi). */
    signal?: AbortSignal,
  ): Promise<{ file: MediaFileRow; stream: NodeJS.ReadableStream; sizeBytes: number }>;
  /**
   * Mulai percakapan ke nomor (bisa kontak baru) dengan template (Fase 4): agen `inbox.initiate` →
   * percakapan baru `served` dipegang agen itu; API key `messages:initiate` → pakai percakapan terbuka /
   * terakhir kontak itu, atau buat percakapan `resolved` (pesan sistem — tidak menambah antrian; balasan
   * pelanggan membuka sesi baru). Semua aturan kirim template berlaku.
   */
  startWithTemplate(
    sender: { kind: 'user'; grant: PermissionGrant } | { kind: 'apiKey'; key: ApiKeySender },
    input: {
      channelId: string;
      /** E.164. */
      phone: string;
      clientMessageId: string;
      templateId: string;
      parameters: TemplateSendParameters;
    },
    client: ClientInfo,
    ensureContact: (organizationId: string, phone: string) => Promise<string>,
    /**
     * Dipanggil SETELAH pemeriksaan (idempotensi, template, rem darurat, batas harian) dan SEBELUM
     * kontak/percakapan dibuat — mis. jatah `mulai-percakapan` per pengguna (review template Info 5).
     */
    beforeCreate?: () => Promise<void>,
  ): Promise<{ message: MessageRowView; created: boolean; conversationId: string }>;
  /** Hapus salinan lokal yang kedaluwarsa (pembersih berkala). */
  purgeExpiredMedia(limit?: number): Promise<number>;
  /** Hapus berkas media TERTENTU sekarang juga (hapus kontak, UU PDP). */
  purgeMediaFiles(mediaFileIds: readonly string[]): Promise<number>;
}

export function createOutboundService(deps: OutboundServiceDeps): OutboundService {
  const { db, store, meta, secretBox, queue, publisher, logger, sendingLimits } = deps;
  const telegram = deps.telegram ?? createTelegramBotClient();
  const fetchCdn = deps.fetchCdn ?? fetch;
  // Batas pekerjaan media BERJALAN (review ruang chat S1): per proses + per pengguna.
  const uploadGate = createConcurrencyGate(deps.mediaConcurrency ?? { global: 4, perUser: 2 });
  const downloadGate = createConcurrencyGate(deps.mediaConcurrency ?? { global: 4, perUser: 2 });
  const downloads = new Map<string, Flight>();
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
    if (
      !channel ||
      !channel.enabled ||
      channel.deletedAt !== null ||
      (channel.type === 'whatsapp' && !channel.waPhoneNumberId)
    ) {
      throw new AppError('CONFLICT', {
        message:
          channel?.type === 'whatsapp' || !channel
            ? 'Nomor WhatsApp pengirim sedang dinonaktifkan atau sudah dihapus. Aktifkan lagi di Pengaturan → Channel.'
            : 'Channel pengirim sedang dinonaktifkan atau sudah dihapus. Aktifkan lagi di Pengaturan → Channel.',
      });
    }
    return channel;
  }

  /** Jendela 24 jam (hanya channel yang memakainya) — selain template. */
  function assertWindowOpen(
    channel: Channel,
    conversation: { windowExpiresAt: Date | null },
    type: string,
    at: Date,
  ) {
    if (!channelHasCustomerWindow(channel.type) || type === 'template') return;
    if (!conversation.windowExpiresAt || conversation.windowExpiresAt.getTime() <= at.getTime()) {
      throw new AppError('WINDOW_CLOSED');
    }
  }

  /** Fase 6: jenis pesan ini tidak berlaku di channel ini (mis. reaksi di Email). */
  function unsupportedForChannel(channel: Channel): AppError {
    const label = {
      whatsapp: 'WhatsApp',
      telegram: 'Telegram',
      email: 'Email',
      messenger: 'Messenger',
      instagram: 'Instagram',
    }[channel.type];
    return new AppError('VALIDATION_ERROR', {
      message: `Jenis pesan ini tidak didukung di channel ${label}.`,
    });
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
        message: 'Pesan itu belum terkirim, jadi belum bisa dibalas atau diberi reaksi.',
      });
    }
    return { id: row.id, wamid: row.wamid };
  }

  async function byIdempotencyKey(sender: Sender, key: string) {
    const [row] = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, sender.grant.organizationId),
          sender.apiKey
            ? eq(messages.apiKeyId, sender.apiKey.id)
            : eq(messages.senderUserId, sender.userId ?? ''),
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
    return {
      ...row,
      occurredAtExact: exact?.at ?? row.occurredAt.toISOString(),
      senderName: await senderNameOf(db, row),
    };
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

  async function cachedMedia(
    organizationId: string,
    fileId: string | null,
  ): Promise<{ file: MediaFileRow; stream: NodeJS.ReadableStream; sizeBytes: number } | null> {
    if (!fileId) return null;
    const [file] = await db
      .select()
      .from(mediaFiles)
      .where(and(eq(mediaFiles.organizationId, organizationId), eq(mediaFiles.id, fileId)))
      .limit(1);
    if (!file?.storageKey || file.deletedAt !== null) return null;
    const opened = await store.open(file.storageKey);
    return opened ? { file, ...opened } : null;
  }

  async function officeContainerAcceptable(
    stored: StoredFile,
    detected: DetectedMedia | null,
    filename: string | null,
  ): Promise<boolean> {
    const container = officeContainerOf(detected);
    if (container === null) return true;
    if (container === 'cfb') {
      let carry = Buffer.alloc(0);
      for await (const chunk of store.chunks(stored.storageKey)) {
        const window = Buffer.concat([carry, chunk]);
        if (containsMacroMarker(window)) return false;
        carry = window.subarray(Math.max(0, window.length - MACRO_MARKER_MAX_BYTES));
      }
      return true;
    }
    const tailStart = Math.max(0, stored.sizeBytes - ZIP_TAIL_BYTES);
    const tail = await store.readRange(stored.storageKey, tailStart, stored.sizeBytes - tailStart);
    const location = findZipCentralDirectory(tail, tailStart);
    if (!location) return false;
    const directory = await store.readRange(stored.storageKey, location.offset, location.size);
    const names = zipEntryNames(directory, location.entries);
    return names !== null && officeZipAllowed(names, filename);
  }

  /** Unduh media masuk ke disk (dialirkan), simpan baris cache; mengembalikan ID baris. */
  async function downloadInbound(
    organizationId: string,
    message: MessageRow,
    signal: AbortSignal,
  ): Promise<string> {
    const media = message.media;
    if (!media) throw notFound(MEDIA_UNAVAILABLE);
    const [channel] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.organizationId, organizationId), eq(channels.id, message.channelId)))
      .limit(1);
    // Channel nonaktif (mungkin karena insiden) / terhapus: tidak ada unduhan BARU memakai
    // tokennya; salinan yang sudah di-cache tetap bisa dibaca (review ruang chat Info 6).
    if (!channel || channel.deletedAt !== null || !channel.enabled)
      throw notFound(MEDIA_UNAVAILABLE);
    // Fase 6: Email = lampiran sudah disimpan saat diambil (tidak bisa diunduh ulang).
    if (channel.type === 'email') throw notFound(MEDIA_UNAVAILABLE);
    const credentials = channel.type === 'whatsapp' ? credentialsOf(channel) : null;
    const writer = await store.writer('inbound', MAX_INBOUND_MEDIA_BYTES);
    let stored: StoredFile | null = null;
    try {
      const combined = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
      let head = Buffer.alloc(0);
      const sink = async (chunk: Uint8Array) => {
        if (head.length < HEAD_BYTES) head = Buffer.concat([head, chunk]);
        await writer.write(chunk);
      };
      if (channel.type === 'telegram') {
        await downloadTelegram(channel, media.metaMediaId, sink, combined);
      } else if (channel.type === 'messenger' || channel.type === 'instagram') {
        await downloadMetaCdn(media.metaMediaId, sink, combined);
      } else
        try {
          if (!credentials) throw notFound(MEDIA_UNAVAILABLE);
          const info = await readWhatsAppMediaUrl(meta, credentials, media.metaMediaId, {
            signal: combined,
          });
          if (info.fileSize !== null && info.fileSize > MAX_INBOUND_MEDIA_BYTES) {
            throw notFound('Media terlalu besar untuk diunduh lewat aplikasi ini.');
          }
          await meta.download(credentials, {
            operation: 'media.download',
            url: info.url,
            maxBytes: MAX_INBOUND_MEDIA_BYTES,
            signal: combined,
            sink,
          });
        } catch (error) {
          if (isMetaApiError(error)) {
            if (error.kind === 'not_found') throw notFound(MEDIA_UNAVAILABLE);
            throw metaFailure(error);
          }
          throw error;
        }
      stored = await writer.finish();
      const filename = cleanFileName(media.filename);
      let detected = detectMedia(head, filename, { verifyContainer: false });
      if (detected && !(await officeContainerAcceptable(stored, detected, filename))) {
        // Dokumen Office berisi makro/program: tetap bisa diunduh, tetapi sebagai biner.
        detected = null;
      }
      const kind: MessageMediaKind = detected?.kind ?? media.kind;
      const days = await mediaRetentionDays(organizationId);
      const fileId = await db.transaction(async (tx) => {
        // Proses api lain bisa saja sudah selesai lebih dulu: pakai salinannya.
        const [current] = await tx
          .select({ mediaFileId: messages.mediaFileId })
          .from(messages)
          .where(and(eq(messages.organizationId, organizationId), eq(messages.id, message.id)))
          .for('update');
        if (current?.mediaFileId) return current.mediaFileId;
        const [file] = await tx
          .insert(mediaFiles)
          .values({
            organizationId,
            channelId: channel.id,
            source: 'inbound',
            kind,
            mimeType: detected?.mimeType ?? 'application/octet-stream',
            sizeBytes: stored?.sizeBytes ?? 0,
            sha256: stored?.sha256 ?? PURGED_SHA256,
            filename,
            storageKey: stored?.storageKey ?? null,
            metaMediaRef: media.metaMediaId.length <= 256 ? media.metaMediaId : null,
            expiresAt: new Date(now().getTime() + days * DAY_MS),
          })
          .returning({ id: mediaFiles.id });
        if (!file) throw new Error('INSERT media tidak mengembalikan baris');
        await tx
          .update(messages)
          .set({ mediaFileId: file.id })
          .where(and(eq(messages.organizationId, organizationId), eq(messages.id, message.id)));
        return file.id;
      });
      logger.info({ messageId: message.id, bytes: stored.sizeBytes }, 'Media masuk diunduh');
      // Berkas kita tidak dipakai (didahului proses lain) → dihapus.
      const [mine] = await db
        .select({ id: mediaFiles.id })
        .from(mediaFiles)
        .where(and(eq(mediaFiles.id, fileId), eq(mediaFiles.storageKey, stored.storageKey)));
      if (mine) stored = null;
      return fileId;
    } finally {
      await writer.abort().catch(() => undefined);
      if (stored) await store.remove(stored.storageKey).catch(() => undefined);
    }
  }

  /** Fase 6 — unduh `file_id` Telegram (host tetap api.telegram.org, maks. 20 MB). */
  async function downloadTelegram(
    channel: Channel,
    fileId: string,
    sink: (chunk: Uint8Array) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    if (!secretBox || !channel.tgBotTokenEncrypted) throw notFound(MEDIA_UNAVAILABLE);
    let token;
    try {
      token = openChannelConnectionSecret(
        secretBox,
        channel,
        'telegramBotToken',
        channel.tgBotTokenEncrypted,
      );
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE', {
        message: 'Kredensial channel tidak bisa dibuka di server. Hubungi admin.',
      });
    }
    try {
      await telegram.downloadFile(token, {
        fileId,
        maxBytes: TELEGRAM_MAX_DOWNLOAD_BYTES,
        sink,
        signal,
      });
    } catch (error) {
      if (error instanceof MediaTooLargeError) throw error;
      if (!isTelegramApiError(error)) throw error;
      if (error.kind === 'too_large') {
        throw notFound('Media terlalu besar untuk diunduh lewat Bot API Telegram (maks. 20 MB).');
      }
      if (error.kind === 'bad_request') throw notFound(MEDIA_UNAVAILABLE);
      throw new AppError('CHANNEL_REQUEST_FAILED', {
        message: 'Media belum bisa diambil dari Telegram. Coba lagi beberapa saat lagi.',
      });
    }
  }

  /**
   * Fase 6 — unduh lampiran Messenger/Instagram dari CDN Meta: HANYA host allowlist, tanpa token,
   * tanpa redirect, ukuran dibatasi (SSRF).
   */
  async function downloadMetaCdn(
    url: string,
    sink: (chunk: Uint8Array) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    if (!isMetaSocialCdnUrl(url)) throw notFound(MEDIA_UNAVAILABLE);
    let response: Response;
    try {
      response = await fetchCdn(url, { redirect: 'error', signal });
    } catch {
      throw new AppError('CHANNEL_REQUEST_FAILED', {
        message: 'Media belum bisa diambil dari Meta. Coba lagi beberapa saat lagi.',
      });
    }
    if (!response.ok || !response.body) throw notFound(MEDIA_UNAVAILABLE);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await sink(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
  }

  async function sendAs(
    sender: Sender,
    conversationId: string,
    input: SendMessageRequest,
    client: ClientInfo,
    initiation: InitiationPolicy,
  ): Promise<{ message: MessageRowView; created: boolean }> {
    const { grant } = sender;
    const existing = await byIdempotencyKey(sender, input.clientMessageId);
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
    const channel = await liveChannel(grant.organizationId, conversation.channel.id);
    // Fase 6: jenis pesan harus berlaku di channel ini (template hanya WhatsApp, dst.).
    if (!channelSupportsOutbound(channel.type, input.type)) throw unsupportedForChannel(channel);
    if (
      (channel.type === 'messenger' || channel.type === 'instagram') &&
      input.type === 'text' &&
      input.text.length > 2000
    ) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Pesan Messenger/Instagram maksimal 2.000 karakter.',
      });
    }
    if (channel.type === 'telegram' && input.type === 'interactive') {
      // Tombol inline Telegram: `callback_data` maks. 64 byte.
      const ids =
        input.interactive.kind === 'button'
          ? input.interactive.buttons.map((button) => button.id)
          : input.interactive.sections.flatMap((section) => section.rows.map((row) => row.id));
      if (ids.some((id) => Buffer.byteLength(id) > 64)) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'ID tombol untuk Telegram maksimal 64 byte.',
        });
      }
    }
    // Di luar jendela 24 jam hanya template Meta yang disetujui yang boleh (Fase 4). Telegram & Email
    // tidak punya jendela (Fase 6).
    assertWindowOpen(channel, conversation, input.type, at);
    // Audit akhir A1/A6: kirim ke percakapan `resolved` yang berarti memulai percakapan lagi = izin
    // mulai-percakapan (`inbox.initiate` / scope `messages:initiate`), bukan sekadar `inbox.reply`.
    const initiates =
      initiation.kind === 'check' &&
      isConversationInitiation(conversation.status, channel.type, input.type);
    if (initiates && !initiation.allowed) {
      throw new AppError('FORBIDDEN', { message: INITIATION_DENIED[initiation.actor] });
    }
    // Rem pengiriman: rem darurat, batas harian pengguna/organisasi, batas per percakapan.
    await sendingLimits.assertCanSend({
      organizationId: grant.organizationId,
      userId: sender.userId,
      ...(sender.apiKey ? { apiKey: sender.apiKey } : {}),
      conversationId: conversation.id,
      client,
    });

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
      // Lewat API key = integrasi/bot (`bot`), pelakunya key itu — bukan pengguna.
      senderKind: sender.apiKey ? 'bot' : 'agent',
      senderUserId: sender.userId,
      apiKeyId: sender.apiKey?.id ?? null,
      type: 'text',
      status: 'pending',
      statusUpdatedAt: at,
      idempotencyKey: input.clientMessageId,
      sendAttempts: 1,
      occurredAt: at,
    };

    if (
      'replyToMessageId' in input &&
      input.replyToMessageId &&
      CHANNEL_CAPABILITIES[channel.type].quoteReply
    ) {
      const quoted = await target(grant, contactId, channelId, input.replyToMessageId);
      values.replyToMessageId = quoted.id;
      values.replyToWamid = quoted.wamid;
    }

    switch (input.type) {
      case 'text':
        values.type = 'text';
        values.text = input.text;
        break;
      case 'template': {
        const resolved = await resolveTemplateSend(db, {
          organizationId: grant.organizationId,
          channelWabaId: channel.waBusinessAccountId ?? '',
          templateId: input.templateId,
          parameters: input.parameters,
        });
        if (resolved.headerMediaFileId) {
          // Berkas judul = unggahan pengirim yang SAMA di channel yang sama (aturan unggah media).
          const [file] = await db
            .select()
            .from(mediaFiles)
            .where(
              and(
                eq(mediaFiles.organizationId, grant.organizationId),
                eq(mediaFiles.id, resolved.headerMediaFileId),
                eq(mediaFiles.source, 'upload'),
                sender.apiKey
                  ? eq(mediaFiles.uploadedByApiKeyId, sender.apiKey.id)
                  : eq(mediaFiles.uploadedByUserId, sender.userId ?? ''),
                eq(mediaFiles.channelId, channelId),
                isNull(mediaFiles.deletedAt),
              ),
            )
            .limit(1);
          if (!file || !file.metaMediaRef || file.expiresAt.getTime() <= at.getTime()) {
            throw notFound(MEDIA_NOT_FOUND);
          }
          if (file.kind.toUpperCase() !== resolved.headerFormat) {
            throw new AppError('VALIDATION_ERROR', {
              message: `Berkas judul harus ${resolved.headerFormat === 'IMAGE' ? 'gambar' : resolved.headerFormat === 'VIDEO' ? 'video' : 'dokumen'} sesuai template.`,
            });
          }
          values.mediaFileId = file.id;
        }
        const { preview, ...template } = resolved;
        values.type = 'template';
        values.text = preview;
        values.extras = { template };
        values.templateId = template.templateId;
        values.templateCategory = template.category;
        break;
      }
      case 'interactive':
        // Tombol/daftar (sudah divalidasi batas Meta oleh skema). Isi utama = teks pratinjau.
        values.type = 'interactive';
        values.text = input.interactive.body;
        values.extras = { interactiveMessage: input.interactive };
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
              sender.apiKey
                ? eq(mediaFiles.uploadedByApiKeyId, sender.apiKey.id)
                : eq(mediaFiles.uploadedByUserId, sender.userId ?? ''),
              eq(mediaFiles.channelId, channelId),
              isNull(mediaFiles.deletedAt),
            ),
          )
          .limit(1);
        if (
          !file ||
          (channel.type === 'whatsapp' ? !file.metaMediaRef : !file.storageKey) ||
          file.expiresAt.getTime() <= at.getTime()
        ) {
          throw notFound(MEDIA_NOT_FOUND);
        }
        if (file.sizeBytes > CHANNEL_CAPABILITIES[channel.type].maxOutboundMediaBytes) {
          throw new AppError('PAYLOAD_TOO_LARGE', {
            message: `Berkas terlalu besar untuk channel ini (maks. ${String(Math.floor(CHANNEL_CAPABILITIES[channel.type].maxOutboundMediaBytes / (1024 * 1024)))} MB).`,
          });
        }
        values.type = file.kind;
        values.text = input.caption?.trim() ? input.caption : null;
        values.mediaFileId = file.id;
        values.media = {
          kind: file.kind,
          metaMediaId: file.metaMediaRef ?? `local:${file.id}`,
          mimeType: file.mimeType,
          sha256: null,
          filename: file.filename,
          voice: false,
          animated: false,
        };
        break;
      }
    }

    // Jatah harian mulai-percakapan dipotong hanya untuk pesan BARU yang lolos semua pemeriksaan.
    if (initiates) await initiation.consume?.();

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
            // Bot membalas → tidak ada lagi pesan pelanggan yang menunggu bot (batas waktu bot).
            ...(sender.apiKey ? { botAwaitingSince: null } : {}),
            // Laporan "waktu respons pertama": pesan keluar pertama agen (reaksi tidak dihitung).
            ...(values.type === 'reaction' || sender.apiKey
              ? {}
              : { firstResponseAt: sql`coalesce(${conversations.firstResponseAt}, ${at})` }),
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
      if (
        !isPgError(error, PG_ERROR_CODES.uniqueViolation, 'messages_idempotency_unique') &&
        !isPgError(error, PG_ERROR_CODES.uniqueViolation, 'messages_api_key_idempotency_unique')
      ) {
        throw error;
      }
      const raced = await byIdempotencyKey(sender, input.clientMessageId);
      if (!raced) throw error;
      return { message: await view(raced), created: false };
    }

    row = await enqueue(row, 1);
    await publishFor(row, true);
    logger.info({ messageId: row.id, type: row.type }, 'Pesan keluar diantrekan');
    return { message: await view(row), created: true };
  }

  async function uploadAs(
    sender: Sender,
    conversationId: string,
    file: UploadInput,
  ): Promise<UploadedMedia> {
    const { grant } = sender;
    const conversation = await scopedConversation(grant, conversationId);
    const channel = await liveChannel(grant.organizationId, conversation.channel.id);
    if (!channelSupportsOutbound(channel.type, 'media')) throw unsupportedForChannel(channel);
    // Fase 6: hanya WhatsApp yang mengunggah ke Meta saat ini; channel lain mengirim berkas lokal.
    const credentials = channel.type === 'whatsapp' ? credentialsOf(channel) : null;
    const release = uploadGate.tryAcquire(sender.userId ?? `key:${sender.apiKey?.id ?? ''}`);
    if (!release) throw busy('unggahan');
    const filename = cleanFileName(file.filename);
    const writer = await store.writer('uploads', MAX_UPLOAD_BYTES);
    let stored: StoredFile | null = null;
    try {
      // Kepala berkas (64 KiB) → jenis; batas ukuran dipersempit ke batas jenis itu (gambar 5 MB…),
      // jadi penulisan berhenti sesegera mungkin (review ruang chat S1).
      let head: Buffer = Buffer.alloc(0);
      let verdict: ReturnType<typeof checkOutboundMedia> | null = null;
      let detected: DetectedMedia | null = null;
      const decide = () => {
        detected = detectMedia(head, filename, { verifyContainer: false });
        verdict = checkOutboundMedia(detected, 0);
        if (!verdict.ok) throw unsupportedMedia();
        writer.maxBytes = Math.min(
          OUTBOUND_MEDIA_LIMITS[verdict.kind].maxBytes,
          CHANNEL_CAPABILITIES[channel.type].maxOutboundMediaBytes,
        );
      };
      try {
        for await (const chunk of file.stream) {
          const bytes = chunk as Buffer;
          if (verdict === null) {
            head = Buffer.concat([head, bytes]);
            if (head.length >= HEAD_BYTES) decide();
          }
          await writer.write(bytes);
        }
        if (verdict === null) decide();
      } catch (error) {
        if (error instanceof MediaTooLargeError) {
          throw new AppError('PAYLOAD_TOO_LARGE', {
            message: `Berkas terlalu besar untuk jenis ini (maks. ${String(Math.floor(writer.maxBytes / (1024 * 1024)))} MB).`,
          });
        }
        throw error;
      }
      if (file.truncated?.()) {
        throw new AppError('PAYLOAD_TOO_LARGE', {
          message: `Berkas terlalu besar (maks. ${String(MAX_UPLOAD_BYTES / (1024 * 1024))} MB).`,
        });
      }
      if (writer.sizeBytes === 0)
        throw new AppError('VALIDATION_ERROR', { message: 'Berkas kosong.' });
      stored = await writer.finish();
      const chosen = verdict as unknown as {
        ok: true;
        kind: OutboundMediaKind;
        mimeType: string;
      };
      // Isi wadah Office (review ruang chat R1) diperiksa dari berkas di disk, tanpa memuat utuh.
      if (!(await officeContainerAcceptable(stored, detected, filename))) throw unsupportedMedia();

      let metaId: string | null = null;
      if (credentials)
        try {
          ({ id: metaId } = await uploadWhatsAppMedia(
            meta,
            credentials,
            channel.waPhoneNumberId ?? '',
            {
              blob: await store.blob(stored.storageKey, chosen.mimeType),
              mimeType: chosen.mimeType,
              filename: filename ?? `berkas-${stored.storageKey.slice(-12)}`,
            },
            { signal: AbortSignal.timeout(120_000) },
          ));
        } catch (error) {
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
          kind: chosen.kind,
          mimeType: chosen.mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          filename,
          storageKey: stored.storageKey,
          metaMediaRef: metaId,
          uploadedByUserId: sender.userId,
          uploadedByApiKeyId: sender.apiKey?.id ?? null,
          expiresAt: new Date(now().getTime() + days * DAY_MS),
        })
        .returning();
      if (!row) throw new Error('INSERT media tidak mengembalikan baris');
      logger.info({ mediaId: row.id, kind: row.kind, bytes: row.sizeBytes }, 'Media diunggah');
      stored = null;
      return {
        id: row.id,
        kind: row.kind,
        mimeType: row.mimeType,
        filename: row.filename,
        sizeBytes: row.sizeBytes,
      };
    } finally {
      await writer.abort().catch(() => undefined);
      if (stored) await store.remove(stored.storageKey).catch(() => undefined);
      // Sisa aliran unggahan dibuang supaya koneksi tidak menggantung.
      file.stream.resume?.();
      release();
    }
  }

  return {
    send: (grant, conversationId, input, client, initiation) =>
      sendAs(userSender(grant), conversationId, input, client, {
        kind: 'check',
        actor: 'user',
        allowed: initiation?.allowed ?? false,
        ...(initiation?.consume ? { consume: initiation.consume } : {}),
      }),
    sendAsApiKey: (key, conversationId, input, client) =>
      sendAs(apiKeySender(key), conversationId, input, client, {
        kind: 'check',
        actor: 'apiKey',
        allowed: apiKeyHasScope(key.scopes ?? [], 'messages:initiate'),
      }),

    async startWithTemplate(who, input, client, ensureContact, beforeCreate) {
      const sender = who.kind === 'user' ? userSender(who.grant) : apiKeySender(who.key);
      const organizationId = sender.grant.organizationId;
      const existing = await byIdempotencyKey(sender, input.clientMessageId);
      if (existing) {
        return {
          message: await view(existing),
          created: false,
          conversationId: existing.conversationId,
        };
      }
      const channel = await liveChannel(organizationId, input.channelId);
      if (channel.type !== 'whatsapp') {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Template hanya untuk channel WhatsApp.',
        });
      }
      // Review template R1: template & nilai variabel sah, rem darurat, batas harian (pengguna/key/
      // organisasi) diperiksa SEBELUM kontak/percakapan dibuat — key yang tertahan tidak bisa
      // menimbun kontak & percakapan sampah.
      await resolveTemplateSend(db, {
        organizationId,
        channelWabaId: channel.waBusinessAccountId ?? '',
        templateId: input.templateId,
        parameters: input.parameters,
      });
      await sendingLimits.assertCanSend({
        organizationId,
        userId: sender.userId,
        ...(sender.apiKey ? { apiKey: sender.apiKey } : {}),
        conversationId: null,
        client,
      });
      await beforeCreate?.();
      const contactId = await ensureContact(organizationId, input.phone);
      const at = now();
      const findConversationFor = async (includeResolved: boolean) => {
        const [row] = await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.organizationId, organizationId),
              eq(conversations.contactId, contactId),
              eq(conversations.channelId, channel.id),
              includeResolved ? undefined : sql`${conversations.status} <> 'resolved'`,
            ),
          )
          .orderBy(sql`${conversations.createdAt} desc`)
          .limit(1);
        return row?.id;
      };
      let conversationId =
        (await findConversationFor(false)) ??
        (sender.apiKey ? await findConversationFor(true) : undefined);
      if (!conversationId) {
        try {
          conversationId = await db.transaction(async (tx) => {
            const [created] = await tx
              .insert(conversations)
              .values({
                organizationId,
                contactId,
                channelId: channel.id,
                ...(sender.apiKey
                  ? { status: 'resolved' as const, resolvedAt: at }
                  : {
                      status: 'served' as const,
                      assigneeUserId: sender.userId,
                      firstAssignedAt: at,
                    }),
                lastMessageAt: at,
              })
              .returning({ id: conversations.id });
            if (!created) throw new Error('INSERT percakapan tidak mengembalikan baris');
            await recordOutgoingEvent(tx, {
              organizationId,
              type: 'conversation.created',
              conversationId: created.id,
              contactId,
              actorUserId: sender.userId,
            });
            return created.id;
          });
        } catch (error) {
          // Pesan masuk bersamaan baru saja membuka percakapan → pakai yang itu.
          if (
            !isPgError(
              error,
              PG_ERROR_CODES.uniqueViolation,
              'conversations_open_contact_channel_unique',
            )
          ) {
            throw error;
          }
          conversationId = await findConversationFor(false);
          if (!conversationId) throw error;
        }
      }
      const result = await sendAs(
        sender,
        conversationId,
        {
          type: 'template',
          clientMessageId: input.clientMessageId,
          templateId: input.templateId,
          parameters: input.parameters,
        },
        client,
        // Rute "mulai percakapan" sudah mewajibkan `inbox.initiate` / `messages:initiate` + jatahnya.
        { kind: 'preauthorized' },
      );
      return { ...result, conversationId };
    },
    upload: (grant, conversationId, file) => uploadAs(userSender(grant), conversationId, file),
    uploadAsApiKey: (key, conversationId, file) =>
      uploadAs(apiKeySender(key), conversationId, file),

    async retry(grant, messageId, client) {
      const message = await scopedMessage(grant, messageId);
      if (message.type === 'template' && message.extras.template?.sensitive) {
        throw new AppError('CONFLICT', {
          message:
            'Kode verifikasi tidak disimpan, jadi pesan ini tidak bisa dikirim ulang. Kirim kode baru.',
        });
      }
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
      const channel = await liveChannel(grant.organizationId, message.channelId);
      assertWindowOpen(channel, conversation, message.type, now());
      await sendingLimits.assertCanSend({
        organizationId: grant.organizationId,
        userId: grant.userId,
        conversationId: message.conversationId,
        client,
      });
      const [updated] = await db
        .update(messages)
        .set({
          status: 'pending',
          failureReason: null,
          errorCode: null,
          wamid: null,
          sendClaimedAt: null,
          // Penulis asli (`senderUserId`, pemilik kunci idempotensi) TETAP; yang menekan "Kirim
          // ulang" dicatat terpisah dan diperiksa ulang worker saat kirim (review ruang chat R2).
          lastSentByUserId: grant.userId,
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

    async emailHtml(grant, messageId) {
      const message = await scopedMessage(grant, messageId);
      const [body] = await db
        .select({ html: messageEmailBodies.html })
        .from(messageEmailBodies)
        .where(
          and(
            eq(messageEmailBodies.organizationId, grant.organizationId),
            eq(messageEmailBodies.messageId, message.id),
          ),
        )
        .limit(1);
      if (!body) throw notFound('Versi HTML email ini tidak tersedia.');
      return { html: body.html };
    },

    async media(grant, messageId, signal) {
      const message = await scopedMessage(grant, messageId);
      const cached = await cachedMedia(grant.organizationId, message.mediaFileId);
      if (cached) return cached;
      // Salinan unggahan pesan keluar tidak bisa diunduh ulang dari Meta.
      if (message.direction !== 'inbound' || !message.media?.metaMediaId) {
        throw notFound(MEDIA_UNAVAILABLE);
      }
      // Single-flight per pesan (review ruang chat S1): permintaan bersamaan menunggu SATU unduhan.
      const key = `${grant.organizationId}:${message.id}`;
      let flight = downloads.get(key);
      if (!flight) {
        const release = downloadGate.tryAcquire(grant.userId);
        if (!release) throw busy('unduhan');
        const controller = new AbortController();
        const created: Flight = {
          controller,
          waiters: 0,
          promise: downloadInbound(grant.organizationId, message, controller.signal).finally(() => {
            downloads.delete(key);
            release();
          }),
        };
        downloads.set(key, created);
        flight = created;
      }
      const joined = flight;
      joined.waiters += 1;
      const onAbort = () => {
        joined.waiters -= 1;
        // Semua peminta sudah memutus → unduhan dibatalkan.
        if (joined.waiters <= 0) joined.controller.abort();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const fileId = await joined.promise;
        const result = await cachedMedia(grant.organizationId, fileId);
        if (!result) throw notFound(MEDIA_UNAVAILABLE);
        return result;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (!signal?.aborted) joined.waiters -= 1;
      }
    },

    async purgeExpiredMedia(limit = 500) {
      const due = await db
        .select({ id: mediaFiles.id, storageKey: mediaFiles.storageKey })
        .from(mediaFiles)
        .where(and(isNull(mediaFiles.deletedAt), sql`${mediaFiles.expiresAt} <= ${now()}`))
        .limit(limit);
      return purgeFiles(due);
    },

    async purgeMediaFiles(mediaFileIds) {
      if (mediaFileIds.length === 0) return 0;
      const due = await db
        .select({ id: mediaFiles.id, storageKey: mediaFiles.storageKey })
        .from(mediaFiles)
        .where(and(isNull(mediaFiles.deletedAt), inArray(mediaFiles.id, [...mediaFileIds])));
      return purgeFiles(due);
    },
  };

  async function purgeFiles(due: readonly { id: string; storageKey: string | null }[]) {
    let removed = 0;
    for (const file of due) {
      try {
        if (file.storageKey) await store.remove(file.storageKey);
        // Metadata yang bisa memuat data pribadi ikut dikosongkan (review ruang chat R4): nama
        // berkas ("KTP_Budi.jpg"), sidik isi, dan ID media Meta.
        await db
          .update(mediaFiles)
          .set({
            storageKey: null,
            deletedAt: now(),
            filename: null,
            sha256: PURGED_SHA256,
            metaMediaRef: null,
          })
          .where(eq(mediaFiles.id, file.id));
        removed += 1;
      } catch (err) {
        logger.warn({ err, mediaId: file.id }, 'Salinan media kedaluwarsa gagal dihapus');
      }
    }
    return removed;
  }
}
