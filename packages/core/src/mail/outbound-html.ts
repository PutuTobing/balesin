import sanitizeHtml from 'sanitize-html';

/**
 * HTML email KELUAR (Fase 9.1, docs/KONTRAK-API-EMAIL-KIRIM.md §3.3): sanitasi profil keluar, pemindai
 * variabel template, render (isi variabel + bingkai merek), dan versi teks.
 *
 * Profil ini BERBEDA dari sanitasi email masuk (`sanitizeEmailHtml`, Fase 6) yang membuang gaya &
 * gambar: email tagihan butuh tabel, gaya inline, `<style>`, dan gambar `cid:`/https. Yang selalu
 * dibuang: skrip, atribut `on*`, `javascript:`, sematan (iframe/object/embed), formulir, SVG/MathML,
 * `link`/`base`/`meta`, media, `url()`/`expression`/`behavior`/`-moz-binding`/`position: fixed` di CSS.
 *
 * Variabel `{{nama}}`: di teks HTML SELALU di-escape (baris baru → `<br>`); di `href` hanya bila
 * seluruh nilai atributnya satu variabel dan nilainya URL `https://`; di tempat lain tidak didukung.
 */

export const EMAIL_HTML_MAX_BYTES = 512 * 1024;
export const EMAIL_TEXT_MAX_BYTES = 256 * 1024;
export const EMAIL_SUBJECT_MAX = 200;
export const EMAIL_TEMPLATE_VARIABLE_NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const EMAIL_TEMPLATE_BUILTIN_VARIABLES = ['nama_organisasi', 'qris'] as const;
export const EMAIL_QRIS_SCAN_TEXT = 'Pindai kode QRIS pada versi HTML email ini.';

const HREF_URL_MAX = 2_000;
const DATA_IMAGE_MAX_BYTES = 100 * 1024;
const FALLBACK_COLOR = '#2563eb';
const QRIS_ALT = 'Kode QRIS';

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const PLACEHOLDER_ONLY = /^\{\{\s*([^{}]*?)\s*\}\}$/;
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

const validName = (name: string) => EMAIL_TEMPLATE_VARIABLE_NAME.test(name);

// ── Sanitasi ────────────────────────────────────────────────────────────────

const ALLOWED_TAGS = [
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
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
  'small',
  'sup',
  'sub',
  'blockquote',
  'pre',
  'code',
  'center',
];
const ALLOWED_TAG_SET = new Set(ALLOWED_TAGS);

/** Atribut tata letak untuk semua elemen (+ `class` untuk `<style>`, `role` untuk tabel tata letak). */
const GLOBAL_ATTRIBUTES = new Set([
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
  'dir',
  'lang',
  'alt',
  'title',
  'style',
  'class',
  'role',
]);

/** Dibuang tanpa dianggap perubahan (pembungkus dokumen penuh). */
const SILENT_TAGS = new Set(['html', 'head', 'body', 'title', 'meta']);

const WARNING = {
  script: 'Skrip dibuang.',
  event: 'Atribut event (on…) dibuang.',
  javascript: 'Tautan javascript: dibuang.',
  embed: 'Konten sematan (iframe/object/embed) dibuang.',
  form: 'Formulir dan isian dibuang.',
  svg: 'Gambar SVG/MathML dibuang.',
  link: 'Tag link/base dibuang.',
  media: 'Audio/video dibuang.',
  element: 'Elemen yang tidak didukung dibuang.',
  attribute: 'Atribut yang tidak didukung dibuang.',
  css: 'Sebagian gaya CSS dibuang (url(), expression, position: fixed, @import, atau properti yang tidak didukung).',
  href: 'Tautan dengan alamat yang tidak didukung dibuang (hanya https, http, mailto, tel).',
  imageHttp: 'Gambar dari alamat http:// dibuang.',
  imageData: 'Gambar data: yang lebih dari 100 KB atau bukan PNG/JPEG/GIF dibuang.',
  imageOther: 'Alamat gambar yang tidak didukung dibuang (hanya cid:, https://, data:).',
} as const;

