import { z } from 'zod';

import { CHANNEL_TYPES } from './channels';
import { isoDateTimeSchema } from './fields';

/**
 * Inbox: kontak, percakapan, dan pesan (Fase 2 butir 4 — docs/KONTRAK-API-INBOX.md).
 *
 * Dipakai DB (enum), worker (pesan masuk → kontak/percakapan/pesan), api (endpoint baca), dan web.
 * Respons TIDAK PERNAH memuat payload mentah Meta, ID media Meta, maupun BSUID pelanggan.
 */

// ── Status percakapan (tab inbox) ───────────────────────────────────────────

/**
 * Status sesi percakapan = tab inbox (PRD §3.3): Bot · Belum dilayani · Dilayani · Selesai.
 * "Semua" = tanpa saringan status.
 *  - `bot`      — sedang ditangani bot eksternal (Fase 3; saklar bot belum ada).
 *  - `unserved` — menunggu agen (antrian terbuka). Bawaan percakapan baru selama bot belum ada.
 *  - `served`   — sedang ditangani agen manusia.
 *  - `resolved` — selesai. Pesan masuk berikutnya membuka PERCAKAPAN BARU (DECISIONS 2026-11-16).
 */
export const CONVERSATION_STATUSES = ['bot', 'unserved', 'served', 'resolved'] as const;
export const conversationStatusSchema = z.enum(CONVERSATION_STATUSES);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const CONVERSATION_STATUS_LABELS: Readonly<Record<ConversationStatus, string>> = {
  bot: 'Bot',
  unserved: 'Belum dilayani',
  served: 'Dilayani',
  resolved: 'Selesai',
};

/** Jendela layanan pelanggan WhatsApp: 24 jam sejak pesan masuk terakhir (jam server). */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Pesan ───────────────────────────────────────────────────────────────────

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export const messageDirectionSchema = z.enum(MESSAGE_DIRECTIONS);
export type MessageDirection = z.infer<typeof messageDirectionSchema>;

/** Penanda pengirim (PRD §3.3 "pesan dari bot vs manusia vs broadcast"). */
export const MESSAGE_SENDER_KINDS = ['customer', 'agent', 'bot', 'broadcast', 'system'] as const;
export const messageSenderKindSchema = z.enum(MESSAGE_SENDER_KINDS);
export type MessageSenderKind = z.infer<typeof messageSenderKindSchema>;

/**
 * Jenis pesan Balesin. Jenis Meta lain dipetakan: `button` → `interactive`; `order`, `unknown`,
 * `unsupported` → `unsupported` (jenis aslinya di `rawType`); `system` (mis. pelanggan ganti nomor)
 * → `system`.
 */
export const MESSAGE_TYPES = [
  'text',
  'image',
  'document',
  'audio',
  'video',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'reaction',
  'system',
  'unsupported',
] as const;
export const messageTypeSchema = z.enum(MESSAGE_TYPES);
export type MessageType = z.infer<typeof messageTypeSchema>;

/**
 * Status pesan KELUAR. `pending` = belum diterima Meta. Urutan hanya maju (`isStatusAdvance` di
 * `@balesin/core`): sent < delivered < read < played; `failed` hanya dari sent/delivered.
 * Pesan masuk tidak punya status (`null`).
 */
export const MESSAGE_DELIVERY_STATUSES = [
  'pending',
  'sent',
  'delivered',
  'read',
  'played',
  'failed',
] as const;
export const messageDeliveryStatusSchema = z.enum(MESSAGE_DELIVERY_STATUSES);
export type MessageDeliveryStatus = z.infer<typeof messageDeliveryStatusSchema>;

export const MESSAGE_MEDIA_KINDS = ['image', 'audio', 'video', 'document', 'sticker'] as const;
export type MessageMediaKind = (typeof MESSAGE_MEDIA_KINDS)[number];

// ── Retensi payload webhook (S4) ────────────────────────────────────────────

/**
 * Payload `webhook_events` yang sudah selesai diproses dikosongkan setelah N hari (pengaturan
 * organisasi, disimpan di DB — PENGATURAN-UI). Kunci dedup tetap disimpan.
 */
export const WEBHOOK_PAYLOAD_RETENTION_DAYS = { default: 8, min: 1, max: 90 } as const;

