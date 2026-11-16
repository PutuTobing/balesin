import { z } from 'zod';

import { MESSAGE_MEDIA_KINDS, type MessageMediaKind } from './inbox';

/**
 * Ruang chat — kirim pesan, unggah & unduh media (Fase 2 butir 6, docs/KONTRAK-API-INBOX.md
 * "Ruang chat"). Dipakai api (validasi), worker (pengiriman), dan web.
 */

// ── Batas media WhatsApp Cloud API ──────────────────────────────────────────

/**
 * Jenis berkas yang boleh diunggah per jenis media, dengan batas ukuran Meta (dokumentasi Cloud API
 * "Supported media types", dibaca 16 Nov 2026). MIME ditentukan server dari ISI berkas (magic
 * bytes), bukan dari nama/`Content-Type` kiriman klien.
 */
export const OUTBOUND_MEDIA_LIMITS: Readonly<
  Record<Exclude<MessageMediaKind, 'sticker'>, { maxBytes: number; mimeTypes: readonly string[] }>
> = {
  image: { maxBytes: 5 * 1024 * 1024, mimeTypes: ['image/jpeg', 'image/png'] },
  audio: {
    maxBytes: 16 * 1024 * 1024,
    mimeTypes: ['audio/ogg', 'audio/mpeg', 'audio/aac', 'audio/mp4', 'audio/amr'],
  },
  video: { maxBytes: 16 * 1024 * 1024, mimeTypes: ['video/mp4', 'video/3gpp'] },
  document: {
    maxBytes: 100 * 1024 * 1024,
    mimeTypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
    ],
  },
};

export type OutboundMediaKind = keyof typeof OUTBOUND_MEDIA_LIMITS;
export const OUTBOUND_MEDIA_KINDS = Object.keys(OUTBOUND_MEDIA_LIMITS) as OutboundMediaKind[];

/** Unggahan terbesar yang diterima api (dokumen 100 MB). */
export const MAX_UPLOAD_BYTES = OUTBOUND_MEDIA_LIMITS.document.maxBytes;

/** Unduhan media masuk terbesar yang mau diambil dari Meta (dokumen 100 MB). */
export const MAX_INBOUND_MEDIA_BYTES = 100 * 1024 * 1024;

/** Retensi salinan lokal media (unggahan & unduhan), hari — bawaan pengaturan organisasi. */
export const MEDIA_RETENTION_DAYS = { default: 30, min: 1, max: 365 } as const;

// ── Kirim pesan ─────────────────────────────────────────────────────────────

const clientMessageId = z.uuid({ error: 'ID pesan dari aplikasi tidak valid.' });
const replyTo = z.uuid({ error: 'Pesan yang dibalas tidak valid.' }).optional();

/** Teks pesan WhatsApp: 1–4096 karakter, tanpa karakter NUL. */
const messageText = z
  .string({ error: 'Isi pesan wajib diisi.' })
  .refine((value) => value.trim().length > 0, 'Isi pesan wajib diisi.')
  .refine((value) => value.length <= 4096, 'Pesan terlalu panjang (maks. 4.096 karakter).')
  .refine((value) => !value.includes('\u0000'), 'Pesan memuat karakter yang tidak didukung.');

/**
 * `POST /conversations/:id/messages`. `clientMessageId` = kunci idempotensi buatan klien (UUID per
 * pesan): mengirim ulang permintaan yang sama tidak menggandakan pesan.
 */
export const sendMessageRequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    clientMessageId,
    text: messageText,
    replyToMessageId: replyTo,
  }),
  z.object({
    type: z.literal('media'),
    clientMessageId,
    /** ID unggahan dari `POST /conversations/:id/media`. */
    mediaId: z.uuid({ error: 'Berkas tidak valid.' }),
    caption: z
      .string()
      .max(1024, 'Keterangan terlalu panjang (maks. 1.024 karakter).')
      .refine(
        (value) => !value.includes('\u0000'),
        'Keterangan memuat karakter yang tidak didukung.',
      )
      .optional(),
    replyToMessageId: replyTo,
  }),
  z.object({
    type: z.literal('location'),
    clientMessageId,
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    name: z.string().trim().max(256).optional(),
    address: z.string().trim().max(512).optional(),
    replyToMessageId: replyTo,
  }),
  z.object({
    type: z.literal('reaction'),
    clientMessageId,
    targetMessageId: z.uuid({ error: 'Pesan yang diberi reaksi tidak valid.' }),
    /** Satu emoji; string kosong = hapus reaksi. */
    emoji: z.string().max(16, 'Reaksi harus satu emoji.'),
  }),
]);
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const messageIdParamsSchema = z.object({ messageId: z.string() });

