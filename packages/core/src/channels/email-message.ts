import { createHash, randomUUID } from 'node:crypto';

import {
  EMAIL_MAX_ATTACHMENT_BYTES,
  EMAIL_MAX_ATTACHMENTS,
  EMAIL_MAX_HTML_BYTES,
  type MessageMediaKind,
} from '@balesin/shared';
import { simpleParser, type AddressObject, type HeaderValue } from 'mailparser';
import sanitizeHtml from 'sanitize-html';

/** Review Fase 6 R1: hasil verifikasi pengirim email. */
export type EmailSenderVerification = 'pass' | 'fail' | 'unverified';

import {
  EMAIL_HTML_MAX_DEPTH,
  EMAIL_HTML_MAX_TAGS,
  htmlWithinLimits,
  plainTextFromUntrustedHtml,
} from '../mail/html-guard';
import { cleanCustomerText, cleanFileName } from '../meta/contact-identity';
import { detectMedia } from '../meta/media-sniff';

/**
 * Email masuk channel Email (Fase 6): urai RFC 822 → bentuk aman.
 *
 *  - Identitas pengirim = alamat `From` (huruf kecil). Alamat bisa dipalsukan (sifat email): hasil
 *    `Authentication-Results` dari server penerima TEPERCAYA menjadi `senderVerification`
 *    (`pass`/`fail`/`unverified`, review Fase 6 R1); tanpa hasil tepercaya = `unverified`.
 *  - Anti-loop: balasan otomatis (`Auto-Submitted`, `Precedence: bulk/junk/list/auto_reply`,
 *    `X-Autoreply`/`X-Autorespond`), laporan bounce (`multipart/report`, MAILER-DAEMON, `Return-Path: <>`)
 *    dan email dari alamat channel sendiri DILEWATI (tidak masuk inbox, tidak dibalas).
 *  - HTML disanitasi KETAT di server: hanya tag teks/struktur, tanpa skrip/gaya/atribut event/form/
 *    iframe/gambar (gambar jarak jauh = pelacak), tautan hanya http/https/mailto. Web tetap wajib
 *    menampilkannya di `<iframe sandbox>`.
 *  - Lampiran: jenis dari ISI (magic bytes); dokumen Office bermakro & berkas yang bisa dijalankan
 *    dilewati; ukuran & jumlah dibatasi.
 */

export type EmailSkipReason = 'auto_reply' | 'bounce' | 'own_address' | 'no_sender';

export interface EmailAttachmentPart {
  filename: string | null;
  kind: MessageMediaKind;
  mimeType: string;
  content: Buffer;
}

export interface ParsedInboundEmail {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  subject: string | null;
  from: { address: string; name: string | null };
  date: Date | null;
  /** Teks untuk ruang chat (kutipan email lama dipotong bila jelas). */
  text: string | null;
  /** HTML tersanitasi (≤ `EMAIL_MAX_HTML_BYTES`), atau `null`. */
  html: string | null;
  /**
   * Review Fase 6 R1 — hasil verifikasi pengirim dari server penerima TEPERCAYA (lihat
   * `emailSenderVerification`): `pass` / `fail` / `unverified` (tidak ada hasil tepercaya).
   */
  senderVerification: EmailSenderVerification;
  /** `true` hanya bila verifikasi GAGAL (`fail`) — peringatan keras. */
  authWarning: boolean;
  attachments: EmailAttachmentPart[];
  skippedAttachments: number;
  /** Tahap 9.0 — header `To`/`Cc` (huruf kecil, tanpa duplikat, maks. `EMAIL_MAX_HEADER_ADDRESSES`). */
  to: string[];
  cc: string[];
  /**
   * Penerima amplop dari server penerima: `Delivered-To` lalu `X-Original-To`, urut dari atas
   * (paling baru dulu). Bisa dipalsukan pengirim — hanya dipakai bila COCOK dengan alamat/alias
   * channel (`emailDestination`).
   */
  envelopeTo: string[];
}

export type EmailParseResult =
  { ok: true; email: ParsedInboundEmail } | { ok: false; reason: EmailSkipReason };

/** `Message-ID` tanpa `<>`; hanya karakter tampak tanpa spasi. */
const MESSAGE_ID_PATTERN = /^[\x21-\x3b\x3d\x3f-\x7e]{1,998}$/;