// ── Parameter & kursor ──────────────────────────────────────────────────────

export const conversationIdParamsSchema = z.object({ conversationId: z.string() });
export const contactIdParamsSchema = z.object({ contactId: z.string() });

export const INBOX_PAGE_DEFAULT = 30;
export const INBOX_PAGE_MAX = 100;

const INVALID_CURSOR = 'Kursor halaman tidak valid. Muat ulang daftar dari awal.';

export const inboxCursorSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, INVALID_CURSOR);

const pageLimitSchema = z.coerce
  .number({ error: 'Jumlah per halaman harus angka.' })
  .int('Jumlah per halaman harus bilangan bulat.')
  .min(1, 'Paling sedikit 1 per halaman.')
  .max(INBOX_PAGE_MAX, `Paling banyak ${INBOX_PAGE_MAX} per halaman.`);

/**
 * Status sesi jendela 24 jam untuk filter inbox (PRD §3.3 "Broadcast · Terbuka · Hampir habis ·
 * Kedaluwarsa"), dihitung saat query terhadap jam server:
 *  - `open`     — jendela masih terbuka lebih dari `WINDOW_EXPIRING_SOON_MS`;
 *  - `expiring` — sisa jendela ≤ `WINDOW_EXPIRING_SOON_MS` (hampir habis);
 *  - `expired`  — jendela sudah lewat (hanya template yang bisa dikirim);
 *  - `none`     — belum pernah ada pesan masuk (mis. percakapan dari broadcast/template).
 */
export const CONVERSATION_WINDOW_FILTERS = ['open', 'expiring', 'expired', 'none'] as const;
export const conversationWindowFilterSchema = z.enum(CONVERSATION_WINDOW_FILTERS);
export type ConversationWindowFilter = z.infer<typeof conversationWindowFilterSchema>;

export const CONVERSATION_WINDOW_FILTER_LABELS: Readonly<Record<ConversationWindowFilter, string>> =
  {
    open: 'Terbuka',
    expiring: 'Hampir habis',
    expired: 'Kedaluwarsa',
    none: 'Broadcast',
  };

/** Ambang "hampir habis": sisa jendela 24 jam ≤ 2 jam (DECISIONS 2026-11-16). */
export const WINDOW_EXPIRING_SOON_MS = 2 * 60 * 60 * 1000;

/**
 * Saringan bersama daftar & hitungan per tab: channel, agen, status jendela, belum dibaca, cari.
 * `assignee` = UUID agen, `me` (diri sendiri), atau `unassigned` (belum di-assign).
 * TITIK KAIT tag: `tagId` ditambahkan di sini saat tabel tag dibangun (butir panel detail).
 */
const conversationFilterFields = {
  channelId: z.uuid({ error: 'Channel tidak valid.' }).optional(),
  assignee: z
    .union([z.uuid(), z.literal('me'), z.literal('unassigned')], {
      error: 'Agen tidak valid.',
    })
    .optional(),
  window: conversationWindowFilterSchema.optional(),
  /** `true` = hanya yang punya pesan belum dibaca. */
  unread: z
    .enum(['true', 'false'], { error: 'Nilai belum dibaca harus true atau false.' })
    .transform((value) => value === 'true')
    .optional(),
  /**
   * Nama kontak (diedit tim / profil WhatsApp / username) atau potongan nomor; 2–100 karakter.
   * Dibatasi laju per pengguna dan waktu query (review kontak R3).
   */
  q: z
    .string()
    .trim()
    .min(2, 'Kata pencarian minimal 2 karakter.')
    .max(100, 'Kata pencarian terlalu panjang (maks. 100 karakter).')
    .optional(),
};

/** `GET /conversations` — tab (status) + saringan + kursor. */
export const conversationListQuerySchema = z.object({
  status: conversationStatusSchema.optional(),
  ...conversationFilterFields,
  cursor: inboxCursorSchema.optional(),
  limit: pageLimitSchema.optional(),
});
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

/** `GET /conversations/counts` — saringan yang sama tanpa tab/kursor. */
export const conversationCountsQuerySchema = z.object(conversationFilterFields);
export type ConversationCountsQuery = z.infer<typeof conversationCountsQuerySchema>;
export type ConversationFilter = ConversationCountsQuery;