/** Jawaban unggah media (`POST /conversations/:id/media`). */
export const uploadedMediaSchema = z.object({
  id: z.uuid(),
  kind: z.enum(MESSAGE_MEDIA_KINDS),
  mimeType: z.string(),
  filename: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
});
export type UploadedMedia = z.infer<typeof uploadedMediaSchema>;
export const uploadMediaResponseSchema = z.object({ media: uploadedMediaSchema });
export type UploadMediaResponse = z.infer<typeof uploadMediaResponseSchema>;

// ── Kegagalan kirim ─────────────────────────────────────────────────────────

/**
 * Alasan pesan keluar `failed` (disimpan di `messages.failure_reason`; kode Meta di `error_code`):
 *  - `window_closed` — di luar jendela 24 jam saat dikirim worker;
 *  - `channel_unavailable` — channel dinonaktifkan/dihapus;
 *  - `recipient_unavailable` — pelanggan tanpa nomor (username saja) — kirim ke BSUID menyusul;
 *  - `sender_not_allowed` — pengirim dinonaktifkan/kehilangan izin sebelum pesan terkirim;
 *  - `media_unavailable` — berkas unggahan sudah kedaluwarsa/dihapus;
 *  - `meta_rejected` — Meta menolak saat dikirim (kode di `error_code`);
 *  - `delivery_failed` — Meta menerima lalu melaporkan gagal lewat webhook status;
 *  - `delivery_unknown` — koneksi ke Meta putus saat mengirim (bisa saja sudah terkirim);
 *  - `credentials_unavailable` — kredensial channel tidak bisa dibuka (master key);
 *  - `queue_unavailable` — antrean kirim (Redis) bermasalah sehingga pesan belum dikirim.
 */
export const OUTBOUND_FAILURE_REASONS = [
  'window_closed',
  'channel_unavailable',
  'recipient_unavailable',
  'sender_not_allowed',
  'media_unavailable',
  'meta_rejected',
  'delivery_failed',
  'delivery_unknown',
  'credentials_unavailable',
  'queue_unavailable',
] as const;
export const outboundFailureReasonSchema = z.enum(OUTBOUND_FAILURE_REASONS);
export type OutboundFailureReason = z.infer<typeof outboundFailureReasonSchema>;

const REASON_MESSAGES: Readonly<Record<OutboundFailureReason, string>> = {
  window_closed:
    'Sudah lebih dari 24 jam sejak pesan terakhir pelanggan. Pesan biasa tidak bisa dikirim — tunggu pelanggan membalas, atau kirim template (segera hadir).',
  channel_unavailable:
    'Nomor WhatsApp pengirim sedang dinonaktifkan atau sudah dihapus. Aktifkan lagi di Pengaturan → Channel.',
  recipient_unavailable:
    'Pelanggan ini memakai username WhatsApp tanpa nomor. Balesin belum bisa membalas ke username.',
  sender_not_allowed: 'Akunmu tidak lagi berhak membalas percakapan ini, jadi pesan tidak dikirim.',
  media_unavailable: 'Berkas sudah tidak tersedia (kedaluwarsa). Unggah ulang lalu kirim lagi.',
  meta_rejected: 'Meta menolak pesan ini. Periksa isinya lalu kirim ulang.',
  delivery_failed: 'Meta melaporkan pesan ini gagal diantar ke pelanggan.',
  delivery_unknown:
    'Koneksi ke Meta terputus saat mengirim, jadi pesan mungkin sudah terkirim. Pastikan pelanggan belum menerimanya sebelum kirim ulang.',
  queue_unavailable:
    'Antrean pengiriman sedang bermasalah sehingga pesan belum dikirim. Kirim ulang beberapa saat lagi.',
  credentials_unavailable:
    'Kredensial channel tidak bisa dibuka di server. Hubungi admin untuk memeriksa kunci enkripsi (BALESIN_MASTER_KEY).',
};

/**
 * Kode error Meta yang sering muncul saat kirim → penjelasan + solusi (dokumentasi Cloud API "Error
 * codes", dibaca 16 Nov 2026).
 */
