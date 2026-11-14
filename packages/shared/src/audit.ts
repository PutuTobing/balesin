import { z } from 'zod';

import { isoDateTimeSchema } from './fields';
import { userRoleSchema } from './roles';

/**
 * Audit log (PRD §3.1, SECURITY.md §10): daftar aksi, label bahasa Indonesia, dan kontrak
 * `GET /audit-logs` (+ ekspor CSV + ringkasan kejadian keamanan). Alur & error per kasus:
 * docs/KONTRAK-API-AUTH.md bagian "Audit log".
 *
 * API menulis audit HANYA dengan nama di `AUDIT_ACTIONS` (lihat `apps/api/src/modules/audit/audit.ts`),
 * jadi setiap aksi pasti punya label di sini (dijaga tes).
 */

/** Nama aksi bertitik. Tambahkan di sini setiap ada aksi baru — beserta labelnya. */
export const AUDIT_ACTIONS = {
  setupCompleted: 'setup.completed',
  loginSucceeded: 'auth.login.success',
  loginFailed: 'auth.login.failed',
  accountLocked: 'auth.account.locked',
  logout: 'auth.logout',
  twoFactorChallengeIssued: 'auth.2fa.challenge_issued',
  twoFactorFailed: 'auth.2fa.failed',
  twoFactorEnrollmentStarted: 'auth.2fa.enrollment_started',
  twoFactorEnabled: 'auth.2fa.enabled',
  twoFactorDisabled: 'auth.2fa.disabled',
  twoFactorBackupCodesRegenerated: 'auth.2fa.backup_codes_regenerated',
  twoFactorBackupCodeUsed: 'auth.2fa.backup_code_used',
  /**
   * Masuk/mulai mendaftar 2FA DITOLAK karena batas waktu pendaftaran 2FA peran wajib sudah lewat
   * (`TWO_FACTOR_ENROLLMENT_WINDOW_HOURS`, review undangan R3).
   */
  twoFactorEnrollmentExpired: 'auth.2fa.enrollment_expired',
  emailSettingsUpdated: 'settings.email.updated',
  emailSettingsTested: 'settings.email.tested',
  invitationCreated: 'user.invitation.created',
  invitationResent: 'user.invitation.resent',
  invitationRevoked: 'user.invitation.revoked',
  invitationAccepted: 'user.invitation.accepted',
  /** Tautan undangan ditampilkan ke pembuatnya untuk disalin manual (email pengirim belum diatur). */
  invitationLinkShown: 'user.invitation.link_shown',
  /** Tautan undangan yang tidak berlaku dicoba dibuka/diterima. */
  invitationRejected: 'user.invitation.rejected',
  passwordResetRequested: 'auth.password_reset.requested',
  passwordResetCompleted: 'auth.password_reset.completed',
  passwordResetFailed: 'auth.password_reset.failed',
  emailVerificationSent: 'auth.email.verification_sent',
  emailVerified: 'auth.email.verified',
  emailVerificationFailed: 'auth.email.verification_failed',
  /** Permintaan ditolak 403 karena peran tidak punya izinnya (dibatasi, lihat `access-denied.ts`). */
  accessDenied: 'auth.access.denied',
  // ── Manajemen pengguna & sesi (Fase 1 butir 6) ────────────────────────────
  userRoleChanged: 'user.role_changed',
  userDisabled: 'user.disabled',
  userEnabled: 'user.enabled',
  /** Owner/Admin mengatur ulang 2FA pengguna lain (autentikator + kode cadangan dibuang). */
  userTwoFactorReset: 'user.2fa.reset',
  /** Owner/Admin membuka lagi batas waktu pendaftaran 2FA (`TWO_FACTOR_ENROLLMENT_WINDOW_HOURS`). */
  userTwoFactorEnrollmentReopened: 'user.2fa.enrollment_reopened',
  /** Owner/Admin membuka kunci masuk/2FA pengguna lain. */
  userUnlocked: 'user.unlocked',
  /** Satu sesi dicabut (oleh pemiliknya dari daftar sesi, atau oleh Owner/Admin). */
  sessionRevoked: 'auth.session.revoked',
  /** Semua sesi (lain) dicabut sekaligus. */
  sessionsRevokedAll: 'auth.sessions.revoked_all',
  /** Audit log diekspor ke CSV. */
  auditExported: 'audit.exported',
  // ── Channel (Fase 2 butir 1–2) — metadata tidak pernah memuat token/App Secret/verify token ──
  channelCreated: 'channel.created',
  /** Nama atau kredensial diubah; `changedFields` menyebut isian yang diganti (tanpa nilainya). */
  channelUpdated: 'channel.updated',
  channelDisabled: 'channel.disabled',
  channelEnabled: 'channel.enabled',
  /** Channel dihapus: kredensialnya dimusnahkan dari database. */
  channelDeleted: 'channel.deleted',
  channelTested: 'channel.tested',
  channelVerifyTokenRotated: 'channel.webhook_verify_token_rotated',
  channelBusinessProfileUpdated: 'channel.business_profile_updated',
} as const;