/** Jumlah percakapan per tab (sesuai cakupan pemanggil + saringan). */
export const conversationCountsResponseSchema = z.object({
  counts: z.object({
    all: z.number().int().nonnegative(),
    bot: z.number().int().nonnegative(),
    unserved: z.number().int().nonnegative(),
    served: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
  }),
  /** Percakapan TERBUKA (≠ selesai) yang punya pesan belum dibaca — untuk badge menu. */
  unreadOpen: z.number().int().nonnegative(),
});
export type ConversationCountsResponse = z.infer<typeof conversationCountsResponseSchema>;

/** `GET /conversations/:id/messages` — terbaru dulu; `cursor` = halaman pesan yang lebih lama. */
export const messageListQuerySchema = z.object({
  cursor: inboxCursorSchema.optional(),
  limit: pageLimitSchema.optional(),
});
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;

// ── Bentuk respons ──────────────────────────────────────────────────────────

/** Kontak singkat (di daftar & detail percakapan). */
export const contactSummarySchema = z.object({
  id: z.uuid(),
  /** Nomor publik berurutan (dipakai mode kompatibel MobiChat & URL). */
  number: z.number().int().positive(),
  /** Nama tampilan: nama dari tim → nama profil WhatsApp → nomor → username. */
  displayName: z.string(),
  /** Nomor E.164 (`+62…`), `null` bila pelanggan memakai username tanpa nomor. */
  phone: z.string().nullable(),
});
export type ContactSummary = z.infer<typeof contactSummarySchema>;

