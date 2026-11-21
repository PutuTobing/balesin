import { BROADCAST_LIMITS } from '@balesin/shared';

/**
 * Judul kolom berkas impor, dibaca DI BROWSER sebelum diunggah (API impor kontak butuh pemetaan
 * kolom bersamaan dengan berkasnya). Aturannya meniru parser server (`recipient-import.ts`): baris
 * pertama yang tidak kosong = judul; judul dibersihkan dari karakter kendali, dipotong 64 karakter,
 * judul kosong → `kolom_N`, judul kembar → akhiran `_2`, `_3`.
 *
 * XLSX dibaca tanpa pustaka: ZIP dicari lewat direktori pusatnya, isinya diurai
 * `DecompressionStream('deflate-raw')` dan dihentikan begitu baris pertama ditemukan (berkas besar
 * tidak pernah diurai penuh). Berkas tetap divalidasi penuh oleh server.
 */

export type ColumnReadError = 'too_big' | 'old_excel' | 'unreadable';

export class ColumnReadFailure extends Error {
  constructor(readonly reason: ColumnReadError) {
    super(reason);
    this.name = 'ColumnReadFailure';
  }
}

/** Batas teks yang diurai untuk mencari baris judul (cukup untuk ratusan kolom). */
const SCAN_LIMIT = 512 * 1024;

export async function readImportColumns(file: File): Promise<string[]> {
  if (file.size > BROADCAST_LIMITS.maxFileBytes) throw new ColumnReadFailure('too_big');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) throw new ColumnReadFailure('unreadable');
  const signature = view(bytes).getUint32(0, true);
  if (bytes.length >= 8 && signature === 0xe011cfd0) throw new ColumnReadFailure('old_excel');
  let header: string[] | null;
  try {
    header = signature === 0x04034b50 ? await xlsxHeader(bytes) : csvHeader(bytes);
  } catch {
    header = null;
  }
  if (!header || header.every((cell) => cell.trim() === '')) {
    throw new ColumnReadFailure('unreadable');
  }
  return normalizeColumns(header);
}

