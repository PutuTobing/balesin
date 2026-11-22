import { z } from 'zod';

import { CHANNEL_TYPES } from './channels';
import { hasControlCharacters, isoDateTimeSchema } from './fields';
import { identityConfirmationSchema } from './identity';
import { interactiveMessageSchema } from './interactive';
import { tagColorSchema, tagRefSchema } from './tags';

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

/**
 * Jenis kejadian penanganan percakapan (tabel `conversation_events`, tab "Log" panel detail):
 *  - `claimed`    — agen mengambil dari antrian terbuka (atau mengambil alih dari bot);
 *  - `assigned`   — agen ditugaskan/dialihkan oleh orang lain (atau diri sendiri mengambil alih);
 *  - `unassigned` — dikembalikan ke antrian terbuka;
 *  - `resolved`   — ditandai selesai;
 *  - `reopened`   — dibuka lagi;
 *  - `note_added` / `note_updated` / `note_deleted` — catatan sesi (butir 8; TANPA isi catatan);
 *  - `handoff`     — bot menyerahkan ke manusia (bot minta, agen mematikan bot, atau bot tidak
 *                    membalas sampai batas waktu) → antrian "Belum dilayani";
 *  - `bot_resumed` — percakapan dikembalikan ke bot.
 *  - `department_changed` — percakapan dipindah ke departemen lain / dilepas dari departemen
 *                    (Fase 5; `department` = departemen BARU saat kejadian, `null` = tanpa).
 */
export const CONVERSATION_EVENT_KINDS = [
  'claimed',
  'assigned',
  'unassigned',
  'resolved',
  'reopened',
  'note_added',
  'note_updated',
  'note_deleted',
  'handoff',
  'bot_resumed',
  'department_changed',
] as const;
/** Jenis yang disimpan di `conversation_events` (enum database). */
export type ConversationRecordKind = (typeof CONVERSATION_EVENT_KINDS)[number];

/**
 * Jenis kejadian KONTAK (tabel `contact_events`, butir 8) — ikut tampil di tab "Log" setiap
 * percakapan kontak itu. Tanpa nilai data pelanggan: hanya nama tag / nama isian yang berubah.
 *  - `tag_added` / `tag_removed` — tag dipasang/dilepas;
 *  - `contact_updated` — isian kontak diubah (`fields`: `name`, `email`, `notes`, `attributes`).
 *  - `whatsapp_identity_attached` — identitas WhatsApp (BSUID) pelanggan dilekatkan ke kontak yang
 *    sebelumnya hanya punya nomor (review kontak R4: tim diberi tanda);
 *  - `possible_duplicate` — kontak baru dibuat untuk pengirim yang nomornya pernah tercatat di kontak
 *    lama tanpa identitas WhatsApp (kontak lama tidak dilekatkan otomatis; gabung manual).
 *  - `merged` — kontak lain digabung ke kontak ini (Fase 5; riwayatnya pindah ke sini);
 *  - `imported` — kontak dibuat/diperbarui lewat impor massal (Fase 5; `fields` = isian berubah).
 */
export const CONTACT_EVENT_KINDS = [
  'tag_added',
  'tag_removed',
  'contact_updated',
  'whatsapp_identity_attached',
  'possible_duplicate',
  'merged',
  'imported',
] as const;
export type ContactEventKind = (typeof CONTACT_EVENT_KINDS)[number];

/** Semua jenis baris tab "Log" (kejadian percakapan + kejadian kontaknya). */
export const conversationEventKindSchema = z.enum([
  ...CONVERSATION_EVENT_KINDS,
  ...CONTACT_EVENT_KINDS,
]);
export type ConversationEventKind = z.infer<typeof conversationEventKindSchema>;

export const CONVERSATION_EVENT_LABELS: Readonly<Record<ConversationEventKind, string>> = {
  claimed: 'Mengambil percakapan',
  assigned: 'Menugaskan percakapan',
  unassigned: 'Mengembalikan ke antrian',
  resolved: 'Menandai selesai',
  reopened: 'Membuka lagi',
  note_added: 'Menambah catatan',
  note_updated: 'Mengubah catatan',
  note_deleted: 'Menghapus catatan',
  handoff: 'Menyerahkan dari bot ke tim',
  bot_resumed: 'Mengembalikan ke bot',
  department_changed: 'Memindahkan ke departemen',
  tag_added: 'Memasang tag',
  tag_removed: 'Melepas tag',
  contact_updated: 'Mengubah data kontak',
  whatsapp_identity_attached: 'Identitas WhatsApp dilekatkan ke kontak ini',
  possible_duplicate: 'Mungkin duplikat kontak lain (nomor pernah tercatat)',
  merged: 'Kontak lain digabung ke kontak ini',
  imported: 'Diperbarui lewat impor kontak',
};

