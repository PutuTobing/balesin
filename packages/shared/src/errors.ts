import { z } from 'zod';

/**
 * Amplop error seragam untuk semua respons gagal dari API:
 *
 *   { "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [...], "requestId": "…" } }
 *
 * `message` selalu bahasa Indonesia dan aman ditampilkan ke pengguna.
 * `requestId` dipakai untuk mencocokkan laporan pengguna dengan log server.
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/** Status HTTP bawaan untuk tiap kode error. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

/** Pesan bawaan (dipakai server bila tidak ada pesan khusus, dan web sebagai cadangan). */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Data yang dikirim tidak valid. Periksa kembali isian Anda.',
  BAD_REQUEST: 'Permintaan tidak dapat diproses.',
  UNAUTHENTICATED: 'Anda perlu masuk terlebih dahulu.',
  FORBIDDEN: 'Anda tidak memiliki izin untuk melakukan tindakan ini.',
  NOT_FOUND: 'Data atau alamat yang diminta tidak ditemukan.',
  CONFLICT: 'Data bentrok dengan data yang sudah ada.',
  PAYLOAD_TOO_LARGE: 'Ukuran data yang dikirim terlalu besar.',
  UNSUPPORTED_MEDIA_TYPE: 'Format data yang dikirim tidak didukung.',
  RATE_LIMITED: 'Terlalu banyak permintaan. Coba lagi beberapa saat lagi.',
  INTERNAL_ERROR: 'Terjadi kesalahan di server. Coba lagi beberapa saat lagi.',
  SERVICE_UNAVAILABLE: 'Layanan sedang tidak tersedia. Coba lagi beberapa saat lagi.',
};

export const errorDetailLocationSchema = z.enum(['body', 'query', 'params', 'headers']);
export type ErrorDetailLocation = z.infer<typeof errorDetailLocationSchema>;

/** Satu masalah pada satu isian (dipakai error validasi). */
export const errorDetailSchema = z.object({
  /** Bagian request tempat isian berada. */
  location: errorDetailLocationSchema.optional(),
  /** Nama isian, bertitik untuk isian bersarang (mis. `alamat.kota`). Kosong = seluruh bagian. */
  field: z.string(),
  message: z.string(),
});
export type ErrorDetail = z.infer<typeof errorDetailSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    /** Salah satu `ERROR_CODES`; bertipe string agar klien lama tetap bisa membaca kode baru. */
    code: z.string(),
    message: z.string(),
    details: z.array(errorDetailSchema).optional(),
    requestId: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
