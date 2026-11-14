import { z } from 'zod';

/**
 * Aturan password (SECURITY.md §1). Yang bisa diperiksa di browser ada di sini; pemeriksaan
 * "password terlalu umum / mudah ditebak" hanya ada di server (daftarnya besar) dan hasilnya
 * dikembalikan sebagai error validasi pada isian password.
 */
export const PASSWORD_MIN_LENGTH = 10;
/** Batas atas supaya hashing tidak bisa dipakai membebani server. */
export const PASSWORD_MAX_LENGTH = 128;

export const PASSWORD_RULES_HINT =
  `Minimal ${PASSWORD_MIN_LENGTH} karakter. Hindari password yang umum dipakai ` +
  'atau yang memuat nama dan email-mu.';

/** Password BARU (setup, undangan, ganti/reset password). */
export const newPasswordSchema = z
  .string({ error: 'Password wajib diisi.' })
  .min(PASSWORD_MIN_LENGTH, `Password minimal ${PASSWORD_MIN_LENGTH} karakter.`)
  .max(PASSWORD_MAX_LENGTH, `Password maksimal ${PASSWORD_MAX_LENGTH} karakter.`);

/**
 * Password saat MASUK: tidak diperiksa aturannya (aturan bisa berubah setelah akun dibuat),
 * hanya dibatasi panjangnya.
 */
export const loginPasswordSchema = z
  .string({ error: 'Password wajib diisi.' })
  .min(1, 'Password wajib diisi.')
  .max(1024, 'Password terlalu panjang.');

/** Hasil pemeriksaan kekuatan password di server. */
export const passwordCheckResponseSchema = z.object({
  acceptable: z.boolean(),
  /** Alasan penolakan + sarannya; `null` bila password diterima. */
  message: z.string().nullable(),
});
export type PasswordCheckResponse = z.infer<typeof passwordCheckResponseSchema>;
