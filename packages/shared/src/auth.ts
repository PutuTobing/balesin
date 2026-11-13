import { z } from 'zod';

import { emailAddressSchema, isoDateTimeSchema } from './fields';
import { loginPasswordSchema } from './password';
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

/** Sesi aktif: dikembalikan saat login berhasil, setup selesai, dan `GET /auth/me`. */
export const authenticatedSessionSchema = z.object({
  status: z.literal('authenticated'),
  user: sessionUserSchema,
  organization: sessionOrganizationSchema,
  /** Kirim di header `X-CSRF-Token`. Berubah setiap kali masuk; simpan di memori saja. */
  csrfToken: z.string(),
  session: sessionInfoSchema,
});
export type AuthenticatedSession = z.infer<typeof authenticatedSessionSchema>;

/**
 * Respons `POST /auth/login`. Web WAJIB memeriksa `status`: saat ini hanya `authenticated`,
 * tetapi langkah 2FA (wajib untuk Owner/Admin/Supervisor) akan menambah varian baru
 * (mis. `two_factor_required`) tanpa mengubah varian yang ada.
 */
export const loginResponseSchema = z.discriminatedUnion('status', [authenticatedSessionSchema]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** Respons `GET /auth/me`. */
export const meResponseSchema = authenticatedSessionSchema;
export type MeResponse = z.infer<typeof meResponseSchema>;

export const logoutResponseSchema = z.object({
  status: z.literal('logged_out'),
});
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
