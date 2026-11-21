import { z } from 'zod';

import {
  emailAddressSchema,
  hasControlCharacters,
  isoDateTimeSchema,
  singleLineText,
} from './fields';
import { identityConfirmationSchema } from './identity';

/**
 * Email pengirim sistem (undangan, reset password, notifikasi) — docs/PENGATURAN-UI.md §1.
 * Diisi lewat wizard setup langkah "Email" dan Pengaturan → Email pengirim.
 *
 * Password SMTP hanya pernah dikirim DARI browser KE server. Server menyimpannya terenkripsi
 * dan hanya mengembalikan petunjuk tersamar (`••••1234`).
 */

// ── Keamanan sambungan & port ───────────────────────────────────────────────

export const SMTP_SECURITY_MODES = ['ssl', 'starttls', 'none'] as const;
export const smtpSecuritySchema = z.enum(SMTP_SECURITY_MODES, {
  error: 'Pilih keamanan sambungan: SSL/TLS, STARTTLS, atau Tanpa enkripsi.',
});
export type SmtpSecurity = z.infer<typeof smtpSecuritySchema>;

export const SMTP_SECURITY_LABELS: Record<SmtpSecurity, string> = {
  ssl: 'SSL/TLS',
  starttls: 'STARTTLS',
  none: 'Tanpa enkripsi',
};

/** Port yang lazim untuk tiap pilihan keamanan (dipakai saat pengguna mengganti pilihan). */
export const SMTP_DEFAULT_PORTS: Record<SmtpSecurity, number> = {
  ssl: 465,
  starttls: 587,
  none: 25,
};

/**
 * Port SMTP yang diterima server. Port lain ditolak: tes koneksi adalah permintaan keluar ke
 * host pilihan pengguna, jadi tidak boleh bisa dipakai memindai port sembarang.
 */
export const SMTP_ALLOWED_PORTS = [25, 465, 587, 2525] as const;

/**
 * Peringatan untuk form saat pengguna memilih "Tanpa enkripsi" dan mengisi username: password
 * akan terkirim polos. Di production server menolak kombinasi ini untuk host di internet
 * (kode hasil `insecure_login`); untuk server di jaringan lokal tetap boleh.
 */
export const SMTP_PLAINTEXT_LOGIN_WARNING =
  'Tanpa enkripsi, password email terkirim tanpa perlindungan. Pakai pilihan ini hanya untuk server email di jaringan lokal kantormu.';

/** `true` bila isian form akan mengirim login tanpa enkripsi (tampilkan `SMTP_PLAINTEXT_LOGIN_WARNING`). */
export function isPlaintextSmtpLogin(input: {
  security: SmtpSecurity;
  username?: string | null;
}): boolean {
  return (
    input.security === 'none' &&
    input.username !== null &&
    input.username !== undefined &&
    input.username.trim() !== ''
  );
}

// ── Preset satu klik ────────────────────────────────────────────────────────

export const SMTP_PRESET_IDS = ['cpanel', 'gmail', 'outlook', 'other'] as const;
export type SmtpPresetId = (typeof SMTP_PRESET_IDS)[number];

export interface SmtpPreset {
  id: SmtpPresetId;
  label: string;
  /** Host tetap; `null` bila host diturunkan dari domain email (`hostPrefix`) atau diisi manual. */
  host: string | null;
  /** Awalan host yang digabung dengan domain email, mis. `mail.` → `mail.perusahaan.co.id`. */
  hostPrefix: string | null;
  port: number | null;
  security: SmtpSecurity | null;
  /** `true` = penyedia menolak password akun biasa; pengguna harus membuat app password. */
  requiresAppPassword: boolean;
  /** Petunjuk singkat yang ditampilkan di bawah pilihan preset. */
  hint: string;
}

export const SMTP_PRESETS: readonly SmtpPreset[] = [
  {
    id: 'cpanel',
    label: 'cPanel / IDCloudHost',
    host: null,
    hostPrefix: 'mail.',
    port: 465,
    security: 'ssl',
    requiresAppPassword: false,
    hint: 'Email dari hosting (cPanel). Host biasanya mail.<domain kamu>, port 465 dengan SSL/TLS. Pakai password akun email itu.',
  },
  {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    host: 'smtp.gmail.com',
    hostPrefix: null,
    port: 587,
    security: 'starttls',
    requiresAppPassword: true,
    hint: 'Wajib memakai app password (16 karakter), bukan password akun Google. Aktifkan verifikasi 2 langkah dulu, lalu buat app password di pengaturan akun Google.',
  },
  {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    host: 'smtp.office365.com',
    hostPrefix: null,
    port: 587,
    security: 'starttls',
    requiresAppPassword: true,
    hint: 'Pakai app password bila akun memakai verifikasi 2 langkah, dan pastikan "Authenticated SMTP" aktif untuk kotak surat ini.',
  },
  {
    id: 'other',
    label: 'Lainnya',
    host: null,
    hostPrefix: null,
    port: null,
    security: null,
    requiresAppPassword: false,
    hint: 'Isi host, port, dan keamanan sesuai petunjuk penyedia email-mu.',
  },
];

