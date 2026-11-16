import { z } from 'zod';

import { hasControlCharacters } from './fields';
import { tagNameSchema } from './tags';

/**
 * Lapisan kompatibel MobiChat (Fase 3 — docs/KONTRAK-API-MOBICHAT.md, docs/API-MOBICHAT-MAPPING.md
 * §1 & §3). Workflow n8n yang dulu memanggil MobiChat cukup mengganti base URL + API key ke Balesin.
 *
 * Bentuk request/response MENGIKUTI MobiChat (nama field snake_case, ID numerik), bukan gaya API
 * native v1. Autentikasi: header `X-API-Key: <API key Balesin>` (huruf besar/kecil bebas) — key yang
 * SAMA dengan API publik v1, scope-nya dipetakan per rute. Key di query string TIDAK diterima.
 *
 * ID: `conversation_id` = `conversations.number`, `message_id`/`id` pesan = `messages.number`
 * (angka berurutan; boleh dikirim sebagai angka atau string angka).
 */

export const MOBICHAT_ROUTES = {
  /** GET riwayat pesan · POST kirim pesan (teks / media dari URL). */
  messages: '/api/public/messages',
  /** GET status + assignment · POST ubah status (`unserved` = handoff, `resolved`). */
  conversationStatus: '/api/public/conversation-status',
  /** POST lepas bot (tanpa `agent_id` = handoff ke antrian) / lepas agen tertentu. */
  unassignAgent: '/api/public/unassign-agent',
  /** POST tugaskan agen. */
  agents: '/api/public/agents',
  /** POST catatan internal tim. */
  notes: '/api/public/conversation/notes',
  /** PUT ganti nama kontak (dari `conversation_id`). */
  contacts: '/api/public/contacts',
  /** PUT tambah tag kontak (dari nomor WhatsApp; tag lama tidak dihapus). */
  tagsWhatsapp: '/api/public/tags/whatsapp',
  /** GET berkas media pesan lewat URL bertanda tangan (dari riwayat pesan). */
  media: '/api/public/media/:messageNumber',
  /** Bot API lama (prioritas kedua): balas teks. */
  botReply: '/api/bot/reply',
  /** Bot API lama: balas media dari URL. */
  botReplyMedia: '/api/bot/reply/media',
} as const;

/** Batas pesan per permintaan `POST /api/public/messages`. */
export const MOBICHAT_MESSAGES_PER_REQUEST_MAX = 5;
/** Riwayat pesan: bawaan & maksimum `limit`. */
export const MOBICHAT_HISTORY_DEFAULT = 30;
export const MOBICHAT_HISTORY_MAX = 100;
/** Masa berlaku URL media bertanda tangan (detik). */
export const MOBICHAT_MEDIA_URL_TTL_SECONDS = 60 * 60;

// ── Nilai bersama ───────────────────────────────────────────────────────────

/** ID numerik MobiChat: angka bulat positif, atau string berisi angka saja. */
export const mobichatIdSchema = z
  .union([z.number(), z.string()], { error: 'ID wajib berupa angka.' })
  .transform((value, context) => {
    const text = typeof value === 'number' ? String(value) : value.trim();
    if (!/^[1-9]\d{0,14}$/.test(text)) {
      context.addIssue({ code: 'custom', message: 'ID wajib berupa angka bulat positif.' });
      return z.NEVER;
    }
    return Number(text);
  });

const looseText = (max: number, label: string) =>
  z
    .string({ error: `${label} wajib berupa teks.` })
    .max(max, `${label} maksimal ${String(max)} karakter.`)
    .refine((value) => !value.includes('\u0000'), `${label} memuat karakter yang tidak didukung.`);

/** `conversation_id` ATAU `conversationId` (MobiChat memakai keduanya di endpoint berbeda). */
const conversationRef = {
  conversation_id: mobichatIdSchema.optional(),
  conversationId: mobichatIdSchema.optional(),
};
const hasConversationRef = (value: { conversation_id?: number; conversationId?: number }) =>
  value.conversation_id !== undefined || value.conversationId !== undefined;
const CONVERSATION_REQUIRED = { error: 'conversation_id wajib diisi.' };

/** ID percakapan dari body/query yang sudah lolos skema. */
export function mobichatConversationNumber(value: {
  conversation_id?: number | undefined;
  conversationId?: number | undefined;
}): number {
  return (value.conversation_id ?? value.conversationId) as number;
}

