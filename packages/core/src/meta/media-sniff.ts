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

// ── Wadah Office (review ruang chat R1) ─────────────────────────────────────

const OFFICE_FOLDER_BY_EXTENSION: Readonly<Record<string, string>> = {
  docx: 'word/',
  xlsx: 'xl/',
  pptx: 'ppt/',
};
/** Panjang maksimal ujung berkas yang perlu dibaca untuk menemukan End Of Central Directory ZIP. */
export const ZIP_TAIL_BYTES = 22 + 0xffff;
/** Direktori pusat ZIP terbesar yang mau dibaca (cukup untuk dokumen Office yang wajar). */
export const ZIP_MAX_CENTRAL_DIRECTORY_BYTES = 8 * 1024 * 1024;

const u16 = (bytes: Uint8Array, at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u32 = (bytes: Uint8Array, at: number) => (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;

/**
 * Lokasi direktori pusat ZIP dari potongan UJUNG berkas (`tail`, dimulai di `tailStart`), atau `null`
 * (bukan ZIP yang utuh / ZIP64 / direktori terlalu besar).
 */
export function findZipCentralDirectory(
  tail: Uint8Array,
  tailStart: number,
): { offset: number; size: number; entries: number } | null {
  for (let at = tail.length - 22; at >= 0; at -= 1) {
    if (u32(tail, at) !== 0x06054b50) continue;
    const entries = u16(tail, at + 10);
    const size = u32(tail, at + 12);
    const offset = u32(tail, at + 16);
    if (size === 0xffffffff || offset === 0xffffffff || entries === 0xffff) return null;
    if (size > ZIP_MAX_CENTRAL_DIRECTORY_BYTES || offset + size > tailStart + at) return null;
    return { offset, size, entries };
  }
  return null;
}

/** Nama entri dari isi direktori pusat ZIP, atau `null` bila rusak. */
export function zipEntryNames(centralDirectory: Uint8Array, expected: number): string[] | null {
  const names: string[] = [];
  let at = 0;
  const decoder = new TextDecoder('utf-8');
  while (at + 46 <= centralDirectory.length && names.length < 100_000) {
    if (u32(centralDirectory, at) !== 0x02014b50) return null;
    const nameLength = u16(centralDirectory, at + 28);
    const extraLength = u16(centralDirectory, at + 30);
    const commentLength = u16(centralDirectory, at + 32);
    const end = at + 46 + nameLength;
    if (end > centralDirectory.length) return null;
    names.push(decoder.decode(centralDirectory.subarray(at + 46, end)));
    at = end + extraLength + commentLength;
  }
  return names.length === expected ? names : null;
}

/**
 * Dokumen Office modern yang sah: ada `[Content_Types].xml` + folder sesuai ekstensi (`word/`,
 * `xl/`, `ppt/`), TANPA proyek makro (`vbaProject.bin`) maupun program tersisip.
 */
export function officeZipAllowed(
  names: readonly string[],
  filename: string | null | undefined,
): boolean {
  const folder = OFFICE_FOLDER_BY_EXTENSION[extensionOf(filename)];
  if (!folder) return false;
  const lower = names.map((name) => name.toLowerCase());
  return (
    lower.includes('[content_types].xml') &&
    lower.some((name) => name.startsWith(folder)) &&
    !lower.some(
      (name) =>
        name.endsWith('vbaproject.bin') ||
        name.endsWith('vbadata.xml') ||
        // Objek OLE / ActiveX tersisip (`word/embeddings/oleObject1.bin`, paket berisi program —
        // review ruang chat Info P2-3). Dokumen tersisip biasa (`.xlsx`, `.docx`) tetap boleh.
        (/(^|\/)(embeddings|activex)\//.test(name) && name.endsWith('.bin')) ||
        /\.(exe|dll|bat|cmd|com|scr|js|vbs|ps1|msi|jar|apk)$/.test(name),
    )
  );
}

const MACRO_MARKERS = ['_VBA_PROJECT', 'Macros', 'VBA\u0000'].map((text) =>
  Uint8Array.from(Array.from(text).flatMap((character) => [character.charCodeAt(0), 0])),
);
/** Panjang penanda terpanjang (untuk tumpang tindih saat memindai berkas per potongan). */
export const MACRO_MARKER_MAX_BYTES = Math.max(...MACRO_MARKERS.map((marker) => marker.length));

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let at = 0; at + needle.length <= haystack.length; at += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[at + index] !== needle[index]) continue outer;
    }
    return at;
  }
  return -1;
}

/** Potongan berkas CFB memuat nama aliran proyek makro VBA (UTF-16LE). */
export function containsMacroMarker(chunk: Uint8Array): boolean {
  return MACRO_MARKERS.some((marker) => indexOf(chunk, marker) !== -1);
}

/** Pemeriksaan wadah Office pada berkas UTUH di memori. */
function officeContainerAllowed(bytes: Uint8Array, filename: string | null | undefined): boolean {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const tailStart = Math.max(0, bytes.length - ZIP_TAIL_BYTES);
    const location = findZipCentralDirectory(bytes.subarray(tailStart), tailStart);
    if (!location) return false;
    const names = zipEntryNames(
      bytes.subarray(location.offset, location.offset + location.size),
      location.entries,
    );
    return names !== null && officeZipAllowed(names, filename);
  }
  return !containsMacroMarker(bytes);
}

export interface DetectOptions {
  /**
   * `false` = hanya dari AWAL berkas (unggahan yang dialirkan): wadah Office belum diperiksa —
   * pemanggil WAJIB memeriksanya setelah berkas utuh (`findZipCentralDirectory` /
   * `containsMacroMarker`). Bawaan `true` (berkas utuh di memori).
   */
  verifyContainer?: boolean;
}

/** Hasil deteksi adalah dokumen Office berwadah ZIP / CFB (perlu pemeriksaan isi wadah). */
export function officeContainerOf(detected: DetectedMedia | null): 'zip' | 'cfb' | null {
  if (!detected || detected.kind !== 'document') return null;
  if (Object.values(OOXML_BY_EXTENSION).includes(detected.mimeType)) return 'zip';
  if (Object.values(CFB_BY_EXTENSION).includes(detected.mimeType)) return 'cfb';
  return null;
}

export function detectMedia(
  bytes: Uint8Array,
  filenameHint?: string | null,
  options: DetectOptions = {},
): DetectedMedia | null {
  const detected = detectHead(bytes, filenameHint);
  if (options.verifyContainer !== false && officeContainerOf(detected)) {
    return officeContainerAllowed(bytes, filenameHint) ? detected : null;
  }
  return detected;
}

function detectHead(bytes: Uint8Array, filenameHint?: string | null): DetectedMedia | null {
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