/** Bagian setelah `@` dari alamat email (huruf kecil), atau `null` bila bentuknya tidak wajar. */
export function emailDomainOf(emailAddress: string): string | null {
  const at = emailAddress.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = emailAddress
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)
    ? domain
    : null;
}

/**
 * Nilai host/port/keamanan untuk sebuah preset. Isian yang tidak ditentukan preset bernilai
 * `null` (biarkan isi form apa adanya). Preset "Lainnya" tidak mengubah apa pun.
 */
export function applySmtpPreset(
  presetId: SmtpPresetId,
  emailAddress: string,
): { host: string | null; port: number | null; security: SmtpSecurity | null } {
  const preset = SMTP_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) return { host: null, port: null, security: null };
  const domain = emailDomainOf(emailAddress);
  const host =
    preset.host ?? (preset.hostPrefix && domain ? `${preset.hostPrefix}${domain}` : null);
  return { host, port: preset.port, security: preset.security };
}

// ── Isian form ──────────────────────────────────────────────────────────────

const HOST_LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_PATTERN = new RegExp(`^${HOST_LABEL}(\\.${HOST_LABEL})*$`);

/** Nama host atau alamat IP — tanpa skema, port, atau path. */
export function isValidSmtpHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (host.includes(':')) return /^[0-9a-f:.]+$/.test(host);
  return HOSTNAME_PATTERN.test(host);
}

export const smtpHostSchema = z
  .string({ error: 'Host SMTP wajib diisi.' })
  .trim()
  .toLowerCase()
  .min(1, 'Host SMTP wajib diisi.')
  .max(253, 'Host SMTP terlalu panjang.')
  .refine(
    isValidSmtpHost,
    'Host SMTP tidak valid. Isi nama servernya saja, contoh: mail.perusahaan.co.id (tanpa http:// dan tanpa garis miring).',
  );

export const smtpPortSchema = z
  .number({ error: 'Port wajib diisi dengan angka.' })
  .int('Port harus berupa angka bulat.')
  .min(1, 'Port harus di antara 1 dan 65535.')
  .max(65_535, 'Port harus di antara 1 dan 65535.');

export const SMTP_PASSWORD_MAX_LENGTH = 1024;

export const emailSettingsInputSchema = z.object({
  /** Nama yang tampil sebagai pengirim, mis. "Balesin Maju Jaya". */
  fromName: singleLineText({
    min: 1,
    max: 100,
    requiredMessage: 'Nama pengirim wajib diisi.',
    tooLongMessage: 'Nama pengirim maksimal 100 karakter.',
  }),
  fromAddress: emailAddressSchema,
  /** Opsional: balasan penerima diarahkan ke alamat ini. */
  replyTo: emailAddressSchema.nullish(),
  host: smtpHostSchema,
  port: smtpPortSchema,
  security: smtpSecuritySchema,
  /** Kosong/`null` = server tidak butuh login (jarang; relay internal). Bawaan di form: alamat email pengirim. */
  username: z
    .string()
    .trim()
    .min(1, 'Username wajib diisi, atau kosongkan bila server tidak meminta username dan password.')
    .max(255, 'Username maksimal 255 karakter.')
    .refine((value) => !hasControlCharacters(value), 'Username tidak valid.')
    .nullish(),
  /**
   * Password / app password. Tidak dikirim = pakai password yang sudah tersimpan (hanya boleh
   * bila host dan username tidak berubah). Tidak pernah dikembalikan server.
   */
  password: z
    .string()
    .min(1, 'Password wajib diisi.')
    .max(SMTP_PASSWORD_MAX_LENGTH, 'Password terlalu panjang.')
    .optional(),
});
export type EmailSettingsInput = z.infer<typeof emailSettingsInputSchema>;

// ── Hasil tes ───────────────────────────────────────────────────────────────

