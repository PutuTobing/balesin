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
  /**
   * Kejadian webhook masuk (Meta) yang sudah tersimpan di `webhook_events`: diproses worker di luar
   * permintaan HTTP supaya Meta dijawab cepat (ARCHITECTURE.md §4).
   */
  webhooks: 'webhooks',
  /**
   * Pemeliharaan berkala oleh worker (dijadwalkan BullMQ Job Scheduler): retensi payload
   * `webhook_events` (review webhook S4). Payload job kosong.
   */
  maintenance: 'maintenance',
  /**
   * Pesan keluar ke Meta (Fase 2 butir 6): satu job = satu baris `messages` berstatus `pending`.
   * Payload hanya ID; isi pesan dibaca worker dari database.
   */
  messages: 'messages',
  /**
   * Notifikasi Web Push (Fase 2 butir 10): satu job = satu kejadian inbox (pesan masuk, ditugaskan,
   * kembali ke antrian, tes). Payload hanya ID; penerima & isi ditentukan worker dari database.
   */
  notifications: 'notifications',
  /**
   * Webhook keluar (Fase 3): satu job berkala (`tick`, tiap 5 dtk) mengambil `outgoing_events`,
   * membuat `webhook_deliveries`, mengirim yang jatuh tempo, dan menjalankan retensi riwayat.
   */
  webhooksOut: 'webhooks-out',
  /**
   * Broadcast (Fase 4): job berkala `tick` (mulai kampanye terjadwal, sapu rem darurat, bagi kerja),
   * `run` per kampanye (payload hanya ID; kirim bertahap dengan throttle), `guard` (rem otomatis
   * lonjakan pesan keluar + retensi data penerima), `alarms` (kirim outbox alarm ke Telegram).
   */
  broadcast: 'broadcast',
  /**
   * Channel selain WhatsApp (Fase 6): `email-tick` berkala (pilih kotak masuk email yang jatuh tempo)
   * dan `email-poll` per channel (payload hanya ID; ambil email baru lewat IMAP).
   */
  channels: 'channels',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Opsi bawaan setiap job: 3 percobaan dengan jeda eksponensial; riwayat dibatasi. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 5_000 },
};

// ── Antrian `webhooks` ──────────────────────────────────────────────────────
//
// Payload HANYA ID baris `webhook_events` (+ organisasinya). Isi pesan pelanggan, App Secret, dan
// header tidak pernah masuk Redis: worker membaca payload yang sudah divalidasi dari database.

export const WEBHOOK_JOBS = {
  /** Satu kejadian WhatsApp (pesan masuk / status / error / field lain). */
  whatsappEvent: 'whatsapp-event',
} as const;
export type WebhookJobName = (typeof WEBHOOK_JOBS)[keyof typeof WEBHOOK_JOBS];

export const webhookEventJobPayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  /** `webhook_events.id`. */
  eventId: z.uuid(),
});
export type WebhookEventJobPayload = z.infer<typeof webhookEventJobPayloadSchema>;

/**
 * 8 percobaan, jeda eksponensial mulai 5 detik (5 dtk, 10 dtk, … ±10 menit total): gangguan database
 * sesaat tidak membuang pesan pelanggan. Riwayat gagal disimpan lebih lama untuk ditelusuri.
 */
export const WEBHOOK_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
  removeOnFail: { age: 14 * 24 * 60 * 60, count: 10_000 },
};

/**
 * ID job = ID kejadian: kejadian yang diantrekan dua kali (Meta mengirim ulang sementara job pertama
 * masih menunggu) tidak menjadi dua job. Pemroses tetap idempoten (status baris diperiksa) untuk
 * kasus job lama sudah dibersihkan.
 */
export function webhookEventJobId(eventId: string): string {
  return `wa-event-${eventId}`;
}

export const webhookEventJobResultSchema = z.object({
  /**
   * `processed` = dinormalisasi dan diteruskan; `skipped` = sudah diproses sebelumnya / tidak ada
   * lagi / jenis yang belum ditangani / channel-nya sudah dinonaktifkan atau dihapus
   * (`channel_inactive`, review webhook R3).
   */
  status: z.enum(['processed', 'skipped']),
  reason: z.enum(['already_done', 'not_found', 'unhandled', 'channel_inactive']).optional(),
});
export type WebhookEventJobResult = z.infer<typeof webhookEventJobResultSchema>;