/** Judul mentah → nama kolom seperti server. */
export function normalizeColumns(header: readonly string[]): string[] {
  const max = BROADCAST_LIMITS.maxColumnNameLength;
  const columns: string[] = [];
  header.slice(0, BROADCAST_LIMITS.maxColumns).forEach((raw, index) => {
    const base =
      raw
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .trim()
        .slice(0, max) || `kolom_${String(index + 1)}`;
    let name = base;
    let suffix = 2;
    while (columns.includes(name)) {
      name = `${base}_${String(suffix)}`.slice(-max);
      suffix += 1;
    }
    columns.push(name);
  });
  return columns;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ── CSV ─────────────────────────────────────────────────────────────────────

function detectDelimiter(line: string): string {
  let best = ',';
  let bestCount = -1;
  for (const candidate of [',', ';', '\t']) {
    let count = 0;
    let quoted = false;
    for (const character of line) {
      if (character === '"') quoted = !quoted;
      else if (!quoted && character === candidate) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** Baris pertama yang tidak kosong dari CSV (tanda kutip & baris baru di dalam kutip didukung). */
export function csvHeader(bytes: Uint8Array): string[] | null {
  if (bytes.includes(0)) return null;
  let text = new TextDecoder('utf-8').decode(bytes.subarray(0, SCAN_LIMIT));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const newline = text.indexOf('\n');
  const delimiter = detectDelimiter(newline < 0 ? text : text.slice(0, newline));
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"' && field === '') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') return row;
      row = [];
    } else {
      field += character;
    }
  }
  row.push(field);
  return row.length > 1 || row[0] !== '' ? row : null;
}

// ── XLSX ────────────────────────────────────────────────────────────────────

interface ZipEntry {
  method: number;
  compressedSize: number;
  localOffset: number;
}

function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const data = view(bytes);
  // Akhir direktori pusat: dicari mundur (komentar ZIP maks. 64 KB).
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (data.getUint32(index, true) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end < 0) throw new Error('bukan zip');
  const count = data.getUint16(end + 10, true);
  let offset = data.getUint32(end + 16, true);
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder('utf-8');
  for (let index = 0; index < count && offset + 46 <= bytes.length; index += 1) {
    if (data.getUint32(offset, true) !== 0x02014b50) break;
    const nameLength = data.getUint16(offset + 28, true);
    const extraLength = data.getUint16(offset + 30, true);
    const commentLength = data.getUint16(offset + 32, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, {
      method: data.getUint16(offset + 10, true),
      compressedSize: data.getUint32(offset + 20, true),
      localOffset: data.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Isi satu berkas di ZIP sebagai teks, berhenti begitu `stop(teks)` benar atau `SCAN_LIMIT`
 * tercapai — tidak pernah mengurai seluruh lembar kerja yang besar.
 */
async function readEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  stop: (text: string) => boolean,
): Promise<string> {
  const data = view(bytes);
  const local = entry.localOffset;
  if (data.getUint32(local, true) !== 0x04034b50) throw new Error('entri rusak');
  const start = local + 30 + data.getUint16(local + 26, true) + data.getUint16(local + 28, true);
  const raw = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return new TextDecoder('utf-8').decode(raw.subarray(0, SCAN_LIMIT));
  if (entry.method !== 8 || typeof DecompressionStream === 'undefined') {
    throw new Error('kompresi tidak didukung');
  }
  const stream = new Blob([raw.slice()])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (stop(text) || text.length >= SCAN_LIMIT) break;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return text;
}

function decodeXml(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : Number(lower.slice(1));
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });
}

/** Gabungan semua `<t>` di dalam potongan XML (teks kaya = beberapa run). */
function textRuns(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((match) => decodeXml(match[1] ?? ''))
    .join('');
}

function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? '';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

async function firstSheetPath(bytes: Uint8Array, entries: Map<string, ZipEntry>) {
  const workbook = entries.get('xl/workbook.xml');
  const rels = entries.get('xl/_rels/workbook.xml.rels');
  if (workbook && rels) {
    const book = await readEntry(bytes, workbook, (text) => text.includes('</sheets>'));
    const sheetId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(book)?.[1];
    if (sheetId) {
      const relations = await readEntry(bytes, rels, () => false);
      for (const match of relations.matchAll(/<Relationship\b[^>]*>/g)) {
        const tag = match[0];
        if (/\bId="([^"]+)"/.exec(tag)?.[1] !== sheetId) continue;
        const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
        if (target) {
          const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
          if (entries.has(path)) return path;
        }
      }
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

async function xlsxHeader(bytes: Uint8Array): Promise<string[] | null> {
  const entries = zipEntries(bytes);
  const sheet = entries.get(await firstSheetPath(bytes, entries));
  if (!sheet) return null;
  const xml = await readEntry(bytes, sheet, (text) => {
    // Cukup sampai baris pertama yang berisi.
    for (const match of text.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (/<v>|<t[\s>]/.test(match[1] ?? '')) return true;
    }
    return false;
  });
  for (const match of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: { index: number; type: string; raw: string; inner: string }[] = [];
    for (const cell of (match[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1] ?? '';
      const inner = cell[2] ?? '';
      const reference = /\br="([A-Z]{1,3}\d{1,7})"/.exec(attributes)?.[1];
      cells.push({
        index: reference ? columnIndex(reference) : cells.length,
        type: /\bt="([^"]+)"/.exec(attributes)?.[1] ?? 'n',
        raw: /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '',
        inner,
      });
    }
    if (cells.length === 0) continue;
    const sharedNeeded = cells
      .filter((cell) => cell.type === 's')
      .map((cell) => Number(cell.raw))
      .filter((value) => Number.isInteger(value) && value >= 0);
    const shared = sharedNeeded.length > 0 ? await sharedStrings(bytes, entries, sharedNeeded) : [];
    const values: string[] = [];
    for (const cell of cells) {
      if (cell.index < 0 || cell.index > 200) continue;
      let value: string;
      if (cell.type === 's') value = shared[Number(cell.raw)] ?? '';
      else if (cell.type === 'inlineStr') value = textRuns(cell.inner);
      else if (cell.type === 'b')
        value = cell.raw === '1' ? 'TRUE' : cell.raw === '0' ? 'FALSE' : '';
      else if (cell.type === 'e') value = '';
      else value = decodeXml(cell.raw);
      while (values.length < cell.index) values.push('');
      values[cell.index] = value;
    }
    if (values.some((value) => value.trim() !== '')) return values;
  }
  return null;
}

async function sharedStrings(
  bytes: Uint8Array,
  entries: Map<string, ZipEntry>,
  needed: number[],
): Promise<string[]> {
  const entry = entries.get('xl/sharedStrings.xml');
  if (!entry) return [];
  const highest = Math.max(...needed);
  const xml = await readEntry(
    bytes,
    entry,
    (text) => (text.match(/<\/si>/g)?.length ?? 0) > highest,
  );
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => textRuns(match[1] ?? ''));
}
