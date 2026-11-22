import { crc32, deflateSync } from 'node:zlib';

import qrcode from 'qrcode-generator';

/**
 * QRIS untuk email API (Fase 9.1, docs/KONTRAK-API-EMAIL-KIRIM.md §3.4).
 *
 * Payload QRIS (EMVCo MPM) WAJIB lolos struktur TLV + CRC-16/CCITT-FALSE SEBELUM apa pun dibuat —
 * tidak pernah membuat kode QR yang tidak bisa dibayar. Gambar dibuat sebagai PNG grayscale 8-bit
 * dengan encoder kecil di sini (`node:zlib`), tanpa `sharp`. Teks payload tidak pernah di-log.
 */

export type QrisInvalidReason = 'qris_invalid_format' | 'qris_crc_mismatch';

export const QRIS_PAYLOAD_MIN = 20;
export const QRIS_PAYLOAD_MAX = 512;

/** CRC-16/CCITT-FALSE (poli 0x1021, awal 0xFFFF, tanpa refleksi/XOR akhir) → 4 hex huruf besar. */
export function crc16CcittFalse(text: string): string {
  let crc = 0xffff;
  for (let index = 0; index < text.length; index += 1) {
    crc ^= (text.charCodeAt(index) & 0xff) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * Periksa payload QRIS: panjang 20–512 karakter ASCII cetak, TLV (ID 2 digit + panjang 2 digit +
 * nilai) habis tepat di akhir, diawali `000201`, elemen terakhir `63` panjang `04`, dan CRC atas
 * teks sampai `6304` sama dengan 4 hex terakhir (tanpa beda huruf besar/kecil).
 */
export function validateQrisPayload(
  payload: string,
): { ok: true } | { ok: false; reason: QrisInvalidReason } {
  const invalid = { ok: false as const, reason: 'qris_invalid_format' as const };
  if (
    payload.length < QRIS_PAYLOAD_MIN ||
    payload.length > QRIS_PAYLOAD_MAX ||
    !PRINTABLE_ASCII.test(payload) ||
    !payload.startsWith('000201')
  ) {
    return invalid;
  }
  let position = 0;
  let lastId: string | null = null;
  let lastLength = -1;
  let lastStart = -1;
  while (position < payload.length) {
    const header = payload.slice(position, position + 4);
    if (!/^\d{4}$/.test(header)) return invalid;
    const length = Number(header.slice(2));
    const end = position + 4 + length;
    if (end > payload.length) return invalid;
    lastId = header.slice(0, 2);
    lastLength = length;
    lastStart = position;
    position = end;
  }
  if (lastId !== '63' || lastLength !== 4 || lastStart !== payload.length - 8) return invalid;
  const checksum = payload.slice(-4);
  if (!/^[0-9A-Fa-f]{4}$/.test(checksum)) return invalid;
  if (crc16CcittFalse(payload.slice(0, -4)) !== checksum.toUpperCase()) {
    return { ok: false, reason: 'qris_crc_mismatch' };
  }
  return { ok: true };
}

// ── PNG ──────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, checksum]);
}

/** PNG grayscale 8-bit (tanpa interlace). `pixels` = `width × height` byte (0 hitam … 255 putih). */
export function encodeGrayscalePng(width: number, height: number, pixels: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('Ukuran gambar PNG tidak valid');
  }
  if (pixels.length !== width * height) throw new Error('Jumlah piksel tidak cocok dengan ukuran');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // kedalaman bit
  header[9] = 0; // grayscale
  header[10] = 0; // kompresi deflate
  header[11] = 0; // filter adaptif
  header[12] = 0; // tanpa interlace
  const raw = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (width + 1);
    raw[offset] = 0; // filter: None
    raw.set(pixels.subarray(row * width, (row + 1) * width), offset + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Zona tenang standar QR (modul). */
const QUIET_ZONE = 4;

/**
 * Kode QR (koreksi galat M, versi otomatis, mode byte) → PNG `sizePx × sizePx`. Skala modul bulat
 * (`floor(sizePx / (modul + 8))`, min. 1) supaya tajam; sisa piksel menjadi bantalan putih di tengah.
 */
export function renderQrPng(text: string, sizePx: number): Buffer {
  if (!Number.isInteger(sizePx) || sizePx < 1 || sizePx > 4096) {
    throw new Error('Ukuran gambar QR tidak valid');
  }
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const modules = qr.getModuleCount();
  const scale = Math.max(1, Math.floor(sizePx / (modules + QUIET_ZONE * 2)));
  const drawn = modules * scale;
  const size = Math.max(sizePx, drawn + 2 * QUIET_ZONE * scale);
  const offset = Math.floor((size - drawn) / 2);
  const pixels = new Uint8Array(size * size).fill(255);
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (!qr.isDark(row, col)) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        const start = (offset + row * scale + dy) * size + offset + col * scale;
        pixels.fill(0, start, start + scale);
      }
    }
  }
  return encodeGrayscalePng(size, size, pixels);
}
