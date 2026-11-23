import { domainToASCII } from 'node:url';

import { attachmentExtensionOf, isDangerousEmailFileName } from '../channels/email-message';
import { cleanFileName } from '../meta/contact-identity';
import { detectMedia } from '../meta/media-sniff';
import type { MailBodyStructureNode } from './imap-account';

/**
 * Isi email modul Email (KONTRAK-API-EMAIL §8): lampiran dari BODYSTRUCTURE, risiko lampiran (nama +
 * jenis saat sinkron, dipastikan ulang dari ISI saat diunduh), gambar raster dari isi, dekode
 * transfer-encoding bagian, dan peringatan pengirim (penyamaran nama, domain mirip).
 */

// ── Lampiran ────────────────────────────────────────────────────────────────

export type MailAttachmentRiskLevel = 'ok' | 'warn' | 'blocked';

export interface MailAttachmentPartInfo {
  partId: string;
  filename: string | null;
  declaredType: string;
  encoding: string | null;
  sizeBytes: number;
  contentId: string | null;
  isInline: boolean;
}

const ARCHIVE_EXTENSIONS = new Set([
  'zip',
  'rar',
  '7z',
  'gz',
  'tgz',
  'tar',
  'bz2',
  'xz',
  'cab',
  'arj',
  'lzh',
  'z',
]);
/** Ekstensi tambahan di luar daftar Fase 6 (pintasan, citra disk, skrip, Office lama berwadah CFB). */
const EXTRA_BLOCKED_EXTENSIONS = new Set([
  'ps1xml',
  'psc1',
  'msh',
  'scf',
  'inf',
  'gadget',
  'application',
  'appref-ms',
  'settingcontent-ms',
  'library-ms',
  'vhdx',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'chm',
  'xll',
  'xlam',
  'ppam',
  'one',
  'website',
  'svgz',
  'xht',
  'xml',
  'xsl',
  'mhtml',
  'jnlp',
  'wsc',
  'sct',
  'ade',
  'adp',
  'mde',
  'accde',
]);
const BLOCKED_TYPES = [
  /^text\/html\b/,
  /^application\/xhtml/,
  /^image\/svg/,
  /^application\/(x-)?(ms-?dos-?)?(executable|msdownload|msdos-program|ms-installer|x-msi)/,
  /^application\/(x-)?(javascript|ecmascript|sh|csh|bat|hta|vbscript|powershell)/,
  /^text\/(javascript|ecmascript|vbscript|x-sh)/,
  /^application\/vnd\.ms-.*\.macroenabled/,
  /^application\/x-apple-diskimage/,
  /^application\/java-archive/,
];
const ARCHIVE_TYPES =
  /^application\/(x-)?(zip|zip-compressed|rar|vnd\.rar|7z-compressed|gzip|x-tar|bzip2|x-xz)\b/;

const extensionOf = attachmentExtensionOf;

export const MAIL_ATTACHMENT_RISK_REASONS = {
  executable: 'executable',
  web: 'web_document',
  macro: 'office_macro',
  legacyOffice: 'office_legacy',
  archive: 'archive',
} as const;

/** Risiko dari nama + jenis yang DINYATAKAN (saat isi email diambil, sebelum berkas diunduh). */
export function mailAttachmentRiskOf(
  filename: string | null,
  declaredType: string | null,
): { risk: MailAttachmentRiskLevel; reason: string | null } {
  const extension = extensionOf(filename);
  const type = (declaredType ?? '').toLowerCase();
  if (isDangerousEmailFileName(filename) || EXTRA_BLOCKED_EXTENSIONS.has(extension)) {
    return {
      risk: 'blocked',
      reason: ['html', 'htm', 'xhtml', 'svg', 'shtml', 'mht', 'mhtml', 'xht', 'svgz'].includes(
        extension,
      )
        ? MAIL_ATTACHMENT_RISK_REASONS.web
        : ['docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'potm', 'xlam', 'ppam'].includes(extension)
          ? MAIL_ATTACHMENT_RISK_REASONS.macro
          : MAIL_ATTACHMENT_RISK_REASONS.executable,
    };
  }
  if (BLOCKED_TYPES.some((pattern) => pattern.test(type))) {
    return {
      risk: 'blocked',
      reason: /html|svg/.test(type)
        ? MAIL_ATTACHMENT_RISK_REASONS.web
        : MAIL_ATTACHMENT_RISK_REASONS.executable,
    };
  }
  if (ARCHIVE_EXTENSIONS.has(extension) || ARCHIVE_TYPES.test(type)) {
    return { risk: 'warn', reason: MAIL_ATTACHMENT_RISK_REASONS.archive };
  }
  return { risk: 'ok', reason: null };
}

const startsWith = (bytes: Uint8Array, signature: readonly number[]) =>
  bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);