const TAG_WARNINGS: Readonly<Record<string, { message: string; forbidden: boolean }>> = {
  script: { message: WARNING.script, forbidden: true },
  iframe: { message: WARNING.embed, forbidden: true },
  frame: { message: WARNING.embed, forbidden: true },
  frameset: { message: WARNING.embed, forbidden: true },
  object: { message: WARNING.embed, forbidden: true },
  embed: { message: WARNING.embed, forbidden: true },
  applet: { message: WARNING.embed, forbidden: true },
  form: { message: WARNING.form, forbidden: true },
  input: { message: WARNING.form, forbidden: true },
  button: { message: WARNING.form, forbidden: true },
  select: { message: WARNING.form, forbidden: true },
  option: { message: WARNING.form, forbidden: true },
  textarea: { message: WARNING.form, forbidden: true },
  svg: { message: WARNING.svg, forbidden: true },
  math: { message: WARNING.svg, forbidden: true },
  link: { message: WARNING.link, forbidden: false },
  base: { message: WARNING.link, forbidden: false },
  audio: { message: WARNING.media, forbidden: false },
  video: { message: WARNING.media, forbidden: false },
  source: { message: WARNING.media, forbidden: false },
  track: { message: WARNING.media, forbidden: false },
  style: { message: WARNING.css, forbidden: false },
};

const ALLOWED_CSS_PROPERTIES = new Set([
  'color',
  'background',
  'background-color',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-align',
  'text-decoration',
  'text-transform',
  'text-indent',
  'vertical-align',
  'white-space',
  'word-break',
  'word-wrap',
  'overflow-wrap',
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-style',
  'border-width',
  'border-radius',
  'border-collapse',
  'border-spacing',
  'display',
  'table-layout',
  'list-style',
  'list-style-type',
  'opacity',
  'box-sizing',
  'overflow',
]);

const UNSAFE_CSS_VALUE =
  /url\s*\(|expression|javascript:|vbscript:|behavior|binding|@import|[<>{}\\]|\/\*|\*\//i;

function safeCssValue(value: string): boolean {
  return value.length > 0 && value.length <= 500 && !UNSAFE_CSS_VALUE.test(value);
}

/** Atribut `style`: hanya properti daftar izin dengan nilai aman. */
function filterInlineStyle(value: string): { style: string; changed: boolean } {
  const kept: string[] = [];
  let changed = false;
  for (const declaration of value.split(';')) {
    if (declaration.trim() === '') continue;
    const colon = declaration.indexOf(':');
    const property = colon === -1 ? '' : declaration.slice(0, colon).trim().toLowerCase();
    const propertyValue = colon === -1 ? '' : declaration.slice(colon + 1).trim();
    const allowed =
      (ALLOWED_CSS_PROPERTIES.has(property) || /^mso-[a-z-]{1,40}$/.test(property)) &&
      safeCssValue(propertyValue);
    if (allowed) kept.push(`${property}: ${propertyValue}`);
    else changed = true;
  }
  return { style: kept.join('; '), changed };
}

const UNSAFE_CSS_DECLARATION =
  /[^;{}]*(?:url\s*\(|expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding)[^;{}]*;?/gi;

/** Isi elemen `<style>`: tanpa `@import`, `url()`, ekspresi, `position: fixed`, `<`, `>`, `\`. */
function sanitizeCssBlock(css: string): { css: string; changed: boolean } {
  const base = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = base.replace(/[<>\\]/g, '');
  out = out.replace(/@import[^;]*;?/gi, '');
  for (let round = 0; round < 10; round += 1) {
    const next = out.replace(UNSAFE_CSS_DECLARATION, '');
    if (next === out) break;
    out = next;
  }
  out = out.replace(/position\s*:\s*fixed\s*(?:!important)?\s*;?/gi, '');
  return { css: out.trim(), changed: out.trim() !== base.trim() };
}

/** Tanpa spasi/karakter kendali (cegah `java\tscript:`). */
const isControlOrSpace = (char: string) => {
  const code = char.charCodeAt(0);
  return code <= 0x20 || code === 0x7f;
};
const compact = (value: string) => [...value].filter((char) => !isControlOrSpace(char)).join('');

function hrefAllowed(value: string): boolean {
  const trimmed = value.trim();
  if (PLACEHOLDER_ONLY.test(trimmed)) return true;
  return /^(https?:\/\/|mailto:|tel:)/i.test(compact(trimmed));
}

type ImageVerdict = 'ok' | 'imageHttp' | 'imageData' | 'imageOther';

function imageSource(value: string): ImageVerdict {
  const trimmed = value.trim();
  if (/^cid:[A-Za-z0-9._@-]{1,128}$/i.test(trimmed)) return 'ok';
  if (/^https:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).protocol === 'https:' ? 'ok' : 'imageOther';
    } catch {
      return 'imageOther';
    }
  }
  if (/^http:/i.test(compact(trimmed))) return 'imageHttp';
  const data = /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
  if (data) {
    const payload = (data[2] ?? '').replace(/\s+/g, '');
    return Math.floor((payload.length * 3) / 4) <= DATA_IMAGE_MAX_BYTES ? 'ok' : 'imageData';
  }
  if (/^data:/i.test(compact(trimmed))) return 'imageData';
  return 'imageOther';
}