export function normalizeMessageId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const match = /<([^<>]+)>/.exec(value);
  const id = (match?.[1] ?? value).trim();
  return MESSAGE_ID_PATTERN.test(id) ? id : null;
}

/** ID eksternal (`messages.wamid`, ≤ 256): `Message-ID` panjang → `sha256:<hex>`. */
export function emailExternalId(messageId: string): string {
  return messageId.length <= 256
    ? messageId
    : `sha256:${createHash('sha256').update(messageId).digest('hex')}`;
}

function messageIdList(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value : value ? value.split(/\s+/) : [];
  return raw
    .map(normalizeMessageId)
    .filter((id): id is string => id !== null && id.length <= 256)
    .slice(-20);
}

const EMAIL_ADDRESS_PATTERN = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

export function normalizeEmailAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim().toLowerCase();
  return address.length <= 254 && EMAIL_ADDRESS_PATTERN.test(address) ? address : null;
}

function headerText(value: HeaderValue | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => headerText(item as HeaderValue)).join('\n');
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && 'value' in value && typeof value.value === 'string') {
    return value.value;
  }
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string')
    return value.text;
  return '';
}

/** Header balasan otomatis / bounce → alasan dilewati (RFC 3834, RFC 3464). */
export function automatedEmailReason(
  headers: ReadonlyMap<string, HeaderValue>,
  fromAddress: string | null,
): EmailSkipReason | null {
  const autoSubmitted = headerText(headers.get('auto-submitted')).trim().toLowerCase();
  if (autoSubmitted !== '' && autoSubmitted !== 'no') return 'auto_reply';
  const precedence = headerText(headers.get('precedence')).trim().toLowerCase();
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return 'auto_reply';
  if (
    headers.has('x-autoreply') ||
    headers.has('x-autorespond') ||
    headers.has('x-autoresponder')
  ) {
    return 'auto_reply';
  }
  const contentType = headerText(headers.get('content-type')).toLowerCase();
  if (contentType.includes('multipart/report') || contentType.includes('message/delivery-status')) {
    return 'bounce';
  }
  const returnPath = headers.get('return-path');
  const returnText = headerText(returnPath).trim();
  // `Return-Path: <>` (pengirim kosong = bounce); mailparser bisa mengurainya jadi alamat kosong.
  if (
    returnText === '<>' ||
    (returnPath !== undefined &&
      typeof returnPath === 'object' &&
      'value' in returnPath &&
      Array.isArray(returnPath.value) &&
      returnPath.value.every((item) => !(item as { address?: string }).address))
  ) {
    return 'bounce';
  }
  const local = fromAddress?.split('@')[0] ?? '';
  if (['mailer-daemon', 'postmaster'].includes(local)) return 'bounce';
  return null;
}

/**
 * `authserv-id` header `Authentication-Results` (token pertama sebelum `;`, tanpa versi, huruf kecil).
 * `null` bila bentuknya tidak dikenali.
 */
export function authServIdOf(value: string): string | null {
  const id = value.split(';', 1)[0]?.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return /^[a-z0-9.-]{1,253}$/.test(id) ? id : null;
}

/** `authserv-id` cocok dengan daftar tepercaya: sama persis, atau `*.domain` untuk entri `.domain`. */
function authServTrusted(id: string, trusted: readonly string[]): boolean {
  return trusted.some((entry) =>
    entry.startsWith('.') ? id.endsWith(entry) || id === entry.slice(1) : id === entry,
  );
}

/**
 * Daftar `authserv-id` tepercaya bawaan untuk kotak masuk di host IMAP ini: host itu sendiri, domain
 * induknya (`.domain`, mis. `mail.perusahaan.co.id` → `.perusahaan.co.id`), plus penyedia besar yang
 * dikenal (Gmail menandai `mx.google.com`).
 */
export function defaultTrustedAuthServIds(imapHost: string): string[] {
  const host = imapHost.trim().toLowerCase();
  const labels = host.split('.');
  const list = [host];
  if (labels.length >= 3) list.push(`.${labels.slice(1).join('.')}`);
  const known: Readonly<Record<string, string[]>> = {
    'imap.gmail.com': ['mx.google.com'],
    'imap.googlemail.com': ['mx.google.com'],
    'imap.mail.yahoo.com': ['.yahoo.com'],
  };
  return [...new Set([...list, ...(known[host] ?? [])])];
}