/** Jenis media yang bisa dikirim dari URL. */
export const MOBICHAT_MEDIA_TYPES = ['image', 'document', 'video', 'audio'] as const;
const mediaTypeSchema = z.enum(MOBICHAT_MEDIA_TYPES, {
  error: 'media_type harus image, document, video, atau audio.',
});

const mediaUrlSchema = z
  .string({ error: 'media_url wajib diisi.' })
  .trim()
  .min(1, 'media_url wajib diisi.')
  .max(2048, 'media_url terlalu panjang.')
  .refine((value) => !hasControlCharacters(value), 'media_url memuat karakter khusus.');

const fileNameSchema = looseText(240, 'file_name');

/** Pilihan tombol/daftar gaya MobiChat (`list_options[]`); batas Meta diperiksa saat dikonversi. */
export const mobichatListOptionSchema = z.object({
  id: z.union([z.string().max(256), z.number()]).transform((value) => String(value)),
  title: z.string().max(100),
  description: z.string().max(200).optional(),
});
const listOptionsSchema = z.array(mobichatListOptionSchema).max(10, 'Maksimal 10 pilihan.');
const captionSchema = looseText(1024, 'Caption');

// ── Permintaan ──────────────────────────────────────────────────────────────

export const mobichatMessagesQuerySchema = z
  .object({
    ...conversationRef,
    limit: z.coerce
      .number({ error: 'limit wajib angka.' })
      .int()
      .min(1)
      .max(MOBICHAT_HISTORY_MAX)
      .optional(),
  })
  .refine(hasConversationRef, CONVERSATION_REQUIRED);

/**
 * Satu pesan di `messages[]`: `text`, `media`, `button` (≤ 3 `list_options`), `list` (≤ 10
 * `list_options`, `list_title` = teks tombol pembuka). `flow`/template belum didukung → 400.
 */
export const mobichatOutgoingMessageSchema = z
  .object({
    message_type: z.string({ error: 'message_type wajib diisi.' }).max(32).optional(),
    text: looseText(4096, 'Teks').optional(),
    message_text: looseText(4096, 'Teks').optional(),
    caption: captionSchema.optional(),
    media_type: mediaTypeSchema.optional(),
    media_url: mediaUrlSchema.optional(),
    file_name: fileNameSchema.optional(),
    list_title: z.string().max(100).optional(),
    list_options: listOptionsSchema.optional(),
  })
  .superRefine((value, context) => {
    const type = value.message_type ?? 'text';
    if (type === 'button' || type === 'list') {
      if (!(value.text ?? value.message_text)?.trim()) {
        context.addIssue({ code: 'custom', path: ['text'], message: 'Isi pesan wajib diisi.' });
      }
      if (!value.list_options?.length) {
        context.addIssue({
          code: 'custom',
          path: ['list_options'],
          message: 'list_options wajib diisi untuk pesan tombol/daftar.',
        });
      }
      return;
    }
    if (type === 'text') {
      const text = value.text ?? value.message_text;
      if (text === undefined || text.trim() === '') {
        context.addIssue({ code: 'custom', path: ['text'], message: 'Isi pesan wajib diisi.' });
      }
      return;
    }
    if (type === 'media') {
      if (!value.media_type) {
        context.addIssue({
          code: 'custom',
          path: ['media_type'],
          message: 'media_type wajib diisi untuk pesan media.',
        });
      }
      if (!value.media_url) {
        context.addIssue({
          code: 'custom',
          path: ['media_url'],
          message: 'media_url wajib diisi untuk pesan media.',
        });
      }
      return;
    }
    context.addIssue({
      code: 'custom',
      path: ['message_type'],
      message: `message_type "${type.slice(0, 32)}" belum didukung Balesin. Pakai "text", "media", "button", atau "list".`,
    });
  });
export type MobichatOutgoingMessage = z.infer<typeof mobichatOutgoingMessageSchema>;

export const mobichatSendMessagesRequestSchema = z
  .object({
    ...conversationRef,
    messages: z
      .array(mobichatOutgoingMessageSchema, { error: 'messages wajib berupa daftar.' })
      .min(1, 'Isi minimal satu pesan.')
      .max(
        MOBICHAT_MESSAGES_PER_REQUEST_MAX,
        `Maksimal ${String(MOBICHAT_MESSAGES_PER_REQUEST_MAX)} pesan per permintaan.`,
      ),
  })
  .refine(hasConversationRef, CONVERSATION_REQUIRED);
