import {
  MAIL_LINK_WARNING_PATH,
  MAIL_QUOTE_HTML_MAX_BYTES,
  MAIL_QUOTE_TEXT_MAX_BYTES,
  type MailComposeAddress,
  type MailDraftMode,
} from '@balesin/shared';
import sanitizeHtml from 'sanitize-html';

import { htmlWithinLimits, plainTextFromUntrustedHtml } from './html-guard';
import {
  EMAIL_HTML_MAX_BYTES,
  EMAIL_TEXT_MAX_BYTES,
  extractStyleBlocks,
  htmlToText,
  sanitizeOutboundEmailHtml,
} from './outbound-html';
import { escapeHtml } from './templates';

/**
 * HTML jendela tulis menu Email (tahap 9B, docs/KONTRAK-API-EMAIL-TULIS.md §6.4, §9.3):
 *
 *  - `sanitizeComposerHtml` — profil EDITOR (badan draf & tanda tangan), lebih sempit dari profil
 *    keluar 9.1: tanpa `<style>`/`class`/`id`, gaya terbatas (warna hex/`rgb()`, perataan, tebal,
 *    miring, garis), `img` HANYA `cid:` yang sah (lampiran inline draf / logo tanda tangan) — editor
 *    di origin aplikasi tidak pernah memuat server pihak ketiga. `data-signature` hanya di `div`.
 *  - `buildMailQuote` — kutipan email asli dari HTML tampilan tersimpan 9A: SEMUA gambar dibuang
 *    (diganti "[gambar]"), tautan ke halaman peringatan 9A (tautan menipu) dicabut jadi teks,
 *    `<style>` dibuang, ≤ 192 KB — lebih → kutipan teks (`> `, ≤ 64 KB).
 *  - `assembleMailBody` — HTML akhir `<div dir="auto">badan</div>` + kutipan → penjaga kerumitan →
 *    `sanitizeOutboundEmailHtml` (lapis akhir 9.1) → ≤ 512 KB; teks akhir.
 * Semua linear terhadap masukan (penjaga kerumitan sebelum sanitize-html, review 9.1 S3).
 */

const COMPOSER_TAGS = [
  'p',
  'br',
  'div',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'a',
  'blockquote',
  'pre',
  'code',
  'h1',
  'h2',
  'h3',
  'hr',
  'img',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
] as const;
const COMPOSER_TAG_SET = new Set<string>(COMPOSER_TAGS);
/** Isinya dibuang utuh (bukan teks yang ditulis orang). */
const NON_TEXT_TAGS = [
  'script',
  'style',
  'textarea',
  'option',
  'noscript',
  'title',
  'template',
  'svg',
  'math',
  'object',
  'iframe',
  'noembed',
  'noframes',
  'xmp',
  'head',
];