/**
 * Status verifikasi pengirim (review Fase 6 R1). Hanya header `Authentication-Results` TERATAS yang
 * dibuat server tepercaya (`trusted`, `null` = tanpa saringan) yang dipakai — header lebih bawah bisa
 * disisipkan pengirim. Tanpa header tepercaya = `unverified` (bukan dianggap lolos).
 *
 * - `fail`: `dmarc=fail`, atau `spf=fail/softfail` tanpa `dkim=pass`.
 * - `pass`: `dmarc=pass`, atau `dkim=pass` dengan `header.d`/`header.i` domain pengirim.
 * - selain itu `unverified`.
 */
export function emailSenderVerification(
  results: readonly string[],
  trusted: readonly string[] | null,
  fromDomain: string | null,
): EmailSenderVerification {
  const header = results.find((value) => {
    const id = authServIdOf(value);
    return id !== null && (trusted === null || authServTrusted(id, trusted));
  });
  if (header === undefined) return 'unverified';
  const text = header.toLowerCase();
  if (/\bdmarc=fail\b/.test(text)) return 'fail';
  if (/\bspf=(fail|softfail)\b/.test(text) && !/\bdkim=pass\b/.test(text)) return 'fail';
  if (/\bdmarc=pass\b/.test(text)) return 'pass';
  if (fromDomain) {
    const domain = fromDomain.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const aligned = new RegExp(
      `\\bdkim=pass\\b[^;]*\\bheader\\.(d=${domain}|i=[^\\s;]*@${domain})(?![a-z0-9.-])`,
    );
    if (aligned.test(text)) return 'pass';
  }
  return 'unverified';
}

/** Nilai mentah header `Authentication-Results` (urutan dari atas; lipatan baris dirapatkan). */
export function authenticationResultsOf(
  headerLines: ReadonlyArray<{ key: string; line: string }>,
): string[] {
  return headerLines
    .filter((entry) => entry.key === 'authentication-results')
    .map((entry) =>
      entry.line
        .replace(/^[^:]*:/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
}

/**
 * `true` bila pengirim TIDAK terbukti (gagal ATAU tanpa hasil tepercaya). `trusted` tidak diberikan =
 * semua `authserv-id` diterima (hanya untuk tes/utilitas).
 */
export function emailAuthWarning(
  headers: ReadonlyMap<string, HeaderValue>,
  trusted: readonly string[] | null = null,
): boolean {
  const raw = headers.get('authentication-results');
  const values =
    raw === undefined
      ? []
      : Array.isArray(raw)
        ? raw.map((item) => headerText(item as HeaderValue))
        : [headerText(raw)];
  return emailSenderVerification(values, trusted, null) !== 'pass';
}

// ── HTML ────────────────────────────────────────────────────────────────────

const ALLOWED_TAGS = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'dd',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];

/**
 * Review 9.1 putaran 2 S3 — jaring pengaman `sanitizeEmailHtml`: batas umum (`html-guard.ts`) +
 * ruang untuk bingkai dokumen email keluar (html/body/tabel merek ≈ 8 tingkat, ±25 tag) karena
 * salinan Inbox email API (`persist`) disanitasi ulang dengan profil ini SETELAH render. Email masuk
 * diperiksa dengan batas umum di `parseInboundEmail` sebelum sampai sini.
 */
const SANITIZE_SAFETY_LIMITS = {
  maxTags: EMAIL_HTML_MAX_TAGS + 500,
  maxDepth: EMAIL_HTML_MAX_DEPTH + 20,
} as const;

/** Catatan di versi teks saat tampilan HTML email masuk dibuang (terlalu besar/rumit). */
export const EMAIL_HTML_OMITTED_NOTE =
  '(Tampilan HTML email ini tidak tersedia karena terlalu besar atau terlalu rumit. Yang tampil hanya versi teksnya.)';

/**
 * HTML email → HTML aman. Tanpa `style`/`class`/`id`/event, tanpa gambar, tanpa skrip/form/iframe/
 * svg/math, tautan hanya http(s)/mailto dengan `rel="noopener noreferrer nofollow"` + `target=_blank`.
 *
 * Review 9.1 S3: HTML yang melewati batas tag/kedalaman TIDAK disanitasi (sanitize-html super-linear
 * terhadap kedalaman) — hasilnya string kosong (= tanpa tampilan HTML).
 */
export function sanitizeEmailHtml(html: string): string {
  if (!htmlWithinLimits(html, SANITIZE_SAFETY_LIMITS)) return '';
  return sanitizeInboundProfile(html);
}

/** Tanpa penjaga — pemanggil WAJIB sudah memeriksa `htmlWithinLimits`. */
function sanitizeInboundProfile(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'title', 'rel', 'target'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {},
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    // Isi tag berbahaya dibuang seluruhnya (bukan hanya tagnya).
    nonTextTags: [
      'style',
      'script',
      'textarea',
      'option',
      'noscript',
      'title',
      'head',
      'template',
      'svg',
      'math',
      'object',
      'iframe',
    ],
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...(attribs.href ? { href: attribs.href } : {}),
          ...(attribs.title ? { title: attribs.title } : {}),
          rel: 'noopener noreferrer nofollow',
          target: '_blank',
        },
      }),
    },
  });
}