/** Gambar raster dari ISI (PNG/JPEG/GIF/WebP); selain itu (termasuk SVG) `null`. */
export function sniffRasterImage(
  bytes: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('latin1') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Risiko dari ISI berkas (saat diunduh): program (PE/ELF/Mach-O/skrip shebang), wadah CFB/OLE (Office
 * lama, `.msg` — konsisten dengan keputusan 9.1 putaran 3), halaman web/SVG, Office bermakro → blocked;
 * arsip → warn. `detectedType` = jenis dari isi (tak dikenal → `application/octet-stream`).
 */
export function classifyMailAttachmentContent(
  bytes: Uint8Array,
  filename: string | null,
  options: {
    /**
     * Review 9A-2 S7: `bytes` hanya KEPALA berkas (berkas utuh dialirkan ke disk) — hasil pemeriksaan
     * wadah ZIP Office (`officeZipAllowed` atas direktori pusat dari disk) diberikan pemanggil.
     */
    officeZipAllowed?: boolean;
  } = {},
): { risk: MailAttachmentRiskLevel; reason: string | null; detectedType: string } {
  const byName = mailAttachmentRiskOf(filename, null);
  const octet = 'application/octet-stream';
  if (byName.risk === 'blocked') return { ...byName, detectedType: octet };
  if (
    startsWith(bytes, [0x4d, 0x5a]) ||
    startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
    startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe]) ||
    startsWith(bytes, [0x23, 0x21])
  ) {
    return {
      risk: 'blocked',
      reason: MAIL_ATTACHMENT_RISK_REASONS.executable,
      detectedType: octet,
    };
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return {
      risk: 'blocked',
      reason: MAIL_ATTACHMENT_RISK_REASONS.legacyOffice,
      detectedType: octet,
    };
  }
  const raster = sniffRasterImage(bytes);
  if (raster) return { risk: 'ok', reason: null, detectedType: raster };
  const head = Buffer.from(bytes.subarray(0, 2048))
    .toString('latin1')
    .replace(/^\xEF\xBB\xBF/, '')
    .trimStart()
    .toLowerCase();
  if (
    /^<(!doctype\s+html|html|svg|\?xml|script|head|body|iframe)\b/.test(head) ||
    /<svg[\s>]/.test(head)
  ) {
    return { risk: 'blocked', reason: MAIL_ATTACHMENT_RISK_REASONS.web, detectedType: octet };
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const office =
      options.officeZipAllowed === undefined
        ? detectMedia(bytes, filename, { verifyContainer: true })
        : options.officeZipAllowed
          ? detectMedia(bytes, filename, { verifyContainer: false })
          : null;
    const extension = extensionOf(filename);
    if (['docx', 'xlsx', 'pptx'].includes(extension)) {
      return office
        ? { risk: 'ok', reason: null, detectedType: office.mimeType }
        : { risk: 'blocked', reason: MAIL_ATTACHMENT_RISK_REASONS.macro, detectedType: octet };
    }
    return {
      risk: 'warn',
      reason: MAIL_ATTACHMENT_RISK_REASONS.archive,
      detectedType: 'application/zip',
    };
  }
  if (
    startsWith(bytes, [0x52, 0x61, 0x72, 0x21]) ||
    startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) ||
    startsWith(bytes, [0x1f, 0x8b])
  ) {
    return { risk: 'warn', reason: MAIL_ATTACHMENT_RISK_REASONS.archive, detectedType: octet };
  }
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-') {
    return { risk: byName.risk, reason: byName.reason, detectedType: 'application/pdf' };
  }
  return { risk: byName.risk, reason: byName.reason, detectedType: octet };
}

/**
 * Bagian lampiran/gambar inline dari BODYSTRUCTURE (tanpa bagian teks isi). Maks. 100 bagian.
 */
