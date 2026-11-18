import { createHash, randomUUID } from 'node:crypto';

import {
  EMAIL_MAX_ATTACHMENT_BYTES,
  EMAIL_MAX_ATTACHMENTS,
  EMAIL_MAX_HTML_BYTES,
  type MessageMediaKind,
} from '@balesin/shared';
import { simpleParser, type AddressObject, type HeaderValue } from 'mailparser';
import sanitizeHtml from 'sanitize-html';

import { cleanCustomerText, cleanFileName } from '../meta/contact-identity';
import { detectMedia } from '../meta/media-sniff';

/**
 * Email masuk channel Email (Fase 6): urai RFC 822 → bentuk aman.
 *
 *  - Identitas pengirim = alamat `From` (huruf kecil). Alamat bisa dipalsukan (sifat email): hasil
 *    `Authentication-Results` server penerima (SPF/DKIM/DMARC gagal) diteruskan sebagai `authWarning`.
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
  authWarning: boolean;
  attachments: EmailAttachmentPart[];
  skippedAttachments: number;
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

/** `Authentication-Results` server penerima: DMARC gagal, atau SPF gagal tanpa DKIM lolos. */
export function emailAuthWarning(headers: ReadonlyMap<string, HeaderValue>): boolean {
  const results = headerText(headers.get('authentication-results')).toLowerCase();
  if (results === '') return false;
  if (/\bdmarc=fail\b/.test(results)) return true;
  return /\bspf=(fail|softfail)\b/.test(results) && !/\bdkim=pass\b/.test(results);
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
 * HTML email → HTML aman. Tanpa `style`/`class`/`id`/event, tanpa gambar, tanpa skrip/form/iframe/
 * svg/math, tautan hanya http(s)/mailto dengan `rel="noopener noreferrer nofollow"` + `target=_blank`.
 */
export function sanitizeEmailHtml(html: string): string {
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

function cleanBody(text: string | undefined): string | null {
  if (!text) return null;
  const cleaned = stripQuotedReply(text.replaceAll('\u0000', '').replace(/\r\n/g, '\n'));
  if (cleaned.length === 0) return null;
  return cleaned.length > 65_536 ? cleaned.slice(0, 65_536) : cleaned;
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

/** Lampiran → jenis aman untuk disimpan, atau `null` (dilewati). */
export function classifyEmailAttachment(
  content: Buffer,
  filename: string | null,
): { kind: MessageMediaKind; mimeType: string } | null {
  if (content.length === 0 || content.length > EMAIL_MAX_ATTACHMENT_BYTES) return null;
  const extension = extensionOf(filename);
  if (DANGEROUS_EXTENSIONS.has(extension)) return null;
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

/**
 * Urai email mentah. `ownAddresses` = alamat channel (email darinya sendiri dilewati — loop).
 */
export async function parseInboundEmail(
  raw: Buffer,
  ownAddresses: readonly string[],
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

  let html: string | null = null;
  if (typeof parsed.html === 'string' && parsed.html.length > 0) {
    const clean = sanitizeEmailHtml(parsed.html).trim();
    html = clean.length > 0 && Buffer.byteLength(clean) <= EMAIL_MAX_HTML_BYTES ? clean : null;
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
  return {
    ok: true,
    email: {
      messageId,
      inReplyTo: messageIdList(parsed.inReplyTo)[0] ?? null,
      references: messageIdList(parsed.references),
      subject: cleanCustomerText(parsed.subject ?? null, 998),
      from: { address: fromAddress, name: cleanCustomerText(sender?.name ?? null) },
      date: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null,
      text: cleanBody(parsed.text),
      html,
      authWarning: emailAuthWarning(parsed.headers),
      attachments,
      skippedAttachments,
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