// ── Teks ────────────────────────────────────────────────────────────────────

const QUOTE_HEADER_PATTERNS = [
  /^(on|pada)\s.{1,300}\s(wrote|menulis):\s*$/i,
  /^-{2,}\s*(original message|pesan asli|forwarded message|pesan yang diteruskan)\s*-{2,}\s*$/i,
  /^_{10,}\s*$/,
];

/**
 * Buang kutipan email sebelumnya di BAWAH balasan (pola umum Gmail/Outlook/Thunderbird). Hanya bila
 * teks balasannya tidak kosong — selain itu teks utuh dipertahankan. Teks asli lengkap tetap ada di
 * versi HTML.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/);
  let cut = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (QUOTE_HEADER_PATTERNS.some((pattern) => pattern.test(line))) {
      cut = index;
      break;
    }
    // Blok kutipan `>` sampai akhir email.
    if (
      line.startsWith('>') &&
      lines.slice(index).every((rest) => rest.trim() === '' || rest.trim().startsWith('>'))
    ) {
      cut = index;
      break;
    }
  }
  const kept = lines.slice(0, cut).join('\n').trim();
  return kept.length > 0 ? kept : text.trim();
}

const EMAIL_TEXT_MAX_CHARS = 65_536;

function cleanBody(text: string | undefined): string | null {
  if (!text) return null;
  const cleaned = stripQuotedReply(text.replaceAll('\u0000', '').replace(/\r\n/g, '\n'));
  if (cleaned.length === 0) return null;
  return cleaned.length > EMAIL_TEXT_MAX_CHARS ? cleaned.slice(0, EMAIL_TEXT_MAX_CHARS) : cleaned;
}

// ── Lampiran ────────────────────────────────────────────────────────────────

/** Ekstensi yang bisa dijalankan / ditafsirkan browser — tidak pernah disimpan. */
const DANGEROUS_EXTENSIONS = new Set([
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
]);
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);

function extensionOf(filename: string | null): string {
  return /\.([A-Za-z0-9]{1,8})$/.exec(filename ?? '')?.[1]?.toLowerCase() ?? '';
}

/** Fase 9 (modul Email): nama berkas berekstensi yang bisa dijalankan/ditafsirkan browser/bermakro. */
export function isDangerousEmailFileName(filename: string | null): boolean {
  return DANGEROUS_EXTENSIONS.has(extensionOf(filename));
}

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const isCfbContainer = (content: Buffer) =>
  content.length >= CFB_SIGNATURE.length &&
  CFB_SIGNATURE.every((value, index) => content[index] === value);

/** Lampiran → jenis aman untuk disimpan, atau `null` (dilewati). */
export function classifyEmailAttachment(
  content: Buffer,
  filename: string | null,
): { kind: MessageMediaKind; mimeType: string } | null {
  if (content.length === 0 || content.length > EMAIL_MAX_ATTACHMENT_BYTES) return null;
  const extension = extensionOf(filename);
  if (DANGEROUS_EXTENSIONS.has(extension)) return null;
  // Review 9.1 putaran 3 (Info): wadah CFB/OLE (Office 97–2003 `.doc`/`.xls`/`.ppt`, `.msg`, …) selalu
  // dilewati — apa pun nama berkasnya — sama dengan lampiran email keluar API (R2b). Makro `.ppt` dan
  // objek OLE/DDE tidak terlihat dari nama aliran, jadi pemeriksaan penanda makro tidak cukup.
  if (isCfbContainer(content)) return null;
  // Deteksi penuh (wadah Office diperiksa: makro → null).
  const detected = detectMedia(content, filename, { verifyContainer: true });
  if (detected) return { kind: detected.kind, mimeType: detected.mimeType };
  // Office yang tidak lolos pemeriksaan wadah = bermakro / rusak.
  if (OFFICE_EXTENSIONS.has(extension)) return null;
  // Jenis lain (zip, gif, csv, …) disimpan sebagai biner — selalu diunduh `attachment`, tidak inline.
  return { kind: 'document', mimeType: 'application/octet-stream' };
}

