import { z } from 'zod';

import { meResponseSchema, type MeResponse } from './auth';
import { brandingInputSchema, organizationNameSchema } from './branding';
import {
  detectEmailHostRequestSchema,
  emailSettingsInputSchema,
  sendTestEmailRequestSchema,
} from './email-settings';
import { DEFAULT_TIME_ZONE, emailAddressSchema, personNameSchema, timeZoneSchema } from './fields';
import { newPasswordSchema } from './password';

/**
 * Wizard setup pertama kali (PRD §3.1, SECURITY.md §1).
 *
 * Hanya bisa jalan selama belum ada Owner dan hanya dengan token setup (`SETUP_TOKEN` di
 * berkas .env server, dibuat installer). Token dikirim di BODY — jangan pernah ditaruh di
 * path atau query string (alamat ikut tercatat di log). Bila token dibagikan lewat tautan,
 * taruh di fragment (`/setup#token=…`), yang tidak dikirim browser ke server.
 */

export const setupTokenSchema = z
  .string({ error: 'Token setup wajib diisi.' })
  .trim()
  .min(1, 'Token setup wajib diisi.')
  .max(512, 'Token setup tidak valid.');

/** `GET /setup/status` */
export const setupStatusResponseSchema = z.object({
  /** `true` = belum ada Owner; tampilkan wizard. `false` = arahkan ke halaman masuk. */
  needsSetup: z.boolean(),
  /** `false` = `SETUP_TOKEN` belum diisi di .env server, wizard belum bisa dijalankan. */
  setupTokenConfigured: z.boolean(),
  /** `false` = `BALESIN_MASTER_KEY` belum diisi, langkah Email belum bisa menyimpan password. */
  canStoreSecrets: z.boolean(),
});
export type SetupStatusResponse = z.infer<typeof setupStatusResponseSchema>;

/** `POST /setup/verify-token` */
export const verifySetupTokenRequestSchema = z.object({ setupToken: setupTokenSchema });
export type VerifySetupTokenRequest = z.infer<typeof verifySetupTokenRequestSchema>;

export const verifySetupTokenResponseSchema = z.object({ valid: z.literal(true) });
export type VerifySetupTokenResponse = z.infer<typeof verifySetupTokenResponseSchema>;

export const setupOwnerSchema = z.object({
  name: personNameSchema,
  email: emailAddressSchema,
  password: newPasswordSchema,
});
export type SetupOwner = z.infer<typeof setupOwnerSchema>;

export const setupOrganizationSchema = z.object({
  name: organizationNameSchema,
  timezone: timeZoneSchema.default(DEFAULT_TIME_ZONE),
});
export type SetupOrganization = z.infer<typeof setupOrganizationSchema>;

/**
 * `POST /setup/check-password` — memeriksa password Owner di server (termasuk daftar password
 * umum) sebelum wizard lanjut ke langkah berikutnya. `email`/`name`/`organizationName` dipakai
 * untuk menolak password yang memuat data itu.
 */
export const checkSetupPasswordRequestSchema = z.object({
  setupToken: setupTokenSchema,
  password: z.string({ error: 'Password wajib diisi.' }).max(1024, 'Password terlalu panjang.'),
  email: z.string().max(254).optional(),
  name: z.string().max(100).optional(),
  organizationName: z.string().max(100).optional(),
});
export type CheckSetupPasswordRequest = z.infer<typeof checkSetupPasswordRequestSchema>;

/** `POST /setup/email/detect-host` */
export const setupDetectEmailHostRequestSchema = detectEmailHostRequestSchema.extend({
  setupToken: setupTokenSchema,
});
export type SetupDetectEmailHostRequest = z.infer<typeof setupDetectEmailHostRequestSchema>;

/** `POST /setup/email/test-connection` — isi form wajib dikirim lengkap (belum ada yang tersimpan). */
export const setupTestEmailConnectionRequestSchema = z.object({
  setupToken: setupTokenSchema,
  settings: emailSettingsInputSchema,
});
export type SetupTestEmailConnectionRequest = z.infer<typeof setupTestEmailConnectionRequestSchema>;

/** `POST /setup/email/send-test` */
export const setupSendTestEmailRequestSchema = z.object({
  setupToken: setupTokenSchema,
  to: sendTestEmailRequestSchema.shape.to,
  settings: emailSettingsInputSchema,
});
export type SetupSendTestEmailRequest = z.infer<typeof setupSendTestEmailRequestSchema>;

/**
 * `POST /setup/complete` — membuat organisasi + Owner (+ branding, + email pengirim) dalam satu
 * transaksi, lalu langsung memasukkan Owner (respons sama dengan login berhasil).
 */
export const completeSetupRequestSchema = z.object({
  setupToken: setupTokenSchema,
  owner: setupOwnerSchema,
  organization: setupOrganizationSchema,
  branding: brandingInputSchema.optional(),
  /** Tidak dikirim/`null` = langkah Email dilewati; bisa diisi nanti di Pengaturan → Email pengirim. */
  email: emailSettingsInputSchema.nullish(),
});
export type CompleteSetupRequest = z.infer<typeof completeSetupRequestSchema>;

/**
 * Respons 201 `POST /setup/complete`. Owner wajib 2FA, jadi saat ini SELALU sesi terbatas
 * `two_factor_enrollment_required` (lanjutkan ke pendaftaran 2FA); bentuknya sama dengan
 * `meResponseSchema` supaya web bisa menyimpannya sebagai sesi apa adanya.
 */
export const completeSetupResponseSchema = meResponseSchema;
export type CompleteSetupResponse = MeResponse;
