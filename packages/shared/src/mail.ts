import { z } from 'zod';

import {
  hasControlCharacters,
  isoDateTimeSchema,
  emailAddressSchema,
  singleLineText,
} from './fields';
import { identityConfirmationSchema } from './identity';
import { hasPermission, type Permission } from './permissions';
import { userRoleSchema, type UserRole } from './roles';
import { isValidSmtpHost, SMTP_PASSWORD_MAX_LENGTH } from './email-settings';

/**
 * Modul Email (Fase 9, tahap 9A — docs/KONTRAK-API-EMAIL.md): kotak surat multi-akun IMAP/SMTP yang
 * terpisah dari Inbox. Berkas ini memuat konstanta, skema Zod API, kode tes koneksi, dan
 * `resolveMailAccess` — SATU fungsi hak per akun yang dipakai api (rute) dan worker/hub (event WS).
 *
 * Aturan inti (kontrak §1–§2):
 *  - Izin `mail.*` hanya pintu masuk; hak nyata per akun: `read` (Baca) < `send` (Baca & kirim) <
 *    `manage` (Kelola).
 *  - Akun PRIBADI: hanya pemiliknya (`manage`). Owner/Admin pun tidak punya hak isi (404 di semua
 *    rute isi) — mereka hanya melihat metadata `redacted` di Pengaturan.
 *  - Akun BERSAMA: Owner/Admin otomatis `manage`; selain itu maks(grant langsung, grant departemen).
 *  - "Kelola" tidak bisa menambah akses (mengatur akses = `mail.accounts.manage`).
 */

// ── Konstanta ──────────────────────────────────────────────────────────────

export const MAIL_ACCOUNT_KINDS = ['shared', 'personal'] as const;
export const mailAccountKindSchema = z.enum(MAIL_ACCOUNT_KINDS, {
  error: 'Pilih jenis akun: bersama atau pribadi.',
});
export type MailAccountKind = z.infer<typeof mailAccountKindSchema>;

/** Semua penyedia yang dikenal skema (CHECK database); `MAIL_PROVIDERS_AVAILABLE` = yang bisa dipakai 9A. */
export const MAIL_PROVIDERS = ['cpanel', 'imap', 'microsoft', 'google', 'pop3'] as const;
export const mailProviderSchema = z.enum(MAIL_PROVIDERS);
export type MailProvider = z.infer<typeof mailProviderSchema>;
export const MAIL_PROVIDERS_AVAILABLE = [
  'cpanel',
  'imap',
] as const satisfies readonly MailProvider[];
export const mailAvailableProviderSchema = z.enum(MAIL_PROVIDERS_AVAILABLE, {
  error: 'Penyedia ini belum bisa dipakai. Pilih cPanel / IDCloudHost atau IMAP lain.',
});
export type MailAvailableProvider = z.infer<typeof mailAvailableProviderSchema>;

/** Warna titik akun = token desain yang sudah ada (DESIGN.md), tanpa warna baru. */
export const MAIL_ACCOUNT_COLORS = [
  'tagBlue',
  'tagTeal',
  'tagPurple',
  'accent',
  'success',
  'warning',
] as const;
export const mailAccountColorSchema = z.enum(MAIL_ACCOUNT_COLORS, { error: 'Pilih warna akun.' });
export type MailAccountColor = z.infer<typeof mailAccountColorSchema>;

export const MAIL_ACCESS_LEVELS = ['read', 'send', 'manage'] as const;
export const mailAccessLevelSchema = z.enum(MAIL_ACCESS_LEVELS, {
  error: 'Pilih tingkat akses: Baca, Baca & kirim, atau Kelola.',
});
export type MailAccessLevel = z.infer<typeof mailAccessLevelSchema>;

export const MAIL_ACCESS_LEVEL_LABELS: Readonly<Record<MailAccessLevel, string>> = {
  read: 'Baca',
  send: 'Baca & kirim',
  manage: 'Kelola',
};

const LEVEL_RANK: Readonly<Record<MailAccessLevel, number>> = { read: 1, send: 2, manage: 3 };

/** `true` bila `level` ≥ `minimum` (`null` = tanpa hak). */
export function mailLevelAtLeast(
  level: MailAccessLevel | null | undefined,
  minimum: MailAccessLevel,
): boolean {
  return level !== null && level !== undefined && LEVEL_RANK[level] >= LEVEL_RANK[minimum];
}

/** Tingkat tertinggi dari daftar (abaikan `null`). */
export function maxMailLevel(
  ...levels: readonly (MailAccessLevel | null | undefined)[]
): MailAccessLevel | null {
  let best: MailAccessLevel | null = null;
  for (const level of levels) {
    if (level && (best === null || LEVEL_RANK[level] > LEVEL_RANK[best])) best = level;
  }
  return best;
}

export const MAIL_PRINCIPAL_TYPES = ['user', 'department'] as const;
export type MailPrincipalType = (typeof MAIL_PRINCIPAL_TYPES)[number];

export const MAIL_SYNC_STATES = [
  'initial_sync',
  'ready',
  'syncing',
  'paused',
  'auth_failed',
  'error',
  'owner_inactive',
  'deleting',
] as const;
export const mailSyncStateSchema = z.enum(MAIL_SYNC_STATES);
export type MailSyncState = z.infer<typeof mailSyncStateSchema>;

/** Status yang membuat worker tidak menyambung ke server (IDLE ditutup, tick melewatinya). */
export const MAIL_IDLE_STOPPED_STATES = [
  'paused',
  'auth_failed',
  'owner_inactive',
  'deleting',
] as const satisfies readonly MailSyncState[];

export const MAIL_FOLDER_ROLES = [
  'inbox',
  'sent',
  'drafts',
  'junk',
  'trash',
  'archive',
  'all',
  'flagged',
] as const;
export const mailFolderRoleSchema = z.enum(MAIL_FOLDER_ROLES);
export type MailFolderRole = z.infer<typeof mailFolderRoleSchema>;

/** Nama tampilan peran RFC 6154 (kontrak §6). */
export const MAIL_FOLDER_ROLE_NAMES: Readonly<Record<MailFolderRole, string>> = {
  inbox: 'Kotak masuk',
  drafts: 'Draf',
  sent: 'Terkirim',
  archive: 'Arsip',
  junk: 'Spam',
  trash: 'Sampah',
  all: 'Semua email',
  flagged: 'Ditandai',
};

/** Urutan tampil folder berperan; folder sendiri menyusul urut abjad. */
export const MAIL_FOLDER_ROLE_ORDER: readonly MailFolderRole[] = [
  'inbox',
  'drafts',
  'sent',
  'archive',
  'junk',
  'trash',
  'all',
  'flagged',
];

/** `\All`/`\Flagged` duplikat isi folder lain: disembunyikan & tidak disinkron. */
export const MAIL_UNSYNCED_FOLDER_ROLES = [
  'all',
  'flagged',
] as const satisfies readonly MailFolderRole[];