function addressesOf(value: AddressObject | AddressObject[] | undefined): AddressObject['value'] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).flatMap((item) => item.value);
}

/** Tahap 9.0: paling banyak sekian alamat per header yang disimpan (`To`, `Cc`). */
export const EMAIL_MAX_HEADER_ADDRESSES = 50;

/** Alamat sah, huruf kecil, tanpa duplikat, maks. `EMAIL_MAX_HEADER_ADDRESSES` (grup ikut diurai). */
function addressListOf(value: AddressObject | AddressObject[] | undefined): string[] {
  const out = new Set<string>();
  const visit = (entries: AddressObject['value']) => {
    for (const entry of entries) {
      if (out.size >= EMAIL_MAX_HEADER_ADDRESSES) return;
      if (entry.group) visit(entry.group);
      const address = normalizeEmailAddress(entry.address);
      if (address) out.add(address);
    }
  };
  visit(addressesOf(value));
  return [...out];
}

/** `Delivered-To` + `X-Original-To` dari baris header mentah, urut kemunculan (teratas dulu). */
function envelopeRecipientsOf(lines: readonly { key: string; line: string }[]): string[] {
  const out = new Set<string>();
  for (const key of ['delivered-to', 'x-original-to']) {
    for (const header of lines) {
      if (header.key !== key || out.size >= 10) continue;
      const value = header.line.slice(header.line.indexOf(':') + 1).trim();
      const address = normalizeEmailAddress(/<([^<>]+)>/.exec(value)?.[1] ?? value);
      if (address) out.add(address);
    }
  }
  return [...out];
}

/**
 * Tahap 9.0 — alamat tujuan email masuk: kandidat pertama (`Delivered-To`/`X-Original-To` → `To` →
 * `Cc`) yang COCOK dengan alamat/alias channel. `null` = tidak ada yang cocok (Bcc, alias belum
 * didaftarkan). Header amplop bisa dipalsukan, jadi tidak pernah dipakai bila tidak cocok.
 */
export function emailDestination(
  email: Pick<ParsedInboundEmail, 'envelopeTo' | 'to' | 'cc'>,
  channelAddresses: readonly string[],
): string | null {
  const own = new Set(channelAddresses.map((address) => address.toLowerCase()));
  return (
    [...email.envelopeTo, ...email.to, ...email.cc].find((address) => own.has(address)) ?? null
  );
}

/**
 * Tahap 9.0 — isi Cc "Balas semua": `To` + `Cc` tanpa alamat sendiri (`exclude`: alamat/alias
 * channel, alamat SMTP sistem, pengirim).
 */
export function emailReplyAll(
  email: Pick<ParsedInboundEmail, 'to' | 'cc'>,
  exclude: readonly string[],
): string[] {
  const skip = new Set(exclude.map((address) => address.toLowerCase()));
  return [...new Set([...email.to, ...email.cc])].filter((address) => !skip.has(address));
}

/**
 * Urai email mentah. `ownAddresses` = alamat channel (email darinya sendiri dilewati — loop).
 */
