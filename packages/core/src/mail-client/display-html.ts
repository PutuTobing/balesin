import { EMAIL_MAX_HTML_BYTES } from '@balesin/shared';
import { Parser } from 'htmlparser2';
import sanitizeHtml from 'sanitize-html';

import { htmlWithinLimits } from '../mail/html-guard';
import {
  compactUrlText,
  extractStyleBlocks,
  filterInlineStyle,
  sanitizeCssBlock,
} from '../mail/outbound-html';

/**
 * Profil sanitasi TAMPILAN email masuk modul Email (KONTRAK-API-EMAIL §8 "Dokumen tampilan",
 * keputusan #10). Lebih kaya dari profil Inbox Fase 6 (gaya & gambar dipertahankan), tetapi:
 *
 *  - Penjaga kerumitan (`html-guard`, review 9.1 S3) dijalankan PALING DULU: HTML > 512 KB atau
 *    > 20.000 tag / sarang > 200 → `tooComplex` (tidak pernah diserahkan ke sanitize-html), pemanggil
 *    memakai versi teks.
 *  - Skrip, `on*`, `javascript:`/`vbscript:`, iframe/frame/object/embed/applet, form & input, SVG/
 *    MathML, `meta`/`base`/`link`, media → dibuang. CSS inline & `<style>` lewat daftar izin yang sama
 *    dengan email keluar (tanpa `url()`, `image-set()`, `expression`, `@import`, `position: fixed`).
 *  - Gambar: `https:` DICABUT ke `remoteImages[i]` dan diganti penanda `balesin-remote:<i>` (proksi
 *    server, bawaan diblokir); `cid:` → penanda `balesin-cid:<cid>`; `data:` hanya PNG/JPEG/GIF/WebP
 *    ≤ 512 KB; `http:` & lainnya dibuang. Penanda hanya bisa dibuat sanitizer ini (src email yang
 *    sudah berbentuk penanda ditolak karena bukan https/cid/data).
 *  - Tautan hanya `http(s):`/`mailto:`/`tel:`, selalu `target=_blank rel="noopener noreferrer
 *    nofollow"`. Tautan yang TEKSNYA berbentuk domain berbeda dengan tujuan `href` (tautan menipu)
 *    ditulis ulang ke halaman peringatan web (`linkWarningHref`).
 */

export const MAIL_REMOTE_IMAGE_MARKER = 'balesin-remote:';
export const MAIL_CID_MARKER = 'balesin-cid:';
const DATA_IMAGE_MAX_BYTES = 512 * 1024;
const REMOTE_IMAGES_MAX = 200;
const HREF_MAX = 2_000;
const CID_PATTERN = /^[A-Za-z0-9._@$%+=-]{1,200}$/;

const ALLOWED_TAGS = [
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'colgroup',
  'col',
  'div',
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'a',
  'img',
  'br',
  'hr',
  'strong',
  'em',
  'b',
  'i',
  'u',
  's',
  'strike',
  'del',
  'ins',
  'mark',
  'small',
  'big',
  'sup',
  'sub',
  'blockquote',
  'q',
  'cite',
  'abbr',
  'address',
  'pre',
  'code',
  'center',
  'font',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'figure',
  'figcaption',
];
const ALLOWED_TAG_SET = new Set(ALLOWED_TAGS);

const GLOBAL_ATTRIBUTES = [
  'align',
  'valign',
  'width',
  'height',
  'bgcolor',
  'border',
  'cellpadding',
  'cellspacing',
  'colspan',
  'rowspan',
  'span',
  'dir',
  'lang',
  'alt',
  'title',
  'style',
  'class',
  'role',
];
const GLOBAL_ATTRIBUTE_SET = new Set(GLOBAL_ATTRIBUTES);
const FONT_ATTRIBUTES = new Set(['color', 'face', 'size']);

/** Pembungkus dokumen penuh — dibuang tanpa isi (isi `<body>` tetap). */
const WRAPPER_TAGS = new Set(['html', 'head', 'body']);

export interface DisplayHtmlOptions {
  /** URL halaman peringatan web untuk tautan menipu (absolut, origin aplikasi). */
  linkWarningHref: (target: string, shownDomain: string) => string;
}

export interface DisplayHtmlResult {
  /** HTML aman dengan penanda gambar; kosong bila `tooComplex`. */
  html: string;
  /** URL gambar luar (https) urut indeks penanda. */
  remoteImages: string[];
  /** Jumlah tautan menipu yang ditulis ulang. */
  linkWarnings: number;
  /** Lewat batas ukuran/kerumitan → TIDAK disanitasi; pakai versi teks. */
  tooComplex: boolean;
}

type ImageVerdict = { kind: 'remote'; url: string } | { kind: 'keep'; src: string } | null;

