import { detectMedia } from '../meta/media-sniff';

/**
 * Jenis lampiran email KELUAR lewat API (Fase 9.1, docs/KONTRAK-API-EMAIL-KIRIM.md §3.5,
 * SECURITY.md §7). Jenis ditentukan dari ISI (magic bytes); nama berkas hanya dipakai untuk MENOLAK
 * (ekstensi berbahaya) dan membedakan teks CSV/TXT serta dokumen Office.
 *
 * Ditolak (v1 konservatif): program/eksekusi, skrip, pintasan, citra disk, arsip, dokumen Office
 * bermakro, HTML/SVG. Diizinkan: PDF, gambar raster, Office tanpa makro, CSV/TXT, dan biner tak
 * dikenal yang bukan daftar tolak (`application/octet-stream`).
 */

export type OutboundAttachmentClass =
  | {
      ok: true;
      mimeType: string;
      rasterImage: boolean;
      /** Nama berkas dengan ekstensi yang SESUAI jenis hasil deteksi isi (review 9.1 R2). */
      filename: string;
    }
  | { ok: false; reason: 'blocked' | 'empty' };

/**
 * Review 9.1 R2 — daftar IZIN jenis lampiran email keluar (bukan lagi "semua kecuali daftar tolak"):
 * PDF, gambar umum, dokumen Office tanpa makro, CSV/TXT. Arsip (ZIP dsb.), audio/video, dan biner
 * tak dikenal DITOLAK. Ekstensi nama berkas dipaksa sesuai jenis isi (ekstensi lain diganti), jadi
 * berkas tidak bisa menyamar dengan ekstensi berbahaya/menyesatkan di aplikasi email penerima.
 */
const ALLOWED_EXTENSIONS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/bmp': ['bmp'],
  'image/tiff': ['tif', 'tiff'],
  'text/csv': ['csv'],
  'text/plain': ['txt', 'csv'],
  'application/msword': ['doc'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
};

const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  // Sama dengan lampiran masuk channel Email (email-message.ts).
  'exe',
  'bat',
  'cmd',
  'com',
  'scr',
  'pif',
  'cpl',
  'msi',
  'msp',
  'dll',
  'js',
  'jse',
  'vbs',
  'vbe',
  'wsf',
  'wsh',
  'ps1',
  'psm1',
  'hta',
  'jar',
  'lnk',
  'reg',
  'iso',
  'img',
  'vhd',
  'apk',
  'html',
  'htm',
  'xhtml',
  'svg',
  'shtml',
  'mht',
  'docm',
  'xlsm',
  'pptm',
  'dotm',
  'xltm',
  'potm',
  'sh',
  'app',
  'url',
  // Arsip & citra disk (email keluar v1).
  'zip',
  'rar',
  '7z',
  'gz',
  'tgz',
  'tar',
  'bz2',
  'xz',
  'cab',
  'dmg',
  'svgz',
  'xml',
]);

const RASTER_IMAGES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((value, index) => bytes[offset + index] === value);

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  Buffer.from(bytes.subarray(start, Math.min(end, bytes.length))).toString('latin1');

function extensionOf(filename: string): string {
  return /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase() ?? '';
}

/** Tanda tangan berkas yang SELALU ditolak (program, arsip, citra disk, pintasan). */
function blockedSignature(bytes: Uint8Array): boolean {
  if (ascii(bytes, 0, 2) === 'MZ') return true; // PE/DOS
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return true; // ELF
  for (const magic of [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
  ]) {
    if (startsWith(bytes, magic)) return true; // Mach-O / fat binary / kelas Java
  }
  if (ascii(bytes, 0, 2) === '#!') return true; // skrip shebang
  if (ascii(bytes, 0, 6) === 'Rar!\x1a\x07') return true;
  if (startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return true; // 7z
  if (startsWith(bytes, [0x1f, 0x8b])) return true; // gzip
  if (ascii(bytes, 0, 3) === 'BZh') return true; // bzip2
  if (startsWith(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return true; // xz
  if (ascii(bytes, 0, 4) === 'MSCF') return true; // CAB
  if (ascii(bytes, 257, 262) === 'ustar') return true; // tar
  for (const offset of [0x8001, 0x8801, 0x9001]) {
    if (ascii(bytes, offset, offset + 5) === 'CD001') return true; // ISO 9660
  }
  // Pintasan Windows (.lnk): ukuran header 0x4C + CLSID 00021401-…
  if (startsWith(bytes, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])) return true;
  return false;
}

/** Teks UTF-8 (tanpa NUL, dekode ketat). */
function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

const BOM_PATTERN = new RegExp(`^${String.fromCharCode(0xfeff)}`);

/** Teks yang ditafsirkan browser/aplikasi email sebagai HTML/SVG/skrip. */
function looksLikeMarkup(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 4096))
    .toString('utf8')
    .replace(BOM_PATTERN, '')
    .trimStart()
    .toLowerCase();
  if (
    ['<!doctype html', '<html', '<head', '<body', '<script', '<svg', '<iframe', '<meta'].some(
      (prefix) => head.startsWith(prefix),
    )
  ) {
    return true;
  }
  return head.startsWith('<?xml') && head.includes('<svg');
}

