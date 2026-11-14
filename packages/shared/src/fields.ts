import { z } from 'zod';

/**
 * Skema isian yang dipakai berulang oleh beberapa form (setup, login, pengaturan).
 * Pesannya bahasa Indonesia dan langsung bisa ditampilkan di bawah isian.
 */

/**
 * Karakter tak terlihat yang tidak pernah sah di isian satu baris: kendali C0/C1 (termasuk baris
 * baru), pemisah baris/paragraf Unicode, dan karakter format (`Cf`: pengubah arah U+202E/U+2066–
 * U+2069, lebar-nol U+200B/U+2060, BOM, …) — bisa dipakai menyamarkan nama di email/inbox. ZWJ
 * (U+200D) dikecualikan karena dipakai emoji gabungan.
 */
export const INVISIBLE_CHARACTER_PATTERN = /[\p{Cc}\p{Zl}\p{Zp}]|(?!\u200d)\p{Cf}/u;

/** `true` bila teks memuat karakter kendali/format tak terlihat (lihat `INVISIBLE_CHARACTER_PATTERN`). */
export function hasControlCharacters(text: string): boolean {
  return INVISIBLE_CHARACTER_PATTERN.test(text);
}

const NO_CONTROL_MESSAGE = 'Tidak boleh memuat baris baru atau karakter khusus tak terlihat.';

/** Teks satu baris: dipangkas, panjang dibatasi, tanpa karakter kendali. */
export function singleLineText(options: {
  min: number;
  max: number;
  requiredMessage: string;
  tooShortMessage?: string;
  tooLongMessage: string;
}) {
  return (
    z
      .string({ error: options.requiredMessage })
      .trim()
      // `abort`: isian kosong cukup melaporkan "wajib diisi", tanpa pesan "minimal N karakter".
      .refine((value) => value.length > 0, { error: options.requiredMessage, abort: true })
      .min(options.min, options.tooShortMessage ?? options.requiredMessage)
      .max(options.max, options.tooLongMessage)
      .refine((value) => !hasControlCharacters(value), NO_CONTROL_MESSAGE)
  );
}

export const EMAIL_MAX_LENGTH = 254;

/**
 * Alamat email dalam bentuk baku (tanpa spasi tepi, huruf kecil) — sama dengan `normalizeEmail`,
 * jadi `Budi@Contoh.com` dan `budi@contoh.com` selalu dianggap alamat yang sama.
 */
export const emailAddressSchema = z
  .string({ error: 'Alamat email wajib diisi.' })
  .trim()
  .toLowerCase()
  .min(1, 'Alamat email wajib diisi.')
  .max(EMAIL_MAX_LENGTH, `Alamat email maksimal ${EMAIL_MAX_LENGTH} karakter.`)
  .pipe(z.email({ error: 'Alamat email tidak valid. Contoh: nama@perusahaan.co.id' }));

/** Nama orang (pengguna). */
export const personNameSchema = singleLineText({
  min: 2,
  max: 100,
  requiredMessage: 'Nama wajib diisi.',
  tooShortMessage: 'Nama minimal 2 karakter.',
  tooLongMessage: 'Nama maksimal 100 karakter.',
});

/** `true` bila `timeZone` adalah nama zona waktu IANA yang dikenal (mis. `Asia/Jakarta`). */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const DEFAULT_TIME_ZONE = 'Asia/Jakarta';

export const timeZoneSchema = z
  .string({ error: 'Zona waktu wajib dipilih.' })
  .trim()
  .refine(isValidTimeZone, 'Zona waktu tidak dikenal. Pilih dari daftar, mis. Asia/Jakarta.');

/** Waktu dalam ISO 8601 (UTC), mis. `2026-11-13T04:00:00.000Z`. */
export const isoDateTimeSchema = z.iso.datetime();
