import { z } from 'zod';

import { AUDIT_ACTIONS, type AuditAction } from './audit';
import { hasControlCharacters, isoDateTimeSchema, singleLineText } from './fields';
import { identityConfirmationSchema } from './identity';

/**
 * Channel (PRD §3.2, docs/PENGATURAN-UI.md §3, docs/SETUP-META.md) — kontrak API untuk wizard
 * koneksi WhatsApp Cloud API resmi Meta, halaman nomor (kualitas, status, batas pesan), dan profil
 * bisnis. Alur & error per kasus: docs/KONTRAK-API-CHANNEL.md.
 *
 * Token System User dan App Secret hanya pernah dikirim DARI browser KE server. Server menyimpannya
 * terenkripsi (AES-256-GCM) dan hanya mengembalikan petunjuk tersamar (`••••1234`). Verify token
 * webhook dibuat server dan hanya ditampilkan ke pemegang izin `channels.manage`.
 */

// ── Jenis & status channel ──────────────────────────────────────────────────

/** Jenis channel. Baru `whatsapp` yang bisa dibuat; sisanya disiapkan untuk fase berikutnya. */
export const CHANNEL_TYPES = ['whatsapp', 'telegram', 'email', 'messenger', 'instagram'] as const;
export const channelTypeSchema = z.enum(CHANNEL_TYPES);
export type ChannelType = z.infer<typeof channelTypeSchema>;

export const CHANNEL_TYPE_LABELS: Readonly<Record<ChannelType, string>> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  email: 'Email',
  messenger: 'Messenger',
  instagram: 'Instagram',
};

/**
 * Status koneksi dari tes terakhir atas kredensial yang TERSIMPAN sekarang. Mengganti token, App
 * Secret, Phone Number ID, atau WABA ID mengembalikan status ke `untested`.
 */
export const CHANNEL_STATUSES = ['connected', 'failed', 'untested'] as const;
export const channelStatusSchema = z.enum(CHANNEL_STATUSES);
export type ChannelStatus = z.infer<typeof channelStatusSchema>;

export const CHANNEL_STATUS_LABELS: Readonly<Record<ChannelStatus, string>> = {
  connected: 'Terhubung',
  failed: 'Gagal',
  untested: 'Belum dites',
};

/** Batas jumlah channel aktif per organisasi (mencegah penumpukan baris berisi kredensial). */
export const MAX_CHANNELS_PER_ORGANIZATION = 20;

// ── Isian wizard WhatsApp ───────────────────────────────────────────────────

export const channelNameSchema = singleLineText({
  min: 2,
  max: 60,
  requiredMessage: 'Nama channel wajib diisi.',
  tooShortMessage: 'Nama channel minimal 2 karakter.',
  tooLongMessage: 'Nama channel maksimal 60 karakter.',
});

/** ID objek Meta (Phone Number ID, WABA ID): hanya angka. */
function metaIdSchema(label: string) {
  return z
    .string({ error: `${label} wajib diisi.` })
    .trim()
    .min(1, `${label} wajib diisi.`)
    .max(32, `${label} terlalu panjang. Salin ulang dari halaman Konfigurasi API di Meta.`)
    .regex(
      /^[0-9]+$/,
      `${label} hanya berisi angka. Salin dari WhatsApp → Konfigurasi API di developers.facebook.com.`,
    )
    .min(5, `${label} terlalu pendek. Salin ulang dari halaman Konfigurasi API di Meta.`);
}

export const phoneNumberIdSchema = metaIdSchema('Phone Number ID');
export const wabaIdSchema = metaIdSchema('WhatsApp Business Account ID');

/**
 * Token System User (permanen). Spasi tepi dan baris baru dibuang — token Meta tidak pernah
 * memuatnya, sedangkan hasil tempel sering membawanya.
 */
export const metaAccessTokenSchema = z
  .string({ error: 'Token System User wajib diisi.' })
  .trim()
  .min(1, 'Token System User wajib diisi.')
  .min(20, 'Token terlalu pendek. Salin ulang token lengkap dari Pengguna Sistem di Meta.')
  .max(4096, 'Token terlalu panjang. Salin ulang token dari Pengguna Sistem di Meta.')
  .regex(
    /^[A-Za-z0-9._|-]+$/,
    'Token hanya berisi huruf dan angka tanpa spasi. Salin ulang token dari Pengguna Sistem di Meta.',
  );

/** App Secret aplikasi Meta (Pengaturan → Dasar). */
export const metaAppSecretSchema = z
  .string({ error: 'App Secret wajib diisi.' })
  .trim()
  .min(1, 'App Secret wajib diisi.')
  .regex(
    /^[A-Za-z0-9]{16,128}$/,
    'App Secret berisi huruf dan angka saja (biasanya 32 karakter). Salin dari Aplikasi → Pengaturan → Dasar → App Secret.',
  );