export const MAIL_FOLDER_ROLE_SOURCES = ['special_use', 'name_guess', 'created'] as const;
export type MailFolderRoleSource = (typeof MAIL_FOLDER_ROLE_SOURCES)[number];

/** Jendela sinkron (hari); `null` = semua email. */
export const MAIL_SYNC_WINDOW_DAYS = [30, 90, 365] as const;
export const MAIL_DEFAULT_SYNC_WINDOW_DAYS = 90;
export const mailSyncWindowDaysSchema = z.union(
  [z.literal(30), z.literal(90), z.literal(365), z.null()],
  {
    error: 'Pilih jendela sinkron 30, 90, atau 365 hari, atau semua email.',
  },
);
export type MailSyncWindowDays = z.infer<typeof mailSyncWindowDaysSchema>;

export const MAIL_PERIODIC_SYNC_MINUTES = { min: 1, max: 60, default: 5 } as const;
export const MAIL_CACHE_RETENTION_DAYS = { min: 7, max: 3650, default: 90 } as const;

/** Batas service (kontrak §3). */
export const MAIL_ACCOUNTS_PER_ORGANIZATION_MAX = 50;
export const MAIL_PERSONAL_ACCOUNTS_PER_USER_MAX = 5;
export const MAIL_ACCESS_GRANTS_PER_ACCOUNT_MAX = 200;

/** TLS wajib (kontrak §4.3): IMAP 993/ssl atau 143/starttls; SMTP 465/ssl atau 587/starttls. */
export const MAIL_IMAP_PORTS = { ssl: 993, starttls: 143 } as const;
export const MAIL_SMTP_PORTS = { ssl: 465, starttls: 587 } as const;
export const MAIL_TLS_SECURITY_MODES = ['ssl', 'starttls'] as const;
export const mailTlsSecuritySchema = z.enum(MAIL_TLS_SECURITY_MODES, {
  error: 'Pilih keamanan SSL/TLS atau STARTTLS.',
});
export type MailTlsSecurity = z.infer<typeof mailTlsSecuritySchema>;

export const MAIL_PORT_NOT_ALLOWED_MESSAGE =
  'Port IMAP 993 (SSL/TLS) atau 143 (STARTTLS); SMTP 465 (SSL/TLS) atau 587 (STARTTLS).';

/** `true` bila pasangan port + keamanan diizinkan (`extraPorts` HANYA tes: server tiruan). */
export function mailPortAllowed(
  kind: 'imap' | 'smtp',
  port: number,
  security: MailTlsSecurity,
  extraPorts: readonly number[] = [],
): boolean {
  const ports = kind === 'imap' ? MAIL_IMAP_PORTS : MAIL_SMTP_PORTS;
  return ports[security] === port || extraPorts.includes(port);
}

// ── Hak per akun ───────────────────────────────────────────────────────────

/** Peran yang otomatis `manage` di SEMUA akun bersama (tidak bisa diberi grant). */
export const MAIL_SHARED_IMPLICIT_MANAGE_ROLES = [
  'owner',
  'admin',
] as const satisfies readonly UserRole[];

export function isMailImplicitManager(role: UserRole): boolean {
  return (MAIL_SHARED_IMPLICIT_MANAGE_ROLES as readonly string[]).includes(role);
}

export interface MailAccessUser {
  id: string;
  role: UserRole;
  active: boolean;
  /** Departemen tempat pengguna menjadi anggota. */
  departmentIds: readonly string[];
}

export interface MailAccessAccount {
  kind: MailAccountKind;
  ownerUserId: string | null;
}

export interface MailAccessGrantInput {
  principalType: MailPrincipalType;
  userId: string | null;
  departmentId: string | null;
  level: MailAccessLevel;
}

/**
 * Hak efektif pengguna atas SATU akun (kontrak §2). `grants` = semua baris `mail_account_access`
 * akun itu (atau setidaknya yang menyangkut pengguna & departemennya). Akun pribadi orang lain →
 * `null` untuk SIAPA PUN, termasuk Owner/Admin.
 */
export function resolveMailAccess(
  user: MailAccessUser,
  account: MailAccessAccount,
  grants: readonly MailAccessGrantInput[],
): MailAccessLevel | null {
  if (!user.active || !hasPermission(user.role, 'mail.view')) return null;
  if (account.kind === 'personal') {
    return account.ownerUserId !== null && account.ownerUserId === user.id ? 'manage' : null;
  }
  const base: MailAccessLevel | null = isMailImplicitManager(user.role) ? 'manage' : null;
  let direct: MailAccessLevel | null = null;
  let department: MailAccessLevel | null = null;
  for (const grant of grants) {
    if (grant.principalType === 'user' && grant.userId === user.id) {
      direct = maxMailLevel(direct, grant.level);
    } else if (
      grant.principalType === 'department' &&
      grant.departmentId !== null &&
      user.departmentIds.includes(grant.departmentId)
    ) {
      department = maxMailLevel(department, grant.level);
    }
  }
  return maxMailLevel(base, direct, department);
}

/** Aksi butuh `mail.send` + level ≥ `send` (pindah/arsip/sampah/spam, kirim 9B). */
export function canMailSend(role: UserRole, level: MailAccessLevel | null): boolean {
  return hasPermission(role, 'mail.send') && mailLevelAtLeast(level, 'send');
}

/**
 * Boleh mengubah server/kredensial/akses/putuskan (kontrak §2 baris terakhir): bersama =
 * `mail.accounts.manage`; pribadi = pemiliknya.
 */
export function canMailAdminister(
  user: Pick<MailAccessUser, 'id' | 'role' | 'active'>,
  account: MailAccessAccount,
): boolean {
  if (!user.active) return false;
  if (account.kind === 'personal') return account.ownerUserId === user.id;
  return hasPermission(user.role, 'mail.accounts.manage');
}

// ── Kode tes koneksi (kontrak §12.2) ───────────────────────────────────────

export const MAIL_INCOMING_TEST_CODES = [
  'ok',
  'imap_host_not_found',
  'imap_host_blocked',
  'imap_port_not_allowed',
  'imap_connection_refused',
  'imap_connection_timeout',
  'imap_tls_failed',
  'imap_certificate_invalid',
  'imap_auth_failed',
  'imap_not_enabled',
  'imap_app_password_required',
  'imap_too_many_connections',
  'imap_quota_full',
  'secret_unavailable',
  'unknown',
] as const;
export const mailIncomingTestCodeSchema = z.enum(MAIL_INCOMING_TEST_CODES);
export type MailIncomingTestCode = z.infer<typeof mailIncomingTestCodeSchema>;

export const MAIL_OUTGOING_TEST_CODES = [
  'ok',
  'smtp_host_not_found',
  'smtp_host_blocked',
  'smtp_port_not_allowed',
  'smtp_connection_refused',
  'smtp_connection_timeout',
  'smtp_tls_failed',
  'smtp_certificate_invalid',
  'smtp_auth_failed',
  'smtp_auth_unsupported',
  'smtp_auth_disabled_m365',
  'smtp_app_password_required',
  'secret_unavailable',
  'unknown',
] as const;
export const mailOutgoingTestCodeSchema = z.enum(MAIL_OUTGOING_TEST_CODES);
export type MailOutgoingTestCode = z.infer<typeof mailOutgoingTestCodeSchema>;