type SniffResult =
  { ok: true; mimeType: string; rasterImage: boolean } | { ok: false; reason: 'blocked' | 'empty' };

export function classifyOutboundEmailAttachment(
  content: Buffer,
  filename: string,
): OutboundAttachmentClass {
  const verdict = sniffOutboundEmailAttachment(content, filename);
  if (!verdict.ok) return verdict;
  const allowed = ALLOWED_EXTENSIONS_BY_TYPE[verdict.mimeType];
  if (!allowed) return { ok: false, reason: 'blocked' };
  const extension = extensionOf(filename);
  const base = extension ? filename.slice(0, -(extension.length + 1)) : filename;
  const finalName = allowed.includes(extension)
    ? filename
    : `${(base.trim() || 'lampiran').slice(0, 190)}.${allowed[0] ?? 'bin'}`;
  return { ...verdict, filename: finalName };
}

function sniffOutboundEmailAttachment(content: Buffer, filename: string): SniffResult {
  if (content.length === 0) return { ok: false, reason: 'empty' };
  const extension = extensionOf(filename);
  if (BLOCKED_EXTENSIONS.has(extension)) return { ok: false, reason: 'blocked' };
  if (blockedSignature(content)) return { ok: false, reason: 'blocked' };

  // PDF, PNG/JPEG/WebP, Office (ZIP/CFB diperiksa wadahnya: makro → null), TXT, dsb.
  const detected = detectMedia(content, filename, { verifyContainer: true });
  const zip = startsWith(content, [0x50, 0x4b, 0x03, 0x04]) || startsWith(content, [0x50, 0x4b]);
  const cfb = startsWith(content, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (zip || cfb) {
    // Hanya dokumen Office tanpa makro; arsip ZIP lain / wadah OLE lain ditolak.
    return detected?.kind === 'document'
      ? { ok: true, mimeType: detected.mimeType, rasterImage: false }
      : { ok: false, reason: 'blocked' };
  }
  if (detected) {
    if (detected.mimeType === 'text/plain' && looksLikeMarkup(content)) {
      return { ok: false, reason: 'blocked' };
    }
    if (detected.mimeType === 'application/pdf' || detected.mimeType === 'text/plain') {
      return { ok: true, mimeType: detected.mimeType, rasterImage: false };
    }
    if (RASTER_IMAGES.has(detected.mimeType)) {
      return { ok: true, mimeType: detected.mimeType, rasterImage: true };
    }
  }
  if (ascii(content, 0, 6) === 'GIF87a' || ascii(content, 0, 6) === 'GIF89a') {
    return { ok: true, mimeType: 'image/gif', rasterImage: true };
  }
  if (ascii(content, 0, 2) === 'BM') return { ok: true, mimeType: 'image/bmp', rasterImage: false };
  if (
    startsWith(content, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(content, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return { ok: true, mimeType: 'image/tiff', rasterImage: false };
  }
  if (isUtf8Text(content)) {
    if (looksLikeMarkup(content)) return { ok: false, reason: 'blocked' };
    return {
      ok: true,
      mimeType: extension === 'csv' ? 'text/csv' : 'text/plain',
      rasterImage: false,
    };
  }
  // Teks berpengkodean lain yang tampak seperti markup tetap ditolak.
  if (looksLikeMarkup(content)) return { ok: false, reason: 'blocked' };
  if (detected) return { ok: true, mimeType: detected.mimeType, rasterImage: false };
  return { ok: true, mimeType: 'application/octet-stream', rasterImage: false };
}
