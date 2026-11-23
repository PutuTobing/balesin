/**
 * Profil HTML editor di sisi web (KONTRAK-API-EMAIL-TULIS §6.4, `sanitizeComposerHtml`). Server tetap
 * penentu; di sini hanya supaya editor tidak pernah memuat isi berbahaya:
 *
 * - HTML (dari draf, tanda tangan, template, atau tempelan) di-parse lewat `DOMParser` — dokumen
 *   inert: skrip tidak jalan dan gambar tidak dimuat — lalu dibangun ULANG elemen demi elemen dari
 *   daftar izin. Tidak ada `innerHTML`/`dangerouslySetInnerHTML` di dokumen aplikasi.
 * - `img` hanya `cid:` yang dikenal (lampiran inline draf / logo tanda tangan) dan ditampilkan lewat
 *   URL pratinjau API (origin sendiri). Gambar jarak jauh & `data:` dibuang.
 * - Hasil editor diserialisasi dengan cara yang sama (daftar izin + escape), `src` dikembalikan ke
 *   `cid:`.
 */

const ALLOWED = new Set([
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
]);

/** Dibuang beserta isinya (bukan hanya tag-nya). */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'template',
  'iframe',
  'object',
  'embed',
  'noscript',
  'svg',
  'math',
  'head',
  'title',
  'meta',
  'link',
  'frame',
  'frameset',
  'select',
  'textarea',
  'button',
  'input',
  'form',
  'canvas',
  'video',
  'audio',
  'picture',
  'xml',
]);

const VOID = new Set(['br', 'hr', 'img']);
const LINK_SCHEMES = /^(https?:|mailto:|tel:)/i;
const COLOR_VALUE =
  /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;
const STYLE_RULES: Record<string, RegExp> = {
  color: COLOR_VALUE,
  'background-color': COLOR_VALUE,
  'text-align': /^(left|right|center|justify|start|end)$/i,
  'font-weight': /^(normal|bold|bolder|lighter|[1-9]00)$/i,
  'font-style': /^(normal|italic|oblique)$/i,
  'text-decoration': /^(none|underline|line-through)$/i,
};
const CONTENT_ID = /^[A-Za-z0-9._-]{1,64}$/;
/** Batas kedalaman (tempelan bersarang sangat dalam tidak membekukan tab). */
const MAX_DEPTH = 64;

export interface CidResolver {
  /** `cid` (tanpa awalan `cid:`) → URL pratinjau di origin sendiri, atau `null` bila tidak dikenal. */
  (contentId: string): string | null;
}

export interface SanitizeResult {
  fragment: DocumentFragment;
  /** Gambar yang dibuang (jarak jauh, `data:`, `cid:` tak dikenal) — untuk pemberitahuan tempel. */
  droppedImages: number;
}

/** Tautan yang boleh dipakai (`https:`, `http:`, `mailto:`, `tel:`), atau `null`. */
export function safeHref(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value || !LINK_SCHEMES.test(value)) return null;
  // Karakter kendali/spasi di tengah URL = tanda penyamaran; ditolak.
  if (/[\s\p{Cc}]/u.test(value)) return null;
  return value;
}

/** Ketikan tautan pengguna → URL lengkap (`contoh.id` → `https://contoh.id`), atau `null`. */
export function normalizeLinkInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return safeHref(value);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return safeHref(`mailto:${value}`);
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(value)) return safeHref(`https://${value}`);
  return null;
}

function cleanStyle(style: string): string {
  const kept: string[] = [];
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration
      .slice(colon + 1)
      .trim()
      .replace(/\s*!important$/i, '');
    const rule = STYLE_RULES[property];
    if (rule && rule.test(value) && !/url\(|expression/i.test(value)) {
      kept.push(`${property}: ${value}`);
    }
  }
  return kept.join('; ');
}

