import { z } from 'zod';

import { isoDateTimeSchema } from './fields';
import { INVITE_PERMISSIONS, invitableRoleSchema, type InvitableRole } from './invitations';
import { loginPasswordSchema } from './password';
import { userRoleSchema, type UserRole } from './roles';
import { twoFactorCodeSchema } from './two-factor';

/**
 * Manajemen pengguna & sesi aktif (Fase 1 butir 6). Alur & error per kasus:
 * docs/KONTRAK-API-AUTH.md bagian "Manajemen pengguna & sesi".
 *
 * Izin rute: `team.manage` (Owner, Admin). Di atasnya berlaku MATRIKS KELOLA per peran sasaran —
 * ditegakkan server (403 + audit `auth.access.denied` aturan `team.manage.*`), web memakainya untuk
 * menyembunyikan tombol.
 */

/**
 * Siapa boleh mengelola (ubah peran, nonaktifkan/aktifkan, atur ulang 2FA, buka kunci, lihat &
 * cabut sesi) pengguna ber-peran apa. Konsisten dengan `INVITE_PERMISSIONS`:
 *  - Owner: semua peran, TERMASUK Owner lain — tetapi tidak dirinya sendiri.
 *  - Admin: Supervisor, CS, Teknisi. TIDAK Owner dan TIDAK Admin lain (hanya Owner yang menentukan
 *    siapa memegang wewenang Admin).
 *  - Supervisor, CS, Teknisi: tidak ada (tidak memegang `team.manage`).
 * Diri sendiri tidak pernah dikelola lewat endpoint tim — pakai halaman Keamanan akun.
 */
export const MANAGE_PERMISSIONS: Record<UserRole, readonly UserRole[]> = {
  owner: ['owner', 'admin', 'supervisor', 'cs', 'teknisi'],
  admin: ['supervisor', 'cs', 'teknisi'],
  supervisor: [],
  cs: [],
  teknisi: [],
};

/** Peran `actor` boleh mengelola pengguna ber-peran `target` (selain dirinya sendiri). */
export function canManageRole(actor: UserRole, target: UserRole): boolean {
  return MANAGE_PERMISSIONS[actor].includes(target);
}

/**
 * Peran yang boleh DIBERIKAN `actor` lewat ubah peran = peran yang boleh ia undang
 * (`INVITE_PERMISSIONS`). Tidak ada yang bisa menjadikan orang Owner lewat ubah peran.
 */
export function assignableRoles(actor: UserRole): readonly InvitableRole[] {
  return INVITE_PERMISSIONS[actor];
}

/**
 * Batas waktu (jam) bagi akun ber-peran wajib 2FA (Owner/Admin/Supervisor) untuk mendaftarkan 2FA,
 * dihitung sejak akunnya dibuat lewat undangan, perannya dinaikkan, 2FA-nya diatur ulang, akunnya
 * diaktifkan kembali, atau pendaftarannya dibuka lagi. Lewat batas ini, masuk dengan password tidak
 * lagi membuka pendaftaran 2FA (403 `TWO_FACTOR_ENROLLMENT_EXPIRED`) sampai Owner/Admin membuka
 * lagi pendaftarannya (review undangan R3 / review 2FA R5.3).
 */
export const TWO_FACTOR_ENROLLMENT_WINDOW_HOURS = 72;

// ── Konfirmasi ulang identitas pelaku ───────────────────────────────────────

/**
 * Password pelaku + kode 2FA pelaku (autentikator atau kode cadangan). `code` wajib bila 2FA pelaku
 * aktif — selalu begitu untuk Owner/Admin. Salah password/kode memakai ember yang sama dengan
 * halaman Keamanan akun (5 salah → 429; kode salah ikut mengunci langkah kedua 15 menit).
 */
export const identityConfirmationSchema = z.object({
  password: loginPasswordSchema,
  code: twoFactorCodeSchema.optional(),
});
export type IdentityConfirmation = z.input<typeof identityConfirmationSchema>;

// ── Pengguna ────────────────────────────────────────────────────────────────

export const TEAM_USER_STATUSES = ['active', 'locked', 'disabled'] as const;
export const teamUserStatusSchema = z.enum(TEAM_USER_STATUSES);
export type TeamUserStatus = z.infer<typeof teamUserStatusSchema>;

export const TEAM_USER_STATUS_LABELS: Readonly<Record<TeamUserStatus, string>> = {
  active: 'Aktif',
  locked: 'Terkunci sementara',
  disabled: 'Nonaktif',
};

export const teamUserSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: userRoleSchema,
  /**
   * `disabled` = dinonaktifkan (tidak bisa masuk). `locked` = aktif tetapi masuk/langkah kedua
   * sedang dikunci sementara (lihat `lockedUntil`; bisa dibuka Owner/Admin). Selain itu `active`.
   */
  status: teamUserStatusSchema,
  disabledAt: isoDateTimeSchema.nullable(),
  /** Kunci sementara berakhir pada waktu ini (`null` = tidak terkunci). */
  lockedUntil: isoDateTimeSchema.nullable(),
  /** `false` = email belum terbukti milik pengguna (mis. undangan yang tautannya disalin manual). */
  emailVerified: z.boolean(),
  lastLoginAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  twoFactor: z.object({
    enabled: z.boolean(),
    /** Perannya wajib 2FA. */
    required: z.boolean(),
    enabledAt: isoDateTimeSchema.nullable(),
    /**
     * Wajib tetapi belum mendaftar: batas waktu mendaftar (`null` = tanpa batas, mis. Owner hasil
     * wizard setup, atau tidak wajib/sudah aktif).
     */
    enrollmentDueAt: isoDateTimeSchema.nullable(),
    /** Batas waktunya sudah lewat: perlu "Buka lagi pendaftaran 2FA" sebelum bisa masuk. */
    enrollmentExpired: z.boolean(),
  }),
  /** Jumlah sesi yang sedang berlaku. */
  activeSessions: z.number().int().nonnegative(),
  /** Pengguna ini adalah pemanggil sendiri (kelola lewat halaman Keamanan akun). */
  isSelf: z.boolean(),
  /** Pemanggil boleh mengelola pengguna ini (`canManageRole` dan bukan diri sendiri). */
  canManage: z.boolean(),
  /** Peran yang boleh dipilih pemanggil untuk pengguna ini (`[]` bila tidak bisa dikelola). */
  assignableRoles: z.array(invitableRoleSchema),
});
export type TeamUser = z.infer<typeof teamUserSchema>;

