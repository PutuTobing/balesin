import { simpleParser } from 'mailparser';

import { EMAIL_HTML_OMITTED_NOTE } from '../channels/email-message';
import { plainTextFromUntrustedHtml } from '../mail/html-guard';
import { sniffRasterImage, decodeTransferEncoding } from './content';
import { sanitizeMailHtmlForDisplay, type DisplayHtmlOptions } from './display-html';

/**
 * Isi email modul Email (KONTRAK-API-EMAIL §11 `mail-fetch-body`): sumber RFC 822 (≤ 25 MB) → teks,
 * HTML tampilan tersanitasi (berpenanda gambar), header mentah (≤ 64 KB), gambar inline raster
 * (≤ 5 MB). Isi TIDAK PERNAH di-log. HTML lewat penjaga kerumitan sebelum sanitasi (review 9.1 S3).
 */

export const MAIL_TEXT_MAX_BYTES = 1024 * 1024;
export const MAIL_SANITIZED_HTML_MAX_BYTES = 2 * 1024 * 1024;
export const MAIL_RAW_HEADERS_LIMIT = 64 * 1024;
const INLINE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const INLINE_IMAGES_MAX = 50;

export interface MailBodyInlineImage {
  contentId: string;
  contentType: string;
  content: Buffer;
}

export interface ParsedMailBody {
  text: string | null;
  /** HTML tampilan berpenanda (`balesin-remote:` / `balesin-cid:`), atau `null`. */
  html: string | null;
  remoteImages: string[];
  linkWarnings: number;
  rawHeaders: string | null;
  inlineImages: MailBodyInlineImage[];
  /** HTML ada tetapi terlalu besar/rumit → hanya teks. */
  htmlOmitted: boolean;
}

/** Potong ke ≤ `maxBytes` UTF-8 tanpa memotong karakter di tengah. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value).subarray(0, maxBytes);
  return buffer.toString('utf8').replace(/�$/, '');
}

function cleanText(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.replaceAll('\u0000', '').replace(/\r\n/g, '\n').trim();
  return text.length > 0 ? truncateUtf8(text, MAIL_TEXT_MAX_BYTES) : null;
}

/** Blok header mentah (sampai baris kosong pertama), ≤ 64 KB, untuk "Lihat sumber". */
export function rawHeaderBlock(raw: Buffer): string {
  const limit = Math.min(raw.length, 512 * 1024);
  const head = raw.subarray(0, limit).toString('latin1');
  const end = head.search(/\r?\n\r?\n/);
  const block = end === -1 ? head : head.slice(0, end);
  // latin1 → byte apa adanya; ditampilkan sebagai teks UTF-8 (header non-ASCII mentah jarang).
  const text = Buffer.from(block, 'latin1').toString('utf8').replaceAll('\u0000', '');
  return truncateUtf8(text, MAIL_RAW_HEADERS_LIMIT);
}

function htmlBody(
  rawHtml: string,
  text: string | null,
  options: DisplayHtmlOptions,
): Pick<ParsedMailBody, 'html' | 'remoteImages' | 'linkWarnings' | 'htmlOmitted' | 'text'> {
  const display = sanitizeMailHtmlForDisplay(rawHtml, options);
  if (display.tooComplex || Buffer.byteLength(display.html) > MAIL_SANITIZED_HTML_MAX_BYTES) {
    const fallback = text ?? cleanText(plainTextFromUntrustedHtml(rawHtml, 512 * 1024));
    return {
      html: null,
      remoteImages: [],
      linkWarnings: 0,
      htmlOmitted: true,
      text: fallback ? `${fallback}\n\n${EMAIL_HTML_OMITTED_NOTE}` : EMAIL_HTML_OMITTED_NOTE,
    };
  }
  return {
    html: display.html.trim().length > 0 ? display.html : null,
    remoteImages: display.remoteImages,
    linkWarnings: display.linkWarnings,
    htmlOmitted: false,
    text,
  };
}

export async function parseMailBody(
  raw: Buffer,
  options: DisplayHtmlOptions,
): Promise<ParsedMailBody> {
  const parsed = await simpleParser(raw, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    keepCidLinks: true,
    maxHtmlLengthToParse: 2 * 1024 * 1024,
  });
  const text = cleanText(parsed.text);
  const rawHtml = typeof parsed.html === 'string' ? parsed.html : '';
  const body =
    rawHtml.length > 0
      ? htmlBody(rawHtml, text, options)
      : { html: null, remoteImages: [], linkWarnings: 0, htmlOmitted: false, text };
  const inlineImages: MailBodyInlineImage[] = [];
  for (const attachment of parsed.attachments) {
    if (inlineImages.length >= INLINE_IMAGES_MAX) break;
    const contentId = attachment.contentId?.replace(/^<|>$/g, '') ?? attachment.cid ?? null;
    if (!contentId || attachment.contentDisposition === 'attachment') continue;
    if (attachment.content.length === 0 || attachment.content.length > INLINE_IMAGE_MAX_BYTES)
      continue;
    const type = sniffRasterImage(attachment.content);
    if (!type) continue;
    inlineImages.push({
      contentId: contentId.slice(0, 998),
      contentType: type,
      content: attachment.content,
    });
  }
  return { ...body, rawHeaders: rawHeaderBlock(raw), inlineImages };
}

/**
 * Email > 25 MB: hanya bagian teks/HTML isi yang diambil (≤ 1 MB, masih ber-transfer-encoding) →
 * teks/HTML tampilan. Gambar inline tidak tersedia.
 */
export function parseMailTextPart(
  raw: Buffer,
  part: { encoding: string | null; charset: string | null; html: boolean },
  options: DisplayHtmlOptions,
): Pick<ParsedMailBody, 'html' | 'remoteImages' | 'linkWarnings' | 'htmlOmitted' | 'text'> {
  const bytes = decodeTransferEncoding(raw, part.encoding);
  let decoded: string;
  try {
    decoded = new TextDecoder(part.charset ?? 'utf-8', { fatal: false }).decode(bytes);
  } catch {
    decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  if (!part.html) {
    return {
      html: null,
      remoteImages: [],
      linkWarnings: 0,
      htmlOmitted: false,
      text: cleanText(decoded),
    };
  }
  return htmlBody(decoded, null, options);
}
