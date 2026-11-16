import { INVISIBLE_CHARACTER_PATTERN } from '@balesin/shared';

import type { NormalizedInboundMessage } from './webhook-payload';

/**
 * Identitas pelanggan WhatsApp dari pesan masuk (input TIDAK tepercaya — review webhook D.1).
 *
 *  - `bsuid`: BSUID Meta (`from_user_id`/`user_id`). Hanya karakter aman; selain itu dianggap tidak ada.
 *  - `phone`: `from`/`wa_id` yang lolos sebagai nomor E.164 (`+` + 7–15 digit, tidak diawali 0).
 *    Nomor yang tidak lolos TIDAK disimpan, jadi Balesin tidak pernah membalas ke nomor itu.
 *
 * Minimal salah satu harus ada; bila keduanya tidak lolos, pesan tidak bisa dikaitkan ke kontak.
 */
export interface WhatsAppContactIdentity {
  bsuid: string | null;
  phone: string | null;
}

const BSUID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const WA_ID_PATTERN = /^[1-9][0-9]{6,14}$/;

/** `wa_id` Meta (digit tanpa `+`) → E.164, atau `null` bila bukan nomor yang sah. */
export function waIdToE164(waId: string | null | undefined): string | null {
  if (typeof waId !== 'string') return null;
  const digits = waId.startsWith('+') ? waId.slice(1) : waId;
  return WA_ID_PATTERN.test(digits) ? `+${digits}` : null;
}

export function whatsAppContactIdentity(
  sender: Pick<NormalizedInboundMessage['sender'], 'waId' | 'userId'>,
): WhatsAppContactIdentity {
  return {
    bsuid: sender.userId !== null && BSUID_PATTERN.test(sender.userId) ? sender.userId : null,
    phone: waIdToE164(sender.waId),
  };
}

const INVISIBLE_GLOBAL = new RegExp(INVISIBLE_CHARACTER_PATTERN.source, 'gu');

/**
 * Teks satu baris kiriman pelanggan (nama profil, username) yang aman disimpan & ditampilkan:
 * karakter kendali/format tak terlihat (pengubah arah U+202E, lebar-nol, baris baru) dibuang, spasi
 * dirapatkan, dipotong ke `max` titik kode. `null` bila kosong.
 */
export function cleanCustomerText(value: string | null | undefined, max = 256): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(INVISIBLE_GLOBAL, ' ').replace(/\s+/gu, ' ').trim();
  if (cleaned.length === 0) return null;
  const codePoints = Array.from(cleaned);
  return codePoints.length > max ? codePoints.slice(0, max).join('').trimEnd() : cleaned;
}