export type MailTestCode = MailIncomingTestCode | MailOutgoingTestCode;

/** Daftar CIDR privat organisasi = `webhookPrivateCidrs` (Pengaturan → Webhook), dipakai juga akun email. */
export const MAIL_PRIVATE_NETWORK_HINT =
  'Server email di jaringan lokal harus didaftarkan dulu di Pengaturan → Webhook → Jaringan privat yang diizinkan.';

/**
 * Pesan tetap per kode (balasan server tidak pernah diteruskan) — SEBAB singkat. Langkah perbaikan ada di
 * `MAIL_TEST_HINTS`, jenis judul di `mailTestCodeKind` (review desain 9A akun P9: tanpa kata "login",
 * tanpa "penyedia server" yang ambigu; pesan akun dipakai juga di halaman akun → tidak menunjuk ke
 * halaman itu sendiri).
 */
export const MAIL_TEST_MESSAGES: Readonly<Record<MailTestCode, string>> = {
  ok: 'Berhasil.',
  imap_host_not_found: 'Server email masuk (IMAP) tidak ditemukan. Periksa penulisan host-nya.',
  imap_host_blocked: `Alamat server IMAP ini tidak boleh dipakai untuk akun email. ${MAIL_PRIVATE_NETWORK_HINT}`,
  imap_port_not_allowed: 'Port IMAP tidak didukung. Pakai 993 (SSL/TLS) atau 143 (STARTTLS).',
  imap_connection_refused: 'Server menolak sambungan IMAP di port ini.',
  imap_connection_timeout: 'Server IMAP tidak merespons. Periksa host dan port-nya.',
  imap_tls_failed: 'Sambungan aman ke server IMAP gagal.',
  imap_certificate_invalid:
    'Sertifikat keamanan server IMAP tidak valid atau tidak cocok dengan nama host.',
  imap_auth_failed: 'Username atau password akun email ditolak server.',
  imap_not_enabled: 'Akses IMAP belum diaktifkan di akun email ini.',
  imap_app_password_required: 'Penyedia email meminta sandi aplikasi, bukan password biasa.',
  imap_too_many_connections: 'Server menolak karena terlalu banyak sambungan dari akun ini.',
  imap_quota_full: 'Kotak surat hampir atau sudah penuh (≥ 95%). Email baru bisa ditolak server.',
  smtp_host_not_found: 'Server email keluar (SMTP) tidak ditemukan. Periksa penulisan host-nya.',
  smtp_host_blocked: `Alamat server SMTP ini tidak boleh dipakai untuk akun email. ${MAIL_PRIVATE_NETWORK_HINT}`,
  smtp_port_not_allowed: 'Port SMTP tidak didukung. Pakai 465 (SSL/TLS) atau 587 (STARTTLS).',
  smtp_connection_refused: 'Server menolak sambungan SMTP di port ini.',
  smtp_connection_timeout:
    'Server SMTP tidak merespons. Periksa host dan port-nya. Kalau sudah benar, mungkin jaringan server aplikasi ini memblokir port 465/587 keluar. Tanyakan ke penyedia hosting atau VPS-nya.',
  smtp_tls_failed: 'Sambungan aman ke server SMTP gagal.',
  smtp_certificate_invalid:
    'Sertifikat keamanan server SMTP tidak valid atau tidak cocok dengan nama host.',
  smtp_auth_failed: 'Username atau password SMTP ditolak server.',
  smtp_auth_unsupported: 'Server SMTP tidak menerima cara masuk dengan password ini.',
  smtp_auth_disabled_m365: 'Microsoft 365 mematikan SMTP AUTH untuk kotak surat ini.',
  smtp_app_password_required:
    'Penyedia email meminta sandi aplikasi untuk SMTP, bukan password biasa.',
  secret_unavailable:
    'Password akun email yang tersimpan tidak bisa dibuka karena kunci server berubah.',
  unknown: 'Tes gagal karena sebab yang tidak dikenali.',
};

/** Langkah perbaikan spesifik per kode (ditampilkan di bawah pesan). */
export const MAIL_TEST_HINTS: Readonly<Record<MailTestCode, string | null>> = {
  ok: null,
  imap_host_not_found:
    'Contoh host yang benar: mail.perusahaan.co.id. Salin dari panel email hosting-mu.',
  imap_host_blocked: 'Pakai nama host publik dari penyedia email, bukan alamat IP lokal.',
  imap_port_not_allowed: 'Pilih 993 dengan SSL/TLS, atau 143 dengan STARTTLS.',
  imap_connection_refused: 'Cocokkan port dan keamanan: 993 untuk SSL/TLS, 143 untuk STARTTLS.',
  imap_connection_timeout: 'Bisa juga coba port lain: 143 dengan STARTTLS.',
  imap_tls_failed: 'Ganti pilihan keamanan: 993 memakai SSL/TLS, 143 memakai STARTTLS.',
  imap_certificate_invalid:
    'Pakai nama host resmi dari penyedia email-mu (bukan alamat IP atau alias).',
  imap_auth_failed: 'Periksa lagi username (biasanya alamat email lengkap) dan password-nya.',
  imap_not_enabled:
    'Aktifkan IMAP di pengaturan email penyedia (Gmail: Setelan → Penerusan dan POP/IMAP), lalu tes ulang.',
  imap_app_password_required:
    'Buat sandi aplikasi di pengaturan keamanan akun email-mu, lalu tempel di isian password.',
  imap_too_many_connections:
    'Tutup aplikasi email lain yang memakai akun ini sebentar, lalu tes ulang.',
  imap_quota_full: 'Kosongkan kotak surat atau tambah kuotanya di penyedia email.',
  smtp_host_not_found:
    'Contoh host yang benar: mail.perusahaan.co.id. Salin dari panel email hosting-mu.',
  smtp_host_blocked: 'Pakai nama host publik dari penyedia email, bukan alamat IP lokal.',
  smtp_port_not_allowed: 'Pilih 465 dengan SSL/TLS, atau 587 dengan STARTTLS.',
  smtp_connection_refused: 'Cocokkan port dan keamanan: 465 untuk SSL/TLS, 587 untuk STARTTLS.',
  smtp_connection_timeout: 'Bisa juga coba port lain: 587 dengan STARTTLS.',
  smtp_tls_failed: 'Ganti pilihan keamanan: 465 memakai SSL/TLS, 587 memakai STARTTLS.',
  smtp_certificate_invalid:
    'Pakai nama host resmi dari penyedia email-mu (bukan alamat IP atau alias).',
  smtp_auth_failed:
    'Periksa username dan password SMTP. Kalau sama dengan server masuk, centang “Pakai username dan password yang sama dengan server masuk”.',
  smtp_auth_unsupported:
    'Coba pilihan keamanan lain (SSL/TLS atau STARTTLS), atau tanyakan ke penyedia email-mu.',
  smtp_auth_disabled_m365:
    "Minta admin Microsoft 365 mengaktifkan 'Authenticated SMTP' untuk kotak surat ini, atau tunggu 'Masuk dengan Microsoft'.",
  smtp_app_password_required:
    'Buat sandi aplikasi di pengaturan keamanan akun email-mu, lalu tempel di isian password SMTP.',
  secret_unavailable: 'Masukkan ulang password akun email ini.',
  unknown: 'Periksa lagi semua isian, lalu tes sekali lagi.',
};