/** `GET /contacts/:id`. */
export const contactSchema = contactSummarySchema.extend({
  channelType: z.enum(CHANNEL_TYPES),
  /** Nama yang diedit tim (format bebas, mis. `ID+NAMA@AREA`). */
  name: z.string().nullable(),
  /** Nama profil WhatsApp (dari pelanggan, tidak tepercaya; karakter tak terlihat dibuang). */
  profileName: z.string().nullable(),
  waUsername: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Contact = z.infer<typeof contactSchema>;
export const contactResponseSchema = z.object({ contact: contactSchema });
export type ContactResponse = z.infer<typeof contactResponseSchema>;

export const messagePreviewSchema = z.object({
  direction: messageDirectionSchema,
  type: messageTypeSchema,
  /** Potongan teks (maks. 200 karakter) atau `null` (mis. gambar tanpa keterangan). */
  text: z.string().nullable(),
  status: messageDeliveryStatusSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type MessagePreview = z.infer<typeof messagePreviewSchema>;

export const conversationSchema = z.object({
  id: z.uuid(),
  number: z.number().int().positive(),
  status: conversationStatusSchema,
  channel: z.object({ id: z.uuid(), name: z.string(), type: z.enum(CHANNEL_TYPES) }),
  contact: contactSummarySchema,
  assignee: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  unreadCount: z.number().int().nonnegative(),
  lastMessageAt: isoDateTimeSchema,
  /** Pesan masuk terakhir menurut jam server (bukan cap waktu Meta). */
  lastInboundAt: isoDateTimeSchema.nullable(),
  /** Akhir jendela 24 jam; `null` = belum pernah ada pesan masuk. */
  windowExpiresAt: isoDateTimeSchema.nullable(),
  /** Jendela 24 jam masih terbuka saat respons dibuat (di luarnya hanya template). */
  windowOpen: z.boolean(),
  lastMessage: messagePreviewSchema.nullable(),
  createdAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationSchema),
  /** `null` = tidak ada halaman berikutnya. */
  nextCursor: z.string().nullable(),
});
export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>;

export const conversationResponseSchema = z.object({ conversation: conversationSchema });
export type ConversationResponse = z.infer<typeof conversationResponseSchema>;

export const messageSchema = z.object({
  id: z.uuid(),
  number: z.number().int().positive(),
  direction: messageDirectionSchema,
  senderKind: messageSenderKindSchema,
  type: messageTypeSchema,
  /** Jenis asli dari Meta (mis. `order`, `button`) — untuk pesan "belum didukung". */
  rawType: z.string().nullable(),
  /** Isi teks / keterangan media / judul tombol yang dipilih. Input pelanggan: tampilkan ter-escape. */
  text: z.string().nullable(),
  /** Metadata media (tanpa ID media Meta). Unduh media menyusul (butir ruang chat). */
  media: z
    .object({
      kind: z.enum(MESSAGE_MEDIA_KINDS),
      mimeType: z.string().nullable(),
      filename: z.string().nullable(),
      voice: z.boolean(),
      animated: z.boolean(),
    })
    .nullable(),
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      name: z.string().nullable(),
      address: z.string().nullable(),
    })
    .nullable(),
  /** Balasan tombol/daftar/flow dari pelanggan. */
  interactive: z
    .object({
      kind: z.enum(['button', 'button_reply', 'list_reply', 'nfm_reply', 'other']),
      id: z.string().nullable(),
      title: z.string().nullable(),
      description: z.string().nullable(),
    })
    .nullable(),
  /** Reaksi: emoji (`null` = reaksi dihapus) + pesan sasarannya bila ditemukan. */
  reaction: z.object({ emoji: z.string().nullable(), messageId: z.uuid().nullable() }).nullable(),
  /** Balas-kutip: pesan yang dikutip bila ditemukan di Balesin. */
  replyTo: z.object({ messageId: z.uuid().nullable() }).nullable(),
  /** Asal iklan Click-to-WhatsApp. `sourceUrl` TIDAK TEPERCAYA — tampilkan sebagai teks. */
  referral: z
    .object({
      sourceType: z.string().nullable(),
      sourceUrl: z.string().nullable(),
      headline: z.string().nullable(),
      body: z.string().nullable(),
    })
    .nullable(),
  forwarded: z.boolean(),
  sharedContactsCount: z.number().int().nonnegative(),
  status: messageDeliveryStatusSchema.nullable(),
  /** Kode error Meta (pesan gagal / jenis belum didukung). */
  errorCode: z.number().int().nullable(),
  createdAt: isoDateTimeSchema,
});
export type Message = z.infer<typeof messageSchema>;

export const messageListResponseSchema = z.object({
  /** Terbaru dulu. */
  messages: z.array(messageSchema),
  /** Kursor halaman berikutnya (pesan yang lebih lama); `null` = sudah paling awal. */
  nextCursor: z.string().nullable(),
});
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;

// ── Real-time (WebSocket `GET /inbox/stream`) ───────────────────────────────

/** Selang ping server (detik); klien yang tidak menjawab pong dua kali berturut-turut diputus. */
export const INBOX_STREAM_HEARTBEAT_SECONDS = 30;

/**
 * Kode penutupan WebSocket dari server (4000–4999 = milik aplikasi):
 *  - 4401 sesi berakhir/dicabut/akun dinonaktifkan → web mengarahkan ke halaman masuk;
 *  - 4403 izin/peran berubah sehingga tidak boleh melihat inbox lagi;
 *  - 4408 tidak menjawab heartbeat;
 *  - 4429 terlalu banyak koneksi untuk pengguna ini.
 */
export const INBOX_STREAM_CLOSE_CODES = {
  sessionEnded: 4401,
  forbidden: 4403,
  heartbeatTimeout: 4408,
  tooManyConnections: 4429,
} as const;

/**
 * Event yang dikirim server. Isinya MINIMAL — ID + kolom status, TANPA isi pesan, nama, atau nomor
 * pelanggan. Klien mengambil data lengkap lewat REST (yang menegakkan cakupan lagi).
 */
export const inboxStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    heartbeatSeconds: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('conversation.updated'),
    conversationId: z.uuid(),
    status: conversationStatusSchema,
    assigneeUserId: z.uuid().nullable(),
    unreadCount: z.number().int().nonnegative(),
    lastMessageAt: isoDateTimeSchema,
    windowExpiresAt: isoDateTimeSchema.nullable(),
  }),
  z.object({
    type: z.literal('message.created'),
    conversationId: z.uuid(),
    messageId: z.uuid(),
    direction: messageDirectionSchema,
    createdAt: isoDateTimeSchema,
  }),
  z.object({
    type: z.literal('message.status'),
    conversationId: z.uuid(),
    messageId: z.uuid(),
    status: messageDeliveryStatusSchema,
  }),
]);
export type InboxStreamEvent = z.infer<typeof inboxStreamEventSchema>;
