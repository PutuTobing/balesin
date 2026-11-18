import { z } from 'zod';

import { CHANNEL_CAPABILITIES, CHANNEL_TYPE_AVAILABILITY } from './channel-capabilities';
import {
  CHANNEL_TYPE_LABELS,
  channelNameSchema,
  channelStatusSchema,
  channelWebhookResponseSchema,
  metaAppSecretSchema,
  type ChannelType,
} from './channels';
import {
  isValidSmtpHost,
  smtpHostSchema,
  smtpPortSchema,
  SMTP_PASSWORD_MAX_LENGTH,
} from './email-settings';
import {
  emailAddressSchema,
  hasControlCharacters,
  isoDateTimeSchema,
  singleLineText,
} from './fields';
import { identityConfirmationSchema } from './identity';

/**
 * Channel selain WhatsApp (Fase 6, docs/KONTRAK-API-CHANNEL-LAIN.md): Telegram Bot, Email (IMAP
 * masuk + SMTP keluar), Facebook Messenger, Instagram DM.
 *
 * Semua rahasia (token bot, password IMAP/SMTP, Page Access Token, App Secret) hanya pernah dikirim
 * DARI browser KE server; server menyimpannya terenkripsi (AES-256-GCM) dan hanya mengembalikan
 * petunjuk tersamar (`••••1234`). Membuat channel atau mengganti kredensialnya WAJIB konfirmasi
 * identitas (password + kode 2FA) untuk semua peran, Owner juga.
 */

/** Jenis channel yang dikelola lewat `/settings/channel-connections` (WhatsApp punya rute sendiri). */
export const CONNECTION_CHANNEL_TYPES = ['telegram', 'email', 'messenger', 'instagram'] as const;
export const connectionChannelTypeSchema = z.enum(CONNECTION_CHANNEL_TYPES, {
  error: 'Jenis channel tidak dikenal. Pilih Telegram, Email, Messenger, atau Instagram.',
});
export type ConnectionChannelType = z.infer<typeof connectionChannelTypeSchema>;

// ── Telegram ────────────────────────────────────────────────────────────────

/** Token bot dari @BotFather: `<id bot>:<rahasia>`. */
export const TELEGRAM_BOT_TOKEN_PATTERN = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;

export const telegramBotTokenSchema = z
  .string({ error: 'Token bot wajib diisi.' })
  .trim()
  .min(1, 'Token bot wajib diisi.')
  .regex(
    TELEGRAM_BOT_TOKEN_PATTERN,
    'Token bot tidak valid. Salin token lengkap dari @BotFather, bentuknya 123456789:AAH….',
  );

// ── Email ───────────────────────────────────────────────────────────────────

/** IMAP WAJIB terenkripsi: SSL/TLS (993) atau STARTTLS (143). Tidak ada pilihan tanpa enkripsi. */
export const IMAP_SECURITY_MODES = ['ssl', 'starttls'] as const;
export const imapSecuritySchema = z.enum(IMAP_SECURITY_MODES, {
  error: 'Pilih keamanan SSL/TLS atau STARTTLS.',
});
export type ImapSecurity = z.infer<typeof imapSecuritySchema>;
export const IMAP_DEFAULT_PORTS: Readonly<Record<ImapSecurity, number>> = {
  ssl: 993,
  starttls: 143,
};
/** Port IMAP yang boleh dituju (permukaan SSRF). */
export const IMAP_ALLOWED_PORTS = [993, 143] as const;

/**
 * SMTP keluar channel email. `none` hanya diterima di luar production (penangkap email lokal) —
 * server menolaknya di production (TLS wajib).
 */
export const EMAIL_CHANNEL_SMTP_SECURITY_MODES = ['ssl', 'starttls', 'none'] as const;
export const emailChannelSmtpSecuritySchema = z.enum(EMAIL_CHANNEL_SMTP_SECURITY_MODES, {
  error: 'Pilih keamanan SSL/TLS atau STARTTLS.',
});

export const EMAIL_POLL_INTERVAL_MINUTES = { min: 1, max: 60, default: 2 } as const;
/** Batas satu email masuk (termasuk lampiran). Lebih besar → dilewati, dicatat di status kotak masuk. */
export const EMAIL_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
/** Batas satu lampiran yang disimpan. */
export const EMAIL_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Lampiran per email yang disimpan (sisanya dilewati, dicatat di pesan). */
export const EMAIL_MAX_ATTACHMENTS = 10;
/** HTML tersanitasi yang disimpan per email (lebih besar → hanya teks). */
export const EMAIL_MAX_HTML_BYTES = 512 * 1024;