export type MailTestCodeKind = 'ok' | 'auth' | 'connection' | 'other';

/**
 * Jenis kode untuk judul galat: `auth` → "Masuk ke IMAP/SMTP gagal"; `connection` → "Server … belum bisa
 * dihubungi" (belum ada proses masuk sama sekali).
 */
export function mailTestCodeKind(code: MailTestCode): MailTestCodeKind {
  if (code === 'ok' || code === 'imap_quota_full') return 'ok';
  if (/_(auth|app_password|not_enabled)/.test(code) || code === 'secret_unavailable') return 'auth';
  if (/_(host|port|connection|tls|certificate|too_many)/.test(code)) return 'connection';
  return 'other';
}

export const MAIL_INCOMING_OK_MESSAGE = 'Masuk ke IMAP berhasil.';
export const MAIL_OUTGOING_OK_MESSAGE =
  'Masuk ke SMTP berhasil. Tidak ada email yang dikirim saat tes.';

// ── Isian server ───────────────────────────────────────────────────────────

const mailHostSchema = (label: string) =>
  z
    .string({ error: `Host ${label} wajib diisi.` })
    .trim()
    .toLowerCase()
    .min(1, `Host ${label} wajib diisi.`)
    .max(253, `Host ${label} terlalu panjang.`)
    .refine(
      isValidSmtpHost,
      `Host ${label} tidak valid. Isi nama servernya saja, contoh: mail.perusahaan.co.id (tanpa http:// dan tanpa garis miring).`,
    );

const mailPortSchema = z.coerce
  .number({ error: 'Port harus angka.' })
  .int('Port harus bilangan bulat.')
  .min(1, 'Port tidak valid.')
  .max(65_535, 'Port tidak valid.');

const mailUsernameSchema = z
  .string({ error: 'Username wajib diisi.' })
  .trim()
  .min(1, 'Username wajib diisi.')
  .max(255, 'Username maksimal 255 karakter.')
  .refine((value) => !hasControlCharacters(value), 'Username tidak valid.');

const mailPasswordSchema = z
  .string({ error: 'Password wajib diisi.' })
  .min(1, 'Password wajib diisi.')
  .max(SMTP_PASSWORD_MAX_LENGTH, 'Password terlalu panjang.');

export const mailImapInputSchema = z
  .object({
    host: mailHostSchema('IMAP'),
    port: mailPortSchema,
    security: mailTlsSecuritySchema,
    username: mailUsernameSchema,
    /** Tidak dikirim (ubah/tes akun tersimpan) = pakai password tersimpan. */
    password: mailPasswordSchema.optional(),
  })
  .strict();
export type MailImapInput = z.infer<typeof mailImapInputSchema>;

export const mailSmtpInputSchema = z
  .object({
    host: mailHostSchema('SMTP'),
    port: mailPortSchema,
    security: mailTlsSecuritySchema,
    /** `true` = pakai username & password IMAP (password tidak disimpan dua kali). */
    sameCredentials: z.boolean().default(true),
    username: mailUsernameSchema.optional(),
    password: mailPasswordSchema.optional(),
  })
  .strict();
export type MailSmtpInput = z.infer<typeof mailSmtpInputSchema>;

export const mailDisplayNameSchema = singleLineText({
  min: 1,
  max: 60,
  requiredMessage: 'Nama tampilan wajib diisi.',
  tooLongMessage: 'Nama tampilan maksimal 60 karakter.',
});
export const mailFromNameSchema = singleLineText({
  min: 1,
  max: 80,
  requiredMessage: 'Nama pengirim wajib diisi.',
  tooLongMessage: 'Nama pengirim maksimal 80 karakter.',
});

/** `authserv-id` tepercaya (sama dengan channel Email Fase 6). */
export const mailTrustedAuthServIdsSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        /^\.?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/,
        'Nama server tidak valid. Contoh: mx.google.com atau .perusahaan.co.id',
      )
      .max(253, 'Nama server terlalu panjang.'),
  )
  .min(1, 'Isi minimal satu nama server, atau kosongkan untuk memakai bawaan.')
  .max(5, 'Paling banyak 5 nama server.')
  .nullable();

export const mailAccessGrantInputSchema = z.discriminatedUnion(
  'principalType',
  [
    z
      .object({
        principalType: z.literal('user'),
        userId: z.uuid({ error: 'Pengguna tidak valid.' }),
        level: mailAccessLevelSchema,
      })
      .strict(),
    z
      .object({
        principalType: z.literal('department'),
        departmentId: z.uuid({ error: 'Departemen tidak valid.' }),
        level: mailAccessLevelSchema,
      })
      .strict(),
  ],
  { error: 'Penerima akses harus pengguna atau departemen.' },
);
export type MailAccessGrantRequest = z.infer<typeof mailAccessGrantInputSchema>;

const grantListSchema = z
  .array(mailAccessGrantInputSchema)
  .max(
    MAIL_ACCESS_GRANTS_PER_ACCOUNT_MAX,
    `Paling banyak ${String(MAIL_ACCESS_GRANTS_PER_ACCOUNT_MAX)} penerima akses per akun.`,
  )
  .superRefine((grants, context) => {
    const seen = new Set<string>();
    grants.forEach((grant, index) => {
      const key = grant.principalType === 'user' ? `u:${grant.userId}` : `d:${grant.departmentId}`;
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'Penerima akses yang sama tercantum dua kali.',
        });
      }
      seen.add(key);
    });
  });

// ── Penyedia & deteksi (kontrak §4.1) ──────────────────────────────────────

export const mailProviderCardSchema = z.object({
  id: mailProviderSchema,
  name: z.string(),
  description: z.string(),
  available: z.boolean(),
  note: z.string().nullable(),
});
export type MailProviderCard = z.infer<typeof mailProviderCardSchema>;

export const mailProvidersResponseSchema = z.object({ providers: z.array(mailProviderCardSchema) });
export type MailProvidersResponse = z.infer<typeof mailProvidersResponseSchema>;