export type MobichatSendMessagesRequest = z.infer<typeof mobichatSendMessagesRequestSchema>;

export const mobichatConversationQuerySchema = z
  .object(conversationRef)
  .refine(hasConversationRef, CONVERSATION_REQUIRED);

/** Status yang boleh diminta lewat `POST /api/public/conversation-status`. */
export const MOBICHAT_SETTABLE_STATUSES = ['unserved', 'resolved'] as const;
export const mobichatSetStatusRequestSchema = z
  .object({
    ...conversationRef,
    status: z.string({ error: 'status wajib diisi.' }).trim().toLowerCase().max(32),
  })
  .refine(hasConversationRef, CONVERSATION_REQUIRED);

/** `agent_id` = ID pengguna Balesin (UUID). Angka MobiChat tidak dikenal → agen tidak ditemukan. */
const agentIdSchema = z
  .union([z.string().trim().max(64), z.number()], { error: 'agent_id tidak valid.' })
  .transform((value) => String(value));

export const mobichatUnassignRequestSchema = z
  .object({
    ...conversationRef,
    agent_id: agentIdSchema.nullable().optional(),
  })
  .refine(hasConversationRef, CONVERSATION_REQUIRED);

export const mobichatAssignRequestSchema = z
  .object({ ...conversationRef, agent_id: agentIdSchema })
  .refine(hasConversationRef, CONVERSATION_REQUIRED);

export const mobichatNoteRequestSchema = z
  .object({
    ...conversationRef,
    notes: z
      .string({ error: 'notes wajib diisi.' })
      .trim()
      .min(1, 'notes wajib diisi.')
      .max(2000, 'Catatan maksimal 2.000 karakter.')
      .refine((value) => !value.includes('\u0000'), 'Catatan memuat karakter yang tidak didukung.'),
  })
  .refine(hasConversationRef, CONVERSATION_REQUIRED);

/** Ganti nama kontak: `edited_name` (nama dari tim) diutamakan, lalu `full_name`, lalu `name`. */
export const mobichatUpdateContactRequestSchema = z
  .object({
    ...conversationRef,
    full_name: z.string().max(200).optional(),
    edited_name: z.string().max(200).optional(),
    name: z.string().max(200).optional(),
  })
  .refine(hasConversationRef, CONVERSATION_REQUIRED)
  .refine(
    (value) =>
      [value.edited_name, value.full_name, value.name].some(
        (name) => name !== undefined && name.trim() !== '',
      ),
    { error: 'Isi full_name atau edited_name.' },
  );

export const mobichatTagsRequestSchema = z.object({
  whatsapp_number: z
    .union([z.string().trim().max(32), z.number()], { error: 'whatsapp_number wajib diisi.' })
    .transform((value) => String(value)),
  tags: z
    .array(tagNameSchema, { error: 'tags wajib berupa daftar.' })
    .min(1, 'Isi minimal satu tag.')
    .max(20, 'Maksimal 20 tag per permintaan.'),
});

/**
 * Bot API lama `POST /api/bot/reply`: `text`, `button` (`list_options` ≤ 3), `list` (`list_title` +
 * `list_options` ≤ 10). `flow` belum didukung.
 */
export const mobichatBotReplyRequestSchema = z.object({
  conversation_id: mobichatIdSchema,
  message_text: looseText(4096, 'message_text').optional(),
  message_type: z.string().max(32).optional(),
  list_title: z.string().max(100).optional(),
  list_options: listOptionsSchema.optional(),
});

/** Bot API lama `POST /api/bot/reply/media`. */
export const mobichatBotReplyMediaRequestSchema = z.object({
  conversation_id: mobichatIdSchema,
  media_url: mediaUrlSchema,
  media_type: mediaTypeSchema,
  caption: captionSchema.optional(),
  file_name: fileNameSchema.optional(),
});

export const mobichatMediaParamsSchema = z.object({ messageNumber: z.string().max(20) });
export const mobichatMediaQuerySchema = z.object({
  exp: z.string().max(20).optional(),
  kid: z.string().max(64).optional(),
  sig: z.string().max(128).optional(),
});

// ── Jawaban ─────────────────────────────────────────────────────────────────