const loginNameSchema = z
  .string({ error: 'Username wajib diisi.' })
  .trim()
  .min(1, 'Username wajib diisi.')
  .max(255, 'Username maksimal 255 karakter.')
  .refine((value) => !hasControlCharacters(value), 'Username tidak valid.');

const mailPasswordSchema = z
  .string({ error: 'Password wajib diisi.' })
  .min(1, 'Password wajib diisi.')
  .max(SMTP_PASSWORD_MAX_LENGTH, 'Password terlalu panjang.');

const imapHostSchema = z
  .string({ error: 'Host IMAP wajib diisi.' })
  .trim()
  .toLowerCase()
  .min(1, 'Host IMAP wajib diisi.')
  .max(253, 'Host IMAP terlalu panjang.')
  .refine(
    isValidSmtpHost,
    'Host IMAP tidak valid. Isi nama servernya saja, contoh: mail.perusahaan.co.id (tanpa http:// dan tanpa garis miring).',
  );

/** Nama folder IMAP (bawaan `INBOX`). Tanpa karakter kendali dan tanpa `*`/`%` (wildcard LIST). */
export const imapFolderSchema = z
  .string()
  .trim()
  .min(1, 'Nama folder wajib diisi.')
  .max(200, 'Nama folder maksimal 200 karakter.')
  .refine(
    (value) => !hasControlCharacters(value) && !/[*%"\\]/.test(value),
    'Nama folder tidak valid.',
  );

export const imapSettingsInputSchema = z.object({
  host: imapHostSchema,
  port: smtpPortSchema,
  security: imapSecuritySchema,
  username: loginNameSchema,
  /** Tidak dikirim saat mengubah = pakai password tersimpan. */
  password: mailPasswordSchema.optional(),
  folder: imapFolderSchema.default('INBOX'),
});

export const emailChannelSmtpInputSchema = z.discriminatedUnion(
  'mode',
  [
    /** Pakai Pengaturan → Email pengirim (sistem). Balasan memakai Reply-To alamat channel ini. */
    z.object({ mode: z.literal('system') }),
    z.object({
      mode: z.literal('custom'),
      host: smtpHostSchema,
      port: smtpPortSchema,
      security: emailChannelSmtpSecuritySchema,
      username: loginNameSchema,
      password: mailPasswordSchema.optional(),
    }),
  ],
  { error: 'Pilih SMTP keluar: sama dengan email pengirim sistem, atau akun terpisah.' },
);
export type EmailChannelSmtpInput = z.input<typeof emailChannelSmtpInputSchema>;

const fromNameSchema = singleLineText({
  min: 1,
  max: 100,
  requiredMessage: 'Nama pengirim wajib diisi.',
  tooLongMessage: 'Nama pengirim maksimal 100 karakter.',
});

// ── Messenger & Instagram ───────────────────────────────────────────────────

function numericMetaId(label: string) {
  return z
    .string({ error: `${label} wajib diisi.` })
    .trim()
    .min(1, `${label} wajib diisi.`)
    .regex(/^[0-9]{5,32}$/, `${label} hanya berisi angka (5–32 digit).`);
}
export const facebookPageIdSchema = numericMetaId('ID Halaman Facebook');
export const instagramAccountIdSchema = numericMetaId('ID akun Instagram');

export const pageAccessTokenSchema = z
  .string({ error: 'Page Access Token wajib diisi.' })
  .trim()
  .min(20, 'Token terlalu pendek. Salin ulang Page Access Token lengkap.')
  .max(4096, 'Token terlalu panjang.')
  .regex(/^[A-Za-z0-9._|-]+$/, 'Token hanya berisi huruf dan angka tanpa spasi.');

// ── Permintaan ──────────────────────────────────────────────────────────────

const confirmation = identityConfirmationSchema.optional();

export const createTelegramChannelSchema = z.object({
  type: z.literal('telegram'),
  name: channelNameSchema,
  botToken: telegramBotTokenSchema,
  confirmation,
});

export const createEmailChannelSchema = z.object({
  type: z.literal('email'),
  name: channelNameSchema,
  emailAddress: emailAddressSchema,
  fromName: fromNameSchema,
  imap: imapSettingsInputSchema.extend({ password: mailPasswordSchema }),
  pollIntervalMinutes: z
    .number()
    .int()
    .min(EMAIL_POLL_INTERVAL_MINUTES.min, 'Interval cek minimal 1 menit.')
    .max(EMAIL_POLL_INTERVAL_MINUTES.max, 'Interval cek maksimal 60 menit.')
    .default(EMAIL_POLL_INTERVAL_MINUTES.default),
  /** Tandai email sudah dibaca di server setelah diambil. */
  markAsRead: z.boolean().default(true),
  smtp: emailChannelSmtpInputSchema,
  confirmation,
});

export const createMessengerChannelSchema = z.object({
  type: z.literal('messenger'),
  name: channelNameSchema,
  pageId: facebookPageIdSchema,
  pageAccessToken: pageAccessTokenSchema,
  appSecret: metaAppSecretSchema,
  confirmation,
});

export const createInstagramChannelSchema = z.object({
  type: z.literal('instagram'),
  name: channelNameSchema,
  pageId: facebookPageIdSchema,
  instagramAccountId: instagramAccountIdSchema,
  pageAccessToken: pageAccessTokenSchema,
  appSecret: metaAppSecretSchema,
  confirmation,
});

/** `POST /settings/channel-connections`. */
export const createConnectionChannelRequestSchema = z.discriminatedUnion(
  'type',
  [
    createTelegramChannelSchema,
    createEmailChannelSchema,
    createMessengerChannelSchema,
    createInstagramChannelSchema,
  ],
  { error: 'Jenis channel tidak dikenal. Pilih Telegram, Email, Messenger, atau Instagram.' },
);
export type CreateConnectionChannelRequest = z.input<typeof createConnectionChannelRequestSchema>;

/**
 * `PATCH /settings/channel-connections/:channelId`. `type` wajib sama dengan channel-nya. Hanya isian
 * yang dikirim yang diubah; rahasia yang tidak dikirim tetap memakai yang tersimpan. Mengubah
 * kredensial/tujuan koneksi (token, host, username, password, alamat, ID) WAJIB `confirmation`.
 */
export const updateConnectionChannelRequestSchema = z.discriminatedUnion(
  'type',
  [
    z.object({
      type: z.literal('telegram'),
      name: channelNameSchema.optional(),
      botToken: telegramBotTokenSchema.optional(),
      confirmation,
    }),
    z.object({
      type: z.literal('email'),
      name: channelNameSchema.optional(),
      emailAddress: emailAddressSchema.optional(),
      fromName: fromNameSchema.optional(),
      imap: imapSettingsInputSchema.optional(),
      pollIntervalMinutes: z
        .number()
        .int()
        .min(EMAIL_POLL_INTERVAL_MINUTES.min, 'Interval cek minimal 1 menit.')
        .max(EMAIL_POLL_INTERVAL_MINUTES.max, 'Interval cek maksimal 60 menit.')
        .optional(),
      markAsRead: z.boolean().optional(),
      smtp: emailChannelSmtpInputSchema.optional(),
      confirmation,
    }),
    z.object({
      type: z.literal('messenger'),
      name: channelNameSchema.optional(),
      pageId: facebookPageIdSchema.optional(),
      pageAccessToken: pageAccessTokenSchema.optional(),
      appSecret: metaAppSecretSchema.optional(),
      confirmation,
    }),
    z.object({
      type: z.literal('instagram'),
      name: channelNameSchema.optional(),
      pageId: facebookPageIdSchema.optional(),
      instagramAccountId: instagramAccountIdSchema.optional(),
      pageAccessToken: pageAccessTokenSchema.optional(),
      appSecret: metaAppSecretSchema.optional(),
      confirmation,
    }),
  ],
  { error: 'Jenis channel tidak dikenal.' },
);
export type UpdateConnectionChannelRequest = z.input<typeof updateConnectionChannelRequestSchema>;

// ── Hasil tes ───────────────────────────────────────────────────────────────

export const CONNECTION_TEST_CODES = [
  'ok',
  // umum
  'secret_unavailable',
  'rate_limited',
  'network_error',
  'unexpected_response',
  'unknown',
  // Telegram
  'telegram_token_invalid',
  'telegram_webhook_not_registered',
  'telegram_webhook_url_mismatch',
  'telegram_webhook_failing',
  // Email (IMAP)
  'imap_host_not_found',
  'imap_host_blocked',
  'imap_port_not_allowed',
  'imap_connection_refused',
  'imap_connection_timeout',
  'imap_tls_failed',
  'imap_certificate_invalid',
  'imap_auth_failed',
  'imap_folder_not_found',
  // Email (SMTP keluar)
  'smtp_not_configured',
  'smtp_failed',
  // Messenger / Instagram
  'meta_token_invalid',
  'meta_app_secret_invalid',
  'meta_permission_denied',
  'meta_page_not_found',
  'meta_instagram_not_found',
  'meta_unavailable',
] as const;
export const connectionTestCodeSchema = z.enum(CONNECTION_TEST_CODES);
export type ConnectionTestCode = z.infer<typeof connectionTestCodeSchema>;

export const CONNECTION_TEST_MESSAGES: Readonly<Record<ConnectionTestCode, string>> = {
  ok: 'Koneksi berhasil. Channel siap dipakai.',
  secret_unavailable:
    'Kredensial tersimpan tidak bisa dibuka (BALESIN_MASTER_KEY server berubah). Masukkan ulang kredensial channel ini.',
  rate_limited:
    'Layanan sedang membatasi permintaan dari akun ini. Tunggu beberapa menit, lalu coba lagi.',
  network_error:
    'Server Balesin tidak bisa menghubungi layanan channel (koneksi terputus atau terlalu lama). Pastikan server punya akses internet keluar, lalu coba lagi.',
  unexpected_response:
    'Jawaban layanan channel tidak bisa dibaca. Coba lagi beberapa saat lagi; bila terus terjadi, laporkan ke pengelola Balesin.',
  unknown: 'Tes gagal karena sebab yang tidak dikenali. Periksa lagi isian, lalu coba sekali lagi.',
  telegram_token_invalid:
    'Token bot ditolak Telegram (salah atau sudah dicabut). Buat/salin ulang token di @BotFather → /mybots → API Token.',
  telegram_webhook_not_registered:
    'Webhook bot belum terpasang, jadi pesan pelanggan belum masuk. Tekan "Pasang webhook". Telegram hanya menerima alamat https publik (port 443, 80, 88, atau 8443).',
  telegram_webhook_url_mismatch:
    'Webhook bot mengarah ke alamat lain (mungkin dipakai aplikasi lain). Tekan "Pasang webhook" untuk mengarahkannya ke Balesin. Satu bot hanya bisa dipakai satu aplikasi.',
  telegram_webhook_failing:
    'Telegram gagal mengirim pesan ke Balesin akhir-akhir ini. Pastikan alamat API Balesin bisa diakses dari internet dengan sertifikat https yang sah.',
  imap_host_not_found:
    'Server email masuk (IMAP) tidak ditemukan. Periksa penulisan host IMAP, contoh: mail.perusahaan.co.id atau imap.gmail.com.',
  imap_host_blocked:
    'Alamat ini tidak boleh dipakai sebagai server email. Isi host IMAP dari penyedia email-mu.',
  imap_port_not_allowed: 'Port IMAP tidak didukung. Pakai 993 (SSL/TLS) atau 143 (STARTTLS).',
  imap_connection_refused:
    'Server IMAP menolak sambungan di port ini. Periksa port dan keamanannya: 993 untuk SSL/TLS, 143 untuk STARTTLS.',
  imap_connection_timeout:
    'Server IMAP tidak merespons. Periksa host dan port, lalu pastikan server Balesin boleh mengakses port itu (firewall).',
  imap_tls_failed:
    'Sambungan aman ke server IMAP gagal. Coba ganti keamanan: 993 memakai SSL/TLS, 143 memakai STARTTLS. Server tanpa enkripsi tidak didukung.',
  imap_certificate_invalid:
    'Sertifikat server IMAP tidak valid atau tidak cocok dengan nama host. Pakai nama host resmi dari penyedia email-mu.',
  imap_auth_failed:
    'Username atau password IMAP ditolak. Untuk Gmail dan Microsoft 365, aktifkan IMAP dan pakai app password, bukan password akun biasa.',
  imap_folder_not_found: 'Folder email tidak ditemukan di server. Biasanya cukup INBOX.',
  smtp_not_configured:
    'SMTP keluar memakai email pengirim sistem, tetapi Pengaturan → Email pengirim belum diatur. Atur dulu, atau isi akun SMTP terpisah untuk channel ini.',
  smtp_failed: 'Email masuk tersambung, tetapi SMTP keluar gagal. Lihat rinciannya di bawah.',
  meta_token_invalid:
    'Page Access Token ditolak Meta (salah, kedaluwarsa, atau dicabut). Buat token baru dari Pengguna Sistem dengan akses ke Halaman ini.',
  meta_app_secret_invalid:
    'App Secret tidak cocok dengan aplikasi pemilik token. Salin ulang dari Aplikasi → Pengaturan → Dasar → App Secret.',
  meta_permission_denied:
    'Token belum punya izin yang dibutuhkan (pages_messaging / instagram_manage_messages). Izin ini butuh App Review Meta.',
  meta_page_not_found:
    'Halaman Facebook tidak ditemukan, atau token tidak punya akses ke Halaman itu. Periksa ID Halaman.',
  meta_instagram_not_found:
    'Akun Instagram tidak ditemukan atau tidak terhubung ke Halaman ini. Pastikan akunnya akun profesional yang terhubung ke Halaman Facebook.',
  meta_unavailable: 'Layanan Meta sedang bermasalah sementara. Coba lagi beberapa menit lagi.',
};

export const CONNECTION_CHECK_NAMES = [
  'bot',
  'webhook',
  'incoming',
  'outgoing',
  'page',
  'instagram',
] as const;
export const connectionCheckSchema = z.object({
  name: z.enum(CONNECTION_CHECK_NAMES),
  ok: z.boolean(),
  code: connectionTestCodeSchema,
  /** Siap ditampilkan apa adanya (untuk `smtp_failed`: pesan kode SMTP aslinya). */
  message: z.string(),
});
export type ConnectionCheck = z.infer<typeof connectionCheckSchema>;

export const connectionTestResultSchema = z.object({
  ok: z.boolean(),
  /** Kode pemeriksaan pertama yang gagal, atau `ok`. */
  code: connectionTestCodeSchema,
  message: z.string(),
  testedAt: isoDateTimeSchema,
  checks: z.array(connectionCheckSchema),
});
export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;

export const connectionLastTestSchema = z.object({
  ok: z.boolean(),
  code: connectionTestCodeSchema,
  message: z.string(),
  testedAt: isoDateTimeSchema,
});

// ── Tampilan ────────────────────────────────────────────────────────────────

const baseView = {
  id: z.uuid(),
  name: z.string(),
  enabled: z.boolean(),
  disabledAt: isoDateTimeSchema.nullable(),
  status: channelStatusSchema,
  lastTest: connectionLastTestSchema.nullable(),
  credentialsUpdatedAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
};

export const telegramChannelSchema = z.object({
  ...baseView,
  type: z.literal('telegram'),
  /** `@username` bot (tanpa `@`), dari `getMe`. */
  botUsername: z.string().nullable(),
  botId: z.string(),
  botTokenHint: z.string().nullable(),
  webhook: z.object({
    url: z.string(),
    /** Terakhir berhasil dipasang (`setWebhook`); `null` = belum. */
    registeredAt: isoDateTimeSchema.nullable(),
    /** Alamat tidak bisa dipakai Telegram (bukan https publik). `null` = aman. */
    warning: z.string().nullable(),
  }),
});
export type TelegramChannel = z.infer<typeof telegramChannelSchema>;

export const emailMailboxStatusSchema = z.object({
  lastPolledAt: isoDateTimeSchema.nullable(),
  /** `null` = belum pernah dicek. */
  lastPollOk: z.boolean().nullable(),
  lastPollCode: connectionTestCodeSchema.nullable(),
  lastPollMessage: z.string().nullable(),
  /** Email terakhir yang dilewati karena terlalu besar / balasan otomatis (jumlah sejak dibuat). */
  skippedMessages: z.number().int().nonnegative(),
});

export const emailChannelSchema = z.object({
  ...baseView,
  type: z.literal('email'),
  emailAddress: z.string(),
  fromName: z.string(),
  imap: z.object({
    host: z.string(),
    port: z.number().int(),
    security: imapSecuritySchema,
    username: z.string(),
    passwordHint: z.string().nullable(),
    folder: z.string(),
  }),
  pollIntervalMinutes: z.number().int(),
  markAsRead: z.boolean(),
  smtp: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('system') }),
    z.object({
      mode: z.literal('custom'),
      host: z.string(),
      port: z.number().int(),
      security: emailChannelSmtpSecuritySchema,
      username: z.string(),
      passwordHint: z.string().nullable(),
    }),
  ]),
  mailbox: emailMailboxStatusSchema,
});
export type EmailChannel = z.infer<typeof emailChannelSchema>;