/** Kartu penyedia (urutan tampil). Ikon netral — tanpa logo merek pihak lain (DESIGN). */
export const MAIL_PROVIDER_CARDS: readonly MailProviderCard[] = [
  {
    id: 'cpanel',
    name: 'cPanel / IDCloudHost',
    description: 'Email hosting dengan domain sendiri. Pengaturan server terisi otomatis.',
    available: true,
    note: null,
  },
  {
    id: 'imap',
    name: 'IMAP lain',
    description: 'Server email apa pun yang mendukung IMAP + SMTP dengan password.',
    available: true,
    note: null,
  },
  {
    id: 'microsoft',
    name: 'Microsoft 365 / Outlook',
    description: 'Masuk dengan akun Microsoft.',
    available: false,
    note: 'Segera hadir',
  },
  {
    id: 'google',
    name: 'Google Workspace / Gmail',
    description: 'Masuk dengan akun Google.',
    available: false,
    note: 'Segera hadir',
  },
  {
    id: 'pop3',
    name: 'POP3',
    description: 'Server lama tanpa IMAP.',
    available: false,
    note: 'Segera hadir',
  },
];

export const MAIL_PRESETS = {
  cpanel: {
    title: 'cPanel / IDCloudHost',
    imap: { port: 993, security: 'ssl' },
    smtp: { port: 465, security: 'ssl' },
    username: 'address',
    guide:
      'Buka cPanel → Email Accounts → Connect Devices (Konfigurasi klien email) untuk melihat nama server, port, dan username.',
  },
  imap: {
    title: 'IMAP lain',
    imap: { port: 993, security: 'ssl' },
    smtp: { port: 587, security: 'starttls' },
    username: 'address',
    guide: 'Lihat halaman bantuan penyedia email-mu untuk nama server IMAP dan SMTP.',
  },
} as const satisfies Record<
  MailAvailableProvider,
  {
    title: string;
    imap: { port: number; security: MailTlsSecurity };
    smtp: { port: number; security: MailTlsSecurity };
    username: 'address' | 'localpart';
    guide: string;
  }
>;

export const MAIL_DETECTION_SOURCES = [
  'known_provider',
  'mx',
  'srv',
  'autoconfig',
  'ispdb',
  'guess',
] as const;
export type MailDetectionSource = (typeof MAIL_DETECTION_SOURCES)[number];

export const detectMailAccountRequestSchema = z
  .object({ emailAddress: emailAddressSchema })
  .strict();
export type DetectMailAccountRequest = z.infer<typeof detectMailAccountRequestSchema>;

const serverSuggestionSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  security: mailTlsSecuritySchema,
});

export const mailServerSuggestionSchema = z.object({
  source: z.enum(MAIL_DETECTION_SOURCES),
  provider: mailProviderSchema,
  /** `null` = penyedia belum didukung 9A (mis. Gmail/Microsoft: hanya catatan). */
  imap: serverSuggestionSchema.nullable(),
  smtp: serverSuggestionSchema.nullable(),
  username: z.enum(['address', 'localpart']),
  description: z.string(),
});
export type MailServerSuggestion = z.infer<typeof mailServerSuggestionSchema>;

export const detectMailAccountResponseSchema = z.object({
  domain: z.string(),
  suggestions: z.array(mailServerSuggestionSchema),
});
export type DetectMailAccountResponse = z.infer<typeof detectMailAccountResponseSchema>;

// ── Tes koneksi (kontrak §4.2) ─────────────────────────────────────────────

export const MAIL_TEST_TARGETS = ['incoming', 'outgoing'] as const;
export type MailTestTarget = (typeof MAIL_TEST_TARGETS)[number];

export const testMailAccountRequestSchema = z
  .object({
    /** Akun tersimpan: password kosong = pakai yang tersimpan (butuh hak ubah server). */
    accountId: z.uuid({ error: 'Akun tidak valid.' }).optional(),
    emailAddress: emailAddressSchema,
    imap: mailImapInputSchema.optional(),
    smtp: mailSmtpInputSchema.optional(),
    syncWindowDays: mailSyncWindowDaysSchema.optional(),
    targets: z
      .array(z.enum(MAIL_TEST_TARGETS))
      .min(1, 'Pilih yang dites: Masuk, Keluar, atau keduanya.')
      .max(2)
      .transform((list) => [...new Set(list)]),
  })
  .strict();
export type TestMailAccountRequest = z.infer<typeof testMailAccountRequestSchema>;

export const mailQuotaSchema = z.object({
  usedBytes: z.number().nonnegative(),
  limitBytes: z.number().nonnegative(),
});
export type MailQuota = z.infer<typeof mailQuotaSchema>;

export const mailIncomingTestResultSchema = z.object({
  ok: z.boolean(),
  code: mailIncomingTestCodeSchema,
  message: z.string(),
  durationMs: z.number().int().nonnegative(),
  details: z
    .object({
      folderCount: z.number().int().nonnegative(),
      inboxTotal: z.number().int().nonnegative(),
      specialFolders: z.array(mailFolderRoleSchema),
      idle: z.boolean(),
      quota: mailQuotaSchema.nullable(),
      estimatedInitialSync: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
});
export type MailIncomingTestResult = z.infer<typeof mailIncomingTestResultSchema>;

export const mailOutgoingTestResultSchema = z.object({
  ok: z.boolean(),
  code: mailOutgoingTestCodeSchema,
  message: z.string(),
  durationMs: z.number().int().nonnegative(),
});
export type MailOutgoingTestResult = z.infer<typeof mailOutgoingTestResultSchema>;

export const testMailAccountResponseSchema = z.object({
  testedAt: isoDateTimeSchema,
  incoming: mailIncomingTestResultSchema.nullable(),
  outgoing: mailOutgoingTestResultSchema.nullable(),
});
export type TestMailAccountResponse = z.infer<typeof testMailAccountResponseSchema>;

// ── Akun ───────────────────────────────────────────────────────────────────

export const createMailAccountRequestSchema = z
  .object({
    kind: mailAccountKindSchema,
    provider: mailAvailableProviderSchema,
    displayName: mailDisplayNameSchema,
    emailAddress: emailAddressSchema,
    fromName: mailFromNameSchema,
    color: mailAccountColorSchema.default('tagBlue'),
    imap: mailImapInputSchema.extend({ password: mailPasswordSchema }),
    smtp: mailSmtpInputSchema,
    syncWindowDays: mailSyncWindowDaysSchema.default(MAIL_DEFAULT_SYNC_WINDOW_DAYS),
    trustedAuthServIds: mailTrustedAuthServIdsSchema.optional(),
    access: grantListSchema.default([]),
    confirmation: identityConfirmationSchema.optional(),
  })
  .strict();
export type CreateMailAccountRequest = z.infer<typeof createMailAccountRequestSchema>;
export type CreateMailAccountInput = z.input<typeof createMailAccountRequestSchema>;

export const updateMailAccountRequestSchema = z
  .object({
    displayName: mailDisplayNameSchema.optional(),
    color: mailAccountColorSchema.optional(),
    fromName: mailFromNameSchema.optional(),
    syncWindowDays: mailSyncWindowDaysSchema.optional(),
    periodicSyncMinutes: z
      .number({ error: 'Selang sinkron harus angka.' })
      .int()
      .min(MAIL_PERIODIC_SYNC_MINUTES.min, 'Selang sinkron minimal 1 menit.')
      .max(MAIL_PERIODIC_SYNC_MINUTES.max, 'Selang sinkron maksimal 60 menit.')
      .optional(),
    emailAddress: emailAddressSchema.optional(),
    imap: mailImapInputSchema.optional(),
    smtp: mailSmtpInputSchema.optional(),
    trustedAuthServIds: mailTrustedAuthServIdsSchema.optional(),
    /** 9B (level Kelola). */
    sentCopyMode: z.enum(['auto', 'append', 'none']).optional(),
    warnExternalRecipients: z.boolean().optional(),
    confirmation: identityConfirmationSchema.optional(),
  })
  .strict();
export type UpdateMailAccountRequest = z.infer<typeof updateMailAccountRequestSchema>;

export const mailAccountIdParamsSchema = z.object({
  accountId: z.string().min(1).max(100),
});
export const mailFolderIdParamsSchema = z.object({ folderId: z.string().min(1).max(100) });
export const mailUserIdParamsSchema = z.object({ userId: z.string().min(1).max(100) });

export const mailUserRefSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  active: z.boolean(),
});

const serverViewSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  security: mailTlsSecuritySchema,
  username: z.string().nullable(),
  /** `••••` + ≤ 4 karakter terakhir; tidak pernah password utuh. */
  password: z.string().nullable(),
});

export const mailAccountSyncSchema = z.object({
  state: mailSyncStateSchema,
  lastSyncedAt: isoDateTimeSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorMessage: z.string().nullable(),
  lastErrorAt: isoDateTimeSchema.nullable(),
  nextAttemptAt: isoDateTimeSchema.nullable(),
  idleActive: z.boolean(),
  initialProgress: z
    .object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
    .nullable(),
  lastTest: z
    .object({ testedAt: isoDateTimeSchema, incomingOk: z.boolean(), outgoingOk: z.boolean() })
    .nullable(),
});
export type MailAccountSync = z.infer<typeof mailAccountSyncSchema>;

export const mailAccountSchema = z.object({
  id: z.uuid(),
  kind: mailAccountKindSchema,
  provider: mailProviderSchema,
  displayName: z.string(),
  emailAddress: z.string(),
  fromName: z.string(),
  color: mailAccountColorSchema,
  avatarUrl: z.string().nullable(),
  /** Pemilik akun pribadi; `null` untuk akun bersama. */
  owner: mailUserRefSchema.nullable(),
  /** Hak pemanggil atas akun ini. */
  myLevel: mailAccessLevelSchema.nullable(),
  redacted: z.literal(false),
  /** Hanya untuk pemegang hak ubah server (bersama: `mail.accounts.manage`; pribadi: pemilik). */
  imap: serverViewSchema.nullable(),
  smtp: serverViewSchema.extend({ sameCredentials: z.boolean() }).nullable(),
  trustedAuthServIds: z.array(z.string()).nullable(),
  syncWindowDays: mailSyncWindowDaysSchema,
  periodicSyncMinutes: z.number().int(),
  /** 9B: salinan email terkirim (`auto` = cari dulu di Terkirim, `append`, `none`). */
  sentCopyMode: z.enum(['auto', 'append', 'none']),
  /** 9B: peringatan penerima di luar domain kantor saat menulis. */
  warnExternalRecipients: z.boolean(),
  /**
   * 9B: peringatan akun. `system_sender_conflict` = kotak surat ini juga Email pengirim sistem
   * (tautan reset password/undangan & kode verifikasi bisa terbaca pembaca akun) → verifikasi alamat
   * terkunci sampai Email pengirim diganti.
   */
  warnings: z.array(z.enum(['system_sender_conflict', 'identity_unverified'])),
  sync: mailAccountSyncSchema,
  stats: z.object({
    messageCount: z.number().int().nonnegative(),
    unreadCount: z.number().int().nonnegative(),
    quota: mailQuotaSchema.nullable(),
  }),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type MailAccount = z.infer<typeof mailAccountSchema>;

/** Akun pribadi orang lain untuk Owner/Admin: metadata saja, tanpa server/folder/isi. */
export const redactedMailAccountSchema = z.object({
  id: z.uuid(),
  kind: z.literal('personal'),
  provider: mailProviderSchema,
  displayName: z.string(),
  emailAddress: z.string(),
  color: mailAccountColorSchema,
  avatarUrl: z.string().nullable(),
  owner: mailUserRefSchema,
  redacted: z.literal(true),
  sync: z.object({
    state: mailSyncStateSchema,
    lastSyncedAt: isoDateTimeSchema.nullable(),
    lastErrorCode: z.string().nullable(),
  }),
});
export type RedactedMailAccount = z.infer<typeof redactedMailAccountSchema>;

export const mailAccountResponseSchema = z.object({ account: mailAccountSchema });
export type MailAccountResponse = z.infer<typeof mailAccountResponseSchema>;

export const mailAccountListResponseSchema = z.object({
  accounts: z.array(mailAccountSchema),
  canConnectPersonal: z.boolean(),
  canManageShared: z.boolean(),
});
export type MailAccountListResponse = z.infer<typeof mailAccountListResponseSchema>;

export const mailSettingsAccountListResponseSchema = z.object({
  accounts: z.array(z.union([mailAccountSchema, redactedMailAccountSchema])),
  canConnectPersonal: z.boolean(),
  canManageShared: z.boolean(),
});
export type MailSettingsAccountListResponse = z.infer<typeof mailSettingsAccountListResponseSchema>;

export const deleteMailAccountRequestSchema = z
  .object({ confirmation: identityConfirmationSchema.optional() })
  .strict();
export const deleteMailAccountResponseSchema = z.object({ deleting: z.literal(true) });

export const mailAccountSyncResponseSchema = z.object({ queued: z.literal(true) });
export const mailAccountPauseResponseSchema = mailAccountResponseSchema;

/** Unggah foto: base64 (PNG/JPEG/WebP dari isi), ≤ 1 MB, sisi ≤ 4.096; SVG ditolak. */
export const MAIL_AVATAR_UPLOAD_MAX_BYTES = 1024 * 1024;
export const MAIL_AVATAR_MAX_DIMENSION = 4096;
export const MAIL_AVATAR_SIZE = 256;
export const MAIL_AVATAR_STORED_MAX_BYTES = 128 * 1024;
export const putMailAvatarRequestSchema = z
  .object({
    image: z
      .string({ error: 'Pilih gambar dulu.' })
      .min(4, 'Pilih gambar dulu.')
      .max(Math.ceil(MAIL_AVATAR_UPLOAD_MAX_BYTES / 3) * 4 + 4, 'Ukuran foto maksimal 1 MB.')
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Isi gambar tidak valid.'),
  })
  .strict();
export const mailAvatarResponseSchema = z.object({ avatarUrl: z.string().nullable() });
export const mailAvatarQuerySchema = z.object({ v: z.string().max(64).optional() });

// ── Akses (kontrak §5) ─────────────────────────────────────────────────────

export const mailAccessPrincipalSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user'),
    id: z.uuid(),
    name: z.string(),
    role: userRoleSchema,
    active: z.boolean(),
  }),
  z.object({
    type: z.literal('department'),
    id: z.uuid(),
    name: z.string(),
    memberCount: z.number().int().nonnegative(),
  }),
]);

