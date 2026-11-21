import { z } from 'zod';

import { authenticatedSessionSchema, twoFactorMethodSchema } from './auth';
import { isoDateTimeSchema } from './fields';
import { loginPasswordSchema } from './password';
import type { UserRole } from './roles';

/**
 * Verifikasi dua langkah (2FA) dengan aplikasi autentikator (TOTP, RFC 6238) + kode cadangan
 * sekali pakai (SECURITY.md §1). Alur lengkapnya ada di docs/KONTRAK-API-AUTH.md bagian 2FA.
 */

/** Peran yang WAJIB memakai 2FA (SECURITY.md §1). Peran lain boleh mengaktifkannya sendiri. */
export const TWO_FACTOR_REQUIRED_ROLES = [
  'owner',
  'admin',
  'supervisor',
] as const satisfies readonly UserRole[];

export function isTwoFactorRequired(role: UserRole): boolean {
  return (TWO_FACTOR_REQUIRED_ROLES as readonly UserRole[]).includes(role);
}

/** Parameter kode (sama dengan yang tertulis di URI `otpauth://`). */
export const TOTP_CODE_LENGTH = 6;
export const TOTP_PERIOD_SECONDS = 30;

/** Jumlah kode cadangan per pembuatan. */
export const BACKUP_CODE_COUNT = 10;
/** Huruf kecil + angka tanpa karakter yang mirip (0/o, 1/l/i). */
export const BACKUP_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
/** Panjang kode cadangan tanpa tanda hubung (ditampilkan `xxxxx-xxxxx`). */
export const BACKUP_CODE_LENGTH = 10;

/** Sesi terbatas "wajib mendaftar 2FA" berlaku paling lama sekian menit. */
export const TWO_FACTOR_ENROLLMENT_SESSION_MINUTES = 30;
/** Rahasia yang sedang didaftarkan (QR) berlaku sekian menit sebelum harus dibuat ulang. */
export const TWO_FACTOR_ENROLLMENT_PENDING_MINUTES = 15;
/**
 * Batas MUTLAK satu rahasia pendaftaran sejak pertama kali dibuat: menampilkan ulang QR yang sama
 * (muat ulang layar) tidak bisa memperpanjangnya melewati ini (review 2FA Info 17).
 */
export const TWO_FACTOR_ENROLLMENT_PENDING_MAX_MINUTES = 30;
/** Tantangan langkah kedua saat masuk berlaku sekian menit. */
export const TWO_FACTOR_CHALLENGE_MINUTES = 5;
/** Kode salah per tantangan sebelum tantangan hangus (harus masuk lagi dengan password). */
export const TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS = 3;
/** Kode salah per akun sebelum langkah kedua dikunci (`LOGIN_LOCK_MINUTES`). */
export const TWO_FACTOR_MAX_FAILED_ATTEMPTS = 5;

/**
 * Membakukan isian kode: spasi dan tanda hubung dibuang, huruf dikecilkan. `123 456` → `123456`,
 * `ABCDE-FGHJK` → `abcdefghjk`.
 */
export function normalizeTwoFactorCode(input: string): string {
  return input.replace(/[\s-]/g, '').toLowerCase();
}

const TOTP_CODE_PATTERN = /^\d{6}$/;
const BACKUP_CODE_PATTERN = new RegExp(`^[${BACKUP_CODE_ALPHABET}]{${BACKUP_CODE_LENGTH}}$`);

/** Jenis kode yang sudah dibakukan; `null` bila bentuknya bukan keduanya. */
export function twoFactorCodeKind(
  normalized: string,
): z.infer<typeof twoFactorMethodSchema> | null {
  if (TOTP_CODE_PATTERN.test(normalized)) return 'totp';
  if (BACKUP_CODE_PATTERN.test(normalized)) return 'backup_code';
  return null;
}

