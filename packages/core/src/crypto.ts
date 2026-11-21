import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import type { Secret } from './secret';

/**
 * Kriptografi bersama untuk api dan worker (SECURITY.md §1 dan §3):
 *  - token acak dan hash-nya (sesi; nanti undangan, reset password, API key);
 *  - perbandingan waktu-konstan;
 *  - "kotak rahasia" AES-256-GCM untuk kredensial yang disimpan di database
 *    (password SMTP sekarang; token Meta, App Secret, token Telegram nanti).
 */

/** SHA-256 dalam heksadesimal. Untuk token ACAK berentropi tinggi — BUKAN untuk password. */
export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Token acak aman dalam base64url. Bawaan 32 byte = 256 bit (43 karakter). */
export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/**
 * Membandingkan dua teks rahasia tanpa membocorkan isi maupun panjangnya lewat waktu:
 * yang dibandingkan adalah hash SHA-256 keduanya (selalu 32 byte) dengan `timingSafeEqual`.
 */
export function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/**
 * Menurunkan sub-kunci 32 byte dari satu rahasia induk (HKDF-SHA256). Setiap pemakaian
 * (`info` berbeda) mendapat kunci yang berbeda, jadi satu kunci tidak pernah dipakai untuk
 * dua tujuan.
 */
export function deriveKey(secret: Buffer | string, info: string): Buffer {
  const material = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  return Buffer.from(hkdfSync('sha256', material, HKDF_SALT, info, 32));
}

const HKDF_SALT = Buffer.from('balesin/hkdf/v1', 'utf8');

/** HMAC-SHA256 dalam base64url. */
export function hmacSha256(key: Buffer, message: string): string {
  return createHmac('sha256', key).update(message).digest('base64url');
}

// ── Kotak rahasia (AES-256-GCM) ─────────────────────────────────────────────

/**
 * Tempat sebuah rahasia disimpan. Ikut "ditandatangani" sebagai AAD: teks sandi yang dipindah
 * ke organisasi lain atau ke kolom lain tidak bisa dibuka.
 */
export interface SecretContext {
  organizationId: string;
  /** `tabel.kolom`, mis. `email_settings.smtp_password`. */
  purpose: string;
  /**
   * Baris pemilik rahasia (mis. ID pengguna untuk rahasia TOTP), bila rahasia itu milik satu
   * baris tertentu. Ikut AAD: teks sandi milik pengguna A yang disalin ke baris pengguna B tidak
   * bisa dibuka.
   */
  subjectId?: string;
}

export interface SecretBox {
  /** Mengenkripsi `plaintext`. Hasilnya teks `v1.<nonce>.<sandi+tag>` (base64url). */
  encrypt(plaintext: string, context: SecretContext): string;
  /** Membuka hasil `encrypt` dengan konteks yang SAMA. Melempar `SecretDecryptionError` bila gagal. */
  decrypt(payload: string, context: SecretContext): string;
}

/** Sengaja tanpa rincian: penyebabnya (kunci salah, data diubah, konteks beda) tidak boleh bocor. */
export class SecretDecryptionError extends Error {
  constructor() {
    super('Rahasia tersimpan tidak bisa dibuka (kunci, konteks, atau datanya tidak cocok)');
    this.name = 'SecretDecryptionError';
  }
}

const SECRET_BOX_VERSION = 'v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function associatedData(context: SecretContext): Buffer {
  const base = `${SECRET_BOX_VERSION}|${context.organizationId}|${context.purpose}`;
  // Tanpa `subjectId` bentuknya sama persis seperti sebelumnya (data lama tetap terbuka).
  return Buffer.from(
    context.subjectId === undefined ? base : `${base}|${context.subjectId}`,
    'utf8',
  );
}

/**
 * Kotak rahasia berbasis `BALESIN_MASTER_KEY`.
 *
 * - AES-256-GCM dengan nonce acak 96-bit per enkripsi.
 * - Kunci enkripsi diturunkan per `purpose` lewat HKDF; master key tidak pernah dipakai langsung.
 * - AAD = versi + organisasi + purpose (+ `subjectId` bila diberikan).
 * - Awalan versi (`v1.`) supaya skema/kunci bisa diganti nanti tanpa menebak format data lama.
 */
export function createSecretBox(masterKey: Secret<Buffer>): SecretBox {
  if (masterKey.reveal().length !== 32) {
    throw new Error('Master key harus 32 byte (AES-256)');
  }

  const keyFor = (purpose: string): Buffer =>
    deriveKey(masterKey.reveal(), `balesin/secret-box/${SECRET_BOX_VERSION}/${purpose}`);

  return {
    encrypt(plaintext, context) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', keyFor(context.purpose), nonce);
      cipher.setAAD(associatedData(context));
      const sealed = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return `${SECRET_BOX_VERSION}.${nonce.toString('base64url')}.${sealed.toString('base64url')}`;
    },

    decrypt(payload, context) {
      const [version, nonceText, sealedText, ...extra] = payload.split('.');
      if (version !== SECRET_BOX_VERSION || !nonceText || !sealedText || extra.length > 0) {
        throw new SecretDecryptionError();
      }
      const nonce = Buffer.from(nonceText, 'base64url');
      const sealed = Buffer.from(sealedText, 'base64url');
      if (nonce.length !== NONCE_BYTES || sealed.length < TAG_BYTES) {
        throw new SecretDecryptionError();
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', keyFor(context.purpose), nonce, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAAD(associatedData(context));
        decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
        return Buffer.concat([
          decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new SecretDecryptionError();
      }
    },
  };
}

// ── Penyamaran untuk tampilan ───────────────────────────────────────────────

const MASK = '••••';

/**
 * Ekor rahasia yang boleh disimpan polos sebagai petunjuk di UI (SECURITY.md §3: "hanya 4
 * karakter terakhir"). Rahasia pendek dibuka lebih sedikit supaya petunjuknya tidak membuka
 * sebagian besar isinya: ≥12 karakter → 4 terakhir, 8–11 → 2 terakhir, lebih pendek → tidak ada.
 */
export function secretTail(secret: string): string | null {
  const characters = Array.from(secret);
  if (characters.length >= 12) return characters.slice(-4).join('');
  if (characters.length >= 8) return characters.slice(-2).join('');
  return null;
}

/** `1234` → `••••1234`. `null` tetap `null`. */
export function maskedSecret(tail: string | null): string | null {
  return tail === null ? null : `${MASK}${tail}`;
}
