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
  /** Email sistem: notifikasi keamanan akun, undangan, atur ulang password, verifikasi email. */
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
  /**
   * Untuk Owner/Admin LAIN: 2FA akun ber-peran wajib (Owner/Admin/Supervisor) baru diaktifkan,
   * lengkap dengan waktu, IP, dan perangkat (mitigasi trust-on-first-use, review 2FA R5).
   */
  securityNoticeAdmin: 'security-notice-admin',
  /** Email undangan. Token diambil worker dari salinan terenkripsi di `user_invitations`. */
  invitation: 'invitation',
  /** Tautan atur ulang password / verifikasi email. Token dari salinan terenkripsi di `account_tokens`. */
  accountToken: 'account-token',
  /**
   * Ke satu Owner: sambungan/alamat email pengirim diubah pengguna selain Owner. Dikirim lewat
   * pengaturan SEBELUM perubahan (salinan di `email_settings_change_notices`), bukan yang baru.
   */
  emailSettingsChanged: 'email-settings-changed',
} as const;
export type EmailJobName = (typeof EMAIL_JOBS)[keyof typeof EMAIL_JOBS];

/** Lingkup kunci percobaan masuk (lihat `apps/api/src/modules/auth/login-rules.ts`). */
export const LOCK_SCOPES = ['source', 'account', 'device', 'two_factor'] as const;
export type LockScope = (typeof LOCK_SCOPES)[number];

/**
 * Sumber kode 2FA yang salah: langkah kedua saat masuk, konfirmasi ulang identitas di halaman
 * Keamanan akun, atau saat menyelesaikan atur ulang password.
 */
export const LOCK_TRIGGERS = ['login', 'reauth', 'password_reset'] as const;
export type LockTrigger = (typeof LOCK_TRIGGERS)[number];

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
  /**
   * Untuk `two_factor`: dari mana kode salah datang — langkah kedua saat masuk (`login`), atau
   * konfirmasi ulang identitas di halaman Keamanan akun dari sesi yang sudah masuk (`reauth`).
   */
  trigger: z.enum(LOCK_TRIGGERS).optional(),
});
export type AccountLockedEmailPayload = z.infer<typeof accountLockedEmailPayloadSchema>;

/** Kejadian yang memicu email pemberitahuan keamanan akun. */
export const SECURITY_NOTICE_EVENTS = [
  'two_factor_enabled',
  'two_factor_disabled',
  'backup_code_used',
  'backup_codes_regenerated',
  'password_changed',
  /** 2FA diatur ulang Owner/Admin (autentikator + kode cadangan dibuang). `actorUserId` = pelaku. */
  'two_factor_reset',
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
  /**
   * Baris audit kejadian ini: worker mengambil IP dan user agent dari sana untuk ditampilkan di
   * email ("dari IP …, Chrome di Windows"). ID saja — bukan IP/UA — yang masuk antrian.
   */
  auditLogId: z.uuid().optional(),
  /** Untuk `two_factor_reset`: Owner/Admin yang mengatur ulang (namanya ditampilkan di email). */
  actorUserId: z.uuid().optional(),
});
export type SecurityNoticeEmailPayload = z.infer<typeof securityNoticeEmailPayloadSchema>;

/**
 * Kejadian yang diberitahukan ke Owner/Admin lain (satu job per penerima):
 *  - `two_factor_enabled` — 2FA akun ber-peran wajib baru aktif (mitigasi TOFU, review 2FA R5).
 *    Penerima: pemegang `team.manage`.
 *  - `two_factor_reset` — 2FA seseorang diatur ulang Owner/Admin (`actorUserId` = pelaku).
 *    Penerima: Owner lain saja.
 *  - `password_reset_without_two_factor` — akun ber-peran wajib yang BELUM mendaftar 2FA mengatur
 *    ulang password-nya (review undangan R3). Penerima: pemegang `team.manage`.
 */
export const SECURITY_NOTICE_ADMIN_EVENTS = [
  'two_factor_enabled',
  'two_factor_reset',
  'password_reset_without_two_factor',
] as const;
export type SecurityNoticeAdminEvent = (typeof SECURITY_NOTICE_ADMIN_EVENTS)[number];

/** Satu email per penerima (Owner/Admin lain) supaya pengulangan job tidak menggandakan email. */
export const securityNoticeAdminEmailPayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  /** Owner/Admin penerima. */
  recipientUserId: z.uuid(),
  /** Pengguna yang mengalami kejadian (2FA-nya aktif/diatur ulang, password-nya diatur ulang). */
  subjectUserId: z.uuid(),
  event: z.enum(SECURITY_NOTICE_ADMIN_EVENTS),
  occurredAt: z.iso.datetime(),
  auditLogId: z.uuid().optional(),
  /** Untuk `two_factor_reset`: Owner/Admin yang mengatur ulang. */
  actorUserId: z.uuid().optional(),
});
export type SecurityNoticeAdminEmailPayload = z.infer<typeof securityNoticeAdminEmailPayloadSchema>;

/** Satu email per Owner penerima; isi pemberitahuan dan salinan pengaturan lama ada di barisnya. */
export const emailSettingsChangedEmailPayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  /** Owner penerima (diperiksa ulang saat mengirim: masih aktif dan masih Owner). */
  recipientUserId: z.uuid(),
  /** `email_settings_change_notices.id`. */
  noticeId: z.uuid(),
});
export type EmailSettingsChangedEmailPayload = z.infer<
  typeof emailSettingsChangedEmailPayloadSchema
>;

export const invitationEmailPayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  invitationId: z.uuid(),
  /** `user_invitations.send_count` saat diantrekan: job untuk token yang sudah diganti diabaikan. */
  sendCount: z.number().int().positive(),
});
export type InvitationEmailPayload = z.infer<typeof invitationEmailPayloadSchema>;

export const accountTokenEmailPayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  tokenId: z.uuid(),
});
export type AccountTokenEmailPayload = z.infer<typeof accountTokenEmailPayloadSchema>;

/**
 * Konteks `SecretBox` salinan token yang menunggu dikirim worker. Harus sama di api (yang
 * mengenkripsi) dan worker (yang membuka). `subjectId` mengikat teks sandi ke satu baris (dan,
 * untuk undangan, ke satu generasi token).
 */
export const DELIVERY_TOKEN_PURPOSES = {
  invitation: 'user_invitations.delivery_token',
  accountToken: 'account_tokens.delivery_token',
} as const;

export function invitationDeliveryContext(
  organizationId: string,
  invitationId: string,
  sendCount: number,
) {
  return {
    organizationId,
    purpose: DELIVERY_TOKEN_PURPOSES.invitation,
    subjectId: `${invitationId}|${sendCount}`,
  };
}

export function accountTokenDeliveryContext(organizationId: string, tokenId: string) {
  return { organizationId, purpose: DELIVERY_TOKEN_PURPOSES.accountToken, subjectId: tokenId };
}

export const emailJobResultSchema = z.object({
  /**
   * `sent` = terkirim; `skipped` = sengaja tidak dikirim (lihat `reason`) — bukan kegagalan,
   * jadi tidak diulang.
   */
  status: z.enum(['sent', 'skipped']),
  /**
   * `no_longer_valid` = tautan sudah tidak berlaku saat diproses (dibatalkan, sudah dipakai,
   * kedaluwarsa, atau sudah diganti tautan yang lebih baru) — tidak ada yang dikirim.
   */
  reason: z.enum(['email_not_configured', 'recipient_unavailable', 'no_longer_valid']).optional(),
});
export type EmailJobResult = z.infer<typeof emailJobResultSchema>;