export const mailAccountAccessResponseSchema = z.object({
  implicit: z.array(
    z.object({ role: z.enum(MAIL_SHARED_IMPLICIT_MANAGE_ROLES), level: z.literal('manage') }),
  ),
  grants: z.array(
    z.object({
      principal: mailAccessPrincipalSchema,
      level: mailAccessLevelSchema,
      grantedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
      grantedAt: isoDateTimeSchema,
    }),
  ),
  /** Pemanggil boleh mengubah (`mail.accounts.manage`). */
  editable: z.boolean(),
});
export type MailAccountAccessResponse = z.infer<typeof mailAccountAccessResponseSchema>;

export const updateMailAccountAccessRequestSchema = z
  .object({ grants: grantListSchema, confirmation: identityConfirmationSchema.optional() })
  .strict();
export type UpdateMailAccountAccessRequest = z.infer<typeof updateMailAccountAccessRequestSchema>;

export const mailAccessSourceSchema = z.object({
  type: z.enum(['role', 'user', 'department']),
  level: mailAccessLevelSchema,
  department: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});

export const teamMailAccessResponseSchema = z.object({
  user: z.object({ id: z.uuid(), name: z.string(), role: userRoleSchema, active: z.boolean() }),
  menuVisible: z.boolean(),
  canConnectPersonal: z.boolean(),
  accounts: z.array(
    z.object({
      account: z.object({
        id: z.uuid(),
        displayName: z.string(),
        emailAddress: z.string(),
        color: mailAccountColorSchema,
      }),
      effectiveLevel: mailAccessLevelSchema.nullable(),
      directLevel: mailAccessLevelSchema.nullable(),
      sources: z.array(mailAccessSourceSchema),
    }),
  ),
  personalAccounts: z.array(
    z.object({ id: z.uuid(), emailAddress: z.string(), syncState: mailSyncStateSchema }),
  ),
});
export type TeamMailAccessResponse = z.infer<typeof teamMailAccessResponseSchema>;

export const updateTeamMailAccessRequestSchema = z
  .object({
    grants: z
      .array(
        z
          .object({
            accountId: z.uuid({ error: 'Akun tidak valid.' }),
            level: mailAccessLevelSchema.nullable(),
          })
          .strict(),
      )
      .max(MAIL_ACCOUNTS_PER_ORGANIZATION_MAX)
      .superRefine((grants, context) => {
        const seen = new Set<string>();
        grants.forEach((grant, index) => {
          if (seen.has(grant.accountId)) {
            context.addIssue({
              code: 'custom',
              path: [index, 'accountId'],
              message: 'Akun yang sama tercantum dua kali.',
            });
          }
          seen.add(grant.accountId);
        });
      }),
    confirmation: identityConfirmationSchema.optional(),
  })
  .strict();
export type UpdateTeamMailAccessRequest = z.infer<typeof updateTeamMailAccessRequestSchema>;

// ── Pengaturan email (retensi) ─────────────────────────────────────────────

export const mailSettingsSchema = z.object({
  cacheRetentionDays: z
    .number({ error: 'Retensi harus angka.' })
    .int()
    .min(MAIL_CACHE_RETENTION_DAYS.min, 'Retensi minimal 7 hari.')
    .max(MAIL_CACHE_RETENTION_DAYS.max, 'Retensi maksimal 3.650 hari.'),
  defaultSyncWindowDays: mailSyncWindowDaysSchema,
  /** 9B: penerima per email (Kepada + Cc + Bcc), 1–100, bawaan 50. Menaikkan = konfirmasi identitas. */
  maxRecipientsPerEmail: z
    .number({ error: 'Batas penerima harus angka.' })
    .int()
    .min(1, 'Batas penerima minimal 1.')
    .max(100, 'Batas penerima maksimal 100.'),
  /** 9B: total lampiran per email (MB), 1–25, bawaan 20. */
  maxAttachmentTotalMb: z
    .number({ error: 'Batas lampiran harus angka.' })
    .int()
    .min(1, 'Batas lampiran minimal 1 MB.')
    .max(25, 'Batas lampiran maksimal 25 MB.'),
});
export type MailSettings = z.infer<typeof mailSettingsSchema>;
export const mailSettingsResponseSchema = z.object({ settings: mailSettingsSchema });
export const updateMailSettingsRequestSchema = mailSettingsSchema
  .extend({
    maxRecipientsPerEmail: mailSettingsSchema.shape.maxRecipientsPerEmail.optional(),
    maxAttachmentTotalMb: mailSettingsSchema.shape.maxAttachmentTotalMb.optional(),
    confirmation: identityConfirmationSchema.optional(),
  })
  .strict();
export type UpdateMailSettingsRequest = z.infer<typeof updateMailSettingsRequestSchema>;

// ── Folder (kontrak §6) ────────────────────────────────────────────────────

export const mailFolderSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  path: z.string(),
  name: z.string(),
  role: mailFolderRoleSchema.nullable(),
  parentId: z.uuid().nullable(),
  depth: z.number().int().nonnegative(),
  selectable: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  syncEnabled: z.boolean(),
  hasOlderOnServer: z.boolean(),
});
export type MailFolder = z.infer<typeof mailFolderSchema>;

export const mailFolderListResponseSchema = z.object({ folders: z.array(mailFolderSchema) });

export const mailSidebarResponseSchema = z.object({
  unified: z.object({ unreadCount: z.number().int().nonnegative() }),
  unread: z.object({ count: z.number().int().nonnegative() }),
  starred: z.object({ count: z.number().int().nonnegative() }),
  accounts: z.array(
    z.object({
      account: z.object({
        id: z.uuid(),
        displayName: z.string(),
        emailAddress: z.string(),
        color: mailAccountColorSchema,
        avatarUrl: z.string().nullable(),
        myLevel: mailAccessLevelSchema,
        sync: z.object({ state: mailSyncStateSchema }),
      }),
      folders: z.array(mailFolderSchema),
    }),
  ),
});
export type MailSidebarResponse = z.infer<typeof mailSidebarResponseSchema>;

// ── Event real-time (kontrak §10) — ID & angka saja ────────────────────────

