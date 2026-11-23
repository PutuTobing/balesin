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

/** Panjang maksimal URL referral iklan yang disimpan. */
const MAX_URL_LENGTH = 2_048;

/**
 * URL kiriman pelanggan/iklan yang AMAN untuk disimpan (review kontak R2): hanya `http:`/`https:`
 * yang sah menurut `URL` (tanpa karakter tak terlihat). Skema lain (`javascript:`, `data:`, …) →
 * `null`. Klien tetap wajib menampilkannya sebagai teks, bukan tautan langsung.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) return null;
  if (INVISIBLE_CHARACTER_PATTERN.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href.length <= MAX_URL_LENGTH ? url.href : null;
}

const INVISIBLE_REMOVE = new RegExp(INVISIBLE_CHARACTER_PATTERN.source, 'gu');

/**
 * Nama berkas kiriman pelanggan (review kontak R2): karakter tak terlihat/pengubah arah DIBUANG (bukan
 * diganti spasi, supaya `tagihan\u202efdp.exe` tampil apa adanya: `tagihanfdp.exe`), hanya bagian
 * setelah `/` atau `\` terakhir (basename), spasi dirapatkan, maks. 255 titik kode. `null` bila
 * kosong atau hanya `.`/`..`. Nama ini HANYA untuk ditampilkan; berkas disimpan dengan nama buatan
 * server, dan `Content-Disposition` unduhan memakai `filename*` RFC 5987.
 */
export function cleanFileName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const visible = value.replace(INVISIBLE_REMOVE, '');
  const base = visible.split(/[\\/]/).at(-1) ?? '';
  // Review 9A-2 R7: titik/spasi di akhir dibuang (Windows membuangnya saat menyimpan, jadi
  // `tagihan.pdf.js.` sebenarnya `tagihan.pdf.js`) — nama tampilan = nama yang akan tersimpan.
  const cleaned = base
    .replace(/\s+/gu, ' ')
    .replace(/[.\s]+$/u, '')
    .trim();
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return null;
  const codePoints = Array.from(cleaned);
  return codePoints.length > 255 ? codePoints.slice(0, 255).join('').trimEnd() : cleaned;
}

/**
 * Kunci advisory lock transaksi untuk identitas kontak, SUDAH terurut (urutan tetap = bebas deadlock).
 * SATU-SATUNYA sumber format kunci: worker (pesan masuk) dan api (hapus kontak, CRM nanti) wajib
 * memakai ini lalu mengunci dengan `lockAdvisoryKeys` (`@balesin/db`).
 */
export function contactIdentityLockKeys(
  organizationId: string,
  channelType: string,
  identity: { bsuid: string | null; phone: string | null; externalUserId?: string | null },
): string[] {
  const keys: string[] = [];
  if (identity.bsuid) keys.push(`contact:${organizationId}:${channelType}:bsuid:${identity.bsuid}`);
  if (identity.phone) keys.push(`contact:${organizationId}:${channelType}:phone:${identity.phone}`);
  // Fase 6: identitas channel lain (ID Telegram, alamat email, PSID/IGSID).
  if (identity.externalUserId) {
    keys.push(`contact:${organizationId}:${channelType}:ext:${identity.externalUserId}`);
  }
  return keys.sort();
}
