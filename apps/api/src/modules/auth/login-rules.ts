import { LOGIN_LOCK_MINUTES, LOGIN_MAX_FAILED_ATTEMPTS } from '@balesin/shared';
import { sql } from 'drizzle-orm';

import type { RateLimitRule } from '../../http/rate-limit';

/**
 * Batas percobaan masuk (SECURITY.md §1): per IP dan per akun; akun dikunci 15 menit setelah
 * 5 kali gagal.
 */

export const LOGIN_LOCK_SECONDS = LOGIN_LOCK_MINUTES * 60;
export const LOGIN_LOCK_INTERVAL = sql.raw(`interval '${LOGIN_LOCK_MINUTES} minutes'`);

/**
 * Percobaan GAGAL per IP (login berhasil mengembalikan jatahnya). Lebih longgar dari batas
 * per akun karena satu kantor biasanya berbagi satu IP publik.
 */
export const LOGIN_IP_RULE: RateLimitRule = {
  name: 'login-ip',
  limit: 20,
  windowSeconds: LOGIN_LOCK_SECONDS,
};

/**
 * Percobaan per akun, dihitung per EMAIL yang diketik (di-hash) — bukan per baris pengguna —
 * supaya perilakunya sama persis untuk email terdaftar dan tidak terdaftar.
 */
export const LOGIN_ACCOUNT_RULE: RateLimitRule = {
  name: 'login-akun',
  limit: LOGIN_MAX_FAILED_ATTEMPTS,
  windowSeconds: LOGIN_LOCK_SECONDS,
};

/** Nama penanda Redis "akun sedang dikunci". */
export const ACCOUNT_LOCK_FLAG = 'akun-terkunci';