/**
 * `POST /settings/channels` — langkah 4–6 wizard (SETUP-META.md). Pelaku selain Owner WAJIB
 * `confirmation` (password + kode 2FA): channel baru dengan App Secret milik orang lain bisa dipakai
 * memalsukan pesan masuk ke inbox.
 */
export const createWhatsAppChannelRequestSchema = z.object({
  type: z.literal('whatsapp'),
  name: channelNameSchema,
  phoneNumberId: phoneNumberIdSchema,
  wabaId: wabaIdSchema,
  accessToken: metaAccessTokenSchema,
  appSecret: metaAppSecretSchema,
  confirmation: identityConfirmationSchema.optional(),
});

/** Satu varian per jenis channel (sekarang hanya WhatsApp). */
export const createChannelRequestSchema = z.discriminatedUnion(
  'type',
  [createWhatsAppChannelRequestSchema],
  { error: 'Jenis channel belum didukung. Saat ini baru WhatsApp.' },
);
export type CreateChannelRequest = z.input<typeof createChannelRequestSchema>;

/** Isian yang mengubah tujuan/kredensial koneksi — wajib `confirmation` (konfirmasi identitas). */
export const CHANNEL_CREDENTIAL_FIELDS = [
  'phoneNumberId',
  'wabaId',
  'accessToken',
  'appSecret',
] as const;
export type ChannelCredentialField = (typeof CHANNEL_CREDENTIAL_FIELDS)[number];

/**
 * `PATCH /settings/channels/:channelId` — hanya isian yang dikirim yang diubah. Token/App Secret
 * yang tidak dikirim tetap memakai yang tersimpan. Bila salah satu `CHANNEL_CREDENTIAL_FIELDS`
 * dikirim, `confirmation` (password + kode 2FA pelaku) WAJIB.
 */