/** Error `/api/public/*`: `{ success: false, code, message }` (n8n membaca `message`/`error`). */
export const mobichatErrorSchema = z.object({
  success: z.literal(false),
  code: z.string(),
  message: z.string(),
});
export type MobichatError = z.infer<typeof mobichatErrorSchema>;

/** Error Bot API lama `/api/bot/*`: `{ error: "..." }` (sama dengan dokumentasi MobiChat). */
export const mobichatBotErrorSchema = z.object({ error: z.string() });

/**
 * Lampiran pesan. URL bertanda tangan berlaku `MOBICHAT_MEDIA_URL_TTL_SECONDS` dan terikat ke API key
 * peminta (key dicabut → URL mati). `name` stiker diawali `sticker_` (workflow ULAN mengabaikannya).
 */
export const mobichatAttachmentSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  file_type: z.string(),
  mime_type: z.string(),
  media_type: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  signed_url: z.string().nullable(),
  public_url: z.string().nullable(),
});
export type MobichatAttachment = z.infer<typeof mobichatAttachmentSchema>;

/**
 * Jenis pengirim gaya MobiChat: `user` (pelanggan), `agent` (agen manusia), `api-bot` (bot/API key),
 * `broadcast`, `system`.
 */
export const MOBICHAT_SENDER_TYPES = ['user', 'agent', 'api-bot', 'broadcast', 'system'] as const;

export const mobichatMessageSchema = z.object({
  id: z.number().int(),
  index: z.number().int(),
  conversation_id: z.number().int(),
  type: z.enum(MOBICHAT_SENDER_TYPES),
  sender: z.enum(MOBICHAT_SENDER_TYPES),
  sender_name: z.string().nullable(),
  message_type: z.string(),
  text: z.string().nullable(),
  message_text: z.string().nullable(),
  status: z.string().nullable(),
  created_at: z.string(),
  attachments: z.array(mobichatAttachmentSchema),
  file_attachments: z.array(mobichatAttachmentSchema),
});
export type MobichatMessage = z.infer<typeof mobichatMessageSchema>;

export const mobichatMessagesResponseSchema = z.object({
  success: z.literal(true),
  conversation_id: z.number().int(),
  messages: z.array(mobichatMessageSchema),
});

export const mobichatSentMessageSchema = z.object({
  id: z.number().int(),
  message_id: z.number().int(),
  message_type: z.string(),
  status: z.string().nullable(),
});
export const mobichatSendMessagesResponseSchema = z.object({
  success: z.literal(true),
  conversation_id: z.number().int(),
  message_id: z.number().int(),
  status: z.string().nullable(),
  messages: z.array(mobichatSentMessageSchema),
});

export const mobichatAssignmentSchema = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    /** `chatbot` = percakapan dipegang bot (status `bot`); `agent` = agen manusia. */
    role: z.enum(['chatbot', 'agent']),
  }),
});
export const mobichatConversationStatusResponseSchema = z.object({
  success: z.literal(true),
  conversation_id: z.number().int(),
  /** Status Balesin apa adanya: `bot` · `unserved` · `served` · `resolved`. */
  status: z.string(),
  assignments: z.array(mobichatAssignmentSchema),
});

export const mobichatSuccessResponseSchema = z.object({
  success: z.literal(true),
  status: z.string(),
  message: z.string(),
  conversation_id: z.number().int().optional(),
});

export const mobichatContactResponseSchema = z.object({
  success: z.literal(true),
  status: z.string(),
  message: z.string(),
  contact: z.object({
    id: z.number().int(),
    full_name: z.string().nullable(),
    edited_name: z.string().nullable(),
    name: z.string().nullable(),
    phone_number: z.string().nullable(),
    tags: z.array(z.string()),
  }),
});

/** Jawaban sukses Bot API lama (bentuk MobiChat). `wamid` belum ada: pesan dikirim lewat antrean. */
export const mobichatBotReplyResponseSchema = z.object({
  success: z.literal(true),
  message_id: z.number().int(),
  conversation_id: z.number().int(),
  result: z.object({
    success: z.literal(true),
    data: z.object({
      messaging_product: z.literal('whatsapp'),
      contacts: z.array(z.object({ input: z.string(), wa_id: z.string() })),
      messages: z.array(z.object({ id: z.string().nullable() })),
    }),
  }),
  status: z.string().nullable(),
});