export interface SanitizedOutboundHtml {
  html: string;
  /** Ada yang dibuang/diubah dari isi (bukan sekadar normalisasi penulisan). */
  changed: boolean;
  /** Ada skrip, atribut `on*`, `javascript:`, sematan, formulir, atau SVG/MathML. */
  forbidden: boolean;
  /** Teks Indonesia singkat, unik, urut kemunculan. */
  warnings: string[];
}

/** Sanitasi HTML email keluar (template saat disimpan & HTML luar saat dikirim). */
export function sanitizeOutboundEmailHtml(html: string): SanitizedOutboundHtml {
  const warnings = new Set<string>();
  let changed = false;
  let forbidden = false;
  const note = (message: string, isForbidden = false) => {
    warnings.add(message);
    changed = true;
    if (isForbidden) forbidden = true;
  };

  const styles: string[] = [];
  const withoutStyles = html.replace(STYLE_BLOCK, (_whole, css: string) => {
    const clean = sanitizeCssBlock(css);
    if (clean.changed) note(WARNING.css);
    if (clean.css !== '') styles.push(clean.css);
    return '';
  });

  const inspect = (tagName: string, attribs: Record<string, string>) => {
    const tag = tagName.toLowerCase();
    if (SILENT_TAGS.has(tag)) return { tagName: tag, attribs: {} };
    if (!ALLOWED_TAG_SET.has(tag)) {
      const known = TAG_WARNINGS[tag];
      note(known?.message ?? WARNING.element, known?.forbidden ?? false);
      for (const name of Object.keys(attribs)) {
        if (name.toLowerCase().startsWith('on')) note(WARNING.event, true);
      }
      return { tagName: tag, attribs: {} };
    }
    const next: Record<string, string> = {};
    for (const [rawName, value] of Object.entries(attribs)) {
      const name = rawName.toLowerCase();
      if (name.startsWith('on')) {
        note(WARNING.event, true);
        continue;
      }
      if (/^(javascript|vbscript):/i.test(compact(value))) {
        note(WARNING.javascript, true);
        continue;
      }
      if (name === 'style') {
        const filtered = filterInlineStyle(value);
        if (filtered.changed) note(WARNING.css);
        if (filtered.style !== '') next.style = filtered.style;
        continue;
      }
      if (tag === 'a' && name === 'href') {
        if (hrefAllowed(value)) next.href = value.trim();
        else note(WARNING.href);
        continue;
      }
      // Diganti nilai tetap di bawah.
      if (tag === 'a' && (name === 'target' || name === 'rel')) continue;
      if (tag === 'img' && name === 'src') {
        const verdict = imageSource(value);
        if (verdict === 'ok') next.src = value.trim();
        else note(WARNING[verdict]);
        continue;
      }
      if (GLOBAL_ATTRIBUTES.has(name)) {
        next[name] = value;
        continue;
      }
      note(WARNING.attribute);
    }
    if (tag === 'a' && next.href !== undefined) {
      next.target = '_blank';
      next.rel = 'noopener noreferrer';
    }
    return { tagName: tag, attribs: next };
  };

  const body = sanitizeHtml(withoutStyles, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      '*': [...GLOBAL_ATTRIBUTES],
      a: ['href', 'target', 'rel'],
      img: ['src'],
    },
    allowedSchemes: ['https', 'http', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['cid', 'https', 'data'] },
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
      'noembed',
      'noframes',
      'xmp',
    ],
    transformTags: { '*': inspect },
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  });

  const head = styles.map((css) => `<style>${css}</style>`).join('');
  return { html: `${head}${body}`, changed, forbidden, warnings: [...warnings] };
}