// ── Antrian `messages` (pesan keluar) ───────────────────────────────────────

export const MESSAGE_JOBS = {
  /** Kirim satu pesan keluar ke Graph API. */
  send: 'send',
} as const;

export const sendMessageJobPayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  messageId: z.uuid(),
});
export type SendMessageJobPayload = z.infer<typeof sendMessageJobPayloadSchema>;

/**
 * 5 percobaan, jeda eksponensial mulai 10 detik — HANYA untuk penolakan yang jelas belum diproses
 * Meta (batas laju, gangguan sementara). Penolakan lain / koneksi putus langsung `failed` (worker).
 */
export const MESSAGE_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 10_000 },
};

/** ID job = pesan + percobaan ke-n (kirim ulang manual memakai nomor percobaan baru). */
export function sendMessageJobId(messageId: string, attempt: number): string {
  return `msg-${messageId}-${String(attempt)}`;
}

// ── Antrian `notifications` (Web Push) ──────────────────────────────────────

export const NOTIFICATION_JOBS = {
  /** Kejadian inbox → push ke penerima yang berhak & berlangganan. */
  inbox: 'inbox',
} as const;

/**
 * Jenis kejadian:
 *  - `message`  — pesan masuk baru (`messageId`);
 *  - `assigned` — percakapan ditugaskan/dialihkan ke seseorang (`actorUserId` = pelaku);
 *  - `queued`   — percakapan kembali ke antrian terbuka (`actorUserId` = pelaku);
 *  - `test`     — notifikasi tes ke perangkat pengguna sendiri (`userId`).
 */
export const NOTIFICATION_EVENT_KINDS = ['message', 'assigned', 'queued', 'test'] as const;

export const notificationJobPayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  kind: z.enum(NOTIFICATION_EVENT_KINDS),
  conversationId: z.uuid().optional(),
  messageId: z.uuid().optional(),
  actorUserId: z.uuid().optional(),
  userId: z.uuid().optional(),
});
export type NotificationJobPayload = z.infer<typeof notificationJobPayloadSchema>;

/** 3 percobaan pendek: notifikasi yang terlambat lebih dari beberapa menit tidak berguna. */
export const NOTIFICATION_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 3_000 },
  removeOnComplete: { age: 60 * 60, count: 2_000 },
  removeOnFail: { age: 24 * 60 * 60, count: 2_000 },
};

/** Pesan masuk: ID job = ID pesan (kiriman ulang webhook tidak menjadi dua notifikasi). */
export function notificationJobId(payload: NotificationJobPayload): string | undefined {
  return payload.kind === 'message' && payload.messageId
    ? `notif-msg-${payload.messageId}`
    : undefined;
}

// ── Antrian `webhooks-out` (webhook keluar) ────────────────────────────────

export const WEBHOOKS_OUT_JOBS = {
  /** Satu putaran: dispatch kejadian → kirim yang jatuh tempo → retensi. Payload kosong. */
  tick: 'tick',
} as const;
export const WEBHOOKS_OUT_TICK_INTERVAL_MS = 5_000;
export const webhooksOutJobPayloadSchema = z.strictObject({});

// ── Antrian `broadcast` ─────────────────────────────────────────────────────

export const BROADCAST_JOBS = {
  tick: 'tick',
  run: 'run',
  guard: 'guard',
  alarms: 'alarms',
} as const;
export type BroadcastJobName = (typeof BROADCAST_JOBS)[keyof typeof BROADCAST_JOBS];

export const BROADCAST_TICK_INTERVAL_MS = 2_000;
export const BROADCAST_GUARD_INTERVAL_MS = 60_000;
export const BROADCAST_ALARMS_INTERVAL_MS = 10_000;
/** Sewa pemroses satu kampanye; proses mati → diambil alih setelah sewa lewat. */
export const BROADCAST_LEASE_MS = 60_000;
/** Lama satu potongan kerja `run` sebelum job berikutnya mengambil alih. */
export const BROADCAST_SLICE_MS = 25_000;

