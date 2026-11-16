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

/** `GET /conversations` — tab (status), channel, pencarian nama/nomor, kursor. */
export const conversationListQuerySchema = z.object({
  status: conversationStatusSchema.optional(),
  channelId: z.uuid({ error: 'Channel tidak valid.' }).optional(),
  /** Nama kontak (diedit tim / profil WhatsApp / username) atau potongan nomor. */
  q: z
    .string()
    .trim()
    .min(1, 'Kata pencarian kosong.')
    .max(100, 'Kata pencarian terlalu panjang (maks. 100 karakter).')
    .optional(),
  cursor: inboxCursorSchema.optional(),
  limit: pageLimitSchema.optional(),
});
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

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
