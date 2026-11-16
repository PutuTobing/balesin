import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import type { Secret } from '@balesin/core';
import { MOBICHAT_MEDIA_URL_TTL_SECONDS, MOBICHAT_ROUTES } from '@balesin/shared';
import { z } from 'zod';

/**
 * URL media bertanda tangan untuk lapisan kompatibel MobiChat (`attachments[].url` di riwayat pesan).
 * n8n mengunduhnya dengan GET polos tanpa header (seperti `signed_url` MobiChat), dan workflow ULAN
 * bisa meneruskan URL ke penyedia AI bila unduhan gagal — jadi URL harus bisa dibuka tanpa sesi.
 *
 *   /api/public/media/<nomor pesan>?exp=<unix>&kid=<ID API key>&sig=<HMAC>
 *
 * - `sig` = HMAC-SHA256(kunci turunan `BALESIN_MASTER_KEY`, "<nomor>.<exp>.<kid>"), base64url.
 * - Berlaku `MOBICHAT_MEDIA_URL_TTL_SECONDS` (1 jam); terikat ke API key PEMINTA — key dicabut,
 *   kedaluwarsa, atau kehilangan scope `messages:read` → URL mati seketika.
 * - Query string tidak pernah ditulis ke log aplikasi (serializer hanya path); proxy di depan
 *   sebaiknya juga tidak mencatat query (docs/KONTRAK-API-MOBICHAT.md).
 */

export interface MediaUrlSigner {
  /** URL lengkap untuk satu pesan, atau `null` bila master key tidak ada. */
  url(messageNumber: number, apiKeyId: string, now: Date): string | null;
  /** `true` bila tanda tangan sah dan belum kedaluwarsa. */
  verify(
    input: { messageNumber: number; exp: number; kid: string; sig: string },
    now: Date,
  ): boolean;
}

const SKEW_SECONDS = 60;

export function createMediaUrlSigner(
  masterKey: Secret<Buffer> | null,
  baseUrl: string,
): MediaUrlSigner {
  const key = masterKey
    ? Buffer.from(
        hkdfSync('sha256', masterKey.reveal(), Buffer.alloc(0), 'balesin/mobichat-media/v1', 32),
      )
    : null;
  const origin = baseUrl.replace(/\/+$/, '');
  const sign = (secret: Buffer, messageNumber: number, exp: number, kid: string) =>
    createHmac('sha256', secret)
      .update(`${String(messageNumber)}.${String(exp)}.${kid}`)
      .digest('base64url');

  return {
    url(messageNumber, apiKeyId, now) {
      if (!key) return null;
      const exp = Math.floor(now.getTime() / 1000) + MOBICHAT_MEDIA_URL_TTL_SECONDS;
      const path = MOBICHAT_ROUTES.media.replace(':messageNumber', String(messageNumber));
      const query = new URLSearchParams({
        exp: String(exp),
        kid: apiKeyId,
        sig: sign(key, messageNumber, exp, apiKeyId),
      });
      return `${origin}${path}?${query.toString()}`;
    },
    verify({ messageNumber, exp, kid, sig }, now) {
      if (!key || !z.uuid().safeParse(kid).success) return false;
      const nowSeconds = Math.floor(now.getTime() / 1000);
      if (exp <= nowSeconds || exp > nowSeconds + MOBICHAT_MEDIA_URL_TTL_SECONDS + SKEW_SECONDS) {
        return false;
      }
      const expected = Buffer.from(sign(key, messageNumber, exp, kid));
      const given = Buffer.from(sig);
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
  };
}