export const metaSocialChannelSchema = z.object({
  ...baseView,
  type: z.enum(['messenger', 'instagram']),
  pageId: z.string(),
  /** Instagram saja. */
  instagramAccountId: z.string().nullable(),
  pageAccessTokenHint: z.string().nullable(),
  appSecretHint: z.string().nullable(),
  /** URL callback webhook (verify token: `GET …/webhook`). */
  webhookUrl: z.string(),
  /** Selalu `true` (v1): butuh App Review Meta — tampilkan `reviewNote`. */
  requiresAppReview: z.literal(true),
  reviewNote: z.string(),
});
export type MetaSocialChannel = z.infer<typeof metaSocialChannelSchema>;

export const connectionChannelSchema = z.union([
  telegramChannelSchema,
  emailChannelSchema,
  metaSocialChannelSchema,
]);
export type ConnectionChannel = z.infer<typeof connectionChannelSchema>;

export const connectionChannelResponseSchema = z.object({ channel: connectionChannelSchema });

export const channelTypeInfoSchema = z.object({
  type: z.enum(['whatsapp', ...CONNECTION_CHANNEL_TYPES]),
  label: z.string(),
  available: z.boolean(),
  /** Catatan untuk ditampilkan di kartu (mis. "Butuh App Review Meta"). */
  note: z.string().nullable(),
  capabilities: z.object({
    customerWindow: z.boolean(),
    templates: z.boolean(),
    broadcast: z.boolean(),
    initiate: z.boolean(),
    quoteReply: z.boolean(),
    messageTypes: z.array(z.string()),
    maxOutboundMediaBytes: z.number().int(),
  }),
});
export type ChannelTypeInfo = z.infer<typeof channelTypeInfoSchema>;

