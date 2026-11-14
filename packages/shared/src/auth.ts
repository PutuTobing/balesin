import { z } from 'zod';

import { emailAddressSchema, isoDateTimeSchema } from './fields';
import { loginPasswordSchema } from './password';
import { permissionSchema } from './permissions';
import { userRoleSchema } from './roles';

/**
 * Kontrak autentikasi (SECURITY.md §1).
 *
 * Sesi disimpan di cookie HttpOnly yang tidak bisa dibaca JavaScript. Yang dipegang web hanya
 * `csrfToken`: kirim balik di header `X-CSRF-Token` pada SETIAP permintaan yang mengubah data
 * (POST/PUT/PATCH/DELETE). Semua permintaan ke API harus memakai `credentials: 'include'`.
 */

/** Nama header token CSRF (huruf kecil, seperti yang dibaca server). */
export const CSRF_HEADER_NAME = 'x-csrf-token';

/** Umur sesi (SECURITY.md §1). Server yang menegakkan; web boleh memakainya untuk teks UI. */
export const SESSION_IDLE_TIMEOUT_HOURS = 12;
export const SESSION_ABSOLUTE_LIFETIME_DAYS = 30;

/** Kunci akun sementara saat brute force (SECURITY.md §1). */
export const LOGIN_MAX_FAILED_ATTEMPTS = 5;
export const LOGIN_LOCK_MINUTES = 15;

export const loginRequestSchema = z.object({
  email: emailAddressSchema,
  password: loginPasswordSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Pengguna yang sedang masuk. Tidak pernah memuat hash password atau rahasia lain. */
export const sessionUserSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: userRoleSchema,
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const sessionOrganizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Zona waktu IANA organisasi, mis. `Asia/Jakarta`. */
  timezone: z.string(),
});
export type SessionOrganization = z.infer<typeof sessionOrganizationSchema>;

export const sessionInfoSchema = z.object({
  /** Sesi berakhir pada waktu ini bila tidak ada aktivitas (digeser maju saat dipakai). */
  idleExpiresAt: isoDateTimeSchema,
  /** Batas mutlak sejak masuk; setelah ini harus masuk lagi. */
  absoluteExpiresAt: isoDateTimeSchema,
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

/** Bagian yang sama di setiap respons "sudah punya sesi" (penuh maupun terbatas). */
const sessionFields = {
  user: sessionUserSchema,
  organization: sessionOrganizationSchema,
  /** Kirim di header `X-CSRF-Token`. Berubah setiap kali masuk; simpan di memori saja. */
  csrfToken: z.string(),
  session: sessionInfoSchema,
  /**
   * Izin pengguna untuk sesi INI (`PERMISSIONS` di `permissions.ts`), berurutan seperti
   * `PERMISSIONS`. Dipakai web untuk menyembunyikan menu/tombol; server tetap memeriksa setiap
   * permintaan. Sesi terbatas (`two_factor_enrollment_required`) selalu `[]`. Cakupan izin
   * bercakupan: `permissionScope(user.role, izin)`.
   *
   * Server SELALU mengirimnya. Opsional di tipe hanya supaya klien yang belum memakainya tetap
   * terkompilasi (tambahan Fase 1 butir 5) — perlakukan "tidak ada" sebagai `[]`.
   */
  permissions: z.array(permissionSchema).optional(),
};

/** Sesi penuh: login selesai (termasuk langkah 2FA bila ada), atau `GET /auth/me`. */
export const authenticatedSessionSchema = z.object({
  status: z.literal('authenticated'),
  ...sessionFields,
});
export type AuthenticatedSession = z.infer<typeof authenticatedSessionSchema>;

/**
 * Sesi TERBATAS untuk Owner/Admin/Supervisor yang belum mengaktifkan verifikasi dua langkah
 * (2FA wajib untuk peran itu, SECURITY.md §1). Cookie sesi sudah terpasang dan `csrfToken`
 * berlaku, tetapi server hanya mengizinkan: `API_ROUTES.twoFactor.status`, `.enroll`,
 * `.confirmEnrollment`, `GET /auth/me`, dan `POST /auth/logout`. Rute lain dijawab 403
 * `TWO_FACTOR_ENROLLMENT_REQUIRED`. Umurnya pendek (`TWO_FACTOR_ENROLLMENT_SESSION_MINUTES`);
 * setelah 2FA aktif, server menerbitkan sesi penuh yang baru.
 */
export const twoFactorEnrollmentSessionSchema = z.object({
  status: z.literal('two_factor_enrollment_required'),
  ...sessionFields,
});
export type TwoFactorEnrollmentSession = z.infer<typeof twoFactorEnrollmentSessionSchema>;

/** Cara menyelesaikan langkah kedua. */
export const TWO_FACTOR_METHODS = ['totp', 'backup_code'] as const;
export const twoFactorMethodSchema = z.enum(TWO_FACTOR_METHODS);
export type TwoFactorMethod = z.infer<typeof twoFactorMethodSchema>;

/**
 * Password benar, tetapi akun memakai 2FA: BELUM ada sesi (tidak ada cookie sesi). Kirim
 * `challengeToken` + kode ke `POST /auth/2fa/verify`. Token hanya disimpan di memori halaman
 * (bukan localStorage/URL), sekali pakai, dan kedaluwarsa pada `expiresAt`.
 */
export const twoFactorChallengeResponseSchema = z.object({
  status: z.literal('two_factor_required'),
  challengeToken: z.string(),
  expiresAt: isoDateTimeSchema,
  /** Berapa kali kode salah masih boleh dicoba dengan tantangan ini. */
  attemptsRemaining: z.number().int().nonnegative(),
  methods: z.array(twoFactorMethodSchema),
});
export type TwoFactorChallengeResponse = z.infer<typeof twoFactorChallengeResponseSchema>;

/**
 * Respons `POST /auth/login`. Web WAJIB memeriksa `status`:
 *  - `authenticated` — selesai, sesi penuh.
 *  - `two_factor_required` — minta kode 2FA, lalu `POST /auth/2fa/verify`.
 *  - `two_factor_enrollment_required` — sesi terbatas; arahkan ke pendaftaran 2FA.
 */
export const loginResponseSchema = z.discriminatedUnion('status', [
  authenticatedSessionSchema,
  twoFactorChallengeResponseSchema,
  twoFactorEnrollmentSessionSchema,
]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** Respons `GET /auth/me`: sesi penuh, atau sesi terbatas yang wajib mendaftar 2FA dulu. */
export const meResponseSchema = z.discriminatedUnion('status', [
  authenticatedSessionSchema,
  twoFactorEnrollmentSessionSchema,
]);
export type MeResponse = z.infer<typeof meResponseSchema>;

export const logoutResponseSchema = z.object({
  status: z.literal('logged_out'),
});
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