export const updateChannelRequestSchema = z
  .object({
    name: channelNameSchema.optional(),
    phoneNumberId: phoneNumberIdSchema.optional(),
    wabaId: wabaIdSchema.optional(),
    accessToken: metaAccessTokenSchema.optional(),
    appSecret: metaAppSecretSchema.optional(),
    confirmation: identityConfirmationSchema.optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      CHANNEL_CREDENTIAL_FIELDS.some((field) => value[field] !== undefined),
    { error: 'Tidak ada yang diubah. Isi minimal satu isian.', path: ['name'] },
  );
export type UpdateChannelRequest = z.input<typeof updateChannelRequestSchema>;

/** `DELETE /settings/channels/:channelId` — konfirmasi identitas pelaku. */
export const deleteChannelRequestSchema = identityConfirmationSchema;
export type DeleteChannelRequest = z.input<typeof deleteChannelRequestSchema>;

export const channelIdParamsSchema = z.object({
  channelId: z.uuid({ error: 'Channel tidak ditemukan.' }),
});

// ── Ringkasan nomor dari Graph API ──────────────────────────────────────────

/**
 * Data nomor dari tes koneksi terakhir (`GET /{phone-number-id}`). Nilai mentah Meta disimpan apa
 * adanya (string) karena daftar nilainya bisa bertambah; label: `qualityRatingLabel`,
 * `phoneNumberStatusLabel`, `messagingLimitLabel`, `nameStatusLabel`.
 */
export const whatsAppNumberSummarySchema = z.object({
  /** Nomor tampilan, mis. `+62 811-2345-678`. */
  displayPhoneNumber: z.string().nullable(),
  /** Nama tampilan yang disetujui Meta. */
  verifiedName: z.string().nullable(),
  /** `GREEN` | `YELLOW` | `RED` | `NA` | `UNKNOWN` (bisa bertambah). */
  qualityRating: z.string().nullable(),
  /** Status nomor, mis. `CONNECTED`, `PENDING`, `FLAGGED`, `RESTRICTED`. */
  status: z.string().nullable(),
  /** Status persetujuan nama tampilan, mis. `APPROVED`, `PENDING_REVIEW`, `DECLINED`. */
  nameStatus: z.string().nullable(),
  /** `VERIFIED` | `NOT_VERIFIED` | `EXPIRED`. */
  codeVerificationStatus: z.string().nullable(),
  /** Batas pesan per 24 jam (portofolio bisnis), mis. `TIER_250`, `TIER_10K`, `TIER_UNLIMITED`. */
  messagingLimit: z.string().nullable(),
  /** Tingkat throughput, mis. `STANDARD`, `HIGH`. */
  throughputLevel: z.string().nullable(),
  fetchedAt: isoDateTimeSchema,
});
export type WhatsAppNumberSummary = z.infer<typeof whatsAppNumberSummarySchema>;

function labelOf(labels: Readonly<Record<string, string>>, value: string | null, empty: string) {
  if (value === null || value === '') return empty;
  return Object.hasOwn(labels, value) ? (labels[value] as string) : value;
}

/** Kualitas nomor (WhatsApp Manager menyebutnya Tinggi/Sedang/Rendah). */
export const QUALITY_RATING_LABELS: Readonly<Record<string, string>> = {
  GREEN: 'Tinggi',
  YELLOW: 'Sedang',
  RED: 'Rendah',
  NA: 'Belum dinilai',
  UNKNOWN: 'Belum dinilai',
};
export const qualityRatingLabel = (value: string | null) =>
  labelOf(QUALITY_RATING_LABELS, value, 'Belum dinilai');

/**
 * Status nomor. Dokumentasi Meta hanya menjamin `CONNECTED` ("nomor harus connected untuk mengirim
 * dan menerima"); nilai lain diambil dari referensi Graph API dan bisa bertambah — nilai tak dikenal
 * ditampilkan apa adanya.
 */
export const PHONE_NUMBER_STATUS_LABELS: Readonly<Record<string, string>> = {
  CONNECTED: 'Terhubung',
  PENDING: 'Menunggu',
  DISCONNECTED: 'Terputus',
  FLAGGED: 'Ditandai (kualitas rendah)',
  RESTRICTED: 'Dibatasi',
  BANNED: 'Diblokir',
  DELETED: 'Dihapus',
  MIGRATED: 'Dipindahkan',
  RATE_LIMITED: 'Terkena batas laju',
  UNVERIFIED: 'Belum diverifikasi',
  OFFLINE: 'Offline',
  UNKNOWN: 'Tidak diketahui',
};
export const phoneNumberStatusLabel = (value: string | null) =>
  labelOf(PHONE_NUMBER_STATUS_LABELS, value, 'Tidak diketahui');

/** Batas pesan bisnis per 24 jam (dokumentasi Meta: 250 → 2.000 → 10.000 → 100.000 → tak terbatas). */
export const MESSAGING_LIMIT_LABELS: Readonly<Record<string, string>> = {
  TIER_50: '50 pelanggan per 24 jam',
  TIER_250: '250 pelanggan per 24 jam',
  TIER_1K: '1.000 pelanggan per 24 jam',
  TIER_2K: '2.000 pelanggan per 24 jam',
  TIER_10K: '10.000 pelanggan per 24 jam',
  TIER_100K: '100.000 pelanggan per 24 jam',
  TIER_UNLIMITED: 'Tidak terbatas',
};
export const messagingLimitLabel = (value: string | null) =>
  labelOf(MESSAGING_LIMIT_LABELS, value, 'Belum diketahui');

export const NAME_STATUS_LABELS: Readonly<Record<string, string>> = {
  APPROVED: 'Disetujui',
  AVAILABLE_WITHOUT_REVIEW: 'Bisa dipakai tanpa peninjauan',
  DECLINED: 'Ditolak',
  EXPIRED: 'Kedaluwarsa',
  PENDING_REVIEW: 'Sedang ditinjau',
  NONE: 'Belum diajukan',
};
export const nameStatusLabel = (value: string | null) =>
  labelOf(NAME_STATUS_LABELS, value, 'Belum diketahui');

/** Peringatan dari data nomor (tes tetap berhasil, tetapi ada yang perlu dibereskan di Meta). */
export const CHANNEL_WARNING_CODES = [
  'number_not_connected',
  'quality_low',
  'quality_medium',
  'display_name_not_approved',
] as const;
export const channelWarningCodeSchema = z.enum(CHANNEL_WARNING_CODES);
export type ChannelWarningCode = z.infer<typeof channelWarningCodeSchema>;

export const CHANNEL_WARNING_MESSAGES: Readonly<Record<ChannelWarningCode, string>> = {
  number_not_connected:
    'Status nomor belum "Terhubung", jadi belum bisa mengirim dan menerima pesan. Selesaikan pendaftaran nomor (verifikasi OTP dan PIN) di WhatsApp Manager, lalu tes lagi.',
  quality_low:
    'Kualitas nomor Rendah. Kurangi pesan yang tidak diminta pelanggan; bila terus rendah, Meta bisa membatasi pengiriman.',
  quality_medium:
    'Kualitas nomor Sedang. Pantau keluhan dan blokir dari pelanggan supaya tidak turun menjadi Rendah.',
  display_name_not_approved:
    'Nama tampilan belum disetujui Meta. Periksa statusnya di WhatsApp Manager → Nomor telepon.',
};

export const channelWarningSchema = z.object({
  code: channelWarningCodeSchema,
  message: z.string(),
});
export type ChannelWarning = z.infer<typeof channelWarningSchema>;

/** Peringatan untuk ringkasan nomor (dipakai server; web cukup menampilkan `warnings` di respons). */
export function numberWarnings(number: WhatsAppNumberSummary | null): ChannelWarning[] {
  if (!number) return [];
  const codes: ChannelWarningCode[] = [];
  if (number.status !== null && number.status !== 'CONNECTED') codes.push('number_not_connected');
  if (number.qualityRating === 'RED') codes.push('quality_low');
  if (number.qualityRating === 'YELLOW') codes.push('quality_medium');
  if (
    number.nameStatus !== null &&
    !['APPROVED', 'AVAILABLE_WITHOUT_REVIEW'].includes(number.nameStatus)
  ) {
    codes.push('display_name_not_approved');
  }
  return codes.map((code) => ({ code, message: CHANNEL_WARNING_MESSAGES[code] }));
}

// ── Kesalahan dari Graph API ────────────────────────────────────────────────

/**
 * Jenis kesalahan Graph API setelah dipetakan dari kode error Meta (`@balesin/core`,
 * `classifyMetaError`). Dipakai juga oleh worker pengirim pesan nanti.
 */
export const META_ERROR_KINDS = [
  'token_invalid',
  'token_expired',
  'app_secret_invalid',
  'permission_denied',
  'not_found',
  'invalid_parameter',
  'rate_limited',
  'account_restricted',
  'phone_not_registered',
  'payment_required',
  'temporarily_unavailable',
  'network_error',
  'unexpected_response',
  'unknown',
] as const;
export const metaErrorKindSchema = z.enum(META_ERROR_KINDS);
export type MetaErrorKind = z.infer<typeof metaErrorKindSchema>;

/** Pesan per jenis kesalahan: apa yang terjadi + langkah perbaikannya. */
export const META_ERROR_MESSAGES: Readonly<Record<MetaErrorKind, string>> = {
  token_invalid:
    'Token System User ditolak Meta (salah, dicabut, atau milik aplikasi lain). Buat token baru di Pengaturan Bisnis → Pengguna Sistem, lalu ganti token di pengaturan channel.',
  token_expired:
    'Token System User sudah kedaluwarsa. Buat token baru dengan masa berlaku "Tidak pernah" di Pengaturan Bisnis → Pengguna Sistem, lalu ganti token di pengaturan channel.',
  app_secret_invalid:
    'App Secret tidak cocok dengan aplikasi pemilik token. Salin ulang dari Aplikasi → Pengaturan → Dasar → App Secret di developers.facebook.com.',
  permission_denied:
    'Token belum punya izin yang dibutuhkan. Pastikan Pengguna Sistem diberi aset aplikasi + akun WhatsApp (kontrol penuh) dan token dibuat dengan izin whatsapp_business_messaging dan whatsapp_business_management.',
  not_found:
    'Data tidak ditemukan di Meta, atau token tidak punya akses ke data itu. Periksa ID yang diisi dan aset Pengguna Sistem.',
  invalid_parameter: 'Meta menolak isian yang dikirim. Periksa lagi isiannya.',
  rate_limited:
    'Meta sedang membatasi permintaan dari akun ini. Tunggu beberapa menit, lalu coba lagi.',
  account_restricted:
    'Akun WhatsApp Business ini sedang dibatasi atau dinonaktifkan Meta karena pelanggaran kebijakan. Periksa Kualitas Akun di WhatsApp Manager.',
  phone_not_registered:
    'Nomor belum terdaftar di Cloud API. Selesaikan pendaftaran nomor (verifikasi OTP dan PIN dua langkah) di WhatsApp Manager.',
  payment_required:
    'Metode pembayaran akun WhatsApp Business belum siap. Tambahkan atau perbarui metode pembayaran di WhatsApp Manager.',
  temporarily_unavailable:
    'Layanan Meta sedang bermasalah sementara. Coba lagi beberapa menit lagi; cek juga metastatus.com.',
  network_error:
    'Server Balesin tidak bisa menghubungi Meta (koneksi terputus atau terlalu lama). Pastikan server punya akses internet keluar ke graph.facebook.com, lalu coba lagi.',
  unexpected_response:
    'Jawaban dari Meta tidak bisa dibaca. Coba lagi beberapa saat lagi; bila terus terjadi, laporkan ke pengelola Balesin.',
  unknown:
    'Meta menolak permintaan ini tanpa alasan yang dikenali. Coba lagi beberapa saat lagi; bila terus terjadi, periksa pengaturan aplikasi di developers.facebook.com.',
};

// ── Tes koneksi ─────────────────────────────────────────────────────────────

/** Kode hasil `POST /settings/channels/:channelId/test`. */
export const CHANNEL_TEST_CODES = [
  'ok',
  'token_invalid',
  'token_expired',
  'app_secret_invalid',
  'permission_denied',
  'phone_number_not_found',
  'waba_not_found',
  'phone_number_waba_mismatch',
  'phone_not_registered',
  'account_restricted',
  'rate_limited',
  'meta_unavailable',
  'network_error',
  'unexpected_response',
  'secret_unavailable',
  'unknown',
] as const;
export const channelTestCodeSchema = z.enum(CHANNEL_TEST_CODES);
export type ChannelTestCode = z.infer<typeof channelTestCodeSchema>;

export const CHANNEL_TEST_MESSAGES: Readonly<Record<ChannelTestCode, string>> = {
  ok: 'Koneksi berhasil. Token, App Secret, Phone Number ID, dan WABA ID cocok.',
  token_invalid: META_ERROR_MESSAGES.token_invalid,
  token_expired: META_ERROR_MESSAGES.token_expired,
  app_secret_invalid: META_ERROR_MESSAGES.app_secret_invalid,
  permission_denied: META_ERROR_MESSAGES.permission_denied,
  phone_number_not_found:
    'Phone Number ID tidak ditemukan, atau token tidak punya akses ke nomor itu. Salin ulang Phone Number ID dari WhatsApp → Konfigurasi API, dan pastikan akun WhatsApp sudah ditetapkan ke Pengguna Sistem.',
  waba_not_found:
    'WhatsApp Business Account ID tidak ditemukan, atau token tidak punya akses ke akun itu. Salin ulang WABA ID dari WhatsApp → Konfigurasi API.',
  phone_number_waba_mismatch:
    'Phone Number ID tidak termasuk dalam WhatsApp Business Account yang diisi. Pastikan keduanya disalin dari halaman Konfigurasi API yang sama.',
  phone_not_registered: META_ERROR_MESSAGES.phone_not_registered,
  account_restricted: META_ERROR_MESSAGES.account_restricted,
  rate_limited: META_ERROR_MESSAGES.rate_limited,
  meta_unavailable: META_ERROR_MESSAGES.temporarily_unavailable,
  network_error: META_ERROR_MESSAGES.network_error,
  unexpected_response: META_ERROR_MESSAGES.unexpected_response,
  secret_unavailable:
    'Kredensial tersimpan tidak bisa dibuka (BALESIN_MASTER_KEY server berubah). Masukkan ulang token System User dan App Secret.',
  unknown: META_ERROR_MESSAGES.unknown,
};

export const channelTestResultSchema = z.object({
  ok: z.boolean(),
  code: channelTestCodeSchema,
  /** Siap ditampilkan apa adanya. */
  message: z.string(),
  testedAt: isoDateTimeSchema,
  /** Data nomor bila Graph API sempat menjawab; `null` bila gagal sebelum itu. */
  number: whatsAppNumberSummarySchema.nullable(),
  /** Hal yang perlu dibereskan walau tes berhasil (status nomor, kualitas, nama tampilan). */
  warnings: z.array(channelWarningSchema),
});
export type ChannelTestResult = z.infer<typeof channelTestResultSchema>;

/** Hasil tes terakhir yang tersimpan (tanpa data nomor; datanya ada di `number` channel). */
export const channelLastTestSchema = z.object({
  ok: z.boolean(),
  code: channelTestCodeSchema,
  message: z.string(),
  testedAt: isoDateTimeSchema,
});
export type ChannelLastTest = z.infer<typeof channelLastTestSchema>;

// ── Tampilan channel ────────────────────────────────────────────────────────

/**
 * `GET /channels` (izin `inbox.view`, semua peran): nama channel untuk inbox/filter — tanpa ID Meta,
 * petunjuk rahasia, atau URL webhook.
 */
export const channelSummarySchema = z.object({
  id: z.uuid(),
  type: channelTypeSchema,
  name: z.string(),
  enabled: z.boolean(),
  displayPhoneNumber: z.string().nullable(),
});
export type ChannelSummary = z.infer<typeof channelSummarySchema>;

export const channelSummaryListResponseSchema = z.object({
  channels: z.array(channelSummarySchema),
});
export type ChannelSummaryListResponse = z.infer<typeof channelSummaryListResponseSchema>;

/** Channel WhatsApp untuk Pengaturan → Channel (izin `channels.manage`). */
export const whatsAppChannelSchema = z.object({
  id: z.uuid(),
  type: z.literal('whatsapp'),
  name: z.string(),
  /** `false` = dinonaktifkan (tidak menerima/mengirim pesan; kredensial tetap tersimpan). */
  enabled: z.boolean(),
  status: channelStatusSchema,
  phoneNumberId: z.string(),
  wabaId: z.string(),
  /** `••••abcd`. Token aslinya tidak pernah dikirim. */
  accessTokenHint: z.string().nullable(),
  appSecretHint: z.string().nullable(),
  /** URL webhook untuk langkah 7 wizard (verify token: `GET …/webhook`). */
  webhookUrl: z.string(),
  lastTest: channelLastTestSchema.nullable(),
  /** Data nomor dari tes berhasil terakhir; `null` bila belum pernah berhasil sejak kredensial diganti. */
  number: whatsAppNumberSummarySchema.nullable(),
  warnings: z.array(channelWarningSchema),
  /** Terakhir token/App Secret/ID diganti (awalnya = waktu dibuat). */
  credentialsUpdatedAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type WhatsAppChannel = z.infer<typeof whatsAppChannelSchema>;

export const channelResponseSchema = z.object({ channel: whatsAppChannelSchema });
export type ChannelResponse = z.infer<typeof channelResponseSchema>;

export const channelSettingsListResponseSchema = z.object({
  channels: z.array(whatsAppChannelSchema),
  /** `false` = `BALESIN_MASTER_KEY` server kosong: channel baru tidak bisa disimpan. */
  canStoreSecrets: z.boolean(),
  maxChannels: z.number().int().positive(),
});
export type ChannelSettingsListResponse = z.infer<typeof channelSettingsListResponseSchema>;

/** Field webhook yang wajib dilanggan di Meta (SETUP-META.md langkah 7). */
export const WHATSAPP_WEBHOOK_FIELDS = [
  'messages',
  'message_template_status_update',
  'account_update',
] as const;

/** `GET /settings/channels/:channelId/webhook` — HANYA `channels.manage`. */
export const channelWebhookResponseSchema = z.object({
  channelId: z.uuid(),
  /** Tempel ke "URL Callback" di Meta. */
  callbackUrl: z.string(),
  /** Tempel ke "Verify token" di Meta. */
  verifyToken: z.string(),
  verifyTokenRotatedAt: isoDateTimeSchema,
  subscribeFields: z.array(z.string()),
  /** Peringatan bila URL tidak bisa dipakai Meta (mis. bukan https). `null` = aman. */
  warning: z.string().nullable(),
});
export type ChannelWebhookResponse = z.infer<typeof channelWebhookResponseSchema>;

/** `POST /settings/channels` → 201. */
export const createChannelResponseSchema = z.object({
  channel: whatsAppChannelSchema,
  webhook: channelWebhookResponseSchema,
});
export type CreateChannelResponse = z.infer<typeof createChannelResponseSchema>;

export const deleteChannelResponseSchema = z.object({ status: z.literal('deleted') });

/** Peringatan URL webhook yang tidak bisa didaftarkan di Meta (Meta hanya menerima https publik). */
export const WEBHOOK_HTTPS_WARNING =
  'Meta hanya menerima URL webhook https yang bisa diakses dari internet. Atur API_URL server ke alamat https publik (lihat panduan instalasi) sebelum memasang webhook.';

// ── Profil bisnis ───────────────────────────────────────────────────────────

/** Kategori bisnis (`vertical`) yang diterima Meta. */
export const BUSINESS_VERTICALS = [
  'ALCOHOL',
  'APPAREL',
  'AUTO',
  'BEAUTY',
  'EDU',
  'ENTERTAIN',
  'EVENT_PLAN',
  'FINANCE',
  'GOVT',
  'GROCERY',
  'HEALTH',
  'HOTEL',
  'NONPROFIT',
  'ONLINE_GAMBLING',
  'OTC_DRUGS',
  'OTHER',
  'PHYSICAL_GAMBLING',
  'PROF_SERVICES',
  'RESTAURANT',
  'RETAIL',
  'TRAVEL',
] as const;
export const businessVerticalSchema = z.enum(BUSINESS_VERTICALS, {
  error: 'Kategori bisnis tidak dikenal. Pilih dari daftar.',
});
export type BusinessVertical = z.infer<typeof businessVerticalSchema>;

export const BUSINESS_VERTICAL_LABELS: Readonly<Record<BusinessVertical, string>> = {
  ALCOHOL: 'Minuman beralkohol',
  APPAREL: 'Pakaian',
  AUTO: 'Otomotif',
  BEAUTY: 'Kecantikan, spa, dan salon',
  EDU: 'Pendidikan',
  ENTERTAIN: 'Hiburan',
  EVENT_PLAN: 'Perencanaan acara',
  FINANCE: 'Keuangan dan perbankan',
  GOVT: 'Pemerintahan',
  GROCERY: 'Bahan makanan',
  HEALTH: 'Kesehatan',
  HOTEL: 'Hotel dan penginapan',
  NONPROFIT: 'Organisasi nirlaba',
  ONLINE_GAMBLING: 'Perjudian daring',
  OTC_DRUGS: 'Obat bebas',
  OTHER: 'Lainnya',
  PHYSICAL_GAMBLING: 'Perjudian fisik',
  PROF_SERVICES: 'Layanan profesional',
  RESTAURANT: 'Restoran',
  RETAIL: 'Belanja dan ritel',
  TRAVEL: 'Perjalanan dan transportasi',
};

export const BUSINESS_PROFILE_LIMITS = {
  about: 139,
  address: 256,
  description: 512,
  email: 128,
  websites: 2,
  website: 256,
} as const;

/** Profil bisnis seperti yang dibaca dari Meta. Isian kosong = `null` / `[]`. */
export const businessProfileSchema = z.object({
  about: z.string().nullable(),
  address: z.string().nullable(),
  description: z.string().nullable(),
  email: z.string().nullable(),
  websites: z.array(z.string()),
  /** Nilai `BUSINESS_VERTICALS`, atau nilai baru dari Meta yang belum dikenal. */
  vertical: z.string().nullable(),
});
export type BusinessProfile = z.infer<typeof businessProfileSchema>;

export const businessProfileResponseSchema = z.object({
  profile: businessProfileSchema,
  fetchedAt: isoDateTimeSchema,
});
export type BusinessProfileResponse = z.infer<typeof businessProfileResponseSchema>;

/** Teks bebas boleh berbaris (deskripsi), tetapi tanpa karakter kendali lain. */
function multilineText(max: number, label: string) {
  return z
    .string()
    .trim()
    .max(max, `${label} maksimal ${max} karakter.`)
    .refine(
      (value) => !hasControlCharacters(value.replace(/\r?\n/g, '')),
      'Tidak boleh memuat karakter khusus tak terlihat.',
    );
}

function oneLine(max: number, label: string) {
  return z
    .string()
    .trim()
    .max(max, `${label} maksimal ${max} karakter.`)
    .refine((value) => !hasControlCharacters(value), 'Tidak boleh memuat baris baru.');
}

const websiteSchema = z
  .string()
  .trim()
  .max(
    BUSINESS_PROFILE_LIMITS.website,
    `Alamat website maksimal ${BUSINESS_PROFILE_LIMITS.website} karakter.`,
  )
  // Paket ini juga ter-bundle ke browser tanpa tipe DOM/Node, jadi diperiksa dengan pola: skema
  // http(s), nama host bertitik tanpa kredensial (`@`) atau spasi, lalu path/query opsional.
  .regex(
    /^https?:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d{1,5})?(?:[/?#][^\s]*)?$/i,
    'Alamat website harus diawali https:// (atau http://), contoh: https://perusahaan.co.id',
  );

/** Isian profil bisnis (urutan tetap; juga daftar isian yang diteruskan ke Meta). */
export const BUSINESS_PROFILE_FIELDS = [
  'about',
  'address',
  'description',
  'email',
  'websites',
  'vertical',
] as const;
export type BusinessProfileField = (typeof BUSINESS_PROFILE_FIELDS)[number];

/**
 * Isian profil bisnis yang tampil ke semua pelanggan sebagai teks/tautan (website, email, Info,
 * alamat, deskripsi): mengubahnya WAJIB `confirmation` untuk semua peran, Owner juga — sesi curian
 * tidak bisa memasang tautan atau teks penipuan ("transfer hanya ke rekening …") di profil resmi
 * (review channel S1; review akhir Fase 1 S1 & putaran 2 N1). Kategori (`vertical`) saja tidak.
 */
export const BUSINESS_PROFILE_CONFIRMED_FIELDS = [
  'websites',
  'email',
  'about',
  'address',
  'description',
] as const satisfies readonly BusinessProfileField[];

export const BUSINESS_PROFILE_FIELD_LABELS: Readonly<Record<BusinessProfileField, string>> = {
  about: 'Info',
  address: 'Alamat',
  description: 'Deskripsi',
  email: 'Email',
  websites: 'Website',
  vertical: 'Kategori',
};

/**
 * `PUT /settings/channels/:channelId/business-profile`. Hanya isian yang dikirim yang diubah.
 * Teks kosong (`""`) / `websites: []` = kosongkan isian itu di Meta. `about` (Info) tidak boleh
 * dikosongkan (aturan Meta). Mengubah `websites`/`email` oleh selain Owner wajib `confirmation`.
 */
export const updateBusinessProfileRequestSchema = z
  .object({
    about: oneLine(BUSINESS_PROFILE_LIMITS.about, 'Info')
      .refine((value) => value.length > 0, 'Info tidak boleh kosong.')
      .optional(),
    address: oneLine(BUSINESS_PROFILE_LIMITS.address, 'Alamat').optional(),
    description: multilineText(BUSINESS_PROFILE_LIMITS.description, 'Deskripsi').optional(),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(
        BUSINESS_PROFILE_LIMITS.email,
        `Email maksimal ${BUSINESS_PROFILE_LIMITS.email} karakter.`,
      )
      .refine(
        (value) => value === '' || z.email().safeParse(value).success,
        'Email tidak valid. Contoh: cs@perusahaan.co.id',
      )
      .optional(),
    websites: z
      .array(websiteSchema)
      .max(BUSINESS_PROFILE_LIMITS.websites, 'Paling banyak 2 alamat website.')
      .optional(),
    vertical: z.union([businessVerticalSchema, z.literal('')]).optional(),
    confirmation: identityConfirmationSchema.optional(),
  })
  .refine((value) => BUSINESS_PROFILE_FIELDS.some((field) => value[field] !== undefined), {
    error: 'Tidak ada yang diubah. Isi minimal satu isian.',
    path: ['about'],
  });
export type UpdateBusinessProfileRequest = z.input<typeof updateBusinessProfileRequestSchema>;

/**
 * `PUT …/business-profile` → 200. `profile` = profil yang dibaca ulang dari Meta setelah diubah;
 * `null` bila pembacaan ulang gagal (perubahan TETAP sudah tersimpan di Meta — muat ulang nanti).
 */
export const updateBusinessProfileResponseSchema = z.object({
  status: z.literal('updated'),
  profile: businessProfileSchema.nullable(),
  fetchedAt: isoDateTimeSchema.nullable(),
});
export type UpdateBusinessProfileResponse = z.infer<typeof updateBusinessProfileResponseSchema>;

// ── Pemberitahuan ke Owner ──────────────────────────────────────────────────

/**
 * Perubahan channel yang, bila dilakukan SELAIN Owner (Admin), dikirim ke semua Owner aktif lewat
 * email dan muncul sebagai kejadian `warning` `channel_changed` di ringkasan keamanan. Nilai ini
 * tercatat di metadata audit (`change`) bersama `ownersNotified: true`.
 */
export const CHANNEL_CHANGE_KINDS = [
  'created',
  'credentials_changed',
  'verify_token_rotated',
  'disabled',
  'enabled',
  'deleted',
  'business_profile_changed',
] as const;
export const channelChangeKindSchema = z.enum(CHANNEL_CHANGE_KINDS);
export type ChannelChangeKind = z.infer<typeof channelChangeKindSchema>;

/** Aksi audit yang mencatat tiap jenis perubahan (satu jenis = satu aksi). */
export const CHANNEL_CHANGE_AUDIT_ACTIONS = {
  created: AUDIT_ACTIONS.channelCreated,
  credentials_changed: AUDIT_ACTIONS.channelUpdated,
  verify_token_rotated: AUDIT_ACTIONS.channelVerifyTokenRotated,
  disabled: AUDIT_ACTIONS.channelDisabled,
  enabled: AUDIT_ACTIONS.channelEnabled,
  deleted: AUDIT_ACTIONS.channelDeleted,
  business_profile_changed: AUDIT_ACTIONS.channelBusinessProfileUpdated,
} as const satisfies Readonly<Record<ChannelChangeKind, AuditAction>>;

export const channelCredentialFieldSchema = z.enum(CHANNEL_CREDENTIAL_FIELDS);

export const CHANNEL_CHANGE_LABELS: Readonly<Record<ChannelChangeKind, string>> = {
  created: 'Channel baru ditambahkan',
  credentials_changed: 'Kredensial atau ID channel diganti',
  verify_token_rotated: 'Verify token webhook dibuat ulang',
  disabled: 'Channel dinonaktifkan',
  enabled: 'Channel diaktifkan kembali',
  deleted: 'Channel dihapus',
  business_profile_changed: 'Profil bisnis WhatsApp diubah',
};

/** Nama isian kredensial untuk ditampilkan (email, banner). */
export const CHANNEL_CREDENTIAL_FIELD_LABELS: Readonly<Record<ChannelCredentialField, string>> = {
  phoneNumberId: 'Phone Number ID',
  wabaId: 'WhatsApp Business Account ID',
  accessToken: 'Token System User',
  appSecret: 'App Secret',
};