/** Isian kontak yang bisa diubah tim (dicatat di `contact_events.fields`, tanpa nilainya). */
export const CONTACT_EDITABLE_FIELDS = ['name', 'email', 'notes', 'attributes'] as const;
export type ContactEditableField = (typeof CONTACT_EDITABLE_FIELDS)[number];

export const CONTACT_FIELD_LABELS: Readonly<Record<ContactEditableField, string>> = {
  name: 'Nama',
  email: 'Email',
  notes: 'Catatan kontak',
  attributes: 'Atribut',
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
/** Review Fase 6 R1 — verifikasi pengirim email (SPF/DKIM/DMARC dari server penerima tepercaya). */
export const EMAIL_SENDER_VERIFICATIONS = ['pass', 'fail', 'unverified'] as const;
export const emailSenderVerificationSchema = z.enum(EMAIL_SENDER_VERIFICATIONS);
export type EmailSenderVerificationValue = z.infer<typeof emailSenderVerificationSchema>;
export const EMAIL_SENDER_VERIFICATION_LABELS: Readonly<
  Record<EmailSenderVerificationValue, string>
> = {
  pass: 'Pengirim terverifikasi server email',
  fail: 'Verifikasi pengirim gagal — alamat pengirim bisa palsu. Jangan proses permintaan sensitif tanpa konfirmasi lain.',
  unverified: 'Pengirim tidak diverifikasi server email',
};

/**
 * SATU-SATUNYA penafsiran hasil verifikasi pengirim yang TERSIMPAN (`messages.extras.email`, jsonb =
 * tidak tepercaya) — dipakai inbox, webhook ke bot, dan "kembalikan ke bot" (review bot P4-I2):
 * - tidak ada / `null` (data lama sebelum review Fase 6 R1) → `fail` bila dulu diperingatkan
 *   (`authWarning`), selain itu `unverified` (tidak pernah dianggap lolos);
 * - `pass` / `unverified` / `fail` → apa adanya;
 * - nilai lain apa pun → `fail` (gagal ke arah aman).
 */
export function storedEmailSenderVerification(email: {
  senderVerification?: unknown;
  authWarning?: unknown;
}): EmailSenderVerificationValue {
  const value = email.senderVerification;
  if (value === undefined || value === null) {
    return email.authWarning === true ? 'fail' : 'unverified';
  }
  return value === 'pass' || value === 'unverified' ? value : 'fail';
}

/**
 * Pesan email dengan hasil verifikasi ini boleh dilayani/diteruskan ke bot? `pass` selalu, `fail`
 * tidak pernah, `unverified` hanya bila channel tidak mewajibkan pengirim terverifikasi.
 */
export function emailSenderTrustedForBot(
  verification: EmailSenderVerificationValue,
  requireVerifiedSender: boolean,
): boolean {
  if (verification === 'pass') return true;
  if (verification === 'fail') return false;
  return !requireVerifiedSender;
}

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
  /** Template Meta yang dikirim Balesin (Fase 4). */
  'template',
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
 * Saringan bersama daftar & hitungan per tab: channel, agen, tag kontak, status jendela, belum
 * dibaca, cari. `assignee` = UUID agen, `me` (diri sendiri), atau `unassigned` (belum di-assign).
 */
const conversationFilterFields = {
  channelId: z.uuid({ error: 'Channel tidak valid.' }).optional(),
  /** Hanya percakapan yang KONTAKNYA memakai tag ini (butir 8). */
  tagId: z.uuid({ error: 'Tag tidak valid.' }).optional(),
  /** Departemen (Fase 5): UUID departemen atau `none` (belum masuk departemen mana pun). */
  departmentId: z
    .union([z.uuid(), z.literal('none')], { error: 'Departemen tidak valid.' })
    .optional(),
  assignee: z
    .union([z.uuid(), z.literal('me'), z.literal('unassigned')], {
      error: 'Agen tidak valid.',
    })
    .optional(),
  window: conversationWindowFilterSchema.optional(),
  /**
   * Tahap 9.0 — "Alamat tujuan": hanya percakapan yang pernah menerima email masuk ke alamat/alias
   * channel ini (pilihan dari `ChannelSummary.emailAddresses`).
   */
  emailRecipient: z
    .string()
    .trim()
    .toLowerCase()
    .max(254, 'Alamat tujuan tidak valid.')
    .pipe(z.email({ error: 'Alamat tujuan tidak valid.' }))
    .optional(),
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

/**
 * Saringan pesan panel detail (butir 8):
 *  - `starred` — pesan ditandai;
 *  - `media`   — gambar, video, stiker (tab "Media");
 *  - `files`   — dokumen & audio (tab "File").
 */
export const MESSAGE_LIST_FILTERS = ['starred', 'media', 'files'] as const;
export type MessageListFilter = (typeof MESSAGE_LIST_FILTERS)[number];

/** `GET /conversations/:id/messages` — terbaru dulu; `cursor` = halaman pesan yang lebih lama. */
export const messageListQuerySchema = z.object({
  cursor: inboxCursorSchema.optional(),
  limit: pageLimitSchema.optional(),
  only: z.enum(MESSAGE_LIST_FILTERS, { error: 'Saringan pesan tidak dikenal.' }).optional(),
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
  /**
   * Asal `displayName`: `team` (diedit tim), `whatsapp` (nama profil kiriman pelanggan — tidak
   * tepercaya, tampilkan penanda "dari WhatsApp" + nomor/username di sampingnya), `channel` (nama
   * profil dari channel lain — Telegram/Email/Messenger/Instagram, sama tidak tepercayanya; tampilkan
   * `channelHandle` di sampingnya), `none` (nomor, @username, alamat email, atau "Kontak #n").
   */
  nameSource: z.enum(['team', 'whatsapp', 'channel', 'none']),
  /** Nomor E.164 (`+62…`), `null` bila pelanggan memakai username tanpa nomor. */
  phone: z.string().nullable(),
  /** Username WhatsApp (tanpa `@`), bila ada. */
  waUsername: z.string().nullable(),
  /**
   * Fase 6: pengenal kontak di channel selain WhatsApp untuk ditampilkan — `@username` Telegram /
   * Instagram atau alamat email; `null` bila tidak ada (Messenger, WhatsApp). Server selalu
   * mengisi; opsional hanya untuk data tiruan lama.
   */
  channelHandle: z.string().nullable().optional(),
  /**
   * Tag kontak (urut nama). Server SELALU mengisinya; opsional di skema hanya supaya data tiruan
   * lama tetap sah — dijadikan wajib setelah web menyesuaikan.
   */
  tags: z.array(tagRefSchema).optional(),
});
export type ContactSummary = z.infer<typeof contactSummarySchema>;

/** Batas atribut kustom kontak (butir 8). */
export const CONTACT_ATTRIBUTES_MAX = 30;
export const CONTACT_ATTRIBUTE_KEY_MAX = 40;
export const CONTACT_ATTRIBUTE_VALUE_MAX = 500;
export const CONTACT_NOTES_MAX = 2_000;
export const CONTACT_NAME_MAX = 256;

/** Kunci atribut: diawali huruf/angka; huruf, angka, spasi, `_`, `-`, `.`; 1–40 karakter. */
export const contactAttributeKeySchema = z
  .string()
  .trim()
  .min(1, 'Nama atribut wajib diisi.')
  .max(
    CONTACT_ATTRIBUTE_KEY_MAX,
    `Nama atribut maksimal ${String(CONTACT_ATTRIBUTE_KEY_MAX)} karakter.`,
  )
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u,
    'Nama atribut hanya boleh huruf, angka, spasi, titik, tanda hubung, dan garis bawah.',
  );

export const contactAttributeValueSchema = z
  .string()
  .trim()
  .min(1, 'Nilai atribut wajib diisi (hapus atributnya bila kosong).')
  .max(
    CONTACT_ATTRIBUTE_VALUE_MAX,
    `Nilai atribut maksimal ${String(CONTACT_ATTRIBUTE_VALUE_MAX)} karakter.`,
  )
  .refine((value) => !hasControlCharacters(value), 'Nilai atribut memuat karakter khusus.');

/** Atribut kustom: peta kunci → teks. Disimpan & dikirim sebagai daftar berurutan. */
export const contactAttributesSchema = z
  .array(z.object({ key: contactAttributeKeySchema, value: contactAttributeValueSchema }))
  .max(CONTACT_ATTRIBUTES_MAX, `Maksimal ${String(CONTACT_ATTRIBUTES_MAX)} atribut per kontak.`)
  .refine(
    (items) =>
      new Set(items.map((item) => item.key.toLocaleLowerCase('id-ID'))).size === items.length,
    'Nama atribut tidak boleh kembar.',
  );
export type ContactAttributes = z.infer<typeof contactAttributesSchema>;

/** `GET /contacts/:id`. */
export const contactSchema = contactSummarySchema.extend({
  channelType: z.enum(CHANNEL_TYPES),
  /** Nama yang diedit tim (format bebas, mis. `ID+NAMA@AREA`). */
  name: z.string().nullable(),
  /** Nama profil WhatsApp (dari pelanggan, tidak tepercaya; karakter tak terlihat dibuang). */
  profileName: z.string().nullable(),
  /**
   * Isian butir 8 (selalu diisi server; opsional di skema hanya untuk data tiruan lama).
   * `email` diisi tim; `notes` = catatan KONTAK (berbeda dari catatan sesi per percakapan).
   */
  email: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  attributes: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  /**
   * Fase 5: kontak ini mungkin duplikat kontak lain (nomor pernah tercatat di kontak itu, review R4)
   * — tawarkan "Gabung". Selalu diisi server; opsional hanya untuk data tiruan lama.
   */
  possibleDuplicateOfContactId: z.uuid().nullable().optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Contact = z.infer<typeof contactSchema>;
export const contactResponseSchema = z.object({ contact: contactSchema });
export type ContactResponse = z.infer<typeof contactResponseSchema>;

/**
 * `PATCH /contacts/:contactId` (`contacts.manage`). Hanya isian yang dikirim yang diubah; `null`
 * mengosongkan (`name: null` → kembali ke nama profil WhatsApp). `attributes` MENGGANTI seluruh
 * daftar atribut.
 */
export const updateContactRequestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Nama tidak boleh kosong (kirim null untuk memakai nama WhatsApp).')
      .max(CONTACT_NAME_MAX, `Nama maksimal ${String(CONTACT_NAME_MAX)} karakter.`)
      .refine((value) => !hasControlCharacters(value), 'Nama memuat karakter khusus.')
      .nullable()
      .optional(),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254, 'Alamat email maksimal 254 karakter.')
      .pipe(z.email({ error: 'Alamat email tidak valid. Contoh: nama@perusahaan.co.id' }))
      .nullable()
      .optional(),
    notes: z
      .string()
      .trim()
      .min(1, 'Catatan kosong — kirim null untuk menghapusnya.')
      .max(
        CONTACT_NOTES_MAX,
        `Catatan maksimal ${CONTACT_NOTES_MAX.toLocaleString('id-ID')} karakter.`,
      )
      .refine(
        (value) => !hasControlCharacters(value.replace(/\r?\n|\t/g, ' ')),
        'Catatan memuat karakter khusus tak terlihat.',
      )
      .nullable()
      .optional(),
    attributes: contactAttributesSchema.optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.email !== undefined ||
      value.notes !== undefined ||
      value.attributes !== undefined,
    { error: 'Tidak ada yang diubah.' },
  );
export type UpdateContactRequest = z.infer<typeof updateContactRequestSchema>;

/**
 * `DELETE /contacts/:contactId` — hapus kontak beserta data pribadinya (UU PDP; `contacts.delete` =
 * Owner/Admin). WAJIB konfirmasi identitas. Percakapan terbuka ikut terhapus.
 */
export const deleteContactRequestSchema = z.object({
  confirmation: identityConfirmationSchema.optional(),
});
export type DeleteContactRequest = z.input<typeof deleteContactRequestSchema>;
export const deleteContactResponseSchema = z.object({
  deleted: z.object({
    messages: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    /** Kejadian webhook yang isinya dikosongkan. */
    webhookEvents: z.number().int().nonnegative(),
    /** Berkas media yang dihapus dari disk. */
    mediaFiles: z.number().int().nonnegative(),
  }),
});
export type DeleteContactResponse = z.infer<typeof deleteContactResponseSchema>;

/** Batas pesan dalam ekspor satu kontak (lebih dari ini → `truncated`; ekspor penuh Fase 4). */
export const CONTACT_EXPORT_MESSAGES_MAX = 10_000;

/**
 * `GET /contacts/:contactId/export` (`contacts.export`) — data pribadi SATU kontak untuk permintaan
 * akses data (UU PDP), JSON. Tanpa ID internal Meta (BSUID, ID media), tanpa catatan sesi internal
 * tim, tanpa berkas media (hanya nama/jenisnya).
 */
export const contactExportSchema = z.object({
  exportedAt: isoDateTimeSchema,
  contact: z.object({
    id: z.uuid(),
    number: z.number().int(),
    channelType: z.string(),
    phone: z.string().nullable(),
    waUsername: z.string().nullable(),
    name: z.string().nullable(),
    profileName: z.string().nullable(),
    email: z.string().nullable(),
    notes: z.string().nullable(),
    attributes: z.array(z.object({ key: z.string(), value: z.string() })),
    tags: z.array(z.string()),
    createdAt: isoDateTimeSchema,
  }),
  conversations: z.array(
    z.object({
      id: z.uuid(),
      number: z.number().int(),
      channel: z.string(),
      status: conversationStatusSchema,
      createdAt: isoDateTimeSchema,
      resolvedAt: isoDateTimeSchema.nullable(),
    }),
  ),
  messages: z.array(
    z.object({
      id: z.uuid(),
      conversationId: z.uuid(),
      direction: messageDirectionSchema,
      type: messageTypeSchema,
      text: z.string().nullable(),
      media: z
        .object({
          kind: z.string(),
          mimeType: z.string().nullable(),
          filename: z.string().nullable(),
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
      status: messageDeliveryStatusSchema.nullable(),
      createdAt: isoDateTimeSchema,
    }),
  ),
  /** `true` = pesan lebih dari `CONTACT_EXPORT_MESSAGES_MAX` (yang terbaru dipotong). */
  truncated: z.boolean(),
  /**
   * Tahap 9.0 (review R6): `true` = ekspor TIDAK lengkap karena sebagian percakapan ada di channel
   * yang tidak boleh dilihat pengekspor (akses per channel). Ekspor lengkap = Owner/Admin. Opsional di
   * skema demi klien lama; server selalu mengirim.
   */
  partial: z.boolean().optional(),
  /** Alasan bila `partial` (teks Indonesia untuk ditampilkan), selain itu `null`. */
  partialReason: z.string().nullable().optional(),
  /** Jumlah percakapan yang dikecualikan (tanpa isi/ID). */
  excludedConversations: z.number().int().nonnegative().optional(),
});
export type ContactExport = z.infer<typeof contactExportSchema>;
export const CONTACT_EXPORT_PARTIAL_REASON =
  'Sebagian percakapan kontak ini ada di channel yang tidak bisa kamu lihat, jadi tidak ikut diekspor. Untuk permintaan data UU PDP, minta Owner atau Admin di tempatmu mengekspor data lengkapnya.';

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
  /**
   * Pesan biasa boleh dikirim saat respons dibuat. Channel tanpa jendela 24 jam (Telegram, Email)
   * selalu `true`. Di WhatsApp di luar jendela hanya template.
   */
  windowOpen: z.boolean(),
  /**
   * Fase 6: aturan jendela 24 jam berlaku di channel ini (WhatsApp, Messenger, Instagram). `false`
   * = sembunyikan hitung mundur. Server selalu mengisi; opsional hanya untuk data tiruan lama.
   */
  windowApplies: z.boolean().optional(),
  lastMessage: messagePreviewSchema.nullable(),
  createdAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable(),
  /** Laporan: pertama kali ditugaskan ke agen. */
  firstAssignedAt: isoDateTimeSchema.nullable(),
  /** Laporan: pesan keluar pertama oleh agen. */
  firstResponseAt: isoDateTimeSchema.nullable(),
  /**
   * Departemen percakapan (Fase 5), `null` = belum ada. Selalu diisi server; opsional hanya untuk
   * data tiruan lama.
   */
  department: z.object({ id: z.uuid(), name: z.string() }).nullable().optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;

// ── Penanganan percakapan (butir 7) ─────────────────────────────────────────

/**
 * Jawaban aksi penanganan: keadaan terbaru menurut cakupan pemanggil SESUDAH aksi. `null` = aksi
 * berhasil tetapi pemanggil tidak lagi boleh melihat percakapan itu (mis. Teknisi mengembalikan
 * chat-nya ke antrian).
 */
export const conversationActionResponseSchema = z.object({
  conversation: conversationSchema.nullable(),
});
export type ConversationActionResponse = z.infer<typeof conversationActionResponseSchema>;

/** `POST /conversations/:id/assign` — tugaskan/alihkan ke agen (aktif, berizin `inbox.reply`). */
export const assignConversationRequestSchema = z.object({
  userId: z.uuid({ error: 'Agen tidak valid.' }),
});
export type AssignConversationRequest = z.infer<typeof assignConversationRequestSchema>;

const userRefSchema = z.object({ id: z.uuid(), name: z.string() });

export const conversationEventSchema = z.object({
  id: z.uuid(),
  kind: conversationEventKindSchema,
  /** `null` = sistem/bot. */
  actor: userRefSchema.nullable(),
  assignee: userRefSchema.nullable(),
  previousAssignee: userRefSchema.nullable(),
  /**
   * Butir 8 (selalu diisi server; opsional di skema hanya untuk data tiruan lama):
   * `tag` = tag yang dipasang/dilepas (nama saat kejadian); `fields` = isian kontak yang diubah.
   */
  tag: z.object({ name: z.string(), color: tagColorSchema }).nullable().optional(),
  fields: z.array(z.enum(CONTACT_EDITABLE_FIELDS)).nullable().optional(),
  /** `department_changed`: departemen baru (nama saat ini), `null` = dilepas dari departemen. */
  department: z.object({ id: z.uuid(), name: z.string() }).nullable().optional(),
  createdAt: isoDateTimeSchema,
});
export type ConversationEvent = z.infer<typeof conversationEventSchema>;
export const conversationEventListResponseSchema = z.object({
  events: z.array(conversationEventSchema),
});
export type ConversationEventListResponse = z.infer<typeof conversationEventListResponseSchema>;

// ── Catatan sesi (butir 8) ──────────────────────────────────────────────────

/**
 * Catatan sesi: catatan INTERNAL per percakapan (tidak pernah terkirim ke pelanggan). Lihat =
 * `inbox.view`; tulis = `inbox.reply` (cakupan); ubah = penulisnya saja; hapus = penulisnya atau
 * pemegang `inbox.notes.moderate` (Owner/Admin). Isi tidak pernah masuk log/audit/event.
 */
export const CONVERSATION_NOTE_MAX = 2_000;
export const CONVERSATION_NOTES_MAX = 200;

export const conversationNoteBodySchema = z
  .string({ error: 'Isi catatan wajib diisi.' })
  .trim()
  .min(1, 'Isi catatan wajib diisi.')
  .max(
    CONVERSATION_NOTE_MAX,
    `Catatan maksimal ${CONVERSATION_NOTE_MAX.toLocaleString('id-ID')} karakter.`,
  )
  .refine(
    (value) => !hasControlCharacters(value.replace(/\r?\n|\t/g, ' ')),
    'Catatan memuat karakter khusus tak terlihat.',
  );

export const conversationNoteRequestSchema = z.object({ body: conversationNoteBodySchema });
export type ConversationNoteRequest = z.infer<typeof conversationNoteRequestSchema>;

export const conversationNoteSchema = z.object({
  id: z.uuid(),
  body: z.string(),
  author: userRefSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  /** Pernah diubah setelah dibuat. */
  edited: z.boolean(),
  /** Hak PEMANGGIL atas catatan ini (untuk menampilkan tombol). */
  canEdit: z.boolean(),
  canDelete: z.boolean(),
});
export type ConversationNote = z.infer<typeof conversationNoteSchema>;
export const conversationNoteResponseSchema = z.object({ note: conversationNoteSchema });
export type ConversationNoteResponse = z.infer<typeof conversationNoteResponseSchema>;
export const conversationNoteListResponseSchema = z.object({
  /** Terlama dulu (seperti utas). */
  notes: z.array(conversationNoteSchema),
});
export type ConversationNoteListResponse = z.infer<typeof conversationNoteListResponseSchema>;
/** Jawaban hapus panel detail / tag / quick reply. */
export const deletedResponseSchema = z.object({ deleted: z.literal(true) });
export type DeletedResponse = z.infer<typeof deletedResponseSchema>;

export const conversationNoteParamsSchema = z.object({
  conversationId: z.string(),
  noteId: z.string(),
});

/**
 * Agen inbox (`GET /inbox/agents`, izin `inbox.assign` — Teknisi tidak): semua pengguna yang perannya memegang
 * `inbox.reply`, termasuk yang dinonaktifkan (`active: false`) supaya saringan agen percakapan lama
 * tetap bisa menampilkan namanya. Tanpa email. Yang bisa DITUGASKAN hanya `active: true`.
 */
export const inboxAgentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: z.enum(['owner', 'admin', 'supervisor', 'cs', 'teknisi']),
  active: z.boolean(),
  /** Percakapan `served` yang sedang dipegang (beban kerja; kapasitas maks. menyusul). */
  openConversations: z.number().int().nonnegative(),
});
export type InboxAgent = z.infer<typeof inboxAgentSchema>;
export const inboxAgentListResponseSchema = z.object({ agents: z.array(inboxAgentSchema) });
export type InboxAgentListResponse = z.infer<typeof inboxAgentListResponseSchema>;

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
  /**
   * Pesan interaktif KELUAR (tombol/daftar yang dikirim agen/bot). Server selalu mengisi (`null`
   * untuk pesan lain); opsional di skema supaya data tiruan web lama tetap sah.
   */
  interactiveMessage: interactiveMessageSchema.nullable().optional(),
  /**
   * Template yang dikirim (pesan keluar `type: template`): `text` pesan = isi body yang sudah diisi.
   * Server selalu mengisi (`null` untuk pesan lain); opsional di skema untuk data tiruan web lama.
   */
  template: z
    .object({
      templateId: z.uuid().nullable(),
      name: z.string(),
      language: z.string(),
      category: z.string(),
    })
    .nullable()
    .optional(),
  /**
   * Fase 6 — pesan channel Email: subjek + ada/tidaknya versi HTML tersanitasi (ambil lewat
   * `GET /messages/:id/email-html`, tampilkan di iframe sandbox). `authWarning` = server email
   * penerima melaporkan pengirim GAGAL verifikasi SPF/DKIM/DMARC (alamat pengirim bisa palsu).
   * Server selalu mengisi (`null` untuk pesan lain); opsional untuk data tiruan lama.
   */
  email: z
    .object({
      subject: z.string().nullable(),
      hasHtml: z.boolean(),
      /** `true` hanya bila verifikasi pengirim GAGAL (`senderVerification: 'fail'`). */
      authWarning: z.boolean(),
      /**
       * Review Fase 6 R1 — hasil verifikasi pengirim oleh server email penerima TEPERCAYA: `pass`,
       * `fail` (peringatan keras: alamat bisa palsu), `unverified` (tidak ada hasil tepercaya —
       * tampilkan label NETRAL `EMAIL_SENDER_VERIFICATION_LABELS.unverified`). Server selalu mengisi.
       */
      senderVerification: emailSenderVerificationSchema.optional(),
      /** Lampiran yang dilewati (terlalu besar / terlalu banyak / jenis berbahaya). */
      skippedAttachments: z.number().int().nonnegative(),
      /**
       * Tahap 9.0 — header alamat (huruf kecil). Masuk: `To`/`Cc` apa adanya (maks. 50). Keluar:
       * `to` = pelanggan, `cc`/`bcc` = alamat tambahan yang dipilih tim (`bcc` hanya catatan
       * internal — tidak pernah ada di header yang diterima siapa pun). Data lama: `[]`. Server
       * selalu mengisi; opsional hanya untuk data tiruan lama.
       */
      to: z.array(z.string()).optional(),
      cc: z.array(z.string()).optional(),
      bcc: z.array(z.string()).optional(),
      /**
       * Masuk: alamat tujuan = alamat/alias channel yang menerima email ini (`Delivered-To`/
       * `X-Original-To`/`To`/`Cc` yang cocok). `null` = tidak cocok (mis. dikirim lewat Bcc atau
       * alias belum didaftarkan) / data lama / pesan keluar.
       */
      recipient: z.string().nullable().optional(),
      /**
       * Masuk: isi Cc untuk "Balas semua" = `To` + `Cc` email ini TANPA alamat/alias channel sendiri
       * dan tanpa pengirimnya (pengirim sudah jadi penerima utama). Pakai yang dari email MASUK
       * TERAKHIR. Keluar: `[]`.
       */
      replyAll: z.array(z.string()).optional(),
    })
    .nullable()
    .optional(),
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
  /** Pesan keluar yang gagal: alasan + penjelasan + boleh dikirim ulang. */
  failure: z
    .object({
      reason: z.string(),
      code: z.number().int().nullable(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
  /** Agen pengirim (pesan keluar oleh manusia). */
  senderUserId: z.uuid().nullable(),
  /**
   * Nama tampilan agen pengirim (pesan keluar oleh manusia) — supaya semua peran yang melihat
   * percakapan (termasuk Teknisi, yang tidak memuat `/inbox/agents`) melihat nama pengirim. Tanpa
   * email. Server SELALU mengisinya; opsional di skema hanya untuk data tiruan lama.
   */
  senderName: z.string().nullable().optional(),
  /** Media bisa diunduh lewat `GET /messages/:id/media`. */
  mediaAvailable: z.boolean(),
  /**
   * Pesan ditandai (bintang, dipakai bersama tim; butir 8). Server SELALU mengisinya; opsional di
   * skema hanya untuk data tiruan lama.
   */
  starredAt: isoDateTimeSchema.nullable().optional(),
  createdAt: isoDateTimeSchema,
});
export type Message = z.infer<typeof messageSchema>;

export const messageResponseSchema = z.object({ message: messageSchema });
export type MessageResponse = z.infer<typeof messageResponseSchema>;

export const messageListResponseSchema = z.object({
  /** Terbaru dulu. */
  messages: z.array(messageSchema),
  /** Kursor halaman berikutnya (pesan yang lebih lama); `null` = sudah paling awal. */
  nextCursor: z.string().nullable(),
});
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;

// ── Real-time (WebSocket `GET /inbox/stream`) ───────────────────────────────

/** Bagian panel detail yang bisa berubah (event `conversation.detail`). */
export const CONVERSATION_DETAIL_SECTIONS = ['tags', 'contact', 'notes', 'stars'] as const;
export type ConversationDetailSection = (typeof CONVERSATION_DETAIL_SECTIONS)[number];

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
  /**
   * Pengguna ini TIDAK LAGI boleh melihat percakapan (mis. Teknisi yang percakapannya dialihkan):
   * web menutup panel & membuang cache-nya. Hanya ID.
   */
  z.object({
    type: z.literal('conversation.removed'),
    conversationId: z.uuid(),
  }),
  z.object({
    type: z.literal('message.status'),
    conversationId: z.uuid(),
    messageId: z.uuid(),
    status: messageDeliveryStatusSchema,
  }),
  /**
   * Bagian panel detail percakapan berubah (butir 8): `tags` / `contact` (data kontaknya), `notes`
   * (catatan sesi), `stars` (pesan ditandai). Hanya ID + nama bagian; web memuat ulang lewat REST.
   */
  z.object({
    type: z.literal('conversation.detail'),
    conversationId: z.uuid(),
    section: z.enum(CONVERSATION_DETAIL_SECTIONS),
  }),
  /** Master tag organisasi berubah (dibuat/diubah/dihapus): muat ulang daftar tag. */
  z.object({ type: z.literal('tags.changed') }),
  /** Rem darurat pengiriman ditarik (`paused: true`) / dilepas — tampilkan/sembunyikan banner. */
  z.object({ type: z.literal('sending.changed'), paused: z.boolean() }),
  /**
   * Terlalu banyak event untuk organisasi ini dalam waktu singkat (mis. broadcast besar): event
   * dibuang, web memuat ulang daftar & percakapan yang terbuka lewat REST (`refreshInbox`).
   */
  z.object({ type: z.literal('resync') }),
]);
export type InboxStreamEvent = z.infer<typeof inboxStreamEventSchema>;
