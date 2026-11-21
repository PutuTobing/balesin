import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) di atas HOTP (RFC 4226) — kode 6 digit yang berganti tiap 30 detik, dipakai
 * verifikasi dua langkah (SECURITY.md §1).
 *
 * Parameter produksi SELALU SHA-1, 6 digit, 30 detik: satu-satunya kombinasi yang dipahami semua
 * aplikasi autentikator populer (Google Authenticator, Microsoft Authenticator, Authy, 1Password).
 * SHA-1 di sini dipakai sebagai HMAC, bukan sebagai hash tahan-tabrakan, jadi tetap aman
 * (RFC 4226 §B, RFC 6238 §5).
 *
 * Sengaja ditulis sendiri (±100 baris, hanya `node:crypto`) alih-alih menambah dependensi:
 * algoritmanya kecil dan baku, dan diuji dengan vektor uji resmi RFC 4226 Lampiran D dan
 * RFC 6238 Lampiran B (`totp.test.ts`). Pustaka populer yang ada membawa banyak lapisan (plugin,
 * format ganda, dukungan browser) yang tidak dibutuhkan di sini.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** 160 bit — panjang yang dianjurkan RFC 4226 §4 untuk HMAC-SHA-1. */
export const TOTP_SECRET_BYTES = 20;
/** Toleransi pergeseran jam: kode dari 1 langkah sebelum/sesudah langkah sekarang diterima. */
export const TOTP_ALLOWED_DRIFT_STEPS = 1;

export type HotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

// ── Base32 (RFC 4648 §6, tanpa padding) ─────────────────────────────────────

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}

/** Membuka teks base32. Huruf kecil, spasi, tanda hubung, dan padding `=` diabaikan. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of clean) {
    const value = BASE32_ALPHABET.indexOf(character);
    if (value === -1) throw new Error('Teks base32 tidak valid');
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  return Buffer.from(bytes);
}

// ── HOTP / TOTP ─────────────────────────────────────────────────────────────

export interface HotpOptions {
  digits?: number;
  algorithm?: HotpAlgorithm;
}

/** HOTP (RFC 4226 §5.3): HMAC atas penghitung 8 byte big-endian, lalu "dynamic truncation". */
export function hotp(secret: Uint8Array, counter: number, options: HotpOptions = {}): string {
  const digits = options.digits ?? TOTP_DIGITS;
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error('Penghitung HOTP harus bilangan bulat tidak negatif');
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(options.algorithm ?? 'sha1', secret)
    .update(message)
    .digest();
  const offset = (mac.at(-1) ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Nomor langkah waktu TOTP untuk saat `nowMs` (RFC 6238 §4.2, T0 = 0). */
export function totpStep(nowMs: number, periodSeconds = TOTP_PERIOD_SECONDS): number {
  return Math.floor(nowMs / 1000 / periodSeconds);
}

/** Rahasia TOTP baru dalam base32 (32 karakter untuk 20 byte). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** Kode TOTP saat ini untuk rahasia base32 (dipakai tes; server hanya MEMERIKSA kode). */
export function generateTotp(secretBase32: string, nowMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs));
}

export interface MatchTotpOptions {
  nowMs?: number;
  /**
   * Langkah terakhir yang sudah pernah dipakai pengguna ini. Kode untuk langkah ini atau
   * sebelumnya DITOLAK (mencegah pemakaian ulang kode yang sama dalam jendelanya).
   */
  lastUsedStep?: number | null;
  driftSteps?: number;
}

/**
 * Memeriksa kode 6 digit. Mengembalikan nomor langkah yang cocok (untuk disimpan sebagai
 * "langkah terakhir dipakai"), atau `null` bila tidak cocok / sudah pernah dipakai.
 *
 * Semua langkah dalam jendela dibandingkan secara waktu-konstan dan tanpa berhenti di tengah,
 * jadi lama pemeriksaan tidak membuka langkah mana yang cocok.
 */
export function matchTotp(
  secretBase32: string,
  code: string,
  options: MatchTotpOptions = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(options.nowMs ?? Date.now());
  const drift = options.driftSteps ?? TOTP_ALLOWED_DRIFT_STEPS;
  const presented = Buffer.from(code, 'utf8');

  let matched: number | null = null;
  for (let step = current - drift; step <= current + drift; step += 1) {
    const expected = Buffer.from(hotp(secret, step), 'utf8');
    const equal = timingSafeEqual(expected, presented);
    if (equal && matched === null) matched = step;
  }
  if (matched === null) return null;
  const lastUsed = options.lastUsedStep ?? null;
  return lastUsed !== null && matched <= lastUsed ? null : matched;
}

// ── URI otpauth:// (format Key URI Google Authenticator) ────────────────────

export interface TotpUriInput {
  /** Nama penerbit yang tampil di aplikasi autentikator (nama produk/organisasi). */
  issuer: string;
  /** Nama akun, biasanya email pengguna. */
  accountName: string;
  secretBase32: string;
}

/**
 * Titik dua adalah pemisah penerbit/akun di label, jadi dibuang dari keduanya; spasi beruntun
 * dirapikan. Hasil kosong diganti teks netral supaya URI tetap sah.
 */
export function sanitizeTotpLabelPart(text: string, fallback: string): string {
  const clean = text.replace(/:/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64).trim();
  return clean.length > 0 ? clean : fallback;
}

/** `otpauth://totp/Penerbit:email?secret=…&issuer=Penerbit&algorithm=SHA1&digits=6&period=30` */
export function totpUri(input: TotpUriInput): string {
  const issuer = sanitizeTotpLabelPart(input.issuer, 'Akun');
  const account = sanitizeTotpLabelPart(input.accountName, 'akun');
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret: input.secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  // URLSearchParams menulis spasi sebagai `+`; sebagian aplikasi autentikator menampilkannya
  // apa adanya, jadi dipakai `%20`.
  return `otpauth://totp/${label}?${query.toString().replace(/\+/g, '%20')}`;
}
