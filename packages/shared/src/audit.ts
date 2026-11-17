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
  /**
   * Permintaan BERSESI SAH ditolak karena token CSRF salah / `Origin` asing (review akhir Fase 1 R1;
   * dibatasi 1×/menit per pengguna, lihat `csrf-rejection.ts`).
   */
  csrfRejected: 'auth.csrf.rejected',
  // ── Rem pengiriman (review ruang chat S2) ─────────────────────────────────
  /** Batas kirim harian / per percakapan diubah. */
  sendingLimitsUpdated: 'settings.sending_limits.updated',
  /** Rem darurat ditarik: semua pengiriman keluar dihentikan. */
  sendingPaused: 'sending.paused',
  /** Pengiriman dilanjutkan setelah rem darurat. */
  sendingResumed: 'sending.resumed',
  /** Batas kirim harian (pengguna/organisasi) tercapai — dicatat sekali per 24 jam per cakupan. */
  sendingLimitReached: 'sending.limit_reached',
  /**
   * Satu pengguna mengambil/menyelesaikan/mengembalikan banyak percakapan dalam waktu singkat
   * (review butir 7 R1; `actions`, `windowMinutes`, `kinds`, `actorRole`). Paling banyak sekali
   * per jam per pengguna.
   */
  inboxBulkAction: 'inbox.bulk_action',
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
  /** Saklar bot channel / jam kerja bot / batas waktu bot diubah (Fase 3). */
  channelBotUpdated: 'channel.bot_updated',
  /** Template Meta (Fase 4). */
  templateCreated: 'template.created',
  templateUpdated: 'template.updated',
  templateSubmitted: 'template.submitted',
  templateDeleted: 'template.deleted',
  templatesSynced: 'template.synced',
  channelVerifyTokenRotated: 'channel.webhook_verify_token_rotated',
  /**
   * Profil bisnis diubah: `changedFields`, nilai lama (`previous`, `null` bila tidak terbaca) dan baru
   * (`next`) — data publik, bukan rahasia.
   */
  channelBusinessProfileUpdated: 'channel.business_profile_updated',
  /** Meta menolak perubahan profil bisnis yang sudah tercatat (`auditLogId` = baris yang batal). */
  channelBusinessProfileUpdateFailed: 'channel.business_profile_update_failed',
  /**
   * Webhook WhatsApp channel ini ditolak berulang karena tanda tangan Meta tidak cocok/tidak ada
   * (`failures`, `windowMinutes`, `reason`): App Secret di Balesin tidak sama dengan aplikasi Meta,
   * atau ada pihak lain yang mencoba mengirim pesan palsu. Paling banyak sekali per jam per channel.
   * Tanpa pelaku (`actorUserId: null`); IP = pengirim terakhir yang ditolak.
   */
  channelWebhookSignatureRejected: 'channel.webhook_signature_rejected',
  /**
   * Atur ulang password diminta (dan diantre) untuk banyak akun berbeda dalam satu jam
   * (`accounts`, `windowMinutes`). Paling banyak sekali per jam per organisasi.
   */
  passwordResetBurst: 'auth.password_reset.burst',
  // ── Panel detail & quick reply (Fase 2 butir 8–9) — tanpa isi template/catatan ──
  /** Tag organisasi dibuat (`name`, `color`). */
  tagCreated: 'tag.created',
  /** Tag diganti nama/warna (`previous`, `name`, `color`). */
  tagUpdated: 'tag.updated',
  /** Tag dihapus dan dilepas dari semua kontak (`name`, `contacts`). */
  tagDeleted: 'tag.deleted',
  /**
   * Quick reply dibuat/diubah/dihapus (`shortcut`, `changedFields`, isi lama/baru dipotong ≤ 1.000 —
   * teks bisnis, bukan data pelanggan; review panel R1). `risky: true` = selain Owner MENAMBAH
   * tautan/angka panjang (`addedLinks`, `addedNumbers`) → kejadian keamanan `quick_reply_risky`.
   */
  quickReplyCreated: 'quick_reply.created',
  quickReplyUpdated: 'quick_reply.updated',
  quickReplyDeleted: 'quick_reply.deleted',
  /**
   * Kontak dihapus beserta data pribadinya (UU PDP) — HANYA ID kontak + jumlah baris yang dihapus
   * (`messages`, `conversations`, `webhookEvents`, `mediaFiles`, `hadOpenConversation`).
   */
  contactDeleted: 'contact.deleted',
  /** Data satu kontak diekspor (permintaan akses data) — ID + jumlah pesan. */
  contactExported: 'contact.exported',
  /** API key dibuat (`name`, `scopes`, `displayPrefix`, `expiresAt`, `allowedIps`, `dailySendLimit`). */
  apiKeyCreated: 'api_key.created',
  /** API key dicabut (`name`, `displayPrefix`). */
  apiKeyRevoked: 'api_key.revoked',
  /** Pengaturan API publik diubah (`docsEnabled`). */
  apiSettingsUpdated: 'settings.api.updated',
  /** Webhook keluar dibuat (`host`, `events`) — URL utuh & rahasia tidak dicatat. */
  outgoingWebhookCreated: 'webhook.created',
  /** Webhook keluar diubah (`changedFields`, `host`/`previousHost` bila URL berubah, `enabled`). */
  outgoingWebhookUpdated: 'webhook.updated',
  outgoingWebhookDeleted: 'webhook.deleted',
  outgoingWebhookSecretRotated: 'webhook.secret_rotated',
  /** Dinonaktifkan otomatis setelah gagal beruntun (`failures`, `host`); tanpa pelaku. */
  outgoingWebhookAutoDisabled: 'webhook.auto_disabled',
  /** Allowlist IP privat webhook diubah (`previous`, `cidrs`). */
  privateNetworkUpdated: 'settings.private_network.updated',
  /** Pengaturan notifikasi organisasi diubah (`preview` lama & baru). */
  notificationSettingsUpdated: 'settings.notifications.updated',
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
  'auth.2fa.enrollment_started': 'Mulai mendaftar 2FA',
  'auth.2fa.enabled': 'Verifikasi dua langkah diaktifkan',
  'auth.2fa.disabled': 'Verifikasi dua langkah dinonaktifkan',
  'auth.2fa.backup_codes_regenerated': 'Kode cadangan dibuat ulang',
  'auth.2fa.backup_code_used': 'Kode cadangan dipakai',
  'auth.2fa.enrollment_expired': 'Masuk ditolak: batas daftar 2FA lewat',
  'settings.email.updated': 'Email pengirim diubah',
  'settings.email.tested': 'Email pengirim dites',
  'user.invitation.created': 'Undangan dibuat',
  'user.invitation.resent': 'Undangan dikirim ulang',
  'user.invitation.revoked': 'Undangan dibatalkan',
  'user.invitation.accepted': 'Undangan diterima',
  'user.invitation.link_shown': 'Tautan undangan disalin manual',
  'user.invitation.rejected': 'Tautan undangan tidak berlaku dibuka',
  'auth.password_reset.requested': 'Atur ulang password diminta',
  'auth.password_reset.completed': 'Password diatur ulang',
  'auth.password_reset.failed': 'Atur ulang password gagal',
  'auth.email.verification_sent': 'Tautan verifikasi email dikirim',
  'auth.email.verified': 'Email diverifikasi',
  'auth.email.verification_failed': 'Verifikasi email gagal',
  'auth.csrf.rejected': 'Permintaan ditolak: token keamanan/asal tidak sah',
  'settings.sending_limits.updated': 'Batas kirim diubah',
  'sending.paused': 'Rem darurat pengiriman ditarik',
  'sending.resumed': 'Pengiriman dilanjutkan',
  'sending.limit_reached': 'Batas kirim harian tercapai',
  'inbox.bulk_action': 'Aksi massal di inbox',
  'auth.access.denied': 'Akses ditolak',
  'user.role_changed': 'Peran pengguna diubah',
  'user.disabled': 'Pengguna dinonaktifkan',
  'user.enabled': 'Pengguna diaktifkan kembali',
  'user.2fa.reset': '2FA pengguna diatur ulang',
  'user.2fa.enrollment_reopened': 'Pendaftaran 2FA dibuka lagi',
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
  'channel.bot_updated': 'Pengaturan bot channel diubah',
  'template.created': 'Template pesan dibuat (draf)',
  'template.updated': 'Template pesan diubah',
  'template.submitted': 'Template pesan diajukan ke Meta',
  'template.deleted': 'Template pesan dihapus',
  'template.synced': 'Template pesan disinkron dari Meta',
  'channel.webhook_verify_token_rotated': 'Verify token webhook dibuat ulang',
  'channel.business_profile_updated': 'Profil bisnis WhatsApp diubah',
  'channel.business_profile_update_failed': 'Perubahan profil bisnis ditolak Meta',
  'channel.webhook_signature_rejected': 'Webhook WhatsApp ditolak berulang',
  'auth.password_reset.burst': 'Banyak permintaan atur ulang password',
  'tag.created': 'Tag dibuat',
  'tag.updated': 'Tag diubah',
  'tag.deleted': 'Tag dihapus',
  'quick_reply.created': 'Balasan cepat dibuat',
  'quick_reply.updated': 'Balasan cepat diubah',
  'quick_reply.deleted': 'Balasan cepat dihapus',
  'settings.notifications.updated': 'Pengaturan notifikasi diubah',
  'contact.deleted': 'Kontak dihapus (UU PDP)',
  'contact.exported': 'Data kontak diekspor',
  'api_key.created': 'API key dibuat',
  'api_key.revoked': 'API key dicabut',
  'settings.api.updated': 'Pengaturan API diubah',
  'webhook.created': 'Webhook keluar dibuat',
  'webhook.updated': 'Webhook keluar diubah',
  'webhook.deleted': 'Webhook keluar dihapus',
  'webhook.secret_rotated': 'Rahasia webhook keluar dirotasi',
  'webhook.auto_disabled': 'Webhook keluar dinonaktifkan otomatis',
  'settings.private_network.updated': 'Allowlist IP privat diubah',
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
  'tag',
  'quick_reply',
  'contact',
  'api_key',
  'webhook',
  'template',
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
  tag: 'Tag',
  quick_reply: 'Balasan cepat',
  contact: 'Kontak',
  api_key: 'API key',
  webhook: 'Webhook keluar',
  template: 'Template pesan',
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
 *    dinonaktifkan, diaktifkan kembali, atau dihapus oleh SELAIN Owner (semua Owner juga diberi tahu
 *    lewat email);
 *  - `business_profile_changed` — profil bisnis WhatsApp (tampil ke semua pelanggan) diubah oleh
 *    SELAIN Owner (semua Owner juga diberi tahu lewat email);
 *  - `member_joined` — undangan diterima: akun baru bergabung (semua Owner diberi tahu lewat email);
 *  - `password_reset_burst` — atur ulang password diminta untuk banyak akun berbeda dalam waktu
 *    singkat (pola pengambilalihan massal setelah email pengirim dibelokkan);
 *  - `webhook_signature_failed` — webhook WhatsApp sebuah channel ditolak berulang karena tanda
 *    tangan Meta salah/tidak ada (App Secret tidak cocok, atau percobaan memalsukan pesan masuk).
 *
 * Perubahan channel/profil bisnis oleh Owner sendiri juga tercatat (`info`); oleh selain Owner
 * `warning`. `account_locked` per email+jaringan (bisa dipicu siapa pun tanpa akun) `info`; kunci
 * per akun / langkah kedua `warning`.
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
  'business_profile_changed',
  'member_joined',
  'password_reset_burst',
  'webhook_signature_failed',
  'sending_paused',
  'sending_limit_reached',
  'sending_limits_changed',
  'inbox_bulk_action',
  'quick_reply_risky',
  'api_key_changed',
  'webhook_changed',
  'webhook_disabled',
  /** Bot channel dinyalakan oleh SELAIN Owner (review bot R1: percakapan baru dialihkan ke bot). */
  'bot_enabled',
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
  business_profile_changed: 'warning',
  member_joined: 'warning',
  password_reset_burst: 'warning',
  webhook_signature_failed: 'warning',
  sending_paused: 'warning',
  sending_limit_reached: 'warning',
  sending_limits_changed: 'info',
  inbox_bulk_action: 'warning',
  quick_reply_risky: 'warning',
  api_key_changed: 'warning',
  webhook_changed: 'warning',
  bot_enabled: 'warning',
  webhook_disabled: 'warning',
};

