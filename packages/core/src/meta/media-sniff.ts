import {
  OUTBOUND_MEDIA_LIMITS,
  type MessageMediaKind,
  type OutboundMediaKind,
} from '@balesin/shared';

/**
 * Deteksi jenis berkas dari ISI (magic bytes) — SECURITY.md §7. Nama berkas / `Content-Type` dari
 * klien atau Meta tidak pernah dipercaya; satu-satunya pemakaian nama berkas adalah membedakan
 * dokumen Office modern (ZIP) dan teks polos, yang tidak punya tanda tangan unik.
 *
 * Hanya jenis yang didukung WhatsApp Cloud API yang dikenali. Selain itu `null` (ditolak untuk
 * unggahan; untuk unduhan media masuk disajikan sebagai `application/octet-stream` + attachment).
 */

export interface DetectedMedia {
  mimeType: string;
  kind: MessageMediaKind;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((value, index) => bytes[offset + index] === value);

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.length)));

const OOXML_BY_EXTENSION: Readonly<Record<string, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const CFB_BY_EXTENSION: Readonly<Record<string, string>> = {
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
};

function extensionOf(filename: string | null | undefined): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename ?? '');
  return match?.[1]?.toLowerCase() ?? '';
}

/** Teks UTF-8 polos: tanpa NUL dan dapat didekode tanpa galat (sampel awal berkas). */
function isPlainText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 64 * 1024);
  if (sample.length === 0 || sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(
      // Sampel bisa memotong karakter multibita di ujung — buang 3 bita terakhir bila dipotong.
      sample.length === bytes.length ? sample : sample.subarray(0, sample.length - 3),
    );
    return true;
  } catch {
    return false;
  }
}

export function detectMedia(bytes: Uint8Array, filenameHint?: string | null): DetectedMedia | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mimeType: 'image/jpeg', kind: 'image' };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: 'image/png', kind: 'image' };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', kind: 'sticker' };
  }
  if (ascii(bytes, 0, 5) === '%PDF-') return { mimeType: 'application/pdf', kind: 'document' };
  if (ascii(bytes, 0, 4) === 'OggS') return { mimeType: 'audio/ogg', kind: 'audio' };
  if (ascii(bytes, 0, 6) === '#!AMR\n') return { mimeType: 'audio/amr', kind: 'audio' };
  if (ascii(bytes, 0, 3) === 'ID3') return { mimeType: 'audio/mpeg', kind: 'audio' };
  // MPEG audio frame (MP3) atau ADTS (AAC): sinkron 11/12 bit.
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0) {
    return { mimeType: 'audio/aac', kind: 'audio' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
    return { mimeType: 'audio/mpeg', kind: 'audio' };
  }
  // ISO BMFF (MP4/3GP/M4A): `ftyp` di offset 4.
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (brand.startsWith('M4A')) return { mimeType: 'audio/mp4', kind: 'audio' };
    if (brand.startsWith('3gp') || brand.startsWith('3g2')) {
      return { mimeType: 'video/3gpp', kind: 'video' };
    }
    return { mimeType: 'video/mp4', kind: 'video' };
  }
  const extension = extensionOf(filenameHint);
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const mimeType = OOXML_BY_EXTENSION[extension];
    return mimeType ? { mimeType, kind: 'document' } : null;
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    const mimeType = CFB_BY_EXTENSION[extension];
    return mimeType ? { mimeType, kind: 'document' } : null;
  }
  if (extension === 'txt' && isPlainText(bytes))
    return { mimeType: 'text/plain', kind: 'document' };
  return null;
}

/** Hasil deteksi yang boleh DIKIRIM (jenis + MIME didukung + ukuran dalam batas Meta). */
export function checkOutboundMedia(
  detected: DetectedMedia | null,
  sizeBytes: number,
):
  | { ok: true; kind: OutboundMediaKind; mimeType: string }
  | { ok: false; reason: 'unsupported' | 'too_large'; maxBytes?: number } {
  if (!detected || detected.kind === 'sticker') return { ok: false, reason: 'unsupported' };
  const limits = OUTBOUND_MEDIA_LIMITS[detected.kind];
  if (!limits.mimeTypes.includes(detected.mimeType)) return { ok: false, reason: 'unsupported' };
  if (sizeBytes > limits.maxBytes) {
    return { ok: false, reason: 'too_large', maxBytes: limits.maxBytes };
  }
  return { ok: true, kind: detected.kind, mimeType: detected.mimeType };
}

/**
 * Jenis yang aman ditampilkan INLINE di browser (gambar raster, audio, video). Selain ini — PDF,
 * dokumen, teks, apa pun yang tidak dikenali, dan TIDAK PERNAH SVG/HTML — disajikan `attachment`.
 */
export const INLINE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'audio/ogg',
  'audio/mpeg',
  'audio/aac',
  'audio/mp4',
  'audio/amr',
  'video/mp4',
  'video/3gpp',
]);