/** `GET /users` — semua pengguna organisasi (aktif dulu, lalu nonaktif), urut peran lalu nama. */
export const teamUserListResponseSchema = z.object({
  users: z.array(teamUserSchema),
  /** Peran sasaran yang boleh dikelola pemanggil (`MANAGE_PERMISSIONS`). */
  manageableRoles: z.array(userRoleSchema),
});
export type TeamUserListResponse = z.infer<typeof teamUserListResponseSchema>;

export const teamUserResponseSchema = z.object({ user: teamUserSchema });
export type TeamUserResponse = z.infer<typeof teamUserResponseSchema>;

export const userIdParamsSchema = z.object({
  userId: z.uuid({ error: 'Pengguna tidak ditemukan.' }),
});

/** `PUT /users/:userId/role` — peran baru + konfirmasi ulang identitas pelaku. */
export const changeUserRoleRequestSchema = identityConfirmationSchema.extend({
  role: invitableRoleSchema,
});
export type ChangeUserRoleRequest = z.input<typeof changeUserRoleRequestSchema>;

/**
 * Hasil aksi pengelolaan (ubah peran, nonaktifkan, aktifkan, atur ulang 2FA, buka lagi pendaftaran,
 * buka kunci): data pengguna sesudahnya + apa saja yang ikut dicabut.
 */
export const teamUserActionResponseSchema = z.object({
  user: teamUserSchema,
  /** Sesi pengguna itu yang dicabut (ia harus masuk lagi). */
  revokedSessions: z.number().int().nonnegative(),
  /** Undangan terbuka terbitan pengguna itu yang dibatalkan karena ia tidak berhak lagi. */
  revokedInvitations: z.number().int().nonnegative(),
});
export type TeamUserActionResponse = z.infer<typeof teamUserActionResponseSchema>;

// ── Sesi aktif ──────────────────────────────────────────────────────────────

export const activeSessionSchema = z.object({
  id: z.uuid(),
  /** Perkiraan peramban + sistem operasi, mis. "Chrome di Android". */
  device: z.string(),
  /** IP tersamar sebagian, mis. `203.0.113.*` atau `2001:db8:85a3:*`; `null` bila tidak tercatat. */
  ipAddress: z.string().nullable(),
  /** Waktu masuk. */
  createdAt: isoDateTimeSchema,
  /** Terakhir dipakai (diperbarui paling sering sekali per menit). */
  lastSeenAt: isoDateTimeSchema,
  /** Sesi yang sedang dipakai permintaan ini. */
  current: z.boolean(),
  /** Sesi terbatas "wajib mendaftar 2FA" (berumur 30 menit). */
  limited: z.boolean(),
  /**
   * Daftar sesi SENDIRI: sesi ini dibuat pada/sesudah sesi yang sedang dipakai, jadi mengeluarkannya
   * wajib konfirmasi identitas (`{ password, code? }` di body DELETE) — supaya cookie lama yang dicuri
   * tidak bisa terus mengusir sesi baru pemiliknya (review butir 6 R4). Sesi yang lebih lama tetap
   * satu klik. Daftar sesi pengguna lain (Owner/Admin): selalu `false`.
   * Server SELALU mengirimnya; opsional di tipe hanya supaya klien lama tetap terkompilasi.
   */
  confirmationRequired: z.boolean().optional(),
});
export type ActiveSession = z.infer<typeof activeSessionSchema>;

/** Sesi yang masih berlaku, terakhir dipakai dulu. */
export const activeSessionListResponseSchema = z.object({
  sessions: z.array(activeSessionSchema),
});
export type ActiveSessionListResponse = z.infer<typeof activeSessionListResponseSchema>;

export const sessionIdParamsSchema = z.object({
  sessionId: z.uuid({ error: 'Sesi tidak ditemukan.' }),
});
export const userSessionParamsSchema = userIdParamsSchema.extend(sessionIdParamsSchema.shape);

/**
 * Body opsional `DELETE /auth/sessions/:sessionId`: wajib bila sesi sasaran lebih baru dari sesi ini
 * (`confirmationRequired: true`); diabaikan bila tidak.
 */
// `nullish`: Fastify memberi `null` untuk DELETE tanpa body.
export const revokeOwnSessionRequestSchema = identityConfirmationSchema.nullish();

export const revokeSessionResponseSchema = z.object({ status: z.literal('revoked') });
export type RevokeSessionResponse = z.infer<typeof revokeSessionResponseSchema>;

export const revokeSessionsResponseSchema = z.object({
  revokedSessions: z.number().int().nonnegative(),
});
export type RevokeSessionsResponse = z.infer<typeof revokeSessionsResponseSchema>;