/** `abcdefghjk` → `abcde-fghjk` (bentuk tampilan kode cadangan). */
export function formatBackupCode(code: string): string {
  const normalized = normalizeTwoFactorCode(code);
  return `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
}

export const TOTP_CODE_HINT = 'Masukkan 6 digit kode dari aplikasi autentikatormu.';
export const TWO_FACTOR_CODE_HINT =
  'Masukkan 6 digit kode dari aplikasi autentikator, atau salah satu kode cadangan (10 karakter).';

/** Kode dari aplikasi autentikator saja (saat mendaftar). Keluaran: 6 digit tanpa spasi. */
export const totpCodeSchema = z
  .string({ error: 'Kode wajib diisi.' })
  .max(32, TOTP_CODE_HINT)
  .transform(normalizeTwoFactorCode)
  .refine((code) => code.length > 0, 'Kode wajib diisi.')
  .refine((code) => code.length === 0 || TOTP_CODE_PATTERN.test(code), TOTP_CODE_HINT);

/** Kode autentikator ATAU kode cadangan. Keluaran: bentuk baku (lihat `twoFactorCodeKind`). */
export const twoFactorCodeSchema = z
  .string({ error: 'Kode wajib diisi.' })
  .max(32, TWO_FACTOR_CODE_HINT)
  .transform(normalizeTwoFactorCode)
  .refine((code) => code.length > 0, 'Kode wajib diisi.')
  .refine((code) => code.length === 0 || twoFactorCodeKind(code) !== null, TWO_FACTOR_CODE_HINT);

// ── Langkah kedua saat masuk (publik) ───────────────────────────────────────

export const verifyTwoFactorRequestSchema = z.object({
  challengeToken: z
    .string({ error: 'Langkah verifikasi tidak lengkap. Masuk lagi dengan email dan password-mu.' })
    .min(1, 'Langkah verifikasi tidak lengkap. Masuk lagi dengan email dan password-mu.')
    .max(128, 'Langkah verifikasi tidak lengkap. Masuk lagi dengan email dan password-mu.'),
  code: twoFactorCodeSchema,
});
export type VerifyTwoFactorRequest = z.input<typeof verifyTwoFactorRequestSchema>;

/** Sesi penuh + keterangan kode yang dipakai (untuk peringatan "kode cadangan tinggal sedikit"). */
export const verifyTwoFactorResponseSchema = authenticatedSessionSchema.extend({
  twoFactor: z.object({
    method: twoFactorMethodSchema,
    /** Sisa kode cadangan yang belum dipakai. */
    backupCodesRemaining: z.number().int().nonnegative(),
  }),
});
export type VerifyTwoFactorResponse = z.infer<typeof verifyTwoFactorResponseSchema>;

// ── Status & pengelolaan (perlu sesi) ───────────────────────────────────────

export const twoFactorStatusResponseSchema = z.object({
  enabled: z.boolean(),
  /** Peran pengguna wajib memakai 2FA (tidak bisa dinonaktifkan sendiri). */
  required: z.boolean(),
  enabledAt: isoDateTimeSchema.nullable(),
  backupCodesRemaining: z.number().int().nonnegative(),
  backupCodesGeneratedAt: isoDateTimeSchema.nullable(),
  /** Pendaftaran sudah dimulai (QR dibuat) tetapi belum dikonfirmasi dan belum kedaluwarsa. */
  enrollmentPending: z.boolean(),
});
export type TwoFactorStatusResponse = z.infer<typeof twoFactorStatusResponseSchema>;

/**
 * Mulai pendaftaran. `password` WAJIB bila dipanggil dari sesi penuh (mis. CS yang mengaktifkan
 * 2FA dari halaman profil); TIDAK perlu dari sesi terbatas "wajib mendaftar 2FA" (password baru
 * saja dimasukkan saat masuk/setup).
 */
export const startTwoFactorEnrollmentRequestSchema = z.object({
  password: loginPasswordSchema.optional(),
});
export type StartTwoFactorEnrollmentRequest = z.input<typeof startTwoFactorEnrollmentRequestSchema>;

/**
 * Rahasia baru untuk aplikasi autentikator. Web membuat QR dari `otpauthUri` (di browser, tanpa
 * layanan luar) dan menampilkan `secret` untuk diketik manual. Jangan simpan di mana pun.
 */
export const startTwoFactorEnrollmentResponseSchema = z.object({
  otpauthUri: z.string(),
  /** Rahasia base32 (32 karakter, huruf besar + angka 2–7). */
  secret: z.string(),
  /** Rahasia dalam kelompok 4 karakter, untuk ditampilkan. */
  secretGrouped: z.string(),
  /** Nama penerbit yang akan tampil di aplikasi autentikator. */
  issuer: z.string(),
  accountName: z.string(),
  /** Setelah waktu ini, konfirmasi ditolak dan pendaftaran harus dimulai ulang. */
  expiresAt: isoDateTimeSchema,
  digits: z.literal(TOTP_CODE_LENGTH),
  periodSeconds: z.literal(TOTP_PERIOD_SECONDS),
});
export type StartTwoFactorEnrollmentResponse = z.infer<
  typeof startTwoFactorEnrollmentResponseSchema
>;

export const confirmTwoFactorEnrollmentRequestSchema = z.object({
  code: totpCodeSchema,
});
export type ConfirmTwoFactorEnrollmentRequest = z.input<
  typeof confirmTwoFactorEnrollmentRequestSchema
>;

/** Kode cadangan yang baru dibuat — HANYA ditampilkan sekali ini (server menyimpan hash-nya). */
export const backupCodesSchema = z.object({
  /** `BACKUP_CODE_COUNT` kode dalam bentuk tampilan `xxxxx-xxxxx`. */
  codes: z.array(z.string()),
  generatedAt: isoDateTimeSchema,
});
export type BackupCodes = z.infer<typeof backupCodesSchema>;

/**
 * 2FA aktif. Server menerbitkan SESI BARU (cookie baru, `csrfToken` baru — ganti yang lama di
 * memori) dan mencabut semua sesi lain milik pengguna ini.
 */
export const confirmTwoFactorEnrollmentResponseSchema = authenticatedSessionSchema.extend({
  backupCodes: backupCodesSchema,
});
export type ConfirmTwoFactorEnrollmentResponse = z.infer<
  typeof confirmTwoFactorEnrollmentResponseSchema
>;

/** Konfirmasi ulang identitas: password + kode (autentikator atau kode cadangan). */
export const twoFactorReauthRequestSchema = z.object({
  password: loginPasswordSchema,
  code: twoFactorCodeSchema,
});
export type TwoFactorReauthRequest = z.input<typeof twoFactorReauthRequestSchema>;

export const regenerateBackupCodesResponseSchema = backupCodesSchema;
export type RegenerateBackupCodesResponse = z.infer<typeof regenerateBackupCodesResponseSchema>;

export const disableTwoFactorResponseSchema = z.object({
  status: z.literal('disabled'),
});
export type DisableTwoFactorResponse = z.infer<typeof disableTwoFactorResponseSchema>;