export async function parseInboundEmail(
  raw: Buffer,
  ownAddresses: readonly string[],
  /** `authserv-id` tepercaya kotak masuk ini (`defaultTrustedAuthServIds` bila tidak diatur). */
  trustedAuthServIds: readonly string[] = [],
): Promise<EmailParseResult> {
  const parsed = await simpleParser(raw, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    keepCidLinks: true,
    maxHtmlLengthToParse: 2 * 1024 * 1024,
  });
  const sender = addressesOf(parsed.from)[0];
  const fromAddress = normalizeEmailAddress(sender?.address);
  const automated = automatedEmailReason(parsed.headers, fromAddress);
  if (automated) return { ok: false, reason: automated };
  if (!fromAddress) return { ok: false, reason: 'no_sender' };
  if (ownAddresses.includes(fromAddress)) return { ok: false, reason: 'own_address' };

  // Review 9.1 putaran 2 S3: email mentah boleh 25 MB dari pengirim mana pun di internet. Ukuran
  // (≤ 512 KB) dan kerumitan (tag/kedalaman) HTML diperiksa SEBELUM sanitize-html (super-linear
  // terhadap kedalaman). Lewat batas → HTML dibuang, versi teks + catatan dipakai.
  let html: string | null = null;
  let htmlOmitted = false;
  const rawHtml = typeof parsed.html === 'string' ? parsed.html : '';
  if (rawHtml.length > 0) {
    if (
      rawHtml.length > EMAIL_MAX_HTML_BYTES ||
      Buffer.byteLength(rawHtml) > EMAIL_MAX_HTML_BYTES ||
      !htmlWithinLimits(rawHtml)
    ) {
      htmlOmitted = true;
    } else {
      const clean = sanitizeInboundProfile(rawHtml).trim();
      if (Buffer.byteLength(clean) > EMAIL_MAX_HTML_BYTES) htmlOmitted = true;
      else if (clean.length > 0) html = clean;
    }
  }
  let text = cleanBody(parsed.text);
  if (htmlOmitted) {
    const body = (text ?? cleanBody(plainTextFromUntrustedHtml(rawHtml)) ?? '').slice(
      0,
      EMAIL_TEXT_MAX_CHARS - EMAIL_HTML_OMITTED_NOTE.length - 2,
    );
    text = body.length > 0 ? `${body}\n\n${EMAIL_HTML_OMITTED_NOTE}` : EMAIL_HTML_OMITTED_NOTE;
  }

  const attachments: EmailAttachmentPart[] = [];
  let skippedAttachments = 0;
  for (const attachment of parsed.attachments) {
    // Gambar tertanam (logo tanda tangan, `cid:`) bukan lampiran sungguhan — diabaikan diam-diam.
    if (attachment.related && attachment.contentDisposition !== 'attachment') continue;
    const filename = cleanFileName(attachment.filename ?? null);
    const verdict =
      attachments.length < EMAIL_MAX_ATTACHMENTS
        ? classifyEmailAttachment(attachment.content, filename)
        : null;
    if (!verdict) {
      skippedAttachments += 1;
      continue;
    }
    attachments.push({ filename, ...verdict, content: attachment.content });
  }

  const messageId =
    normalizeMessageId(parsed.messageId) ?? `tanpa-id.${randomUUID()}@balesin.invalid`;
  const verification = emailSenderVerification(
    authenticationResultsOf(parsed.headerLines),
    trustedAuthServIds,
    fromAddress.split('@')[1] ?? null,
  );
  return {
    ok: true,
    email: {
      messageId,
      inReplyTo: messageIdList(parsed.inReplyTo)[0] ?? null,
      references: messageIdList(parsed.references),
      subject: cleanCustomerText(parsed.subject ?? null, 998),
      from: { address: fromAddress, name: cleanCustomerText(sender?.name ?? null) },
      date: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null,
      text,
      html,
      senderVerification: verification,
      authWarning: verification === 'fail',
      attachments,
      skippedAttachments,
      to: addressListOf(parsed.to),
      cc: addressListOf(parsed.cc),
      envelopeTo: envelopeRecipientsOf(parsed.headerLines),
    },
  };
}

// ── Balasan keluar ──────────────────────────────────────────────────────────

/** Subjek balasan: `Re: <subjek>` tanpa menumpuk `Re:`/`Bls:`. */
export function replySubject(subject: string | null): string {
  const base = (subject ?? '').replace(/^\s*((re|bls|balas|fwd?|tr)\s*:\s*)+/i, '').trim();
  return base.length > 0 ? `Re: ${base}`.slice(0, 250) : 'Re: (tanpa subjek)';
}

/** `Message-ID` baru untuk email keluar di domain alamat channel. */
export function newOutboundMessageId(fromAddress: string): string {
  const domain = fromAddress.split('@')[1] ?? 'balesin.invalid';
  return `${randomUUID()}@${domain}`;
}
