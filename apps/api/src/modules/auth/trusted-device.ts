import { constantTimeEqual, deriveKey, hmacSha256, sha256Hex, type Secret } from '@balesin/core';

/**
 * "Perangkat dikenal" (OWASP: device cookies) — supaya kunci akun tidak bisa dipakai orang lain
 * untuk mengunci pemilik akun (temuan S1 review keamanan Fase 1).
 *
 * Setelah login berhasil, browser menerima cookie HttpOnly bertanda tangan berisi ID pengguna
 * dan waktu terbit. Percobaan masuk yang membawa cookie sah UNTUK AKUN YANG SAMA dihitung di
 * ember milik perangkat itu sendiri (5 gagal / 15 menit), dan tidak terkena kunci yang dipicu
 * percobaan dari jaringan lain. Cookie ini BUKAN kredensial: tanpa password yang benar tidak
 * ada yang bisa masuk; ia hanya memilih ember batas laju.
 *
 * Bentuk nilai: `v1.<userId>.<detik terbit>.<HMAC-SHA256 base64url>`, kunci HMAC diturunkan dari
 * `SESSION_SECRET` (berganti `SESSION_SECRET` = semua perangkat kembali "tidak dikenal").
 * Diterbitkan ulang setiap login berhasil. Saat 2FA dibuat, cookie ini tetap hanya diterbitkan
 * SETELAH semua langkah masuk selesai.
 */

export const TRUSTED_DEVICE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

/**
 * Untuk langkah kedua 2FA, cookie perangkat dikenal hanya diakui bila terbit pada/sesudah waktu
 * ini (temuan S1 review 2FA): waktu aktif 2FA dibulatkan KE ATAS ke detik berikutnya. Waktu terbit
 * cookie beresolusi detik, jadi tanpa pembulatan ke atas cookie "hanya password" yang terbit di
 * detik yang sama dengan aktivasi ikut diakui.
 */
export function trustedDeviceThreshold(totpEnabledAt: Date): number {
  return Math.ceil(totpEnabledAt.getTime() / 1000) * 1000;
}

/**
 * Waktu terbit cookie baru untuk pengguna ber-2FA: tidak lebih awal dari ambang di atas, supaya
 * cookie yang terbit tepat setelah aktivasi/langkah kedua (detik yang sama) tetap diakui.
 */
export function deviceIssueTime(totpEnabledAt: Date | null, now = new Date()): Date {
  if (totpEnabledAt === null) return now;
  return new Date(Math.max(now.getTime(), trustedDeviceThreshold(totpEnabledAt)));
}

/** Waktu paling akhir di antara yang ada (`null` bila semuanya kosong). */
export function latestDate(...dates: Array<Date | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const date of dates) {
    if (date && (latest === null || date.getTime() > latest.getTime())) latest = date;
  }
  return latest;
}

/**
 * Cookie perangkat dikenal tetap diakui setelah password diganti HANYA bila terbit sesudahnya
 * (review 2FA G.3): atur ulang password membatalkan semua cookie perangkat lama, sehingga ember
 * batas laju milik perangkat itu tidak bisa dipakai lagi oleh siapa pun yang memegangnya.
 */
export function deviceStillValid(device: TrustedDevice, passwordChangedAt: Date | null): boolean {
  return (
    passwordChangedAt === null ||
    device.issuedAt.getTime() >= trustedDeviceThreshold(passwordChangedAt)
  );
}

const VERSION = 'v1';
const TOKEN_PATTERN =
  /^v1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

export interface TrustedDevice {
  userId: string;
  /** Waktu cookie diterbitkan (detik, dibulatkan ke bawah). */
  issuedAt: Date;
  /** Pengenal ember batas laju perangkat ini (hash nilai cookie; bukan rahasia). */
  deviceKey: string;
}

export interface TrustedDevices {
  /** Nilai cookie baru untuk pengguna ini. */
  issue(userId: string, now?: Date): string;
  /** Isi cookie bila sah dan belum kedaluwarsa; `undefined` untuk nilai apa pun yang lain. */
  verify(token: string | undefined, now?: Date): TrustedDevice | undefined;
}

export function createTrustedDevices(sessionSecret: Secret<string>): TrustedDevices {
  const key = deriveKey(sessionSecret.reveal(), 'balesin/trusted-device/v1');
  const sign = (userId: string, issuedAt: number) =>
    hmacSha256(key, `${VERSION}|${userId}|${issuedAt}`);

  return {
    issue(userId, now = new Date()) {
      const issuedAt = Math.floor(now.getTime() / 1000);
      return `${VERSION}.${userId}.${issuedAt}.${sign(userId, issuedAt)}`;
    },

    verify(token, now = new Date()) {
      if (!token) return undefined;
      const match = TOKEN_PATTERN.exec(token);
      if (!match) return undefined;
      const [, userId = '', issuedText = '', signature = ''] = match;
      const issuedAt = Number(issuedText);
      const age = Math.floor(now.getTime() / 1000) - issuedAt;
      if (age < -60 || age > TRUSTED_DEVICE_MAX_AGE_SECONDS) return undefined;
      if (!constantTimeEqual(signature, sign(userId, issuedAt))) return undefined;
      return {
        userId,
        issuedAt: new Date(issuedAt * 1000),
        deviceKey: sha256Hex(`device|${token}`).slice(0, 40),
      };
    },
  };
}