export const mailStreamEventSchemas = [
  z.object({
    type: z.literal('mail.message.created'),
    accountId: z.uuid(),
    folderId: z.uuid(),
    messageId: z.uuid(),
    receivedAt: isoDateTimeSchema,
    /** 9B: kunci utas opak (HMAC) — bilah "ada email baru di utas ini" di jendela tulis. */
    threadKey: z.string().max(64).optional(),
  }),
  z.object({
    type: z.literal('mail.message.updated'),
    accountId: z.uuid(),
    messageId: z.uuid(),
    fields: z.array(z.enum(['flags', 'folder', 'body'])),
  }),
  z.object({
    type: z.literal('mail.message.deleted'),
    accountId: z.uuid(),
    folderId: z.uuid(),
    messageId: z.uuid(),
  }),
  z.object({
    type: z.literal('mail.folder.counts'),
    accountId: z.uuid(),
    folderId: z.uuid(),
    unreadCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('mail.account.status'),
    accountId: z.uuid(),
    syncState: mailSyncStateSchema,
    lastSyncedAt: isoDateTimeSchema.nullable(),
    errorCode: z.string().nullable(),
    initialProgress: z
      .object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
      .nullable(),
  }),
  z.object({
    type: z.literal('mail.attachment.ready'),
    accountId: z.uuid(),
    attachmentId: z.uuid(),
  }),
  z.object({
    type: z.literal('mail.attachment.failed'),
    accountId: z.uuid(),
    attachmentId: z.uuid(),
    code: z.string().max(60),
  }),
  z.object({
    type: z.literal('mail.action.failed'),
    accountId: z.uuid(),
    messageIds: z.array(z.uuid()).max(100),
    action: z.string().max(40),
    code: z.string().max(60),
  }),
  z.object({ type: z.literal('mail.access.changed') }),
  z.object({ type: z.literal('mail.resync'), accountId: z.uuid() }),
  // ── 9B (KONTRAK-API-EMAIL-TULIS §14): outbox/draf hanya ke pembuatnya (`userIds`) ──
  z.object({
    type: z.literal('mail.outbox.updated'),
    accountId: z.uuid(),
    outboxId: z.uuid(),
    draftId: z.uuid().nullable(),
    status: z.enum([
      'pending',
      'queued',
      'sending',
      'sent',
      'failed',
      'canceled',
      'delivery_unknown',
    ]),
    holdReason: z.string().max(40).nullable(),
    sendAfter: isoDateTimeSchema.nullable(),
    nextAttemptAt: isoDateTimeSchema.nullable(),
    failureReason: z.string().max(40).nullable(),
  }),
  z.object({
    type: z.literal('mail.draft.updated'),
    accountId: z.uuid(),
    draftId: z.uuid(),
    version: z.number().int().positive(),
    serverCopyState: z.enum(['pending', 'synced', 'error', 'disabled']),
  }),
  z.object({ type: z.literal('mail.draft.deleted'), accountId: z.uuid(), draftId: z.uuid() }),
  z.object({
    type: z.literal('mail.identity.updated'),
    accountId: z.uuid(),
    identityId: z.uuid(),
    verificationState: z.enum(['unverified', 'pending', 'verified']),
  }),
  z.object({
    type: z.literal('mail.compose.presence'),
    accountId: z.uuid(),
    threadKey: z.string().max(64),
    users: z.array(z.object({ id: z.uuid(), name: z.string().max(100) })).max(20),
  }),
] as const;

export const mailStreamEventSchema = z.discriminatedUnion('type', [...mailStreamEventSchemas]);
export type MailStreamEvent = z.infer<typeof mailStreamEventSchema>;

// ── Navigasi sesi ──────────────────────────────────────────────────────────

/**
 * Menu Email tampil (kontrak §1): `mail.view` DAN (≥ 1 akun bisa diakses ATAU `mail.private.own`
 * ATAU `mail.accounts.manage`).
 */
export function mailMenuVisible(role: UserRole, accessibleAccounts: number): boolean {
  if (!hasPermission(role, 'mail.view')) return false;
  const extra: Permission[] = ['mail.private.own', 'mail.accounts.manage'];
  return accessibleAccounts > 0 || extra.some((permission) => hasPermission(role, permission));
}

// ── Peran folder RFC 6154 (dipakai worker; dites unit) ─────────────────────

const SPECIAL_USE_FLAGS: Readonly<Record<string, MailFolderRole>> = {
  '\\inbox': 'inbox',
  '\\sent': 'sent',
  '\\drafts': 'drafts',
  '\\junk': 'junk',
  '\\trash': 'trash',
  '\\archive': 'archive',
  '\\all': 'all',
  '\\flagged': 'flagged',
};

const NAME_GUESSES: Readonly<Record<string, MailFolderRole>> = {
  sent: 'sent',
  'sent items': 'sent',
  'sent messages': 'sent',
  'sent mail': 'sent',
  terkirim: 'sent',
  drafts: 'drafts',
  draft: 'drafts',
  draf: 'drafts',
  junk: 'junk',
  spam: 'junk',
  'junk e-mail': 'junk',
  'junk email': 'junk',
  trash: 'trash',
  'deleted items': 'trash',
  'deleted messages': 'trash',
  sampah: 'trash',
  archive: 'archive',
  archives: 'archive',
  arsip: 'archive',
};

/** Nama folder tanpa awalan namespace `INBOX.`/`INBOX/` (untuk tampilan & tebakan). */
export function stripInboxNamespace(path: string, delimiter: string | null): string {
  const separators = delimiter ? [delimiter] : ['.', '/'];
  for (const separator of separators) {
    const prefix = `INBOX${separator}`;
    if (path.length > prefix.length && path.toUpperCase().startsWith(prefix)) {
      return path.slice(prefix.length);
    }
  }
  return path;
}

/**
 * Peran folder: bendera SPECIAL-USE server dulu, lalu tebakan nama (tanpa beda huruf, dengan/tanpa
 * awalan `INBOX.`). `INBOX` selalu `inbox`.
 */
export function mailFolderRoleOf(folder: {
  path: string;
  delimiter: string | null;
  flags: Iterable<string>;
}): { role: MailFolderRole | null; source: MailFolderRoleSource | null } {
  if (folder.path.toUpperCase() === 'INBOX') return { role: 'inbox', source: 'special_use' };
  for (const flag of folder.flags) {
    const role = SPECIAL_USE_FLAGS[flag.toLowerCase()];
    if (role && role !== 'inbox') return { role, source: 'special_use' };
  }
  const bare = stripInboxNamespace(folder.path, folder.delimiter).trim().toLowerCase();
  // Hanya folder tingkat atas (atau tepat di bawah INBOX) yang ditebak.
  if (folder.delimiter && bare.includes(folder.delimiter)) return { role: null, source: null };
  const guess = NAME_GUESSES[bare];
  return guess ? { role: guess, source: 'name_guess' } : { role: null, source: null };
}

/** Nama tampilan: nama Indonesia untuk folder berperan, selain itu segmen terakhir apa adanya. */
export function mailFolderDisplayName(
  path: string,
  delimiter: string | null,
  role: MailFolderRole | null,
): string {
  if (role) return MAIL_FOLDER_ROLE_NAMES[role];
  const bare = stripInboxNamespace(path, delimiter);
  const segments = delimiter ? bare.split(delimiter) : [bare];
  const last = segments.at(-1) ?? bare;
  // Review 9A-1 R4: nama dari server dibersihkan dari karakter kendali & pengubah arah.
  const clean = (value: string) =>
    value
      // eslint-disable-next-line no-control-regex -- karakter kendali justru dibuang.
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const name = clean(last) || clean(path);
  return name.length > 0 ? Array.from(name).slice(0, 200).join('') : 'Folder';
}