export function mailAttachmentParts(root: MailBodyStructureNode | null): MailAttachmentPartInfo[] {
  if (!root) return [];
  const out: MailAttachmentPartInfo[] = [];
  const bodyChosen = new Set<MailBodyStructureNode>();
  // Bagian teks/HTML pertama (tanpa disposisi attachment) adalah isi, bukan lampiran.
  const visitText = (node: MailBodyStructureNode) => {
    if (node.childNodes.length > 0) {
      for (const child of node.childNodes) visitText(child);
      return;
    }
    if (
      (node.type === 'text/plain' || node.type === 'text/html') &&
      node.disposition !== 'attachment' &&
      node.filename === null
    ) {
      bodyChosen.add(node);
    }
  };
  visitText(root);
  const visit = (node: MailBodyStructureNode, depth: number) => {
    if (out.length >= 100 || depth > 20) return;
    if (node.childNodes.length > 0) {
      for (const child of node.childNodes) visit(child, depth + 1);
      return;
    }
    if (bodyChosen.has(node)) return;
    const isInline =
      node.disposition !== 'attachment' && node.id !== null && node.type.startsWith('image/');
    const isAttachment =
      node.disposition === 'attachment' ||
      node.filename !== null ||
      isInline ||
      !node.type.startsWith('text/');
    if (!isAttachment || node.type.startsWith('multipart/')) return;
    out.push({
      partId: node.part ?? '1',
      filename: cleanFileName(node.filename),
      declaredType: node.type,
      encoding: node.encoding,
      sizeBytes: node.size,
      contentId: node.id ? node.id.replace(/^<|>$/g, '').slice(0, 998) : null,
      isInline,
    });
  };
  visit(root, 0);
  return out;
}

/** Bagian teks/HTML isi (untuk email > 25 MB: hanya teks yang diambil). */
export function mailBodyTextParts(root: MailBodyStructureNode | null): {
  plain: MailBodyStructureNode | null;
  html: MailBodyStructureNode | null;
} {
  let plain: MailBodyStructureNode | null = null;
  let html: MailBodyStructureNode | null = null;
  const visit = (node: MailBodyStructureNode) => {
    if (node.childNodes.length > 0) {
      for (const child of node.childNodes) visit(child);
      return;
    }
    if (node.disposition === 'attachment' || node.filename !== null) return;
    if (node.type === 'text/plain' && !plain) plain = node;
    if (node.type === 'text/html' && !html) html = node;
  };
  if (root) visit(root);
  return { plain, html };
}

/** Dekode transfer-encoding (base64 / quoted-printable) tanpa memuat array angka (berkas besar). */
export function decodeTransferEncoding(raw: Buffer, encoding: string | null): Buffer {
  const kind = (encoding ?? '').toLowerCase();
  if (kind === 'base64') {
    return Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  if (kind !== 'quoted-printable') return raw;
  const out = Buffer.allocUnsafe(raw.length);
  let length = 0;
  const hex = (code: number) =>
    code >= 0x30 && code <= 0x39
      ? code - 0x30
      : code >= 0x41 && code <= 0x46
        ? code - 0x37
        : code >= 0x61 && code <= 0x66
          ? code - 0x57
          : -1;
  for (let index = 0; index < raw.length; index += 1) {
    const byte = raw[index] ?? 0;
    if (byte !== 0x3d) {
      out[length++] = byte;
      continue;
    }
    const next = raw[index + 1];
    // Jeda baris lunak `=\r\n` / `=\n`.
    if (next === 0x0d && raw[index + 2] === 0x0a) {
      index += 2;
      continue;
    }
    if (next === 0x0a) {
      index += 1;
      continue;
    }
    const high = hex(next ?? -1);
    const low = hex(raw[index + 2] ?? -1);
    if (high >= 0 && low >= 0) {
      out[length++] = high * 16 + low;
      index += 2;
    } else {
      out[length++] = byte;
    }
  }
  return out.subarray(0, length);
}

/**
 * Review 9A-2 S7: dekoder transfer-encoding BERALIR (lampiran besar dialirkan ke disk per potongan,
 * tanpa string latin1 utuh). Hasil `push`+`end` = `decodeTransferEncoding` atas gabungan potongan.
 */
export function createTransferDecoder(encoding: string | null): {
  push(chunk: Buffer): Buffer;
  end(): Buffer;
} {
  const kind = (encoding ?? '').toLowerCase();
  if (kind === 'base64') {
    let carry = '';
    return {
      push(chunk) {
        const text = carry + chunk.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '');
        const usable = text.length - (text.length % 4);
        carry = text.slice(usable);
        return Buffer.from(text.slice(0, usable), 'base64');
      },
      end() {
        const rest = carry;
        carry = '';
        return Buffer.from(rest, 'base64');
      },
    };
  }
  if (kind === 'quoted-printable') {
    let carry: Buffer = Buffer.alloc(0);
    return {
      push(chunk) {
        const joined = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        // `=` di dua byte terakhir bisa jadi awal escape/jeda lunak yang terpotong → ditahan.
        const lastEq = joined.lastIndexOf(0x3d);
        const cut = lastEq >= 0 && lastEq >= joined.length - 2 ? lastEq : joined.length;
        carry = Buffer.from(joined.subarray(cut));
        return decodeTransferEncoding(joined.subarray(0, cut), kind);
      },
      end() {
        const rest = carry;
        carry = Buffer.alloc(0);
        return decodeTransferEncoding(rest, kind);
      },
    };
  }
  return { push: (chunk) => chunk, end: () => Buffer.alloc(0) };
}