/** Atribut yang lolos untuk satu elemen (nama → nilai), sebelum `src` dipetakan. */
function allowedAttributes(tag: string, source: Element): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  if (tag === 'a') {
    const href = safeHref(source.getAttribute('href'));
    if (href) result.push(['href', href]);
  }
  if (tag === 'td' || tag === 'th') {
    for (const name of ['colspan', 'rowspan']) {
      const value = source.getAttribute(name);
      if (value && /^\d{1,3}$/.test(value)) result.push([name, value]);
    }
  }
  if (tag === 'img') {
    const alt = source.getAttribute('alt');
    if (alt) result.push(['alt', alt.slice(0, 200)]);
    for (const name of ['width', 'height']) {
      const value = source.getAttribute(name);
      if (value && /^\d{1,4}$/.test(value)) result.push([name, value]);
    }
  }
  if (tag === 'div') {
    const signature = source.getAttribute('data-signature');
    if (signature !== null && /^[\w-]{0,64}$/.test(signature)) {
      result.push(['data-signature', signature]);
    }
  }
  const style = source.getAttribute('style');
  if (style) {
    const cleaned = cleanStyle(style);
    if (cleaned) result.push(['style', cleaned]);
  }
  return result;
}

/** `cid:` dari `src` (draf/tanda tangan) atau `data-cid` (elemen editor yang sudah dipetakan). */
function contentIdOf(source: Element): string | null {
  const marked = source.getAttribute('data-cid');
  if (marked && CONTENT_ID.test(marked)) return marked;
  const src = source.getAttribute('src') ?? '';
  if (!/^cid:/i.test(src)) return null;
  const id = src.slice(4).trim();
  return CONTENT_ID.test(id) ? id : null;
}

/**
 * HTML → fragmen di `target` (dokumen editor) yang hanya berisi elemen & atribut yang diizinkan.
 * `resolveCid`: `cid:` yang dikenal dipetakan ke URL pratinjau (`data-cid` menyimpan aslinya).
 */
export function sanitizeToFragment(
  html: string,
  target: Document,
  resolveCid: CidResolver = () => null,
): SanitizeResult {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const fragment = target.createDocumentFragment();
  let droppedImages = 0;

  const copy = (source: Node, parent: Node, depth: number) => {
    if (source.nodeType === Node.TEXT_NODE) {
      parent.appendChild(target.createTextNode(source.textContent ?? ''));
      return;
    }
    if (source.nodeType !== Node.ELEMENT_NODE) return; // komentar (sisa Word), dsb.
    const element = source as Element;
    const tag = element.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag) || tag.includes(':')) return; // `o:p` & teman Word.
    if (depth > MAX_DEPTH) {
      parent.appendChild(target.createTextNode(element.textContent ?? ''));
      return;
    }
    if (!ALLOWED.has(tag)) {
      // Tag tak dikenal: isinya tetap (teks dari `<font>`, `<center>`, dsb.).
      for (const child of Array.from(element.childNodes)) copy(child, parent, depth + 1);
      return;
    }
    if (tag === 'img') {
      const cid = contentIdOf(element);
      const url = cid ? resolveCid(cid) : null;
      if (!cid || !url) {
        droppedImages += 1;
        return;
      }
      const image = target.createElement('img');
      for (const [name, value] of allowedAttributes(tag, element)) image.setAttribute(name, value);
      image.setAttribute('src', url);
      image.setAttribute('data-cid', cid);
      parent.appendChild(image);
      return;
    }
    const output = target.createElement(tag);
    for (const [name, value] of allowedAttributes(tag, element)) output.setAttribute(name, value);
    if (tag === 'a') {
      output.setAttribute('rel', 'noopener noreferrer');
      output.setAttribute('target', '_blank');
    }
    for (const child of Array.from(element.childNodes)) copy(child, output, depth + 1);
    parent.appendChild(output);
  };

  for (const child of Array.from(parsed.body.childNodes)) copy(child, fragment, 0);
  return { fragment, droppedImages };
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/**
 * Isi editor → HTML untuk server (profil yang sama dengan `sanitizeToFragment`). `img` ditulis
 * kembali sebagai `cid:`; `rel`/`target` tautan (hanya untuk tampilan editor) tidak ikut.
 */
export function serializeEditor(root: Node): string {
  const out: string[] = [];
  const walk = (node: Node, depth: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(escapeText(node.textContent ?? ''));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) return;
    if (!ALLOWED.has(tag) || depth > MAX_DEPTH) {
      for (const child of Array.from(element.childNodes)) walk(child, depth + 1);
      return;
    }
    if (tag === 'img') {
      const cid = contentIdOf(element);
      if (!cid) return;
      const attributes = allowedAttributes(tag, element)
        .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
        .join('');
      out.push(`<img src="cid:${escapeAttribute(cid)}"${attributes}>`);
      return;
    }
    const attributes = allowedAttributes(tag, element)
      .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
      .join('');
    out.push(`<${tag}${attributes}>`);
    if (VOID.has(tag)) return;
    for (const child of Array.from(element.childNodes)) walk(child, depth + 1);
    out.push(`</${tag}>`);
  };
  for (const child of Array.from(root.childNodes)) walk(child, 0);
  return out.join('');
}

