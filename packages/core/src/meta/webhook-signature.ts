import { createHmac, timingSafeEqual } from 'node:crypto';

import type { Secret } from '../secret';

/**
 * Tanda tangan webhook Meta (SECURITY.md §4, review Fase 2 bagian D.1).
 *
 * Meta menandatangani SETIAP notifikasi webhook dengan `X-Hub-Signature-256: sha256=<heks>`, yaitu
 * HMAC-SHA256 atas body mentah (byte persis seperti dikirim) memakai App Secret aplikasi Meta.
 * Sumber: developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint
 *
 * Aturan:
 *  - dihitung atas `Buffer` body mentah SEBELUM `JSON.parse` (parse ulang lalu stringify mengubah
 *    byte — escape Unicode, urutan, spasi — sehingga tanda tangan sah bisa ditolak, atau lebih buruk:
 *    pemeriksaan atas data yang sudah ditafsirkan);
 *  - dibandingkan waktu-konstan (`timingSafeEqual`) atas 32 byte hasil decode heks yang panjangnya
 *    sudah dipastikan sama;
 *  - tanpa header / format salah / tidak cocok = ditolak, tanpa membaca isi body.
 */

/** Nama header (huruf kecil, seperti di `request.headers` Node). */
export const META_SIGNATURE_HEADER = 'x-hub-signature-256';

/** `sha256=` + 64 heks. Meta mengirim huruf kecil; huruf besar tetap diterima (heks sama). */
const SIGNATURE_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;

export type MetaSignatureCheck =
  /** Cocok: body benar-benar dari pemegang App Secret. */
  | 'valid'
  /** Header tidak ada (atau kosong). */
  | 'missing'
  /** Header ada tetapi bukan `sha256=<64 heks>` (termasuk header ganda yang digabung Node). */
  | 'malformed'
  /** Format benar, nilainya tidak cocok. */
  | 'mismatch';

type AppSecret = Secret<string> | string;

function reveal(secret: AppSecret): string {
  return typeof secret === 'string' ? secret : secret.reveal();
}

/** HMAC-SHA256 body mentah → `sha256=<heks>` (untuk tes dan server Meta tiruan). */
export function signMetaWebhook(rawBody: Buffer | string, appSecret: AppSecret): string {
  return `sha256=${createHmac('sha256', reveal(appSecret)).update(rawBody).digest('hex')}`;
}

/**
 * Memeriksa `X-Hub-Signature-256` atas body mentah. `header` sengaja `unknown`: nilai dari
 * `request.headers` bisa `undefined`, string, atau array (header ganda).
 */
export function verifyMetaWebhookSignature(
  rawBody: Buffer,
  header: unknown,
  appSecret: AppSecret,
): MetaSignatureCheck {
  if (header === undefined || header === null || header === '') return 'missing';
  if (typeof header !== 'string') return 'malformed';
  const match = SIGNATURE_PATTERN.exec(header.trim());
  const presentedHex = match?.[1];
  if (!presentedHex) return 'malformed';

  const presented = Buffer.from(presentedHex, 'hex');
  const expected = createHmac('sha256', reveal(appSecret)).update(rawBody).digest();
  // Keduanya selalu 32 byte (pola di atas), jadi `timingSafeEqual` tidak pernah melempar.
  if (presented.length !== expected.length) return 'malformed';
  return timingSafeEqual(presented, expected) ? 'valid' : 'mismatch';
}

// ── Jabat tangan verifikasi (GET) ───────────────────────────────────────────

/**
 * `hub.challenge` yang boleh dipantulkan (review Fase 2 D.3). Meta mengirim angka; batasnya sengaja
 * sempit supaya respons tidak pernah bisa memuat markup (XSS pantul) meski dijawab `text/plain`.
 */
export const WEBHOOK_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type WebhookHandshake =
  | { ok: true; verifyToken: string; challenge: string }
  | { ok: false; reason: 'mode' | 'token_missing' | 'challenge_invalid' };

/**
 * Membaca query jabat tangan `?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`. Nilai ganda
 * (array) dianggap salah. Perbandingan verify token dilakukan pemanggil (`constantTimeEqual`).
 */
export function parseWebhookHandshake(query: unknown): WebhookHandshake {
  const params = (typeof query === 'object' && query !== null ? query : {}) as Record<
    string,
    unknown
  >;
  const mode = params['hub.mode'];
  const verifyToken = params['hub.verify_token'];
  const challenge = params['hub.challenge'];
  if (mode !== 'subscribe') return { ok: false, reason: 'mode' };
  if (typeof verifyToken !== 'string' || verifyToken === '' || verifyToken.length > 256) {
    return { ok: false, reason: 'token_missing' };
  }
  if (typeof challenge !== 'string' || !WEBHOOK_CHALLENGE_PATTERN.test(challenge)) {
    return { ok: false, reason: 'challenge_invalid' };
  }
  return { ok: true, verifyToken, challenge };
}