const COLOR_VALUE =
  /^(#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*[0-9.]{1,5}%?\s*,\s*[0-9.]{1,5}%?\s*,\s*[0-9.]{1,5}%?\s*(,\s*[0-9.]{1,5}%?\s*)?\))$/i;
const STYLE_RULES: Readonly<Record<string, RegExp>> = {
  color: COLOR_VALUE,
  'background-color': COLOR_VALUE,
  'text-align': /^(left|right|center|justify|start|end)$/i,
  'font-weight': /^(normal|bold|bolder|lighter|[1-9]00)$/i,
  'font-style': /^(normal|italic|oblique)$/i,
  'text-decoration': /^(none|underline|line-through|overline)( (underline|line-through))?$/i,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `cid:` gambar inline draf (`img-<8 hex>`) atau logo tanda tangan (`sig-logo-<uuid>`). */
export const MAIL_INLINE_CID_PATTERN = /^img-[0-9a-f]{8}$/;
export const MAIL_SIGNATURE_LOGO_CID_PREFIX = 'sig-logo-';
export function signatureLogoCid(signatureId: string): string {
  return `${MAIL_SIGNATURE_LOGO_CID_PREFIX}${signatureId.toLowerCase()}`;
}

/** Gaya inline editor: hanya properti daftar izin dengan nilai aman (`url()` tidak pernah lolos). */
export function filterComposerStyle(value: string): { style: string; changed: boolean } {
  const kept: string[] = [];
  let changed = false;
  for (const declaration of value.slice(0, 2_000).split(';')) {
    if (declaration.trim() === '') continue;
    const colon = declaration.indexOf(':');
    const property = colon === -1 ? '' : declaration.slice(0, colon).trim().toLowerCase();
    const propertyValue = colon === -1 ? '' : declaration.slice(colon + 1).trim();
    const rule = STYLE_RULES[property];
    if (rule && propertyValue.length <= 60 && rule.test(propertyValue)) {
      kept.push(`${property}: ${propertyValue}`);
    } else {
      changed = true;
    }
  }
  if (value.length > 2_000) changed = true;
  return { style: kept.join('; '), changed };
}

export interface ComposerSanitizeOptions {
  /** `cid` (tanpa `cid:`) yang boleh dirujuk `<img>`. Selain itu gambar dibuang. */
  allowedCids: ReadonlySet<string>;
}

export interface SanitizedComposerHtml {
  html: string;
  /** Ada yang dibuang/diubah (web mengganti isi editornya dengan `html`). */
  changed: boolean;
  /** > 20.000 tag / sarang > 200 → tidak disanitasi (`html` kosong). Pemanggil: 400. */
  tooComplex: boolean;
  /** Gambar yang dibuang karena bukan `cid:` sah (tempelan dari web/Word). */
  removedImages: number;
}

/** Profil HTML editor (§6.4). */
export function sanitizeComposerHtml(
  html: string,
  options: ComposerSanitizeOptions,
): SanitizedComposerHtml {
  if (!htmlWithinLimits(html)) {
    return { html: '', changed: true, tooComplex: true, removedImages: 0 };
  }
  let changed = html.includes('<!--');
  let removedImages = 0;
  const inspect = (tagName: string, attribs: Record<string, string>) => {
    const tag = tagName.toLowerCase();
    if (!COMPOSER_TAG_SET.has(tag)) {
      changed = true;
      return { tagName: tag, attribs: {} };
    }
    const next: Record<string, string> = {};
    for (const [rawName, raw] of Object.entries(attribs)) {
      const name = rawName.toLowerCase();
      const value = raw.trim();
      if (name === 'style') {
        const filtered = filterComposerStyle(value);
        if (filtered.changed) changed = true;
        if (filtered.style !== '') next.style = filtered.style;
        continue;
      }
      if (tag === 'a' && name === 'href') {
        if (/^(https?:\/\/|mailto:|tel:)/i.test(value) && value.length <= 2_000) next.href = value;
        else changed = true;
        continue;
      }
      if (tag === 'img' && name === 'src') {
        const cid = /^cid:([A-Za-z0-9._-]{1,128})$/i.exec(value)?.[1];
        if (cid && options.allowedCids.has(cid)) next.src = `cid:${cid}`;
        else {
          changed = true;
          removedImages += 1;
        }
        continue;
      }
      if (tag === 'img' && name === 'alt') {
        next.alt = value.slice(0, 200);
        continue;
      }
      if (tag === 'img' && (name === 'width' || name === 'height')) {
        if (/^\d{1,4}$/.test(value)) next[name] = value;
        else changed = true;
        continue;
      }
      if ((tag === 'td' || tag === 'th') && (name === 'colspan' || name === 'rowspan')) {
        if (/^\d{1,3}$/.test(value)) next[name] = value;
        else changed = true;
        continue;
      }
      if (tag === 'div' && name === 'data-signature') {
        if (UUID.test(value) || value === 'none') next['data-signature'] = value.toLowerCase();
        else changed = true;
        continue;
      }
      // Gaya Word (`class="MsoNormal"`), `id`, `on*`, `target`, `rel`, … dibuang.
      changed = true;
    }
    return { tagName: tag, attribs: next };
  };
  const result = sanitizeHtml(html, {
    allowedTags: [...COMPOSER_TAGS],
    allowedAttributes: {
      '*': ['style'],
      a: ['href'],
      img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      div: ['data-signature'],
    },
    allowedSchemes: ['https', 'http', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['cid'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    parseStyleAttributes: false,
    disallowedTagsMode: 'discard',
    nonTextTags: NON_TEXT_TAGS,
    transformTags: { '*': inspect },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  });
  return { html: result, changed, tooComplex: false, removedImages };
}

/** `cid` gambar (`<img src="cid:…">`) yang dirujuk HTML (urut, unik). */
export function referencedCids(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*"cid:([A-Za-z0-9._-]{1,128})"/gi)) {
    const cid = match[1];
    if (cid && !found.includes(cid)) found.push(cid);
  }
  return found;
}

/** Teks biasa → HTML aman (paragraf + `<br>`, di-escape). */
export function plainTextToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  return Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
}

// ── Kutipan ────────────────────────────────────────────────────────────────

export interface MailQuoteSource {
  mode: Exclude<MailDraftMode, 'new'>;
  from: MailComposeAddress | null;
  to: readonly MailComposeAddress[];
  cc: readonly MailComposeAddress[];
  subject: string | null;
  sentAt: Date | null;
  /** `mail_message_bodies.html_sanitized` (penanda `balesin-remote:`/`balesin-cid:`), atau `null`. */
  html: string | null;
  /** `mail_message_bodies.text`, atau `null`. */
  text: string | null;
  timeZone: string;
}

export interface MailQuote {
  html: string;
  text: string;
  /** HTML asli terlalu besar/rumit/tidak ada → kutipan teks. */
  textOnly: boolean;
}

const QUOTE_TEXT_TRUNCATED = '[kutipan dipotong]';
const IMAGE_PLACEHOLDER = '[gambar]';

function formatQuoteDate(date: Date | null, timeZone: string): string {
  if (!date) return 'tanggal tidak diketahui';
  const format = (zone: string) =>
    new Intl.DateTimeFormat('id-ID', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: zone,
    }).format(date);
  try {
    return format(timeZone);
  } catch {
    return format('UTC');
  }
}