export type AuditActionKey = keyof typeof AUDIT_ACTIONS;
export type AuditAction = (typeof AUDIT_ACTIONS)[AuditActionKey];

/** Semua nama aksi, berurutan seperti `AUDIT_ACTIONS`. */
export const AUDIT_ACTION_NAMES = Object.values(AUDIT_ACTIONS) as [AuditAction, ...AuditAction[]];
export const auditActionSchema = z.enum(AUDIT_ACTION_NAMES, {
  error: 'Jenis aksi tidak dikenal.',
});

/** Label aksi untuk layar Audit log dan ekspor CSV. */
export const AUDIT_ACTION_LABELS: Readonly<Record<AuditAction, string>> = {
  'setup.completed': 'Penyiapan awal selesai',
  'auth.login.success': 'Berhasil masuk',
  'auth.login.failed': 'Gagal masuk',
  'auth.account.locked': 'Akun dikunci sementara',
  'auth.logout': 'Keluar',
  'auth.2fa.challenge_issued': 'Diminta kode verifikasi dua langkah',
  'auth.2fa.failed': 'Kode verifikasi dua langkah salah',
  'auth.2fa.enrollment_started': 'Mulai mendaftarkan verifikasi dua langkah',
  'auth.2fa.enabled': 'Verifikasi dua langkah diaktifkan',
  'auth.2fa.disabled': 'Verifikasi dua langkah dinonaktifkan',
  'auth.2fa.backup_codes_regenerated': 'Kode cadangan dibuat ulang',
  'auth.2fa.backup_code_used': 'Kode cadangan dipakai',
  'auth.2fa.enrollment_expired': 'Ditolak: batas waktu daftar verifikasi dua langkah lewat',
  'settings.email.updated': 'Email pengirim diubah',
  'settings.email.tested': 'Email pengirim dites',
  'user.invitation.created': 'Undangan dibuat',
  'user.invitation.resent': 'Undangan dikirim ulang',
  'user.invitation.revoked': 'Undangan dibatalkan',
  'user.invitation.accepted': 'Undangan diterima',
  'user.invitation.link_shown': 'Tautan undangan ditampilkan untuk disalin',
  'user.invitation.rejected': 'Tautan undangan tidak berlaku dibuka',
  'auth.password_reset.requested': 'Atur ulang password diminta',
  'auth.password_reset.completed': 'Password diatur ulang',
  'auth.password_reset.failed': 'Atur ulang password gagal',
  'auth.email.verification_sent': 'Tautan verifikasi email dikirim',
  'auth.email.verified': 'Email diverifikasi',
  'auth.email.verification_failed': 'Verifikasi email gagal',
  'auth.access.denied': 'Akses ditolak',
  'user.role_changed': 'Peran pengguna diubah',
  'user.disabled': 'Pengguna dinonaktifkan',
  'user.enabled': 'Pengguna diaktifkan kembali',
  'user.2fa.reset': 'Verifikasi dua langkah pengguna diatur ulang',
  'user.2fa.enrollment_reopened': 'Pendaftaran verifikasi dua langkah dibuka lagi',
  'user.unlocked': 'Kunci akun dibuka',
  'auth.session.revoked': 'Sesi dikeluarkan',
  'auth.sessions.revoked_all': 'Semua sesi dikeluarkan',
  'audit.exported': 'Audit log diekspor',
  'channel.created': 'Channel ditambahkan',
  'channel.updated': 'Channel diubah',
  'channel.disabled': 'Channel dinonaktifkan',
  'channel.enabled': 'Channel diaktifkan kembali',
  'channel.deleted': 'Channel dihapus',
  'channel.tested': 'Koneksi channel dites',
  'channel.webhook_verify_token_rotated': 'Verify token webhook dibuat ulang',
  'channel.business_profile_updated': 'Profil bisnis WhatsApp diubah',
};

/** Label untuk aksi yang mungkin belum dikenal klien (versi lama): tampilkan kodenya apa adanya. */
export function auditActionLabel(action: string): string {
  return Object.hasOwn(AUDIT_ACTION_LABELS, action)
    ? AUDIT_ACTION_LABELS[action as AuditAction]
    : action;
}

/** Jenis target di audit log. */
export const AUDIT_TARGET_TYPES = [
  'user',
  'session',
  'invitation',
  'email_settings',
  'organization',
  'permission',
  'rule',
  'audit_log',
  'channel',
] as const;
export const auditTargetTypeSchema = z.enum(AUDIT_TARGET_TYPES, {
  error: 'Jenis target tidak dikenal.',
});
export type AuditTargetType = z.infer<typeof auditTargetTypeSchema>;

