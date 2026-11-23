import sanitizeHtml from 'sanitize-html';

import { EMAIL_HTML_TOO_COMPLEX_MESSAGE, htmlWithinLimits } from './html-guard';

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

// Review 9.1 S1 (ReDoS): pola linear — `[^{}]*` berhenti di kurung kurawal berikutnya, tanpa
// kuantifier yang tumpang tindih. Spasi di sekitar nama dipangkas di kode (`.trim()`).
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const PLACEHOLDER_ONLY = /^\{\{([^{}]*)\}\}$/;

const validName = (name: string) => EMAIL_TEMPLATE_VARIABLE_NAME.test(name);

/**
 * Review 9.1 putaran 3 S4 (amplifikasi variabel): kemunculan `{{…}}` per template (subjek + HTML +
 * teks digabung). Nilai variabel disisipkan di SETIAP kemunculan (di-escape, `&` → `&amp;`), jadi
 * tanpa batas ini ukuran hasil = kemunculan × nilai. Dicek saat simpan draf, terbit, pratinjau, dan
 * render (template lama yang sudah tersimpan). Ukuran hasil juga dibatasi saat render.
 */
export const EMAIL_TEMPLATE_PLACEHOLDERS_MAX = 200;
export const EMAIL_TEMPLATE_PLACEHOLDERS_MESSAGE =
  'Template memuat lebih dari 200 penanda variabel {{…}} (subjek, HTML, dan teks digabung). Kurangi pemakaiannya.';
export const EMAIL_CONTENT_TOO_LARGE_MESSAGE = {
  html: 'HTML email setelah variabel diisi melebihi 512 KB. Perpendek isi template atau nilai variabelnya.',
  text: 'Versi teks email setelah variabel diisi melebihi 256 KB. Perpendek isi template atau nilai variabelnya.',
} as const;

/** Jumlah kemunculan `{{…}}`, berhenti setelah melewati `limit` (linear). */
function placeholderCount(value: string, limit: number): number {
  const pattern = new RegExp(PLACEHOLDER.source, 'g');
  let count = 0;
  while (count <= limit && pattern.exec(value) !== null) count += 1;
  return count;
}

/**
 * Bagian template yang membuat jumlah `{{…}}` melewati `EMAIL_TEMPLATE_PLACEHOLDERS_MAX`, atau
 * `null` bila masih dalam batas. Urutan hitung: subjek → HTML → teks.
 */
export function templatePlaceholderOverflow(input: {
  subject: string;
  html: string | null;
  text: string | null;
}): 'subject' | 'html' | 'text' | null {
  let total = 0;
  for (const [field, value] of [
    ['subject', input.subject],
    ['html', input.html],
    ['text', input.text],
  ] as const) {
    if (value === null) continue;
    total += placeholderCount(value, EMAIL_TEMPLATE_PLACEHOLDERS_MAX - total);
    if (total > EMAIL_TEMPLATE_PLACEHOLDERS_MAX) return field;
  }
  return null;
}

/**
 * Isi `{{…}}` dengan batas ukuran hasil (byte UTF-8): berhenti SEGERA begitu hasil melewati
 * `maxBytes` dan mengembalikan `null` (S4 — tidak pernah membangun string raksasa).
 */
function fillBounded(
  template: string,
  replace: (whole: string, raw: string) => string,
  maxBytes: number,
): string | null {
  const pattern = new RegExp(PLACEHOLDER.source, 'g');
  const parts: string[] = [];
  let bytes = 0;
  let position = 0;
  const push = (piece: string) => {
    bytes += Buffer.byteLength(piece, 'utf8');
    parts.push(piece);
    return bytes <= maxBytes;
  };
  for (let match = pattern.exec(template); match !== null; match = pattern.exec(template)) {
    if (!push(template.slice(position, match.index))) return null;
    if (!push(replace(match[0], match[1] ?? ''))) return null;
    position = match.index + match[0].length;
  }
  if (!push(template.slice(position))) return null;
  return parts.join('');
}