export const broadcastRunJobPayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  campaignId: z.uuid(),
});
export type BroadcastRunJobPayload = z.infer<typeof broadcastRunJobPayloadSchema>;
export const broadcastScheduledJobPayloadSchema = z.strictObject({});

/** Satu job `run` per kampanye per jendela 5 detik (tick yang sering tidak menggandakan job). */
export function broadcastRunJobId(campaignId: string, now: number): string {
  return `bc-${campaignId}-${String(Math.floor(now / 5_000))}`;
}

// ── Antrian `maintenance` ───────────────────────────────────────────────────

export const MAINTENANCE_JOBS = {
  /** Mengosongkan payload `webhook_events` yang sudah selesai dan lebih tua dari retensi organisasi. */
  webhookPayloadRetention: 'webhook-payload-retention',
  /**
   * Klaim kirim yang macet (review ruang chat R5): pesan `pending` tanpa wamid yang klaimnya lebih
   * tua dari `SEND_CLAIM_STALE_MS` → `delivery_unknown`.
   */
  staleSendClaims: 'stale-send-claims',
  /**
   * Batas waktu bot (Fase 3): percakapan `bot` yang pesan pelanggannya tidak dibalas bot selama
   * `channels.bot_timeout_minutes` → antrian tim (`handoff` oleh sistem), tiap menit.
   */
  botTimeouts: 'bot-timeouts',
  /** Sinkron template Meta semua channel WhatsApp aktif (Fase 4), tiap 6 jam. */
  templateSync: 'template-sync',
  /**
   * Jaring pengaman kode OTP (review template Info 1): nilai template `sensitive` yang lebih tua dari
   * `SENSITIVE_TEMPLATE_MAX_AGE_MS` dikosongkan walau job kirimnya tidak pernah selesai. Tiap 10 menit.
   */
  sensitiveTemplateWipe: 'sensitive-template-wipe',
  /** CSAT otomatis (Fase 5): buat/kirim survei, terima kasih, kedaluwarsa — tiap 15 detik. */
  csatDispatch: 'csat-dispatch',
  /**
   * Jam kerja/pesan otomatis/alokasi (Fase 5): penugasan round-robin + sapaan/di luar jam kerja/
   * "ditangani agen" — tiap 10 detik.
   */
  workspaceDispatch: 'workspace-dispatch',
} as const;
export type MaintenanceJobName = (typeof MAINTENANCE_JOBS)[keyof typeof MAINTENANCE_JOBS];

/** Selang job retensi (sekali per jam; tiap jalan dibatasi jumlah barisnya). */
export const WEBHOOK_PAYLOAD_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export const maintenanceJobPayloadSchema = z.strictObject({});

/**
 * Umur klaim kirim yang masih dianggap BERJALAN (review ruang chat R5): lebih lama dari batas waktu
 * panggilan Meta. Job ganda (BullMQ stalled) yang menemukan klaim lebih muda dari ini dilewati —
 * percobaan pertama dibiarkan selesai; klaim yang lebih tua ditandai `delivery_unknown`.
 */
export const SEND_CLAIM_STALE_MS = 2 * 60 * 1000;
/** Umur maksimal nilai template sensitif (kode OTP) di `messages.extras.template`. */
export const SENSITIVE_TEMPLATE_MAX_AGE_MS = 60 * 60 * 1000;
export const SENSITIVE_TEMPLATE_WIPE_INTERVAL_MS = 10 * 60 * 1000;
/** Selang job CSAT. */
export const CSAT_DISPATCH_INTERVAL_MS = 15_000;
/** Selang job alokasi & pesan otomatis. */
export const WORKSPACE_DISPATCH_INTERVAL_MS = 10_000;
/** Selang pemeriksa klaim kirim macet. */
export const STALE_SEND_CLAIMS_INTERVAL_MS = 60 * 1000;

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
  /**
   * Ke satu Owner: channel dibuat / kredensial atau ID-nya diganti / verify token dibuat ulang /
   * dinonaktifkan / dihapus oleh pengguna SELAIN Owner. Isi (pelaku, channel, perubahan, waktu,
   * IP/perangkat) dibaca worker dari baris audit `auditLogId` — payload hanya ID.
   */
  channelChanged: 'channel-changed',
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
  /** Password Owner diganti operator server lewat `balesin reset-owner-password` (Fase 7, R4). */
  'password_changed_by_server',
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
 *  - `role_changed`, `user_disabled` — oleh Admin (bukan Owner). Penerima: Owner saja.
 */
