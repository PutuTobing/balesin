import { z } from 'zod';

/**
 * Definisi antrian BullMQ yang dipakai bersama: api (produsen) dan worker (konsumen).
 * Hanya nama, skema payload, dan opsi — tanpa impor BullMQ, supaya paket ini tetap ringan.
 */

/** Awalan semua kunci BullMQ di Redis. */
export const QUEUE_PREFIX = 'balesin';

export const QUEUE_NAMES = {
  /** Pekerjaan internal: uji antrian, nanti pembersihan sesi kedaluwarsa, dsb. */
  system: 'system',
  /** Email sistem (notifikasi akun; nanti undangan dan reset password). */
  email: 'email',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Opsi bawaan setiap job: 3 percobaan dengan jeda eksponensial; riwayat dibatasi. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 5_000 },
};

// ── Antrian `system` ────────────────────────────────────────────────────────

export const SYSTEM_JOBS = {
  /** Uji ujung-ke-ujung: produsen → Redis → worker. Dipakai pemeriksaan kesehatan antrian. */
  ping: 'ping',
} as const;
export type SystemJobName = (typeof SYSTEM_JOBS)[keyof typeof SYSTEM_JOBS];

export const systemPingPayloadSchema = z.strictObject({
  /** Waktu job dibuat (ISO 8601), untuk mengukur lama menunggu di antrian. */
  requestedAt: z.iso.datetime(),
});
export type SystemPingPayload = z.infer<typeof systemPingPayloadSchema>;

export const systemPingResultSchema = z.object({
  processedAt: z.iso.datetime(),
  /** Lama job menunggu sampai diproses, dalam milidetik. */
  waitedMs: z.number(),
});
export type SystemPingResult = z.infer<typeof systemPingResultSchema>;

// ── Antrian `email` ─────────────────────────────────────────────────────────
//
// Payload HANYA memuat ID dan waktu — tidak pernah token, password SMTP, atau rahasia lain.
// BullMQ menyimpan payload, `failedReason`, dan stack di Redis. Worker mengambil sendiri alamat
// penerima dan pengaturan SMTP dari database, lalu membuka password-nya tepat saat mengirim.

export const EMAIL_JOBS = {
  /** Pemberitahuan ke pemilik akun: akunnya dikunci sementara karena gagal masuk berulang. */
  accountLocked: 'account-locked',
  /**
   * Pemberitahuan keamanan akun: 2FA diaktifkan/dinonaktifkan, kode cadangan dipakai. Selalu
   * dikirim ke pemilik akun supaya perubahan yang bukan olehnya segera ketahuan.
   */
  securityNotice: 'security-notice',
} as const;
export type EmailJobName = (typeof EMAIL_JOBS)[keyof typeof EMAIL_JOBS];

/** Lingkup kunci percobaan masuk (lihat `apps/api/src/modules/auth/login-rules.ts`). */
export const LOCK_SCOPES = ['source', 'account', 'device', 'two_factor'] as const;
export type LockScope = (typeof LOCK_SCOPES)[number];

export const accountLockedEmailPayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  userId: z.uuid(),
  /** Waktu kunci berakhir (ISO 8601). */
  lockedUntil: z.iso.datetime(),
  /**
   * `source` = percobaan dari satu jaringan dihentikan; `account` = percobaan dari banyak
   * jaringan, akun dikunci untuk perangkat yang belum dikenal; `device` = dari perangkat dikenal;
   * `two_factor` = password benar tetapi kode verifikasi dua langkah salah berulang kali.
   */
  scope: z.enum(LOCK_SCOPES).default('account'),
});
export type AccountLockedEmailPayload = z.infer<typeof accountLockedEmailPayloadSchema>;

/** Kejadian yang memicu email pemberitahuan keamanan akun. */
export const SECURITY_NOTICE_EVENTS = [
  'two_factor_enabled',
  'two_factor_disabled',
  'backup_code_used',
  'backup_codes_regenerated',
] as const;
export type SecurityNoticeEvent = (typeof SECURITY_NOTICE_EVENTS)[number];

export const securityNoticeEmailPayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  userId: z.uuid(),
  event: z.enum(SECURITY_NOTICE_EVENTS),
  /** Waktu kejadian (ISO 8601). */
  occurredAt: z.iso.datetime(),
  /** Untuk `backup_code_used`: sisa kode cadangan yang belum dipakai. */
  backupCodesRemaining: z.number().int().nonnegative().optional(),
});
export type SecurityNoticeEmailPayload = z.infer<typeof securityNoticeEmailPayloadSchema>;

export const emailJobResultSchema = z.object({
  /**
   * `sent` = terkirim; `skipped` = sengaja tidak dikirim (lihat `reason`) — bukan kegagalan,
   * jadi tidak diulang.
   */
  status: z.enum(['sent', 'skipped']),
  reason: z.enum(['email_not_configured', 'recipient_unavailable']).optional(),
});
export type EmailJobResult = z.infer<typeof emailJobResultSchema>;