export const AUDIT_TARGET_TYPE_LABELS: Readonly<Record<AuditTargetType, string>> = {
  user: 'Pengguna',
  session: 'Sesi',
  invitation: 'Undangan',
  email_settings: 'Email pengirim',
  organization: 'Organisasi',
  permission: 'Izin',
  rule: 'Aturan akses',
  audit_log: 'Audit log',
  channel: 'Channel',
};

// ── GET /audit-logs ─────────────────────────────────────────────────────────

export const AUDIT_LOG_PAGE_DEFAULT = 50;
export const AUDIT_LOG_PAGE_MAX = 200;
/** Ekspor CSV memuat paling banyak sekian baris terbaru yang cocok dengan saringan. */
export const AUDIT_LOG_EXPORT_MAX_ROWS = 10_000;

/**
 * Kursor halaman berikutnya (`nextCursor` dari respons sebelumnya). Bentuknya tidak perlu dipahami
 * klien — kirim balik apa adanya.
 */
export const auditCursorSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, 'Kursor halaman tidak valid. Muat ulang daftar dari awal.');

const optionalUuid = (message: string) => z.uuid({ error: message }).optional();

/** Saringan bersama daftar & ekspor. Semua opsional; rentang waktu `from` ≤ waktu < `to`. */
const auditLogFilterFields = {
  /** Hanya aksi oleh pengguna ini. */
  actorUserId: optionalUuid('Pelaku tidak dikenal.'),
  /** Aksi OLEH atau TERHADAP pengguna ini (pelaku = dia, atau target = pengguna dia). */
  userId: optionalUuid('Pengguna tidak dikenal.'),
  action: auditActionSchema.optional(),
  targetType: auditTargetTypeSchema.optional(),
  targetId: z
    .string()
    .trim()
    .min(1, 'ID target tidak valid.')
    .max(100, 'ID target terlalu panjang.')
    .regex(/^[A-Za-z0-9._:-]+$/, 'ID target tidak valid.')
    .optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
};

const rangeInOrder = (value: { from?: string | undefined; to?: string | undefined }) =>
  !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to);
const RANGE_ERROR = { error: 'Waktu mulai harus sebelum waktu akhir.', path: ['to'] };

/** `GET /audit-logs/export` — saringan yang sama dengan daftar, tanpa kursor. */
export const auditLogFilterSchema = z
  .object(auditLogFilterFields)
  .refine(rangeInOrder, RANGE_ERROR);
export type AuditLogFilter = z.infer<typeof auditLogFilterSchema>;

/** `GET /audit-logs` — saringan + kursor + jumlah per halaman (bawaan `AUDIT_LOG_PAGE_DEFAULT`). */
export const auditLogListQuerySchema = z
  .object({
    ...auditLogFilterFields,
    cursor: auditCursorSchema.optional(),
    limit: z.coerce
      .number({ error: 'Jumlah per halaman harus angka.' })
      .int('Jumlah per halaman harus bilangan bulat.')
      .min(1, 'Paling sedikit 1 per halaman.')
      .max(AUDIT_LOG_PAGE_MAX, `Paling banyak ${AUDIT_LOG_PAGE_MAX} per halaman.`)
      .optional(),
  })
  .refine(rangeInOrder, RANGE_ERROR);
export type AuditLogListQuery = z.infer<typeof auditLogListQuerySchema>;

/** Nilai metadata di respons: selalu datar (nilai bersarang dikirim sebagai teks JSON). */
export const auditMetadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const auditPersonSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  /** Peran SEKARANG (bukan saat kejadian). */
  role: userRoleSchema,
});
export type AuditPerson = z.infer<typeof auditPersonSchema>;