export const SECURITY_NOTICE_ADMIN_EVENTS = [
  'two_factor_enabled',
  'two_factor_reset',
  'password_reset_without_two_factor',
  // Peran diubah / pengguna dinonaktifkan oleh SELAIN Owner (Admin): ke semua Owner aktif. Peran
  // lama → baru dibaca worker dari baris audit `auditLogId` (review butir 6 Info 6).
  'role_changed',
  'user_disabled',
  // Undangan diterima (semua peran): ke semua Owner aktif — akun baru dari cookie curian tidak
  // boleh bergabung diam-diam (review akhir Fase 1 T1). Penerbit undangan dari baris audit.
  'member_joined',
  // Atur ulang password untuk banyak akun berbeda dalam satu jam: ke semua Owner aktif (R5).
  'password_reset_burst',
  // Rem darurat pengiriman ditarik (subjek = pelaku) / batas kirim harian tercapai (subjek = pengirim
  // yang mencapai batas): ke semua Owner aktif (review ruang chat S2). Rincian dari baris audit.
  'sending_paused',
  'sending_limit_reached',
  // Rem OTOMATIS (Fase 4): lonjakan pesan keluar menghentikan semua pengiriman, atau kampanye
  // broadcast dijeda otomatis. Subjek = penerima sendiri (tidak ada pelaku); rincian dari audit.
  'sending_auto_paused',
  // Webhook keluar dinonaktifkan otomatis setelah gagal beruntun (Fase 3): ke semua Owner aktif;
  // subjek = pembuat endpoint, rincian (host, jumlah gagal) dari baris audit.
  'webhook_disabled',
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

/** Satu email per Owner penerima. Rincian kejadian diambil dari baris audit (bukan dari payload). */
export const channelChangedEmailPayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  /** Owner penerima (diperiksa ulang saat mengirim: masih aktif dan masih Owner). */
  recipientUserId: z.uuid(),
  /** Baris audit `channel.*` kejadiannya. */
  auditLogId: z.uuid(),
});
export type ChannelChangedEmailPayload = z.infer<typeof channelChangedEmailPayloadSchema>;

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

// ── Antrian `channels` (Fase 6) ─────────────────────────────────────────────

export const CHANNEL_JOBS = {
  /** Berkala: antrekan `email-poll` untuk kotak masuk yang jatuh tempo. Payload kosong. */
  emailTick: 'email-tick',
  /** Satu putaran ambil email baru satu channel. */
  emailPoll: 'email-poll',
} as const;

export const EMAIL_TICK_INTERVAL_MS = 30_000;
/** Kotak masuk yang diambil per putaran tick (sisanya tick berikutnya). */
export const EMAIL_TICK_BATCH = 50;
/** Email per putaran per channel (sisanya putaran berikutnya, segera). */
export const EMAIL_POLL_MAX_MESSAGES = 25;

export const emailPollJobPayloadSchema = z.strictObject({
  organizationId: z.uuid(),
  channelId: z.uuid(),
});
export type EmailPollJobPayload = z.infer<typeof emailPollJobPayloadSchema>;

/** Satu job menunggu per channel (tick berikutnya tidak menggandakan). */
export function emailPollJobId(channelId: string): string {
  return `email-poll-${channelId}`;
}

/**
 * Tanpa ulangan BullMQ: kegagalan dicatat di `email_mailbox_states` dan dicoba lagi sesuai jadwal.
 * Job selesai/gagal LANGSUNG dihapus — ID job per channel harus bebas lagi untuk putaran berikutnya.
 */
export const EMAIL_POLL_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: true,
  removeOnFail: true,
};