export const EMAIL_TEST_CODES = [
  'ok',
  'not_configured',
  'host_not_found',
  'host_blocked',
  'port_not_allowed',
  'connection_refused',
  'connection_timeout',
  'tls_failed',
  'certificate_invalid',
  'auth_failed',
  'auth_unsupported',
  'insecure_login',
  'sender_rejected',
  'recipient_rejected',
  'message_rejected',
  'secret_unavailable',
  'unknown',
] as const;
export const emailTestCodeSchema = z.enum(EMAIL_TEST_CODES);
export type EmailTestCode = z.infer<typeof emailTestCodeSchema>;

/**
 * Pesan untuk tiap hasil tes: apa yang terjadi + apa yang perlu dilakukan. Server selalu
 * memakai pesan dari daftar ini — balasan mentah server email tidak pernah diteruskan.
 */
export const EMAIL_TEST_MESSAGES: Record<EmailTestCode, string> = {
  ok: 'Berhasil terhubung ke server email. Pengaturan ini siap dipakai.',
  not_configured: 'Email pengirim belum diatur. Isi dulu pengaturannya, lalu jalankan tes.',
  host_not_found:
    'Server email tidak ditemukan. Periksa lagi penulisan host SMTP, contoh: mail.perusahaan.co.id.',
  host_blocked:
    'Alamat ini tidak boleh dipakai sebagai server email. Isi host SMTP dari penyedia email-mu.',
  port_not_allowed:
    'Port ini tidak didukung. Pakai 465 (SSL/TLS), 587 (STARTTLS), atau 25/2525 (tanpa enkripsi).',
  connection_refused:
    'Server menolak sambungan di port ini. Periksa port dan pilihan keamanannya: 465 untuk SSL/TLS, 587 untuk STARTTLS.',
  connection_timeout:
    'Server email tidak merespons. Periksa host dan port, lalu pastikan server aplikasi boleh mengakses port itu (firewall).',
  tls_failed:
    'Sambungan aman gagal dibuat. Coba ganti pilihan keamanan: port 465 memakai SSL/TLS, port 587 memakai STARTTLS.',
  certificate_invalid:
    'Sertifikat keamanan server email tidak valid atau tidak cocok dengan nama host. Pakai nama host resmi dari penyedia email-mu.',
  auth_failed:
    'Username atau password ditolak server email. Periksa lagi keduanya. Untuk Gmail dan Microsoft 365, pakai app password, bukan password akun biasa.',
  auth_unsupported:
    'Server email tidak menerima cara masuk ini. Coba pilihan keamanan lain (SSL/TLS atau STARTTLS), atau hubungi penyedia email-mu.',
  insecure_login:
    'Pilihan "Tanpa enkripsi" hanya untuk server email di jaringan lokal, karena password akan terkirim tanpa perlindungan. Pilih SSL/TLS (port 465) atau STARTTLS (port 587).',
  sender_rejected:
    'Server menolak alamat pengirim. Pastikan alamat email pengirim sama dengan akun yang dipakai masuk ke server email.',
  recipient_rejected:
    'Server menolak alamat tujuan. Periksa lagi penulisan alamat tujuan email tes.',
  message_rejected:
    'Server email menolak pesan tes. Coba lagi beberapa saat lagi, atau hubungi penyedia email-mu.',
  secret_unavailable:
    'Password email yang tersimpan tidak bisa dibuka. Masukkan ulang passwordnya, lalu simpan.',
  unknown:
    'Tes gagal karena sebab yang tidak dikenali. Periksa lagi semua isian, lalu coba sekali lagi.',
};

export const emailTestResultSchema = z.object({
  ok: z.boolean(),
  code: emailTestCodeSchema,
  /** Siap ditampilkan apa adanya. */
  message: z.string(),
  testedAt: isoDateTimeSchema,
});
export type EmailTestResult = z.infer<typeof emailTestResultSchema>;

// ── Baca & simpan pengaturan ────────────────────────────────────────────────

export const EMAIL_SETTINGS_STATUSES = [
  'connected',
  'failed',
  'untested',
  'not_configured',
] as const;
export const emailSettingsStatusSchema = z.enum(EMAIL_SETTINGS_STATUSES);
export type EmailSettingsStatus = z.infer<typeof emailSettingsStatusSchema>;

export const EMAIL_SETTINGS_STATUS_LABELS: Record<EmailSettingsStatus, string> = {
  connected: 'Terhubung',
  failed: 'Gagal',
  untested: 'Belum dites',
  not_configured: 'Belum diatur',
};

