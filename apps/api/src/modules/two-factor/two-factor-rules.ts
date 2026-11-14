import {
  LOGIN_LOCK_MINUTES,
  TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS,
  TWO_FACTOR_MAX_FAILED_ATTEMPTS,
} from '@balesin/shared';

import type { RateLimitRule } from '../../http/rate-limit';

/**
 * Batas percobaan kode verifikasi dua langkah (SECURITY.md §1), selaras dengan aturan kunci
 * login (`modules/auth/login-rules.ts`):
 *
 *  1. Per tantangan: `TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS` (3) kode salah → tantangan hangus,
 *     pengguna harus memasukkan password lagi. Dihitung di database (`failed_attempts`).
 *  2. Per akun (`TWO_FACTOR_ACCOUNT_RULE`): 5 kode salah dari tantangan mana pun → langkah kedua
 *     akun itu dikunci 15 menit. Hanya orang yang SUDAH tahu password-nya yang bisa sampai ke
 *     sini, jadi kunci ini memang boleh berlaku untuk semua asal — KECUALI perangkat dikenal:
 *  3. Per perangkat dikenal (`TWO_FACTOR_DEVICE_RULE`): browser yang pernah menyelesaikan login
 *     akun ini punya ember sendiri, supaya penebak kode dari tempat lain tidak mengunci pemilik
 *     akun di perangkatnya sendiri.
 *  4. Per IP (`TWO_FACTOR_IP_RULE`): semua permintaan verifikasi dari satu alamat (berhasil
 *     mengembalikan jatahnya) — menahan banjir token tantangan ngawur.
 *
 * Kunci akun/perangkat mengirim email pemberitahuan (lingkup `two_factor`, paling banyak sekali
 * per jam per akun) dan tercatat di audit sebagai `auth.account.locked`.
 */

export const TWO_FACTOR_LOCK_SECONDS = LOGIN_LOCK_MINUTES * 60;
export const CHALLENGE_MAX_ATTEMPTS = TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS;

export const TWO_FACTOR_ACCOUNT_RULE: RateLimitRule = {
  name: '2fa-akun',
  limit: TWO_FACTOR_MAX_FAILED_ATTEMPTS,
  windowSeconds: TWO_FACTOR_LOCK_SECONDS,
};

export const TWO_FACTOR_DEVICE_RULE: RateLimitRule = {
  name: '2fa-perangkat',
  limit: TWO_FACTOR_MAX_FAILED_ATTEMPTS,
  windowSeconds: TWO_FACTOR_LOCK_SECONDS,
};

export const TWO_FACTOR_IP_RULE: RateLimitRule = {
  name: '2fa-ip',
  limit: 30,
  windowSeconds: TWO_FACTOR_LOCK_SECONDS,
};

/** Mulai + konfirmasi pendaftaran per pengguna (kode salah saat mendaftar tidak mengunci). */
export const TWO_FACTOR_ENROLL_RULE: RateLimitRule = {
  name: '2fa-daftar',
  limit: 10,
  windowSeconds: 15 * 60,
};

/**
 * Konfirmasi ulang identitas (password + kode) untuk membuat ulang kode cadangan, menonaktifkan
 * 2FA, atau mulai mendaftar dari sesi penuh: percobaan GAGAL per pengguna.
 */
export const TWO_FACTOR_REAUTH_RULE: RateLimitRule = {
  name: '2fa-konfirmasi',
  limit: 5,
  windowSeconds: 15 * 60,
};

/** Penanda Redis "langkah kedua akun ini dikunci" (aturan 2). */
export const TWO_FACTOR_ACCOUNT_LOCK_FLAG = '2fa-akun-terkunci';
/** Penanda Redis "langkah kedua dari perangkat dikenal ini dikunci" (aturan 3). */
export const TWO_FACTOR_DEVICE_LOCK_FLAG = '2fa-perangkat-terkunci';
