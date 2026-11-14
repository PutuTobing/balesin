import { z } from 'zod';

import { isoDateTimeSchema } from './fields';
import { linkTokenSchema } from './invitations';

/**
 * Verifikasi alamat email akun. Dipakai sekarang untuk memverifikasi email akun sendiri (mis.
 * Owner hasil wizard setup, atau akun dari undangan yang tautannya disalin manual); mekanisme
 * tokennya (tabel `account_tokens`, kolom `email` tujuan) disiapkan juga untuk ubah email di profil
 * nanti. Alur: docs/KONTRAK-API-AUTH.md bagian "Verifikasi email".
 */

/** Tautan verifikasi berlaku sekian jam dan hanya sekali pakai. */
export const EMAIL_VERIFICATION_VALID_HOURS = 24;

/** `GET /auth/email/verification` (sesi penuh). */
export const emailVerificationStatusResponseSchema = z.object({
  email: z.string(),
  verified: z.boolean(),
  verifiedAt: isoDateTimeSchema.nullable(),
  /** Email pengirim sudah diatur, jadi tautan verifikasi bisa dikirim. */
  canSend: z.boolean(),
});
export type EmailVerificationStatusResponse = z.infer<typeof emailVerificationStatusResponseSchema>;

/** 202 `POST /auth/email/verification` — tautan diantrekan ke email akun. */
export const sendEmailVerificationResponseSchema = z.object({
  status: z.literal('queued'),
  expiresAt: isoDateTimeSchema,
});
export type SendEmailVerificationResponse = z.infer<typeof sendEmailVerificationResponseSchema>;

/** `POST /auth/email/verify` (publik). */
export const verifyEmailRequestSchema = z.object({ token: linkTokenSchema });
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

export const verifyEmailResponseSchema = z.object({
  status: z.literal('verified'),
  email: z.string(),
});
export type VerifyEmailResponse = z.infer<typeof verifyEmailResponseSchema>;