/**
 * Review 9.1 putaran 3 R10: huruf kecil HANYA untuk A–Z. `String#toLowerCase()` bisa memperpanjang
 * string (mis. "İ" U+0130 → 2 unit), sehingga indeks dari hasilnya tidak cocok lagi dengan `html`.
 * Versi ini mempertahankan panjang, jadi indeksnya aman dipakai untuk memotong string asli.
 */
const asciiLower = (value: string) => value.replace(/[A-Z]+/g, (run) => run.toLowerCase());

/**
 * Blok `<style>` dipindai dengan `indexOf` (linear, review 9.1 S1): `<style …>` sampai `</style …>`
 * berikutnya. Tanpa penutup → berhenti (sisanya diurus sanitize-html, yang membuang `<style>`).
 */
export function extractStyleBlocks(html: string): { rest: string; blocks: string[] } {
  const lower = asciiLower(html);
  const blocks: string[] = [];
  let rest = '';
  let position = 0;
  for (;;) {
    const open = lower.indexOf('<style', position);
    if (open === -1) break;
    const after = lower.charAt(open + 6);
    if (after !== '>' && after !== '/' && !/\s/.test(after)) {
      rest += html.slice(position, open + 6);
      position = open + 6;
      continue;
    }
    const openEnd = lower.indexOf('>', open + 6);
    if (openEnd === -1) break;
    const close = lower.indexOf('</style', openEnd + 1);
    if (close === -1) break;
    const closeEnd = lower.indexOf('>', close + 7);
    if (closeEnd === -1) break;
    rest += html.slice(position, open);
    blocks.push(html.slice(openEnd + 1, close));
    position = closeEnd + 1;
  }
  return { rest: rest + html.slice(position), blocks };
}

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
  tooComplex: EMAIL_HTML_TOO_COMPLEX_MESSAGE,
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
export function filterInlineStyle(value: string): { style: string; changed: boolean } {
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

/** Potongan CSS (di antara `;`, `{`, `}`) yang dibuang utuh. Diuji per potongan — tanpa awalan. */
const UNSAFE_CSS_CHUNK =
  /url\s*\(|image-set\s*\(|expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding|@import|position\s*:\s*fixed/i;

/** Komentar `/* … *\/` dibuang dengan `indexOf` (linear). Komentar tak tertutup = sisanya dibuang. */
function stripCssComments(css: string): string {
  let out = '';
  let position = 0;
  for (;;) {
    const open = css.indexOf('/*', position);
    if (open === -1) return out + css.slice(position);
    out += css.slice(position, open);
    const close = css.indexOf('*/', open + 2);
    if (close === -1) return out;
    position = close + 2;
  }
}

/**
 * Isi elemen `<style>`: tanpa `@import`, `url()`, `image-set()`, ekspresi, `position: fixed`, `<`,
 * `>`, `\`. Review 9.1 S1: dipindai per karakter pemisah (`;`, `{`, `}`) — linear; potongan yang tidak
 * aman dibuang utuh (beserta `;` penutupnya).
 */
export function sanitizeCssBlock(css: string): { css: string; changed: boolean } {
  const base = stripCssComments(css);
  const cleaned = base.replace(/[<>\\]/g, '');
  let out = '';
  let start = 0;
  for (let index = 0; index <= cleaned.length; index += 1) {
    const char = index < cleaned.length ? cleaned.charAt(index) : '';
    if (char !== ';' && char !== '{' && char !== '}' && char !== '') continue;
    const chunk = cleaned.slice(start, index);
    if (UNSAFE_CSS_CHUNK.test(chunk)) {
      // Deklarasi berbahaya + `;`-nya dibuang; `{`/`}` tetap supaya struktur blok utuh.
      if (char === '{' || char === '}') out += char;
    } else {
      out += chunk + char;
    }
    start = index + 1;
  }
  return { css: out.trim(), changed: out.trim() !== base.trim() };
}

/** Tanpa spasi/karakter kendali (cegah `java\tscript:`). */
const isControlOrSpace = (char: string) => {
  const code = char.charCodeAt(0);
  return code <= 0x20 || code === 0x7f;
};
export const compactUrlText = (value: string) =>
  [...value].filter((char) => !isControlOrSpace(char)).join('');

function hrefAllowed(value: string): boolean {
  // Review 9.1 S1: nilai kepanjangan ditolak SEBELUM regex apa pun.
  if (value.length > HREF_URL_MAX) return false;
  const trimmed = value.trim();
  if (PLACEHOLDER_ONLY.test(trimmed)) return true;
  return /^(https?:\/\/|mailto:|tel:)/i.test(compactUrlText(trimmed));
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
  if (/^http:/i.test(compactUrlText(trimmed))) return 'imageHttp';
  const data = /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
  if (data) {
    const payload = (data[2] ?? '').replace(/\s+/g, '');
    return Math.floor((payload.length * 3) / 4) <= DATA_IMAGE_MAX_BYTES ? 'ok' : 'imageData';
  }
  if (/^data:/i.test(compactUrlText(trimmed))) return 'imageData';
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
  /**
   * Review 9.1 putaran 2 S3: HTML melewati batas tag/kedalaman (`html-guard.ts`) sehingga TIDAK
   * disanitasi — `html` kosong. Pemanggil API menjawab 400 `html_too_complex`.
   */
  tooComplex: boolean;
}

/**
 * Sanitasi HTML email keluar (template saat disimpan & HTML luar saat dikirim). HTML yang terlalu
 * rumit (> 20.000 tag atau sarang > 200 tingkat) tidak pernah diserahkan ke sanitize-html (S3).
 */
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
  const extracted = extractStyleBlocks(html);
  for (const css of extracted.blocks) {
    const clean = sanitizeCssBlock(css);
    if (clean.changed) note(WARNING.css);
    if (clean.css !== '') styles.push(clean.css);
  }
  const withoutStyles = extracted.rest;
  // Diukur pada masukan sanitize-html yang sebenarnya (blok `<style>` sudah diambil).
  if (!htmlWithinLimits(withoutStyles)) {
    return {
      html: '',
      changed: true,
      forbidden: false,
      warnings: [WARNING.tooComplex],
      tooComplex: true,
    };
  }

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
      if (/^(javascript|vbscript):/i.test(compactUrlText(value))) {
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
  return { html: `${head}${body}`, changed, forbidden, warnings: [...warnings], tooComplex: false };
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
  return [...value.matchAll(PLACEHOLDER)].map((match) => (match[1] ?? '').trim());
}

type HtmlSegment = { kind: 'style' | 'tag' | 'text'; value: string };

/**
 * Potong HTML hasil sanitasi (atribut selalu `"…"`, `<`/`>` dalam nilai di-escape) dengan pemindaian
 * `indexOf` — linear (review 9.1 S1).
 */
function segmentsOf(html: string): HtmlSegment[] {
  const lower = asciiLower(html);
  const segments: HtmlSegment[] = [];
  let position = 0;
  while (position < html.length) {
    const open = html.indexOf('<', position);
    if (open === -1) break;
    if (open > position) segments.push({ kind: 'text', value: html.slice(position, open) });
    const isStyle = lower.startsWith('<style', open) && /[\s>/]/.test(lower.charAt(open + 6));
    if (isStyle) {
      const close = lower.indexOf('</style', open + 6);
      const end = close === -1 ? -1 : lower.indexOf('>', close + 7);
      if (end !== -1) {
        segments.push({ kind: 'style', value: html.slice(open, end + 1) });
        position = end + 1;
        continue;
      }
    }
    const end = html.indexOf('>', open + 1);
    if (end === -1) {
      segments.push({ kind: 'text', value: html.slice(open) });
      position = html.length;
      break;
    }
    segments.push({ kind: 'tag', value: html.slice(open, end + 1) });
    position = end + 1;
  }
  if (position < html.length) segments.push({ kind: 'text', value: html.slice(position) });
  return segments;
}

const ATTRIBUTE = /(\s)([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g;

export function scanTemplateVariables(input: {
  subject: string;
  html: string;
  text: string | null;
  /**
   * Hasil `sanitizeOutboundEmailHtml(html).html` bila pemanggil sudah menyanitasi (hindari sanitasi
   * berulang, review 9.1 S3). Tanpa ini, HTML disanitasi di sini.
   */
  sanitizedHtml?: string;
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
  const sanitizedHtml = input.sanitizedHtml ?? sanitizeOutboundEmailHtml(input.html).html;
  for (const segment of segmentsOf(sanitizedHtml)) {
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
      const only = value.length <= HREF_URL_MAX ? PLACEHOLDER_ONLY.exec(value.trim()) : null;
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
  reason:
    | 'template_variable_invalid'
    | 'subject_invalid'
    | 'html_too_complex'
    | 'template_placeholders_too_many'
    | 'content_too_large';
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
/** Subjek sah ≤ 200 karakter (≤ 800 byte); isian di atas ini pasti `subject_invalid`. */
const SUBJECT_FILL_MAX_BYTES = 4 * 1024;
const tooComplexError: RenderOutboundEmailError = {
  field: 'html',
  reason: 'html_too_complex',
  message: EMAIL_HTML_TOO_COMPLEX_MESSAGE,
};

export function renderOutboundEmail(input: RenderOutboundEmailInput): RenderOutboundEmailResult {
  const substitute = input.substituteVariables !== false;
  const errors: RenderOutboundEmailError[] = [];
  const valueOf = (name: string): string => {
    if (name === 'nama_organisasi') return input.organizationName;
    return Object.hasOwn(input.values, name) ? (input.values[name] ?? '') : '';
  };
  /** Isi variabel teks polos (subjek & versi teks); `null` = hasil melewati `maxBytes` (S4). */
  const plain = (template: string, qrisText: string, maxBytes: number): string | null =>
    substitute
      ? fillBounded(
          template,
          (whole, raw) => {
            const name = raw.trim();
            if (!validName(name)) return whole;
            return name === 'qris' ? qrisText : valueOf(name);
          },
          maxBytes,
        )
      : template;

  // S4: jumlah `{{…}}` dibatasi sebelum apa pun diisi (template lama yang tersimpan ikut dicek).
  if (substitute) {
    const overflow = templatePlaceholderOverflow(input);
    if (overflow) {
      return {
        ok: false,
        errors: [
          {
            field: overflow,
            reason: 'template_placeholders_too_many',
            message: EMAIL_TEMPLATE_PLACEHOLDERS_MESSAGE,
          },
        ],
      };
    }
  }

  // Subjek: nilai mentah, satu baris, 1–200 karakter (isian > 4 KB = pasti tidak sah).
  const subject = (plain(input.subject, '', SUBJECT_FILL_MAX_BYTES) ?? '').trim();
  if (subject.length === 0 || subject.length > EMAIL_SUBJECT_MAX || /[\r\n]/.test(subject)) {
    errors.push({ field: 'subject', reason: 'subject_invalid', message: SUBJECT_INVALID });
  }

  let body: string | null = null;
  let sanitized = false;
  if (input.html !== null) {
    const first = sanitizeOutboundEmailHtml(input.html);
    if (first.tooComplex) {
      // S3: tidak ada yang bisa dirender — kembalikan galat segera (tanpa sanitasi kedua).
      errors.push({ ...tooComplexError });
      return { ok: false, errors };
    }
    sanitized = first.changed;
    let filled = first.html;
    if (substitute) {
      const invalidHref = new Set<string>();
      const qrisTag = input.qrisImageSrc
        ? `<img src="${escapeHtml(input.qrisImageSrc)}" alt="${QRIS_ALT}" width="240" height="240" style="display:block;margin:0 auto">`
        : '';
      // S4: ukuran hasil dihitung bertahap dan berhenti di batas. Batas minimal = ukuran hasil
      // sanitasi pertama, jadi isi yang sudah sah tanpa variabel tidak pernah ditolak di sini.
      const maxBytes = Math.max(EMAIL_HTML_MAX_BYTES, Buffer.byteLength(first.html, 'utf8'));
      const pieces: string[] = [];
      let bytes = 0;
      let tooLarge = false;
      const fillSegment = (segment: HtmlSegment): string | null => {
        if (!segment.value.includes('{{')) return segment.value;
        if (segment.kind === 'style') return segment.value.replace(PLACEHOLDER, '');
        if (segment.kind === 'text') {
          return fillBounded(
            segment.value,
            (whole, raw) => {
              const name = raw.trim();
              if (!validName(name)) return whole;
              return name === 'qris' ? qrisTag : withBreaks(valueOf(name));
            },
            maxBytes - bytes,
          );
        }
        // Atribut: hanya `href` yang diisi (URL https ≤ 2.000), lainnya dikosongkan — tidak membesar.
        return segment.value.replace(
          ATTRIBUTE,
          (whole, space: string, attribute: string, value: string) => {
            if (!value.includes('{{')) return whole;
            const only = value.length <= HREF_URL_MAX ? PLACEHOLDER_ONLY.exec(value.trim()) : null;
            const name = (only?.[1] ?? '').trim();
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
      };
      for (const segment of segmentsOf(first.html)) {
        const piece = fillSegment(segment);
        if (piece === null) {
          tooLarge = true;
          break;
        }
        bytes += Buffer.byteLength(piece, 'utf8');
        if (bytes > maxBytes) {
          tooLarge = true;
          break;
        }
        pieces.push(piece);
      }
      if (tooLarge) {
        errors.push({
          field: 'html',
          reason: 'content_too_large',
          message: EMAIL_CONTENT_TOO_LARGE_MESSAGE.html,
        });
        return { ok: false, errors };
      }
      filled = pieces.join('');
      for (const name of invalidHref) {
        errors.push({
          field: 'html',
          reason: 'template_variable_invalid',
          name,
          message: `Nilai {{${name}}} harus alamat https:// yang lengkap.`,
        });
      }
    }
    if (filled === first.html) {
      // Tidak ada yang diisi (isi luar, atau template tanpa variabel di HTML): hasil sanitasi pertama
      // dipakai langsung — sanitasi ulang tidak mengubah apa pun (review 9.1 S3, hindari kerja ganda).
      body = first.html;
    } else {
      // Pertahanan berlapis: hasil isian disanitasi ulang (nilai variabel bisa menambah `<br>`).
      const second = sanitizeOutboundEmailHtml(filled);
      if (second.tooComplex) errors.push({ ...tooComplexError });
      body = second.html;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const organizationName = input.organizationName;
  const footerLines = [
    ...(input.brand.footerText ? [input.brand.footerText] : []),
    organizationName,
  ];
  let text: string;
  if (input.text !== null) {
    const filledText = plain(
      input.text,
      input.qrisImageSrc ? EMAIL_QRIS_SCAN_TEXT : '',
      Math.max(EMAIL_TEXT_MAX_BYTES, Buffer.byteLength(input.text, 'utf8')),
    );
    if (filledText === null) {
      return {
        ok: false,
        errors: [
          {
            field: 'text',
            reason: 'content_too_large',
            message: EMAIL_CONTENT_TOO_LARGE_MESSAGE.text,
          },
        ],
      };
    }
    text = filledText;
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