const addressLabel = (item: MailComposeAddress | null) =>
  !item ? 'pengirim tidak diketahui' : item.name ? `${item.name} <${item.address}>` : item.address;
const addressList = (items: readonly MailComposeAddress[]) =>
  items.map((item) => addressLabel(item)).join(', ');

function quoteHeaderText(source: MailQuoteSource): string[] {
  const when = formatQuoteDate(source.sentAt, source.timeZone);
  if (source.mode === 'forward') {
    return [
      '---------- Email diteruskan ----------',
      `Dari: ${addressLabel(source.from)}`,
      `Tanggal: ${when}`,
      `Subjek: ${source.subject ?? ''}`,
      `Kepada: ${addressList(source.to)}`,
      ...(source.cc.length > 0 ? [`Cc: ${addressList(source.cc)}`] : []),
    ];
  }
  return [`Pada ${when}, ${addressLabel(source.from)} menulis:`];
}

/** HTML tampilan tersimpan → HTML kutipan (gambar dibuang, tautan peringatan dicabut, tanpa gaya). */
function quoteHtmlOf(html: string): string | null {
  const { rest } = extractStyleBlocks(html);
  if (!htmlWithinLimits(rest)) return null;
  return sanitizeHtml(rest, {
    allowedTags: [
      'p',
      'br',
      'div',
      'span',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'ul',
      'ol',
      'li',
      'a',
      'blockquote',
      'pre',
      'code',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'table',
      'thead',
      'tbody',
      'tfoot',
      'tr',
      'td',
      'th',
      'center',
      'font',
    ],
    allowedAttributes: { a: ['href'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['https', 'http', 'mailto', 'tel'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: NON_TEXT_TAGS,
    transformTags: {
      img: (_tag, attribs) => ({
        tagName: 'span',
        attribs: {},
        text: attribs.alt ? `[${attribs.alt.slice(0, 80)}]` : IMAGE_PLACEHOLDER,
      }),
      a: (tag, attribs): sanitizeHtml.Tag => {
        const href = attribs.href ?? '';
        // Tautan menipu yang sudah ditulis ulang 9A ke halaman peringatan → teks saja.
        if (href.includes(`${MAIL_LINK_WARNING_PATH}?`) || !/^(https?:|mailto:|tel:)/i.test(href)) {
          return { tagName: 'span', attribs: {} };
        }
        return { tagName: tag, attribs: { href } };
      },
    },
  });
}

function quoteTextOf(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const parts: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const quoted = `> ${line}`;
    bytes += Buffer.byteLength(quoted, 'utf8') + 1;
    if (bytes > MAIL_QUOTE_TEXT_MAX_BYTES) {
      parts.push(`> ${QUOTE_TEXT_TRUNCATED}`);
      break;
    }
    parts.push(quoted);
  }
  return parts.join('\n');
}

/** Kutipan balas/teruskan (§9.3 langkah 2). `null` = email asli tidak punya isi. */
export function buildMailQuote(source: MailQuoteSource): MailQuote | null {
  const header = quoteHeaderText(source);
  const plain = source.text ?? (source.html ? plainTextFromUntrustedHtml(source.html) : null);
  if ((plain === null || plain.trim() === '') && !source.html) return null;
  const quotedText = quoteTextOf(plain ?? '');
  const text = `${header.join('\n')}\n${quotedText}`;
  const headerHtml = header.map((line) => escapeHtml(line)).join('<br>');
  const textAsHtml = `<div>${headerHtml}</div><blockquote type="cite">${escapeHtml(quotedText)
    .split('\n')
    .join('<br>')}</blockquote>`;
  if (source.html) {
    const inner = quoteHtmlOf(source.html);
    if (inner !== null && Buffer.byteLength(inner, 'utf8') <= MAIL_QUOTE_HTML_MAX_BYTES) {
      return {
        html: `<div>${headerHtml}</div><blockquote type="cite">${inner}</blockquote>`,
        text,
        textOnly: false,
      };
    }
  }
  return { html: textAsHtml, text, textOnly: true };
}

// ── Perakitan akhir ────────────────────────────────────────────────────────

export interface AssembleMailBodyInput {
  format: 'html' | 'text';
  bodyHtml: string | null;
  bodyText: string | null;
  quote: MailQuote | null;
  /** `cid` yang sah saat kirim (lampiran inline draf + logo tanda tangan yang masih ada). */
  allowedCids: ReadonlySet<string>;
}

export type AssembledMailBody =
  | { ok: true; html: string; text: string; cids: string[] }
  | { ok: false; reason: 'html_too_complex' | 'content_too_large' };

/** HTML & teks FINAL (§9.3 langkah 1–5). Rujukan `cid:` yatim dibuang. */
export function assembleMailBody(input: AssembleMailBodyInput): AssembledMailBody {
  let bodyHtml: string;
  let bodyText: string;
  if (input.format === 'text') {
    bodyText = (input.bodyText ?? '').replace(/\r\n?/g, '\n');
    bodyHtml = plainTextToHtml(bodyText);
  } else {
    const clean = sanitizeComposerHtml(input.bodyHtml ?? '', { allowedCids: input.allowedCids });
    if (clean.tooComplex) return { ok: false, reason: 'html_too_complex' };
    bodyHtml = clean.html;
    bodyText = htmlToText(bodyHtml);
  }
  const html = `<div dir="auto">${bodyHtml}</div>${input.quote ? input.quote.html : ''}`;
  if (!htmlWithinLimits(html)) return { ok: false, reason: 'html_too_complex' };
  const finalHtml = sanitizeOutboundEmailHtml(html);
  if (finalHtml.tooComplex) return { ok: false, reason: 'html_too_complex' };
  if (Buffer.byteLength(finalHtml.html, 'utf8') > EMAIL_HTML_MAX_BYTES) {
    return { ok: false, reason: 'content_too_large' };
  }
  const text = input.quote ? `${bodyText}\n\n${input.quote.text}` : bodyText;
  if (Buffer.byteLength(text, 'utf8') > EMAIL_TEXT_MAX_BYTES) {
    return { ok: false, reason: 'content_too_large' };
  }
  return {
    ok: true,
    html: finalHtml.html,
    text: truncateUtf8(text, EMAIL_TEXT_MAX_BYTES),
    cids: referencedCids(finalHtml.html),
  };
}

// ── Variabel tanda tangan ──────────────────────────────────────────────────

export interface SignatureVariables {
  agentName: string;
  senderAddress: string;
  organizationName: string;
  /** `null` = tanda tangan tanpa logo (`{{logo}}` kosong). */
  logo: { signatureId: string; width: number } | null;
}

/** Isi `{{nama_agen}}` dkk. (di-escape); `{{logo}}` → `<img src="cid:sig-logo-…">`. */
export function fillSignatureVariables(html: string, values: SignatureVariables): string {
  return html.replace(/\{\{([^{}]{0,60})\}\}/g, (whole, raw: string) => {
    switch (raw.trim()) {
      case 'nama_agen':
        return escapeHtml(values.agentName);
      case 'alamat_pengirim':
        return escapeHtml(values.senderAddress);
      case 'nama_organisasi':
        return escapeHtml(values.organizationName);
      case 'logo':
        return values.logo
          ? `<img src="cid:${signatureLogoCid(values.logo.signatureId)}" alt="${escapeHtml(values.organizationName)}" width="${String(values.logo.width)}">`
          : '';
      default:
        return whole;
    }
  });
}