// ── Peringatan pengirim (kontrak §8) ────────────────────────────────────────

export interface MailSenderWarningContext {
  /** Domain organisasi (akun Email + Channel Email), huruf kecil. */
  organizationDomains: readonly string[];
  /** Nama anggota tim aktif + nama organisasi. */
  protectedNames: readonly string[];
}

const normalizeName = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s"'`.,_\-()[\]{}<>|]+/g, '');

/** Huruf mirip → huruf dasar (penyetaraan homoglif sederhana; bukan daftar Unicode lengkap). */
const CONFUSABLES: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '5': 's',
  '@': 'a',
  i: 'l',
  // Kiril & Yunani yang paling sering dipakai menyamar.
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  у: 'y',
  і: 'l',
  ј: 'j',
  ԁ: 'd',
  ο: 'o',
  α: 'a',
  ν: 'v',
};

function skeleton(domain: string): string {
  const lower = domain.normalize('NFKC').toLowerCase();
  let out = '';
  for (const char of lower) out += CONFUSABLES[char] ?? char;
  return out.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd');
}

function editDistanceAtMost(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return false;
    previous = current;
  }
  return (previous[b.length] ?? max + 1) <= max;
}

function asciiDomain(domain: string): string {
  const ascii = domainToASCII(domain.toLowerCase());
  return ascii === '' ? domain.toLowerCase() : ascii;
}

/**
 * `impersonation`: nama tampilan = nama anggota tim/organisasi (tanpa beda huruf/spasi) atau memuat
 * alamat berdomain organisasi, TETAPI domain From di luar organisasi. `lookalike_sender`: domain From
 * mirip domain organisasi (jarak edit ≤ 2, atau sama setelah penyetaraan huruf mirip/punycode).
 */
export function mailSenderWarnings(
  from: { address: string; name: string | null } | null,
  context: MailSenderWarningContext,
): ('impersonation' | 'lookalike_sender')[] {
  if (!from) return [];
  const domains = [...new Set(context.organizationDomains.map(asciiDomain))].filter(
    (domain) => domain.length > 0,
  );
  if (domains.length === 0 && context.protectedNames.length === 0) return [];
  const fromDomain = asciiDomain(from.address.slice(from.address.lastIndexOf('@') + 1));
  const internal = domains.some(
    (domain) => fromDomain === domain || fromDomain.endsWith(`.${domain}`),
  );
  if (internal) return [];
  const warnings: ('impersonation' | 'lookalike_sender')[] = [];
  const name = from.name ? normalizeName(from.name) : '';
  if (name.length >= 3) {
    const sameName = context.protectedNames.some((candidate) => {
      const normalized = normalizeName(candidate);
      return normalized.length >= 3 && normalized === name;
    });
    const mentionsDomain = domains.some((domain) =>
      (from.name ?? '').toLowerCase().includes(`@${domain}`),
    );
    if (sameName || mentionsDomain) warnings.push('impersonation');
  }
  const fromSkeleton = skeleton(fromDomain);
  const unicodeFrom = fromDomain.startsWith('xn--') || fromDomain.includes('.xn--');
  const lookalike = domains.some((domain) => {
    if (domain.length < 5) return false;
    if (skeleton(domain) === fromSkeleton) return true;
    if (
      unicodeFrom &&
      skeleton(domain) === skeleton(from.address.slice(from.address.lastIndexOf('@') + 1))
    ) {
      return true;
    }
    return editDistanceAtMost(fromDomain, domain, 2);
  });
  if (lookalike) warnings.push('lookalike_sender');
  return warnings;
}