const BLOCKS = new Set([
  'p',
  'div',
  'li',
  'blockquote',
  'pre',
  'h1',
  'h2',
  'h3',
  'tr',
  'table',
  'ul',
  'ol',
  'hr',
]);

/** HTML (profil editor) → teks biasa: blok jadi baris, `br` jadi baris baru, daftar diberi tanda. */
export function htmlToPlainText(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const lines: string[] = [];
  let current = '';
  const flush = () => {
    lines.push(current.replace(/[ \t]+$/g, ''));
    current = '';
  };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      current += (node.textContent ?? '').replace(/\s+/g, ' ');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) return;
    if (tag === 'br') {
      flush();
      return;
    }
    if (tag === 'img') {
      const alt = element.getAttribute('alt');
      if (alt) current += alt;
      return;
    }
    const block = BLOCKS.has(tag);
    if (block && current.trim() !== '') flush();
    if (tag === 'li') current += '• ';
    if (tag === 'a') {
      for (const child of Array.from(element.childNodes)) walk(child);
      const href = element.getAttribute('href');
      const text = element.textContent?.trim() ?? '';
      if (href && !href.startsWith('mailto:') && text !== href) current += ` (${href})`;
      return;
    }
    for (const child of Array.from(element.childNodes)) walk(child);
    if (block && current.trim() !== '') flush();
  };
  for (const child of Array.from(parsed.body.childNodes)) walk(child);
  if (current.trim() !== '') flush();
  return lines
    .map((line) => line.trimStart())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Teks biasa → HTML profil editor: paragraf per baris kosong, `br` per baris, di-escape. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .filter((block) => block.trim() !== '')
    .map((block) => `<p>${block.split('\n').map(escapeText).join('<br>')}</p>`)
    .join('');
}

/** Teks/HTML editor kosong (hanya spasi, `br`, paragraf kosong)? */
export function isBlankHtml(html: string): boolean {
  return htmlToPlainText(html).trim() === '' && !/<img\b/i.test(html);
}

/**
 * Isi variabel tanda tangan untuk pilihan per email di jendela tulis (sama dengan
 * `fillSignatureVariables` server, §4): nilai di-escape, `{{logo}}` → `cid:sig-logo-<id>`.
 */
export function fillSignature(
  html: string,
  values: {
    signatureId: string;
    agentName: string;
    senderAddress: string;
    organizationName: string;
    hasLogo: boolean;
  },
): string {
  const escape = (value: string) => escapeAttribute(value);
  return html.replace(/\{\{([^{}]{0,60})\}\}/g, (whole, raw: string) => {
    switch (raw.trim()) {
      case 'nama_agen':
        return escape(values.agentName);
      case 'alamat_pengirim':
        return escape(values.senderAddress);
      case 'nama_organisasi':
        return escape(values.organizationName);
      case 'logo':
        return values.hasLogo
          ? `<img src="cid:sig-logo-${escape(values.signatureId)}" alt="${escape(values.organizationName)}">`
          : '';
      default:
        return whole;
    }
  });
}

/** `cid` logo tanda tangan → ID tanda tangan, atau `null`. */
export function signatureIdOfLogoCid(contentId: string): string | null {
  const match = /^sig-logo-([0-9a-f-]{36})$/i.exec(contentId);
  return match?.[1] ?? null;
}

const ATTACHMENT_WORDS =
  /\b(terlampir|lampiran|dilampirkan|lampirkan|kami lampirkan|attached|attachment)\b/i;

/**
 * Peringatan web "kamu menulis 'terlampir' tapi belum ada lampiran" (kontrak §6.5). Hanya teks
 * tulisan sendiri — tanda tangan (`data-signature`) tidak dihitung.
 */
export function mentionsAttachment(html: string, format: 'html' | 'text'): boolean {
  if (format === 'text') return ATTACHMENT_WORDS.test(html);
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const block of Array.from(parsed.querySelectorAll('[data-signature]'))) block.remove();
  return ATTACHMENT_WORDS.test(parsed.body.textContent ?? '');
}
