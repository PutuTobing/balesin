import { createHmac, timingSafeEqual } from 'node:crypto';

import { deriveKey } from '@balesin/core';
import { MAIL_VIEW_TOKEN_TTL_SECONDS } from '@balesin/shared';

/**
 * Token dokumen tampilan email (KONTRAK-API-EMAIL §8, penyimpangan §16): iframe sandbox ber-origin
 * opak tidak membawa cookie sesi, jadi dokumen/gambar/cid diautentikasi TOKEN di path.
 *
 * Bentuk: base64url(payload 38 byte ‖ HMAC-SHA256 16 byte) = 72 karakter (muat batas parameter rute
 * Fastify 100). Payload: versi(1) ‖ ID pesan(16) ‖ ID sesi asal(16) ‖ bendera(1, bit0 = gambar luar
 * boleh) ‖ kedaluwarsa detik unix(4). Kunci HKDF dari master key (cadangan: rahasia sesi), label
 * `balesin/mail-view/v1`. Tanpa data pribadi (bukan alamat/subjek). Setiap pemakaian memeriksa ulang
 * sesi asal (dicabut/kedaluwarsa), pengguna aktif, hak `read`, dan pesan masih ada (service).
 */

const VERSION = 1;
const PAYLOAD_BYTES = 38;
const MAC_BYTES = 16;
/** Toleransi jam (detik) untuk token dari masa depan. */
const SKEW_SECONDS = 60;

export interface MailViewClaims {
  messageId: string;
  sessionRef: string;
  images: boolean;
  expiresAt: Date;
}

const uuidBytes = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex');
const uuidOf = (bytes: Buffer) => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MailViewTokens {
  issue(
    input: { messageId: string; sessionRef: string; images: boolean },
    now: Date,
  ): {
    token: string;
    expiresAt: Date;
  };
  /** `null` = rusak, tanda tangan salah, atau kedaluwarsa. */
  verify(token: string, now: Date): MailViewClaims | null;
}

export function createMailViewTokens(secret: Buffer | string): MailViewTokens {
  const key = deriveKey(secret, 'balesin/mail-view/v1');
  const mac = (payload: Buffer) =>
    createHmac('sha256', key).update(payload).digest().subarray(0, MAC_BYTES);
  return {
    issue(input, now) {
      if (!UUID_PATTERN.test(input.messageId) || !UUID_PATTERN.test(input.sessionRef)) {
        throw new Error('ID token tampilan tidak sah');
      }
      const exp = Math.floor(now.getTime() / 1000) + MAIL_VIEW_TOKEN_TTL_SECONDS;
      const payload = Buffer.alloc(PAYLOAD_BYTES);
      payload.writeUInt8(VERSION, 0);
      uuidBytes(input.messageId).copy(payload, 1);
      uuidBytes(input.sessionRef).copy(payload, 17);
      payload.writeUInt8(input.images ? 1 : 0, 33);
      payload.writeUInt32BE(exp, 34);
      return {
        token: Buffer.concat([payload, mac(payload)]).toString('base64url'),
        expiresAt: new Date(exp * 1000),
      };
    },
    verify(token, now) {
      if (token.length > 100 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
      const bytes = Buffer.from(token, 'base64url');
      if (bytes.length !== PAYLOAD_BYTES + MAC_BYTES) return null;
      const payload = bytes.subarray(0, PAYLOAD_BYTES);
      const given = bytes.subarray(PAYLOAD_BYTES);
      if (!timingSafeEqual(given, mac(payload))) return null;
      if (payload.readUInt8(0) !== VERSION) return null;
      const exp = payload.readUInt32BE(34);
      const nowSeconds = Math.floor(now.getTime() / 1000);
      if (exp <= nowSeconds || exp > nowSeconds + MAIL_VIEW_TOKEN_TTL_SECONDS + SKEW_SECONDS) {
        return null;
      }
      return {
        messageId: uuidOf(payload.subarray(1, 17)),
        sessionRef: uuidOf(payload.subarray(17, 33)),
        images: (payload.readUInt8(33) & 1) === 1,
        expiresAt: new Date(exp * 1000),
      };
    },
  };
}