const META_CODE_MESSAGES: Readonly<Record<number, string>> = {
  131047:
    'Sudah lebih dari 24 jam sejak pesan terakhir pelanggan. Pesan biasa tidak bisa dikirim — tunggu pelanggan membalas, atau kirim template (segera hadir).',
  470: 'Sudah lebih dari 24 jam sejak pesan terakhir pelanggan. Pesan biasa tidak bisa dikirim — tunggu pelanggan membalas, atau kirim template (segera hadir).',
  131026:
    'Pesan tidak bisa diantar: nomor pelanggan tidak aktif di WhatsApp, belum menyetujui ketentuan terbaru, atau aplikasinya terlalu lama. Hubungi pelanggan lewat kanal lain.',
  131051: 'Jenis pesan ini tidak didukung WhatsApp. Kirim sebagai teks atau berkas lain.',
  130429: 'Batas kecepatan kirim nomor ini tercapai. Tunggu sebentar lalu kirim ulang.',
  131056:
    'Terlalu banyak pesan ke pelanggan yang sama dalam waktu singkat. Tunggu beberapa menit lalu kirim ulang.',
  131049:
    'Meta menahan pesan ini untuk menjaga kenyamanan pelanggan (terlalu banyak pesan bisnis). Coba lagi nanti.',
  131053:
    'Meta gagal memproses berkas (format atau ukuran tidak sesuai). Periksa berkasnya lalu unggah ulang.',
  131021: 'Nomor tujuan sama dengan nomor pengirim.',
  131030:
    'Nomor pelanggan belum ada di daftar penerima uji nomor tes Meta. Tambahkan nomornya di WhatsApp Manager, atau pakai nomor produksi.',
  131000: 'Gangguan sementara di Meta. Kirim ulang beberapa saat lagi.',
  131016: 'Layanan Meta sedang kelebihan beban. Kirim ulang beberapa saat lagi.',
  131009: 'Meta menolak isian pesan (parameter tidak valid). Periksa isi pesan lalu kirim ulang.',
  131042:
    'Metode pembayaran akun WhatsApp Business belum siap. Perbarui metode pembayaran di WhatsApp Manager.',
  131031: 'Akun WhatsApp Business dikunci Meta. Periksa status akun di WhatsApp Manager.',
  368: 'Nomor ini sedang dibatasi Meta karena pelanggaran kebijakan. Periksa Kualitas Akun di WhatsApp Manager.',
  190: 'Token System User ditolak Meta (salah atau kedaluwarsa). Minta admin mengganti token di Pengaturan → Channel.',
  10: 'Token belum punya izin whatsapp_business_messaging. Minta admin memperbaiki izin token di Pengaturan Bisnis Meta.',
  131005:
    'Token belum punya izin whatsapp_business_messaging. Minta admin memperbaiki izin token di Pengaturan Bisnis Meta.',
};

/** Kegagalan yang masuk akal dikirim ulang lewat tombol "Kirim ulang". */
const RETRYABLE_REASONS = new Set<OutboundFailureReason>([
  'meta_rejected',
  'delivery_failed',
  'delivery_unknown',
  'channel_unavailable',
  'window_closed',
  'credentials_unavailable',
  'queue_unavailable',
]);
const UNRETRYABLE_META_CODES = new Set([131021, 131051]);

export function outboundFailureMessage(
  reason: OutboundFailureReason,
  errorCode: number | null,
): string {
  if (errorCode !== null && (reason === 'meta_rejected' || reason === 'delivery_failed')) {
    const known = META_CODE_MESSAGES[errorCode];
    if (known) return known;
    return `${REASON_MESSAGES[reason]} (kode Meta ${String(errorCode)})`;
  }
  return REASON_MESSAGES[reason];
}

export function isRetryableFailure(
  reason: OutboundFailureReason,
  errorCode: number | null,
): boolean {
  return (
    RETRYABLE_REASONS.has(reason) && !(errorCode !== null && UNRETRYABLE_META_CODES.has(errorCode))
  );
}

/** Kirim ulang paling banyak sekian kali per pesan. */
export const MAX_SEND_ATTEMPTS = 5;

export const messageFailureSchema = z.object({
  reason: outboundFailureReasonSchema,
  /** Kode error Meta bila ada. */
  code: z.number().int().nullable(),
  /** Penjelasan + solusi (bahasa Indonesia). */
  message: z.string(),
  /** Tombol "Kirim ulang" boleh ditampilkan. */
  retryable: z.boolean(),
});
export type MessageFailure = z.infer<typeof messageFailureSchema>;