export const auditLogEntrySchema = z.object({
  id: z.uuid(),
  createdAt: isoDateTimeSchema,
  /** Nama aksi; label: `auditActionLabel(action)`. Bisa berisi aksi yang belum dikenal klien. */
  action: z.string(),
  /** `null` = aksi sistem / pelaku belum dikenal (mis. login gagal), atau pengguna sudah tidak ada. */
  actor: auditPersonSchema.nullable(),
  target: z
    .object({
      type: z.string(),
      id: z.string().nullable(),
      /** Nama pengguna untuk target `user`; selain itu `null`. */
      name: z.string().nullable(),
    })
    .nullable(),
  /** Rincian tanpa rahasia (sudah disaring saat ditulis DAN saat dikirim). */
  metadata: z.record(z.string(), auditMetadataValueSchema),
  ipAddress: z.string().nullable(),
  /** Perkiraan peramban + sistem operasi, mis. "Chrome di Windows". */
  device: z.string().nullable(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const auditLogListResponseSchema = z.object({
  entries: z.array(auditLogEntrySchema),
  /** `null` = tidak ada halaman berikutnya. */
  nextCursor: z.string().nullable(),
});
export type AuditLogListResponse = z.infer<typeof auditLogListResponseSchema>;

// ── GET /audit-logs/security-summary ────────────────────────────────────────

/** Rentang ringkasan kejadian keamanan (banner peringatan untuk Owner/Admin). */
export const SECURITY_SUMMARY_DAYS = 7;
export const SECURITY_SUMMARY_MAX_EVENTS = 20;

/**
 * Kejadian yang patut diketahui Owner:
 *  - `email_sender_changed` — server/alamat email pengirim diubah oleh selain Owner (review RBAC S1);
 *  - `two_factor_reset` — 2FA seseorang diatur ulang Owner/Admin;
 *  - `two_factor_enrollment_reopened` — pendaftaran 2FA peran wajib dibuka lagi;
 *  - `password_reset_without_two_factor` — akun peran wajib-2FA yang belum mendaftar 2FA mengatur
 *    ulang password-nya (review undangan R3);
 *  - `account_locked` — akun dikunci sementara karena gagal masuk/kode 2FA berulang;
 *  - `role_changed`, `user_disabled` — perubahan wewenang di tim;
 *  - `channel_changed` — channel dibuat, kredensial/ID-nya diganti, verify token dibuat ulang,
 *    dinonaktifkan, atau dihapus oleh SELAIN Owner (semua Owner juga diberi tahu lewat email).
 */
export const SECURITY_EVENT_KINDS = [
  'email_sender_changed',
  'two_factor_reset',
  'two_factor_enrollment_reopened',
  'password_reset_without_two_factor',
  'account_locked',
  'role_changed',
  'user_disabled',
  'channel_changed',
] as const;
export const securityEventKindSchema = z.enum(SECURITY_EVENT_KINDS);
export type SecurityEventKind = z.infer<typeof securityEventKindSchema>;

/**
 * Keparahan BAWAAN: `warning` = tampilkan sebagai banner peringatan; `info` = cukup di daftar.
 * Server bisa menaikkannya per kejadian (ubah peran / nonaktifkan oleh SELAIN Owner → `warning`),
 * jadi web selalu memakai `event.severity` dari respons, bukan tabel ini.
 */
export const SECURITY_EVENT_SEVERITY: Readonly<Record<SecurityEventKind, 'warning' | 'info'>> = {
  email_sender_changed: 'warning',
  two_factor_reset: 'warning',
  two_factor_enrollment_reopened: 'info',
  password_reset_without_two_factor: 'warning',
  account_locked: 'warning',
  role_changed: 'info',
  user_disabled: 'info',
  channel_changed: 'warning',
};

export const SECURITY_EVENT_LABELS: Readonly<Record<SecurityEventKind, string>> = {
  email_sender_changed: 'Email pengirim diubah oleh selain Owner',
  two_factor_reset: 'Verifikasi dua langkah pengguna diatur ulang',
  two_factor_enrollment_reopened: 'Pendaftaran verifikasi dua langkah dibuka lagi',
  password_reset_without_two_factor:
    'Akun yang belum memakai verifikasi dua langkah mengatur ulang password',
  account_locked: 'Akun dikunci sementara',
  role_changed: 'Peran pengguna diubah',
  user_disabled: 'Pengguna dinonaktifkan',
  channel_changed: 'Channel diubah oleh selain Owner',
};

export const securityEventSchema = z.object({
  /** ID baris audit (buka di Audit log dengan saringan `targetId`/`userId`). */
  id: z.uuid(),
  kind: securityEventKindSchema,
  severity: z.enum(['warning', 'info']),
  occurredAt: isoDateTimeSchema,
  actor: auditPersonSchema.nullable(),
  /** Pengguna yang terkena (untuk kejadian tentang pengguna). */
  subject: z.object({ id: z.uuid(), name: z.string(), role: userRoleSchema }).nullable(),
  details: z.record(z.string(), auditMetadataValueSchema),
});
export type SecurityEvent = z.infer<typeof securityEventSchema>;

export const securitySummaryResponseSchema = z.object({
  /** Awal rentang (sekarang − `SECURITY_SUMMARY_DAYS` hari). */
  since: isoDateTimeSchema,
  /** Kejadian terbaru dulu, maks. `SECURITY_SUMMARY_MAX_EVENTS`. */
  events: z.array(securityEventSchema),
  /** Jumlah per jenis dalam rentang (bisa lebih dari yang dimuat `events`). */
  counts: z.record(securityEventKindSchema, z.number().int().nonnegative()),
  /** Waktu kejadian `warning` terbaru, atau `null`. Web membandingkannya dengan "terakhir ditutup". */
  latestWarningAt: isoDateTimeSchema.nullable(),
});
export type SecuritySummaryResponse = z.infer<typeof securitySummaryResponseSchema>;
