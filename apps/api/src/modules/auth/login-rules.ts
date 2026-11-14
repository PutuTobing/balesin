import { sha256Hex, type LockScope } from '@balesin/core';
import { LOGIN_LOCK_MINUTES, LOGIN_MAX_FAILED_ATTEMPTS } from '@balesin/shared';
import { sql } from 'drizzle-orm';

import type { RateLimitRule } from '../../http/rate-limit';

/**
 * Batas percobaan masuk (SECURITY.md §1: "rate limit login per IP & per akun; kunci 15 menit
 * setelah 5 gagal; notifikasi email"), dirancang supaya kunci akun tidak bisa dipakai orang lain
 * untuk mengunci pemilik akun (temuan S1 review keamanan Fase 1):
 *
 *  1. Per IP (`LOGIN_IP_RULE`): semua percobaan GAGAL dari satu alamat, email apa pun. Hanya
 *     hasil gagal yang menghabiskan jatah, jadi banyak login sah serentak dari satu IP kantor (NAT)
 *     tidak kena 429. Serbuan paralel dibatasi `LOGIN_IP_CONCURRENCY_RULE`.
 *  2. Per akun + asal (`LOGIN_SOURCE_RULE`): 5 gagal untuk satu email dari satu IP (/64 untuk
 *     IPv6) → percobaan email itu DARI ASAL ITU dikunci 15 menit. Pemilik akun di jaringan lain
 *     tidak ikut terkunci.
 *  3. Per akun dari mana pun (`LOGIN_ACCOUNT_RULE`): ambang tinggi untuk tebakan yang disebar ke
 *     banyak IP → email itu dikunci 15 menit untuk semua asal, KECUALI perangkat dikenal.
 *  4. Per perangkat dikenal (`LOGIN_DEVICE_RULE`): browser yang pernah berhasil masuk ke akun itu
 *     (cookie bertanda tangan, `trusted-device.ts`) memakai embernya sendiri, jadi tidak terkena
 *     aturan 2 dan 3 yang dipicu orang lain.
 *
 * Semua hitungan per email memakai email yang DIKETIK (di-hash), bukan baris pengguna, jadi email
 * tidak terdaftar diperlakukan sama persis dengan akun sungguhan.
 */

export const LOGIN_LOCK_SECONDS = LOGIN_LOCK_MINUTES * 60;
export const LOGIN_LOCK_INTERVAL = sql.raw(`interval '${LOGIN_LOCK_MINUTES} minutes'`);

/**
 * Percobaan GAGAL per IP. Hanya diperiksa (tanpa dinaikkan) sebelum password diperiksa, lalu
 * dinaikkan bila hasilnya gagal — login berhasil tidak pernah menyentuhnya. Lebih longgar dari
 * batas per akun karena satu kantor biasanya berbagi satu IP publik.
 */
export const LOGIN_IP_RULE: RateLimitRule = {
  name: 'login-ip',
  limit: 20,
  windowSeconds: LOGIN_LOCK_SECONDS,
};

/**
 * Pemeriksaan password yang SEDANG BERJALAN per IP (semafor: jatah selalu dikembalikan setelah
 * selesai; jendela hanya untuk memulihkan jatah bila proses mati di tengah jalan). Karena
 * `LOGIN_IP_RULE` baru dinaikkan setelah hasilnya diketahui, serbuan paralel bisa melewati batas
 * gagal paling banyak sejumlah ini per jendela — tetap terbatas.
 */
export const LOGIN_IP_CONCURRENCY_RULE: RateLimitRule = {
  name: 'login-ip-serentak',
  limit: 30,
  windowSeconds: 60,
};

/** 5 gagal untuk satu email dari satu asal → kunci asal itu 15 menit. */
export const LOGIN_SOURCE_RULE: RateLimitRule = {
  name: 'login-akun-asal',
  limit: LOGIN_MAX_FAILED_ATTEMPTS,
  windowSeconds: LOGIN_LOCK_SECONDS,
};

/** Tebakan tersebar dari banyak asal: 50 per jam untuk satu email → kunci email itu 15 menit. */
export const LOGIN_ACCOUNT_RULE: RateLimitRule = {
  name: 'login-akun',
  limit: 50,
  windowSeconds: 60 * 60,
};

/** 5 gagal dari satu perangkat dikenal → kunci perangkat itu 15 menit. */
export const LOGIN_DEVICE_RULE: RateLimitRule = {
  name: 'login-perangkat',
  limit: LOGIN_MAX_FAILED_ATTEMPTS,
  windowSeconds: LOGIN_LOCK_SECONDS,
};

/** Nama penanda Redis "email ini dikunci untuk semua asal" (aturan 3). */
export const ACCOUNT_LOCK_FLAG = 'akun-terkunci';
/** Nama penanda Redis "email ini dikunci dari asal ini" (aturan 2). */
export const SOURCE_LOCK_FLAG = 'akun-asal-terkunci';
/** Nama penanda Redis "perangkat dikenal ini dikunci" (aturan 4). */
export const DEVICE_LOCK_FLAG = 'perangkat-terkunci';
/** Penanda "email pemberitahuan kunci sudah dikirim" — paling banyak sekali per jam per akun. */
export const LOCK_NOTICE_FLAG = 'email-kunci-terkirim';
export const LOCK_NOTICE_INTERVAL_SECONDS = 60 * 60;

/** Lingkup sebuah kunci (masuk metadata audit dan payload pemberitahuan). */
export type { LockScope };

/**
 * Kunci batas laju "per akun" untuk email yang DIKETIK (di-hash). Juga dipakai sebagai kunci
 * penanda "email pemberitahuan kunci sudah dikirim", jadi kunci password dan kunci kode 2FA
 * berbagi jatah satu email per jam.
 */
export function loginAccountKey(email: string): string {
  return sha256Hex(`login|${email}`).slice(0, 40);
}