export const SECURITY_EVENT_LABELS: Readonly<Record<SecurityEventKind, string>> = {
  email_sender_changed: 'Email pengirim diubah',
  two_factor_reset: '2FA pengguna diatur ulang',
  two_factor_enrollment_reopened: 'Pendaftaran 2FA dibuka lagi',
  password_reset_without_two_factor: 'Password diatur ulang tanpa 2FA',
  account_locked: 'Akun dikunci sementara',
  role_changed: 'Peran pengguna diubah',
  user_disabled: 'Pengguna dinonaktifkan',
  channel_changed: 'Channel diubah',
  business_profile_changed: 'Profil bisnis WhatsApp diubah',
  member_joined: 'Anggota baru bergabung lewat undangan',
  password_reset_burst: 'Banyak permintaan atur ulang password',
  webhook_signature_failed: 'Webhook WhatsApp ditolak berulang',
  sending_paused: 'Rem darurat pengiriman ditarik',
  sending_limit_reached: 'Batas kirim harian tercapai',
  sending_limits_changed: 'Batas kirim diubah',
  inbox_bulk_action: 'Aksi massal di inbox',
  quick_reply_risky: 'Balasan cepat diberi tautan/angka baru',
  api_key_changed: 'API key dibuat atau dicabut',
  webhook_changed: 'Webhook keluar / allowlist IP privat diubah',
  bot_enabled: 'Bot channel dinyalakan oleh selain Owner',
  webhook_disabled: 'Webhook keluar dinonaktifkan karena gagal beruntun',
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