/**
 * Dari mana pengaturan yang sedang berlaku berasal:
 *  - `database`: diisi lewat UI (sumber utama);
 *  - `env`: cadangan `SMTP_*` di berkas .env server (hanya-baca dari UI);
 *  - `none`: belum diatur sama sekali.
 */
export const emailSettingsSourceSchema = z.enum(['database', 'env', 'none']);
export type EmailSettingsSource = z.infer<typeof emailSettingsSourceSchema>;

export const emailSettingsViewSchema = z.object({
  fromName: z.string(),
  fromAddress: z.string(),
  replyTo: z.string().nullable(),
  host: z.string(),
  port: z.number(),
  security: smtpSecuritySchema,
  username: z.string().nullable(),
  hasPassword: z.boolean(),
  /** Petunjuk tersamar, mis. `••••1234`; `null` bila tidak ada password atau terlalu pendek untuk disamarkan. */
  passwordHint: z.string().nullable(),
});
export type EmailSettingsView = z.infer<typeof emailSettingsViewSchema>;

export const emailSettingsResponseSchema = z.object({
  source: emailSettingsSourceSchema,
  settings: emailSettingsViewSchema.nullable(),
  status: emailSettingsStatusSchema,
  /** Hasil tes terakhir atas pengaturan yang TERSIMPAN; `null` bila belum pernah dites. */
  lastTest: emailTestResultSchema.nullable(),
  updatedAt: isoDateTimeSchema.nullable(),
  /**
   * `false` = server belum punya `BALESIN_MASTER_KEY`, jadi password tidak bisa disimpan.
   * Tampilkan petunjuk untuk mengisinya di berkas .env server.
   */
  canStoreSecrets: z.boolean(),
});
export type EmailSettingsResponse = z.infer<typeof emailSettingsResponseSchema>;

/**
 * `PUT /settings/email`. Mengubah jalur kirim (host, port, keamanan, username, password, alamat
 * pengirim, balas-ke — termasuk menyimpan pertama kali) WAJIB `confirmation` untuk semua peran, Owner
 * juga (review akhir Fase 1 T2). Mengubah nama pengirim saja tidak.
 */
export const saveEmailSettingsRequestSchema = emailSettingsInputSchema.extend({
  confirmation: identityConfirmationSchema.optional(),
});
export type SaveEmailSettingsRequest = z.infer<typeof saveEmailSettingsRequestSchema>;

/**
 * `POST /settings/email/test-connection`
 * - tanpa `settings`: menguji pengaturan yang tersimpan dan mencatat hasilnya sebagai status;
 * - dengan `settings`: menguji isi form yang belum disimpan (status tersimpan tidak berubah).
 */
export const testEmailConnectionRequestSchema = z.object({
  settings: emailSettingsInputSchema.optional(),
});
export type TestEmailConnectionRequest = z.infer<typeof testEmailConnectionRequestSchema>;

/** `POST /settings/email/send-test` — kirim email tes ke `to`. */
export const sendTestEmailRequestSchema = z.object({
  to: emailAddressSchema,
  settings: emailSettingsInputSchema.optional(),
});
export type SendTestEmailRequest = z.infer<typeof sendTestEmailRequestSchema>;

// ── Deteksi host dari domain email ──────────────────────────────────────────

export const detectEmailHostRequestSchema = z.object({
  emailAddress: emailAddressSchema,
});
export type DetectEmailHostRequest = z.infer<typeof detectEmailHostRequestSchema>;

export const emailHostSuggestionSchema = z.object({
  presetId: z.enum(SMTP_PRESET_IDS),
  host: z.string(),
  port: z.number(),
  security: smtpSecuritySchema,
  /**
   * Dasar saran: `known_provider` (domain penyedia terkenal), `mx_record` (catatan MX domain
   * menunjuk penyedia itu), `dns_found` (nama host `mail.`/`smtp.` ditemukan di DNS).
   */
  reason: z.enum(['known_provider', 'mx_record', 'dns_found']),
  /** Kalimat siap tampil, mis. "Domain ini memakai Google Workspace." */
  description: z.string(),
});
export type EmailHostSuggestion = z.infer<typeof emailHostSuggestionSchema>;

export const detectEmailHostResponseSchema = z.object({
  domain: z.string(),
  /** Urut dari yang paling mungkin benar. Kosong = tidak ada saran; minta pengguna mengisi manual. */
  suggestions: z.array(emailHostSuggestionSchema),
});
export type DetectEmailHostResponse = z.infer<typeof detectEmailHostResponseSchema>;