function imageVerdict(value: string): ImageVerdict {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > DATA_IMAGE_MAX_BYTES * 2) return null;
  const cid = /^cid:(.+)$/i.exec(trimmed);
  if (cid) {
    const id = (cid[1] ?? '').replace(/^<|>$/g, '');
    return CID_PATTERN.test(id) ? { kind: 'keep', src: `${MAIL_CID_MARKER}${id}` } : null;
  }
  if (/^https:\/\//i.test(trimmed)) {
    if (trimmed.length > HREF_MAX) return null;
    try {
      const url = new URL(trimmed);
      return url.protocol === 'https:' && url.username === '' && url.password === ''
        ? { kind: 'remote', url: url.href }
        : null;
    } catch {
      return null;
    }
  }
  const data = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
  if (data) {
    const payload = (data[2] ?? '').replace(/\s+/g, '');
    return Math.floor((payload.length * 3) / 4) <= DATA_IMAGE_MAX_BYTES
      ? { kind: 'keep', src: `data:image/${(data[1] ?? 'png').toLowerCase()};base64,${payload}` }
      : null;
  }
  return null;
}

function hrefAllowed(value: string): string | null {
  if (value.length > HREF_MAX) return null;
  const trimmed = value.trim();
  const compacted = compactUrlText(trimmed);
  if (/^(javascript|vbscript|data):/i.test(compacted)) return null;
  if (/^(https?:\/\/|mailto:|tel:)/i.test(compacted)) return trimmed;
  return null;
}

/** Domain dari teks tautan yang BERBENTUK alamat (`www.bank.co.id`, `https://bank.co.id/…`). */
export function domainShownInLinkText(text: string): string | null {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0 || trimmed.length > 300 || trimmed.includes(' ')) return null;
  const match =
    /^(?:https?:\/\/)?(?:[^@/\s]+@)?((?:[a-z0-9¡-￿-]{1,63}\.)+[a-z¡-￿]{2,63})\.?(?::\d{1,5})?(?:[/?#][^\s]*)?$/i.exec(
      trimmed,
    );
  if (!match?.[1]) return null;
  return normalizeHost(match[1]);
}

function normalizeHost(host: string): string | null {
  try {
    // Penyetaraan IDN (Unicode ↔ punycode) lewat parser URL.
    const hostname = new URL(`https://${host}`).hostname.toLowerCase();
    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function sameSite(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Tujuan `href` http(s) → host ternormalisasi; selain http(s) → `null` (tidak dibandingkan). */
function hrefHost(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return normalizeHost(url.hostname);
  } catch {
    return null;
  }
}

const escapeAttribute = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Lintasan kedua di HTML yang SUDAH aman: tautan menipu → `href` diganti halaman peringatan. HTML
 * hasil sanitasi kedalamannya ≤ masukan (sudah lolos penjaga), jadi parser tetap linear.
 */
function rewriteDeceptiveLinks(
  html: string,
  linkWarningHref: DisplayHtmlOptions['linkWarningHref'],
): { html: string; count: number } {
  interface OpenAnchor {
    start: number;
    end: number;
    attribs: Record<string, string>;
    text: string;
  }
  const edits: { start: number; end: number; replacement: string }[] = [];
  let anchor: OpenAnchor | null = null;
  let depth = 0;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name !== 'a') return;
        depth += 1;
        if (depth === 1) {
          anchor = { start: parser.startIndex, end: parser.endIndex, attribs, text: '' };
        }
      },
      ontext(text) {
        if (anchor && anchor.text.length < 400) anchor.text += text;
      },
      onclosetag(name) {
        if (name !== 'a' || depth === 0) return;
        depth -= 1;
        if (depth > 0 || !anchor) return;
        const current: OpenAnchor = anchor;
        anchor = null;
        const href = current.attribs.href;
        if (!href) return;
        const shown = domainShownInLinkText(current.text);
        const target = hrefHost(href);
        if (!shown || !target || sameSite(shown, target)) return;
        const attributes = Object.entries({
          ...current.attribs,
          href: linkWarningHref(href, shown),
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
        })
          .map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`)
          .join('');
        edits.push({ start: current.start, end: current.end, replacement: `<a${attributes}>` });
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  if (edits.length === 0) return { html, count: 0 };
  let out = '';
  let position = 0;
  for (const edit of edits) {
    out += html.slice(position, edit.start) + edit.replacement;
    position = edit.end + 1;
  }
  return { html: out + html.slice(position), count: edits.length };
}

export function sanitizeMailHtmlForDisplay(
  html: string,
  options: DisplayHtmlOptions,
): DisplayHtmlResult {
  // Penjaga S3 SEBELUM sanitasi apa pun (ukuran lalu kerumitan).
  if (
    html.length > EMAIL_MAX_HTML_BYTES ||
    Buffer.byteLength(html) > EMAIL_MAX_HTML_BYTES ||
    !htmlWithinLimits(html)
  ) {
    return { html: '', remoteImages: [], linkWarnings: 0, tooComplex: true };
  }
  const styles: string[] = [];
  const extracted = extractStyleBlocks(html);
  for (const css of extracted.blocks) {
    const clean = sanitizeCssBlock(css);
    if (clean.css !== '') styles.push(clean.css);
  }
  const remoteImages: string[] = [];
  const remoteIndex = new Map<string, number>();

  const inspect = (tagName: string, attribs: Record<string, string>) => {
    const tag = tagName.toLowerCase();
    if (WRAPPER_TAGS.has(tag) || !ALLOWED_TAG_SET.has(tag)) return { tagName: tag, attribs: {} };
    const next: Record<string, string> = {};
    for (const [rawName, value] of Object.entries(attribs)) {
      const name = rawName.toLowerCase();
      if (name.startsWith('on')) continue;
      if (/^(javascript|vbscript):/i.test(compactUrlText(value))) continue;
      if (name === 'style') {
        const filtered = filterInlineStyle(value);
        if (filtered.style !== '') next.style = filtered.style;
        continue;
      }
      if (tag === 'a') {
        if (name === 'href') {
          const href = hrefAllowed(value);
          if (href) next.href = href;
        } else if (name === 'title') next.title = value;
        continue;
      }
      if (tag === 'img' && name === 'src') {
        const verdict = imageVerdict(value);
        if (verdict?.kind === 'keep') next.src = verdict.src;
        else if (verdict?.kind === 'remote') {
          let index = remoteIndex.get(verdict.url);
          if (index === undefined && remoteImages.length < REMOTE_IMAGES_MAX) {
            index = remoteImages.length;
            remoteImages.push(verdict.url);
            remoteIndex.set(verdict.url, index);
          }
          if (index !== undefined) next.src = `${MAIL_REMOTE_IMAGE_MARKER}${String(index)}`;
        }
        continue;
      }
      if (tag === 'font' && FONT_ATTRIBUTES.has(name)) {
        if (!/[<>"'`;{}\\]|url\s*\(|expression/i.test(value) && value.length <= 100) {
          next[name] = value;
        }
        continue;
      }
      if (GLOBAL_ATTRIBUTE_SET.has(name) && value.length <= 2_000) next[name] = value;
    }
    if (tag === 'a') {
      next.target = '_blank';
      next.rel = 'noopener noreferrer nofollow';
    }
    return { tagName: tag, attribs: next };
  };

  const body = sanitizeHtml(extracted.rest, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      '*': GLOBAL_ATTRIBUTES,
      a: ['href', 'target', 'rel', 'title'],
      img: ['src'],
      font: [...FONT_ATTRIBUTES],
    },
    allowedSchemes: ['https', 'http', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['https', 'data', 'balesin-remote', 'balesin-cid'] },
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    parseStyleAttributes: false,
    disallowedTagsMode: 'discard',
    nonTextTags: [
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
      'frameset',
      'noembed',
      'noframes',
      'xmp',
      'head',
    ],
    transformTags: { '*': inspect },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  });
  const rewritten = rewriteDeceptiveLinks(body, options.linkWarningHref);
  const head = styles.map((css) => `<style>${css}</style>`).join('');
  return {
    html: `${head}${rewritten.html}`,
    remoteImages,
    linkWarnings: rewritten.count,
    tooComplex: false,
  };
}

