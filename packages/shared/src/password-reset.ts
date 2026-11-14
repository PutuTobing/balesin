import { z } from 'zod';

import { twoFactorMethodSchema } from './auth';
import { emailAddressSchema, isoDateTimeSchema } from './fields';
import { linkTokenSchema } from './invitations';
import { newPasswordSchema } from './password';
import { twoFactorCodeSchema } from './two-factor';

/**
 * Atur ulang password lewat email (SECURITY.md §1). Alur lengkap: docs/KONTRAK-API-AUTH.md bagian
 * "Atur ulang password".
 */

/** Tautan atur ulang password berlaku sekian menit dan hanya sekali pakai. */
export const PASSWORD_RESET_VALID_MINUTES = 30;

/**
 * `GET /auth/password-reset` (publik) — apakah reset lewat email tersedia di instalasi ini
 * (email pengirim sudah diatur). Ini keadaan INSTALASI, bukan akun: tidak membuka ada/tidaknya
 * akun siapa pun.
 */
export const passwordResetStatusResponseSchema = z.object({ available: z.boolean() });
export type PasswordResetStatusResponse = z.infer<typeof passwordResetStatusResponseSchema>;

export const requestPasswordResetRequestSchema = z.object({ email: emailAddressSchema });
export type RequestPasswordResetRequest = z.infer<typeof requestPasswordResetRequestSchema>;

/**
 * 202 — SELALU sama untuk email terdaftar maupun tidak (cegah enumerasi). Tampilkan pesan seperti
 * "Kalau email itu terdaftar, tautan atur ulang password sudah dikirim. Periksa kotak masuk dan
 * folder spam. Tautan berlaku 30 menit."
 */
export const requestPasswordResetResponseSchema = z.object({
  status: z.literal('accepted'),
  validMinutes: z.literal(PASSWORD_RESET_VALID_MINUTES),
});
export type RequestPasswordResetResponse = z.infer<typeof requestPasswordResetResponseSchema>;

export const inspectPasswordResetRequestSchema = z.object({ token: linkTokenSchema });
export type InspectPasswordResetRequest = z.infer<typeof inspectPasswordResetRequestSchema>;

/** Isi tautan — hanya untuk token yang sah. */
export const inspectPasswordResetResponseSchema = z.object({
  email: z.string(),
  expiresAt: isoDateTimeSchema,
  /**
   * Akun memakai 2FA: kode autentikator ATAU kode cadangan WAJIB diisi bersama password baru.
   * Atur ulang password tidak pernah bisa dipakai melewati 2FA.
   */
  twoFactorRequired: z.boolean(),
  /** Cara yang bisa dipakai (`backup_code` hanya bila masih ada kode cadangan). Kosong bila tanpa 2FA. */
  methods: z.array(twoFactorMethodSchema),
});
export type InspectPasswordResetResponse = z.infer<typeof inspectPasswordResetResponseSchema>;

export const completePasswordResetRequestSchema = z.object({
  token: linkTokenSchema,
  password: newPasswordSchema,
  /** Wajib bila `twoFactorRequired`; diabaikan bila akun tanpa 2FA. */
  code: twoFactorCodeSchema.optional(),
});
export type CompletePasswordResetRequest = z.input<typeof completePasswordResetRequestSchema>;

/**
 * Password diganti. TIDAK ada sesi baru: semua sesi akun ini dicabut, lalu pengguna masuk lagi
 * dengan password baru (+ kode 2FA bila aktif).
 */
export const completePasswordResetResponseSchema = z.object({
  status: z.literal('password_reset'),
});
export type CompletePasswordResetResponse = z.infer<typeof completePasswordResetResponseSchema>;
