import { Parser } from 'htmlparser2';

/**
 * Review 9.1 putaran 2 S3 (Tinggi): sanitize-html (htmlparser2) berwaktu super-linear terhadap
 * KEDALAMAN tag — tumpukan elemen terbuka di htmlparser2 memakai `Array#unshift`, jadi
 * `'<div>'.repeat(n)` ≈ O(n²) dan membekukan event loop (512 KB ≈ puluhan detik).
 *
 * Penjaga ini dijalankan SEBELUM sanitize-html di setiap jalur: HTML yang melewati batas tidak
 * pernah disanitasi (API → 400 `html_too_complex`; email masuk → HTML dibuang, pakai versi teks).
 * Penghitungan memakai `Parser` htmlparser2 versi yang SAMA dengan sanitize-html (tokenisasi identik:
 * komentar, `<script>`/`<style>`/`<textarea>`/`<title>`, konten SVG/MathML, penutupan tersirat
 * `<p>`/`<li>`/`<td>`), dan BERHENTI begitu batas terlewati — tumpukan tidak pernah lebih dari
 * `maxDepth` elemen, sehingga biayanya linear terhadap panjang masukan.
 *
 * Batas (docs/DECISIONS.md): 20.000 tag pembuka dan kedalaman sarang 200 tingkat. Email tagihan /
 * buletin yang wajar memakai ratusan sampai beberapa ribu tag dengan kedalaman < 40.
 */

export const EMAIL_HTML_MAX_TAGS = 20_000;
export const EMAIL_HTML_MAX_DEPTH = 200;

export const EMAIL_HTML_TOO_COMPLEX_MESSAGE =
  'HTML terlalu rumit untuk diproses: maksimal 20.000 tag dan kedalaman sarang 200 tingkat. Sederhanakan susunan HTML-nya, lalu kirim lagi.';

export interface HtmlLimits {
  maxTags: number;
  maxDepth: number;
}

export const EMAIL_HTML_LIMITS: Readonly<HtmlLimits> = {
  maxTags: EMAIL_HTML_MAX_TAGS,
  maxDepth: EMAIL_HTML_MAX_DEPTH,
};

export type HtmlComplexity =
  | { ok: true; tags: number; maxDepth: number }
  /** `tags`/`maxDepth` = nilai saat pemindaian berhenti (bukan total). */
  | { ok: false; reason: 'tags' | 'depth'; tags: number; maxDepth: number };

/** Penanda henti dari dalam callback parser (dilempar lalu ditangkap di `measureHtmlComplexity`). */
const STOP = new Error('Batas kerumitan HTML terlewati.');

/**
 * Jumlah tag pembuka dan kedalaman sarang maksimum, berhenti di batas. Tag void (`<br>`, `<img>`)
 * dan self-closing di SVG/MathML langsung ditutup parser, jadi tidak menumpuk kedalaman; tag penutup
 * tanpa pasangan diabaikan (sama dengan parser).
 */
export function measureHtmlComplexity(
  html: string,
  limits: Readonly<HtmlLimits> = EMAIL_HTML_LIMITS,
): HtmlComplexity {
  let tags = 0;
  // Elemen yang masih terbuka (= panjang tumpukan parser). Saat `onopentag`, elemen baru belum
  // dihitung: kedalaman elemen itu = `open + 1`.
  let open = 0;
  let maxDepth = 0;
  let exceeded: 'tags' | 'depth' | null = null;
  const parser = new Parser(
    {
      onopentag() {
        tags += 1;
        const depth = open + 1;
        if (depth > maxDepth) maxDepth = depth;
        if (tags > limits.maxTags) exceeded = 'tags';
        else if (depth > limits.maxDepth) exceeded = 'depth';
        if (exceeded) throw STOP;
        open = depth;
      },
      onclosetag() {
        if (open > 0) open -= 1;
      },
    },
    // Sama dengan opsi parser bawaan sanitize-html.
    { decodeEntities: true },
  );
  try {
    parser.write(html);
  } catch (error) {
    if (error !== STOP) throw error;
  }
  if (exceeded) return { ok: false, reason: exceeded, tags, maxDepth };
  return { ok: true, tags, maxDepth };
}

export function htmlWithinLimits(
  html: string,
  limits: Readonly<HtmlLimits> = EMAIL_HTML_LIMITS,
): boolean {
  return measureHtmlComplexity(html, limits).ok;
}

// ── Versi teks darurat (HTML dibuang) ───────────────────────────────────────

const BLOCK_TAGS = new Set([
  'br',
  'p',
  'div',
  'tr',
  'li',
  'table',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'blockquote',
  'pre',
  'hr',
  'center',
  'section',
  'article',
  'header',
  'footer',
]);
/** Isinya bukan teks yang dibaca orang. */
const SKIPPED_CONTENT_TAGS = new Set(['script', 'style', 'head', 'title', 'template', 'noscript']);

const ENTITY = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);/g;
const ENTITY_TEXT: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeBasicEntities(value: string): string {
  return value.replace(ENTITY, (whole, entity: string) => {
    if (!entity.startsWith('#')) return ENTITY_TEXT[entity] ?? whole;
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
  });
}

const TAG_NAME = /^<\/?([a-z][a-z0-9-]{0,30})/;

/**
 * HTML MENTAH (tidak tepercaya, boleh sangat besar/rumit) → teks polos, LINEAR: hanya `indexOf` dan
 * regex berbatas. Dipakai saat HTML email masuk dibuang (terlalu besar/rumit) dan email tidak punya
 * bagian teks. Hasilnya teks biasa (ditampilkan sebagai teks, bukan HTML). Kasar tetapi aman: tag
 * dibuang, isi `<script>`/`<style>`/`<head>` dilewati, tag blok jadi baris baru.
 */
export function plainTextFromUntrustedHtml(html: string, maxLength = 65_536): string {
  // Indeks selalu dari `html` asli (`toLowerCase()` bisa mengubah panjang string, mis. "İ").
  const parts: string[] = [];
  let length = 0;
  let position = 0;
  const push = (value: string) => {
    if (value.length === 0) return;
    parts.push(value);
    length += value.length;
  };
  // Batas kasar sebelum dekode/rapikan (entitas & spasi memendekkan teks).
  const budget = maxLength * 4;
  while (position < html.length && length < budget) {
    const open = html.indexOf('<', position);
    const end = open === -1 ? html.length : open;
    push(html.slice(position, Math.min(end, position + budget - length)));
    if (open === -1) break;
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      position = close === -1 ? html.length : close + 3;
      continue;
    }
    const close = html.indexOf('>', open + 1);
    if (close === -1) break;
    const head = html.slice(open, open + 34).toLowerCase();
    const name = TAG_NAME.exec(head)?.[1] ?? '';
    const closing = head.charAt(1) === '/';
    position = close + 1;
    if (!closing && SKIPPED_CONTENT_TAGS.has(name)) {
      const ending = new RegExp(`</${name}`, 'gi');
      ending.lastIndex = position;
      const found = ending.exec(html);
      const endingClose = found ? html.indexOf('>', found.index) : -1;
      position = endingClose === -1 ? html.length : endingClose + 1;
      continue;
    }
    if (BLOCK_TAGS.has(name)) push('\n');
    else if (name === 'td' || name === 'th') push(' ');
  }
  const text = decodeBasicEntities(parts.join(''))
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}