// ── Penyajian dokumen tampilan ──────────────────────────────────────────────

/** GIF 1×1 transparan (gambar luar yang diblokir / cid yang tidak ada). */
export const MAIL_BLANK_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export interface MailViewDocumentInput {
  /** `html_sanitized` (berpenanda) atau `null` → teks. */
  html: string | null;
  text: string | null;
  /** Path dasar gambar luar (`…/view/<token>/images`) bila gambar ditampilkan; `null` = blokir. */
  imagesBase: string | null;
  /** `cid` → URL gambar inline (`…/view/<token>/cid/<attachmentId>`). */
  cidUrls: ReadonlyMap<string, string>;
}

const escapeText = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Dokumen HTML untuk iframe sandbox. Penanda diganti di sini (saat disajikan), bukan saat disimpan,
 * supaya token & keputusan "tampilkan gambar" tidak pernah tersimpan di database.
 */
export function renderMailViewDocument(input: MailViewDocumentInput): string {
  let body: string;
  if (input.html !== null) {
    body = input.html
      .replace(/src="balesin-remote:(\d{1,3})"/g, (_match, index: string) =>
        input.imagesBase
          ? `src="${escapeAttribute(`${input.imagesBase}/${index}`)}"`
          : `src="${MAIL_BLANK_IMAGE}" data-gambar-diblokir="1"`,
      )
      .replace(/src="balesin-cid:([A-Za-z0-9._@$%+=-]{1,200})"/g, (_match, cid: string) => {
        const url = input.cidUrls.get(cid);
        return `src="${url ? escapeAttribute(url) : MAIL_BLANK_IMAGE}"`;
      });
  } else {
    body = `<pre class="balesin-teks">${escapeText(input.text ?? '')}</pre>`;
  }
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<style>html,body{margin:0;padding:0;background:#fff;color:#1f2328}',
    'body{padding:16px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;overflow-wrap:anywhere}',
    'img{max-width:100%;height:auto}table{max-width:100%}',
    '.balesin-teks{white-space:pre-wrap;font:inherit;margin:0}</style>',
    '</head><body>',
    body,
    '</body></html>',
  ].join('');
}