// ── Pemindai variabel ───────────────────────────────────────────────────────

export type TemplateField = 'subject' | 'html' | 'text';

export interface TemplateVariableProblem {
  field: TemplateField;
  name: string;
  reason: 'attribute_not_supported' | 'invalid_name';
}

export interface TemplateVariableScan {
  /** Nama sah unik, urut kemunculan (subjek → HTML → teks), TERMASUK variabel bawaan. */
  used: string[];
  problems: TemplateVariableProblem[];
}

function placeholdersOf(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

type HtmlSegment = { kind: 'style' | 'tag' | 'text'; value: string };

/** Potong HTML hasil sanitasi (atribut selalu `"…"`, `<`/`>` dalam nilai di-escape). */
function segmentsOf(html: string): HtmlSegment[] {
  const pattern = /<style\b[^>]*>[\s\S]*?<\/style\s*>|<[^>]*>/gi;
  const segments: HtmlSegment[] = [];
  let last = 0;
  for (const match of html.matchAll(pattern)) {
    const index = match.index;
    if (index > last) segments.push({ kind: 'text', value: html.slice(last, index) });
    segments.push({
      kind: /^<style\b/i.test(match[0]) ? 'style' : 'tag',
      value: match[0],
    });
    last = index + match[0].length;
  }
  if (last < html.length) segments.push({ kind: 'text', value: html.slice(last) });
  return segments;
}

const ATTRIBUTE = /(\s)([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g;

export function scanTemplateVariables(input: {
  subject: string;
  html: string;
  text: string | null;
}): TemplateVariableScan {
  const used: string[] = [];
  const problems: TemplateVariableProblem[] = [];
  const problem = (
    field: TemplateField,
    name: string,
    reason: TemplateVariableProblem['reason'],
  ) => {
    if (!problems.some((p) => p.field === field && p.name === name && p.reason === reason)) {
      problems.push({ field, name, reason });
    }
  };
  const use = (field: TemplateField, name: string) => {
    if (!validName(name)) {
      problem(field, name, 'invalid_name');
      return false;
    }
    if (!used.includes(name)) used.push(name);
    return true;
  };

  for (const name of placeholdersOf(input.subject)) use('subject', name);

  const rawCounts = new Map<string, number>();
  for (const name of placeholdersOf(input.html)) {
    if (use('html', name)) rawCounts.set(name, (rawCounts.get(name) ?? 0) + 1);
  }
  const keptCounts = new Map<string, number>();
  const kept = (name: string) => keptCounts.set(name, (keptCounts.get(name) ?? 0) + 1);
  for (const segment of segmentsOf(sanitizeOutboundEmailHtml(input.html).html)) {
    if (!segment.value.includes('{{')) continue;
    if (segment.kind === 'text') {
      for (const name of placeholdersOf(segment.value)) if (validName(name)) kept(name);
      continue;
    }
    if (segment.kind === 'style') {
      for (const name of placeholdersOf(segment.value)) {
        if (validName(name)) {
          kept(name);
          problem('html', name, 'attribute_not_supported');
        }
      }
      continue;
    }
    for (const match of segment.value.matchAll(ATTRIBUTE)) {
      const attribute = (match[2] ?? '').toLowerCase();
      const value = match[3] ?? '';
      if (!value.includes('{{')) continue;
      const only = PLACEHOLDER_ONLY.exec(value.trim());
      for (const name of placeholdersOf(value)) {
        if (!validName(name)) continue;
        kept(name);
        if (!(attribute === 'href' && only)) problem('html', name, 'attribute_not_supported');
      }
    }
  }
  // Variabel yang hilang karena sanitasi (mis. di atribut `style`/`src`) = tidak didukung di sana.
  for (const [name, count] of rawCounts) {
    if ((keptCounts.get(name) ?? 0) < count) problem('html', name, 'attribute_not_supported');
  }

  if (input.text !== null) for (const name of placeholdersOf(input.text)) use('text', name);
  return { used, problems };
}

// ── Render ──────────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const withBreaks = (value: string) => escapeHtml(value).replace(/\r\n|\r|\n/g, '<br>');

function httpsUrl(value: string): boolean {
  if (value.length === 0 || value.length > HREF_URL_MAX) return false;
  if ([...value].some(isControlOrSpace)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

function truncateBytes(value: string, max: number): string {
  if (Buffer.byteLength(value, 'utf8') <= max) return value;
  return Buffer.from(value, 'utf8').subarray(0, max).toString('utf8').replace(/�+$/, '');
}

export interface RenderOutboundEmailInput {
  subject: string;
  /** `null` = email teks saja. */
  html: string | null;
  /** `null` = dibuat dari HTML. */
  text: string | null;
  values: Readonly<Record<string, string>>;
  organizationName: string;
  /** `cid:qris` (kirim) atau `data:` URI (pratinjau); `null` = tanpa QRIS (`{{qris}}` kosong). */
  qrisImageSrc: string | null;
  layout: 'brand' | 'none';
  brand: { primaryColor: string; logoSrc: string | null; footerText: string | null };
  /**
   * `false` = isi luar (bukan template): `{{…}}` dibiarkan apa adanya, tidak ada substitusi. Bawaan
   * `true`.
   */
  substituteVariables?: boolean;
}

export interface RenderOutboundEmailError {
  field: TemplateField;
  reason: 'template_variable_invalid' | 'subject_invalid';
  name?: string;
  message: string;
}

export type RenderOutboundEmailResult =
  | {
      ok: true;
      subject: string;
      html: string | null;
      text: string;
      /** Sanitasi membuang sesuatu dari HTML masukan (untuk HTML luar → `sanitized: true`). */
      sanitized: boolean;
      /** Semua `cid:` yang dirujuk `<img src>` di HTML akhir (termasuk logo bingkai), unik. */
      referencedCids: string[];
    }
  | { ok: false; errors: RenderOutboundEmailError[] };

const SUBJECT_INVALID = 'Subjek wajib diisi (maks. 200 karakter, satu baris).';

export function renderOutboundEmail(input: RenderOutboundEmailInput): RenderOutboundEmailResult {
  const substitute = input.substituteVariables !== false;
  const errors: RenderOutboundEmailError[] = [];
  const valueOf = (name: string): string => {
    if (name === 'nama_organisasi') return input.organizationName;
    return Object.hasOwn(input.values, name) ? (input.values[name] ?? '') : '';
  };
  const plain = (template: string, qrisText: string) =>
    substitute
      ? template.replace(PLACEHOLDER, (whole, name: string) => {
          if (!validName(name)) return whole;
          return name === 'qris' ? qrisText : valueOf(name);
        })
      : template;

  // Subjek: nilai mentah, satu baris, 1–200 karakter.
  const subject = plain(input.subject, '').trim();
  if (subject.length === 0 || subject.length > EMAIL_SUBJECT_MAX || /[\r\n]/.test(subject)) {
    errors.push({ field: 'subject', reason: 'subject_invalid', message: SUBJECT_INVALID });
  }

  let body: string | null = null;
  let sanitized = false;
  if (input.html !== null) {
    const first = sanitizeOutboundEmailHtml(input.html);
    sanitized = first.changed;
    let filled = first.html;
    if (substitute) {
      const invalidHref = new Set<string>();
      const qrisTag = input.qrisImageSrc
        ? `<img src="${escapeHtml(input.qrisImageSrc)}" alt="${QRIS_ALT}" width="240" height="240" style="display:block;margin:0 auto">`
        : '';
      filled = segmentsOf(first.html)
        .map((segment) => {
          if (!segment.value.includes('{{')) return segment.value;
          if (segment.kind === 'style') return segment.value.replace(PLACEHOLDER, '');
          if (segment.kind === 'text') {
            return segment.value.replace(PLACEHOLDER, (whole, name: string) => {
              if (!validName(name)) return whole;
              return name === 'qris' ? qrisTag : withBreaks(valueOf(name));
            });
          }
          return segment.value.replace(
            ATTRIBUTE,
            (whole, space: string, attribute: string, value: string) => {
              if (!value.includes('{{')) return whole;
              const only = PLACEHOLDER_ONLY.exec(value.trim());
              const name = only?.[1] ?? '';
              if (attribute.toLowerCase() === 'href' && only && validName(name)) {
                const url = name === 'qris' ? '' : valueOf(name);
                if (!httpsUrl(url)) {
                  invalidHref.add(name);
                  return '';
                }
                return `${space}${attribute}="${escapeHtml(url)}"`;
              }
              // Variabel di atribut lain tidak didukung: dikosongkan.
              return `${space}${attribute}="${value.replace(PLACEHOLDER, '')}"`;
            },
          );
        })
        .join('');
      for (const name of invalidHref) {
        errors.push({
          field: 'html',
          reason: 'template_variable_invalid',
          name,
          message: `Nilai {{${name}}} harus alamat https:// yang lengkap.`,
        });
      }
    }
    // Pertahanan berlapis: hasil isian disanitasi ulang.
    body = sanitizeOutboundEmailHtml(filled).html;
  }

  if (errors.length > 0) return { ok: false, errors };

  const organizationName = input.organizationName;
  const footerLines = [
    ...(input.brand.footerText ? [input.brand.footerText] : []),
    organizationName,
  ];
  let text: string;
  if (input.text !== null) {
    text = plain(input.text, input.qrisImageSrc ? EMAIL_QRIS_SCAN_TEXT : '');
  } else if (body !== null) {
    text = htmlToText(body);
    if (input.layout === 'brand') text = `${text}\n\n--\n${footerLines.join('\n')}`.trim();
  } else {
    text = '';
  }
  text = truncateBytes(text, EMAIL_TEXT_MAX_BYTES);

  const html =
    body === null
      ? null
      : input.layout === 'brand'
        ? brandDocument(subject, body, organizationName, input.brand)
        : plainDocument(subject, body);
  const referencedCids = html
    ? [
        ...new Set(
          [...html.matchAll(/<img\b[^>]*?\ssrc="cid:([^"]+)"/gi)].map((match) => match[1] ?? ''),
        ),
      ].filter((cid) => cid !== '')
    : [];
  return { ok: true, subject, html, text, sanitized, referencedCids };
}

function documentHead(subject: string): string {
  return (
    '<!doctype html><html lang="id"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light">' +
    `<title>${escapeHtml(subject)}</title></head>`
  );
}

function plainDocument(subject: string, body: string): string {
  return `${documentHead(subject)}<body>${body}</body></html>`;
}

const FONT = 'font-family:Arial,Helvetica,sans-serif;';

function brandDocument(
  subject: string,
  body: string,
  organizationName: string,
  brand: RenderOutboundEmailInput['brand'],
): string {
  const color = /^#[0-9a-fA-F]{6}$/.test(brand.primaryColor) ? brand.primaryColor : FALLBACK_COLOR;
  const name = escapeHtml(organizationName);
  const header = brand.logoSrc
    ? `<img src="${escapeHtml(brand.logoSrc)}" alt="${name}" width="160" style="display:block;max-width:160px;height:auto;border:0">`
    : `<span style="${FONT}font-size:20px;font-weight:bold;color:#111827">${name}</span>`;
  const footer = [
    ...(brand.footerText ? [withBreaks(brand.footerText)] : []),
    `<strong>${name}</strong>`,
  ].join('<br>');
  return (
    `${documentHead(subject)}<body style="margin:0;padding:0;background-color:#f4f5f7">` +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f5f7">' +
    '<tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#ffffff;border-radius:8px">' +
    `<tr><td style="padding:24px 24px 16px 24px">${header}</td></tr>` +
    `<tr><td style="height:4px;line-height:4px;font-size:0;background-color:${color}">&nbsp;</td></tr>` +
    `<tr><td style="padding:24px;${FONT}font-size:15px;line-height:1.6;color:#1f2937">${body}</td></tr>` +
    `<tr><td style="padding:16px 24px 24px 24px;${FONT}font-size:12px;line-height:1.5;color:#6b7280;border-top:1px solid #e5e7eb">${footer}</td></tr>` +
    '</table></td></tr></table></body></html>'
  );
}

// ── Versi teks ──────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  euro: '€',
};

function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g,
    (whole, entity: string) => {
      if (entity.startsWith('#')) {
        const code =
          entity[1] === 'x' || entity[1] === 'X'
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return Number.isInteger(code) &&
          code > 0 &&
          code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : whole;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
    },
  );
}

const stripTags = (value: string) => value.replace(/<[^>]*>/g, '');

function attributeOf(tag: string, attribute: string): string | null {
  const match = new RegExp(`\\s${attribute}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(
    tag,
  );
  if (!match) return null;
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
}

/** HTML → teks polos (versi `text/plain` email). */
export function htmlToText(html: string): string {
  let out = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  out = out.replace(/<img\b[^>]*>/gi, (tag) =>
    attributeOf(tag, 'alt') === QRIS_ALT ? `\n${EMAIL_QRIS_SCAN_TEXT}\n` : '',
  );
  out = out.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi,
    (_whole, attributes: string, inner: string) => {
      const label = decodeEntities(stripTags(inner)).replace(/\s+/g, ' ').trim();
      const href = attributeOf(` ${attributes}`, 'href')?.trim() ?? '';
      const shown = href.replace(/^mailto:/i, '');
      if (!href || !/^(https?:|mailto:|tel:)/i.test(href)) return label;
      if (!label) return shown;
      return label === shown || label === href ? label : `${label} (${shown})`;
    },
  );
  out = out
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<hr\b[^>]*>/gi, '\n----\n')
    .replace(
      /<\/?(p|div|tr|table|h[1-6]|ul|ol|blockquote|pre|center|thead|tbody|tfoot)\b[^>]*>/gi,
      '\n',
    )
    .replace(/<\/t[dh]\s*>/gi, ' ');
  out = decodeEntities(stripTags(out));
  out = out
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncateBytes(out, EMAIL_TEXT_MAX_BYTES);
}
