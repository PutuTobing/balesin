import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { deriveKey } from '../crypto';

/**
 * Kunci & penanda tahap 9B (docs/KONTRAK-API-EMAIL-TULIS.md §3.2, §11):
 *  - `threadKey` = base64url(HMAC-SHA256(HKDF `balesin/mail-thread/v1`, `accountId ‖ thread_root`))
 *    dipotong 22 karakter — opak, tidak membocorkan `Message-ID`. SAMA di api & worker (kunci dari
 *    master key).
 *  - Kode verifikasi 6 digit disimpan sebagai HMAC (HKDF `balesin/mail-identity-verify/v1`, terikat
 *    ID identitas), dibandingkan waktu-konstan.
 *  - `Message-ID` email verifikasi disimpan sebagai SHA-256 bentuk ternormalisasi (tanpa `<>`), jadi
 *    sinkron bisa mencocokkan tanpa teks asli di database.
 */

const THREAD_KEY_LENGTH = 22;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export interface MailComposeKeys {
  threadKey(accountId: string, threadRoot: string): string;
  hashVerificationCode(identityId: string, code: string): string;
  verificationCodeMatches(identityId: string, code: string, stored: string): boolean;
}

export function createMailComposeKeys(secret: Buffer | string): MailComposeKeys {
  const threadKeyBytes = deriveKey(secret, 'balesin/mail-thread/v1');
  const codeKeyBytes = deriveKey(secret, 'balesin/mail-identity-verify/v1');
  const hashCode = (identityId: string, code: string) =>
    createHmac('sha256', codeKeyBytes)
      .update(`${identityId.toLowerCase()}\u0000${code}`)
      .digest('base64url');
  return {
    threadKey(accountId, threadRoot) {
      return createHmac('sha256', threadKeyBytes)
        .update(`${accountId.toLowerCase()}\u0000${threadRoot}`)
        .digest('base64url')
        .slice(0, THREAD_KEY_LENGTH);
    },
    hashVerificationCode: hashCode,
    verificationCodeMatches(identityId, code, stored) {
      const expected = Buffer.from(hashCode(identityId, code));
      const actual = Buffer.from(stored);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  };
}

/** Kode 6 digit (acak kriptografis, `000000`–`999999`). */
export function newMailVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 128 bit acak → 26 karakter base32 huruf kecil. */
export function randomBase32(bytes = 16): string {
  const data = randomBytes(bytes);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** `Message-ID` (tanpa `<>`) email verifikasi: `v.<acak>@<domain>`. */
export function newMailVerificationMessageId(domain: string): string {
  return `v.${randomBase32()}@${domain.toLowerCase()}`;
}

/** Bentuk baku `Message-ID` untuk dicocokkan: tanpa `<>` dan spasi. */
export function normalizeMailMessageIdForMatch(value: string): string {
  const match = /<([^<>]+)>/.exec(value);
  return (match?.[1] ?? value).trim();
}

export function mailMessageIdHash(value: string): string {
  return createHash('sha256').update(normalizeMailMessageIdForMatch(value)).digest('hex');
}