/** Informasi semua jenis channel (urutan tetap) — untuk kartu Pengaturan → Channel. */
export function channelTypeInfos(): ChannelTypeInfo[] {
  return (['whatsapp', ...CONNECTION_CHANNEL_TYPES] as ChannelType[]).map((type) => ({
    type,
    label: CHANNEL_TYPE_LABELS[type],
    available: CHANNEL_TYPE_AVAILABILITY[type].available,
    note: CHANNEL_TYPE_AVAILABILITY[type].reason,
    capabilities: {
      ...CHANNEL_CAPABILITIES[type],
      messageTypes: [...CHANNEL_CAPABILITIES[type].messageTypes],
    },
  }));
}

/** `GET /settings/channel-connections`. */
export const connectionChannelListResponseSchema = z.object({
  channels: z.array(connectionChannelSchema),
  types: z.array(channelTypeInfoSchema),
  canStoreSecrets: z.boolean(),
  maxChannels: z.number().int().positive(),
});
export type ConnectionChannelListResponse = z.infer<typeof connectionChannelListResponseSchema>;

/** `POST /settings/channel-connections` → 201. `webhook` hanya untuk Messenger/Instagram. */
export const createConnectionChannelResponseSchema = z.object({
  channel: connectionChannelSchema,
  webhook: channelWebhookResponseSchema.nullable(),
});

/** Field webhook Messenger/Instagram yang wajib dilanggan di Meta. */
export const META_SOCIAL_WEBHOOK_FIELDS = [
  'messages',
  'messaging_postbacks',
  'message_deliveries',
  'message_reads',
] as const;

/** Peringatan alamat webhook Telegram (Telegram hanya mengirim ke https publik di port tertentu). */
export const TELEGRAM_WEBHOOK_WARNING =
  'Telegram hanya mengirim pesan ke alamat https publik di port 443, 80, 88, atau 8443. Atur API_URL server ke alamat https publik sebelum memasang webhook.';

/** HTML email tersanitasi (`GET /conversations/:id/messages/:messageId/email-html`). */
export const emailHtmlResponseSchema = z.object({
  /**
   * HTML yang SUDAH disanitasi server (tanpa skrip/gaya/gambar jarak jauh). Tetap tampilkan HANYA di
   * `<iframe sandbox>` tanpa `allow-scripts`/`allow-same-origin`.
   */
  html: z.string(),
});
export type EmailHtmlResponse = z.infer<typeof emailHtmlResponseSchema>;
