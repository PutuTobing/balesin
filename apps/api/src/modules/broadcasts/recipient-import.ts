import { inflateRawSync } from 'node:zlib';

import {
  BROADCAST_IMPORT_ISSUES,
  BROADCAST_LIMITS,
  normalizeBroadcastPhone,
  type BroadcastImportIssue,
} from '@balesin/shared';

/**
 * Impor penerima broadcast dari CSV/XLSX (Fase 4) — parser SENDIRI tanpa dependensi baru:
 *  - CSV: RFC 4180 (kutip ganda, baris baru di dalam kutip), pemisah `,`/`;`/tab dideteksi dari baris
 *    judul, BOM UTF-8 dibuang, berkas berisi byte NUL (biner) ditolak.
 *  - XLSX: hanya membaca ZIP (direktori pusat) + `sharedStrings.xml` + lembar PERTAMA. Entri dibuka
 *    dengan batas ukuran hasil (`maxOutputLength`, cegah zip bomb), ZIP64/terenkripsi ditolak, rumus &
 *    makro tidak pernah dijalankan (yang dibaca hanya nilai tersimpan). Angka besar (nomor HP yang
 *    tersimpan sebagai angka) dikembalikan ke digit utuh.
 * Batas: berkas 5 MB, 20.000 penerima, 30 kolom, isian 500 karakter. Semua galat = `ImportError`
 * berpesan Indonesia (tanpa isi berkas).
 */

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ParsedTable {
  /** Judul kolom (sudah dibersihkan & unik). */
  columns: string[];
  /** Baris data (tanpa baris judul), masing-masing dengan nomor baris sumber (judul = 1). */
  rows: { row: number; values: string[] }[];
}

// ── CSV ─────────────────────────────────────────────────────────────────────

function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, Math.max(0, text.indexOf('\n')) || text.length);
  let best = ',';
  let bestCount = -1;
  for (const candidate of [',', ';', '\t']) {
    let count = 0;
    let quoted = false;
    for (const character of firstLine) {
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

export function parseCsv(buffer: Buffer, maxRows: number): string[][] {
  if (buffer.includes(0)) throw new ImportError('Berkas bukan CSV teks (berisi data biner).');
  let text = new TextDecoder('utf-8').decode(buffer);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;
  const pushRow = () => {
    row.push(field);
    field = '';
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
    if (rows.length > maxRows + 1) {
      throw new ImportError(
        `Berkas melebihi ${BROADCAST_LIMITS.maxRecipients.toLocaleString('id-ID')} baris.`,
      );
    }
  };
  while (index < text.length) {
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
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      pushRow();
    } else {
      field += character;
    }
    index += 1;
  }
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

// ── XLSX ────────────────────────────────────────────────────────────────────

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

const u16 = (bytes: Buffer, at: number) => bytes.readUInt16LE(at);
const u32 = (bytes: Buffer, at: number) => bytes.readUInt32LE(at);

function zipEntries(buffer: Buffer): Map<string, ZipEntry> {
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at -= 1) {
    if (u32(buffer, at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ImportError('Berkas Excel rusak (bukan ZIP yang utuh).');
  const count = u16(buffer, end + 10);
  const size = u32(buffer, end + 12);
  const offset = u32(buffer, end + 16);
  if (count === 0xffff || size === 0xffffffff || offset + size > end) {
    throw new ImportError('Berkas Excel tidak didukung (ZIP64 atau rusak).');
  }
  const entries = new Map<string, ZipEntry>();
  let at = offset;
  for (let index = 0; index < count && index < 10_000; index += 1) {
    if (at + 46 > buffer.length || u32(buffer, at) !== 0x02014b50) {
      throw new ImportError('Berkas Excel rusak (direktori ZIP tidak valid).');
    }
    const nameLength = u16(buffer, at + 28);
    const extraLength = u16(buffer, at + 30);
    const commentLength = u16(buffer, at + 32);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    entries.set(name, {
      name,
      flags: u16(buffer, at + 8),
      method: u16(buffer, at + 10),
      compressedSize: u32(buffer, at + 20),
      uncompressedSize: u32(buffer, at + 24),
      localOffset: u32(buffer, at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buffer: Buffer, entry: ZipEntry, budget: { left: number }): string {
  if ((entry.flags & 0x1) !== 0) throw new ImportError('Berkas Excel terenkripsi tidak didukung.');
  const at = entry.localOffset;
  if (at + 30 > buffer.length || u32(buffer, at) !== 0x04034b50) {
    throw new ImportError('Berkas Excel rusak.');
  }
  const start = at + 30 + u16(buffer, at + 26) + u16(buffer, at + 28);
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new ImportError('Berkas Excel rusak.');
  let output: Buffer;
  if (entry.method === 0) {
    output = data;
  } else if (entry.method === 8) {
    try {
      output = inflateRawSync(data, { maxOutputLength: Math.max(1, budget.left) });
    } catch {
      throw new ImportError('Berkas Excel terlalu besar setelah dibuka atau rusak.');
    }
  } else {
    throw new ImportError('Kompresi berkas Excel tidak didukung.');
  }
  budget.left -= output.length;
  if (budget.left < 0) throw new ImportError('Berkas Excel terlalu besar setelah dibuka.');
  return output.toString('utf8');
}

// ── Pemindai XML LINEAR (review broadcast T1) ───────────────────────────────
//
// Tanpa regex `[\s\S]*?` atas isi berkas: tag pembuka tanpa penutup membuat regex seperti itu memindai
// sampai akhir teks UNTUK SETIAP tag (O(n²), berkas 40 KB bisa membekukan proses berjam-jam). Pemindai
// di bawah hanya maju dengan `indexOf` (setiap posisi teks dibaca paling banyak beberapa kali) dan
// MENOLAK berkas bila sebuah tag tidak tertutup.

const BROKEN_XML =
  'Berkas Excel rusak (struktur XML tidak lengkap). Simpan ulang dari Excel lalu coba lagi.';

function isTagBoundary(code: number): boolean {
  // `>`, `/`, spasi, tab, baris baru — supaya `<c` tidak cocok dengan `<col`, `<row` dengan `<rowBreaks`.
  return code === 62 || code === 47 || code === 32 || code === 9 || code === 10 || code === 13;
}

/** Setiap elemen `<name …>…</name>` / `<name …/>` di `xml`, berurutan. Elemen sejenis tidak bersarang. */
function* xmlElements(xml: string, name: string): Generator<{ attributes: string; inner: string }> {
  const open = `<${name}`;
  const close = `</${name}>`;
  let position = 0;
  for (;;) {
    const at = xml.indexOf(open, position);
    if (at < 0) return;
    if (!isTagBoundary(xml.charCodeAt(at + open.length))) {
      position = at + open.length;
      continue;
    }
    const tagEnd = xml.indexOf('>', at + open.length);
    if (tagEnd < 0) throw new ImportError(BROKEN_XML);
    const selfClosing = xml.charCodeAt(tagEnd - 1) === 47;
    const attributes = xml.slice(at + open.length, selfClosing ? tagEnd - 1 : tagEnd);
    if (selfClosing) {
      yield { attributes, inner: '' };
      position = tagEnd + 1;
      continue;
    }
    const closeAt = xml.indexOf(close, tagEnd + 1);
    if (closeAt < 0) throw new ImportError(BROKEN_XML);
    yield { attributes, inner: xml.slice(tagEnd + 1, closeAt) };
    position = closeAt + close.length;
  }
}

/** Nilai atribut `name="…"` (linear; tanpa kutip penutup = tidak ada). */
function attributeValue(attributes: string, name: string): string | undefined {
  const key = `${name}="`;
  let position = 0;
  for (;;) {
    const at = attributes.indexOf(key, position);
    if (at < 0) return undefined;
    const before = at === 0 ? 32 : attributes.charCodeAt(at - 1);
    if (before === 32 || before === 9 || before === 10 || before === 13) {
      const end = attributes.indexOf('"', at + key.length);
      return end < 0 ? undefined : attributes.slice(at + key.length, end);
    }
    position = at + key.length;
  }
}

function firstElementText(xml: string, name: string): string | undefined {
  for (const element of xmlElements(xml, name)) return element.inner;
  return undefined;
}

const ENTITY = /&(lt|gt|amp|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g;
function decodeXml(text: string): string {
  return text.replace(ENTITY, (_whole, name: string) => {
    switch (name) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code = name.startsWith('#x')
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }
    }
  });
}

/** Teks semua `<t>` di dalam `<si>`/`<is>` (rich text = beberapa run). */
function textRuns(xml: string): string {
  let text = '';
  for (const run of xmlElements(xml, 't')) text += run.inner;
  return decodeXml(text);
}

function columnIndex(reference: string): number {
  let index = 0;
  for (const letter of reference) {
    const code = letter.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

/** Nilai angka tersimpan → teks (angka bulat besar seperti nomor HP dikembalikan ke digit utuh). */
function numberText(raw: string): string {
  const value = Number(raw);
  if (Number.isFinite(value) && Number.isInteger(value) && Math.abs(value) < 1e15) {
    return String(value);
  }
  return raw;
}

function firstSheetPath(entries: Map<string, ZipEntry>, buffer: Buffer, budget: { left: number }) {
  const workbook = entries.get('xl/workbook.xml');
  const rels = entries.get('xl/_rels/workbook.xml.rels');
  if (workbook && rels) {
    let sheetId: string | undefined;
    for (const sheet of xmlElements(readEntry(buffer, workbook, budget), 'sheet')) {
      sheetId = attributeValue(sheet.attributes, 'r:id');
      break;
    }
    if (sheetId) {
      for (const relation of xmlElements(readEntry(buffer, rels, budget), 'Relationship')) {
        if (attributeValue(relation.attributes, 'Id') !== sheetId) continue;
        const target = attributeValue(relation.attributes, 'Target');
        if (target) {
          const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
          if (entries.has(path)) return path;
        }
      }
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

export function parseXlsx(buffer: Buffer, maxRows: number): string[][] {
  const entries = zipEntries(buffer);
  const budget = { left: BROADCAST_LIMITS.maxXlsxUncompressedBytes };
  const sheetPath = firstSheetPath(entries, buffer, budget);
  const sheetEntry = entries.get(sheetPath);
  if (!sheetEntry) throw new ImportError('Lembar kerja pertama tidak ditemukan di berkas Excel.');
  const shared: string[] = [];
  const sharedEntry = entries.get('xl/sharedStrings.xml');
  if (sharedEntry) {
    for (const item of xmlElements(readEntry(buffer, sharedEntry, budget), 'si')) {
      shared.push(textRuns(item.inner));
    }
  }
  const sheet = readEntry(buffer, sheetEntry, budget);
  const rows: string[][] = [];
  for (const row of xmlElements(sheet, 'row')) {
    const values: string[] = [];
    for (const cell of xmlElements(row.inner, 'c')) {
      const reference = attributeValue(cell.attributes, 'r');
      const type = attributeValue(cell.attributes, 't') ?? 'n';
      const raw = firstElementText(cell.inner, 'v');
      let value: string;
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = textRuns(cell.inner);
      else if (type === 'str') value = decodeXml(raw ?? '');
      else if (type === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : '';
      else if (type === 'e') value = '';
      else value = raw === undefined ? '' : numberText(decodeXml(raw));
      const index =
        reference && /^[A-Z]{1,3}\d{1,7}$/.test(reference) ? columnIndex(reference) : values.length;
      if (index < 0 || index > 200) continue;
      while (values.length < index) values.push('');
      values[index] = value;
    }
    if (values.some((value) => value.trim() !== '')) rows.push(values);
    if (rows.length > maxRows + 1) {
      throw new ImportError(
        `Berkas melebihi ${BROADCAST_LIMITS.maxRecipients.toLocaleString('id-ID')} baris.`,
      );
    }
  }
  return rows;
}

/** Jenis berkas dari isinya (bukan nama): ZIP = XLSX, selain itu CSV teks. */
export function parseSpreadsheet(buffer: Buffer): string[][] {
  if (buffer.length === 0) throw new ImportError('Berkas kosong.');
  if (buffer.length > BROADCAST_LIMITS.maxFileBytes) {
    throw new ImportError('Berkas terlalu besar (maks. 5 MB).');
  }
  const isZip = buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50;
  if (!isZip && buffer.length >= 8 && buffer.readUInt32LE(0) === 0xe011cfd0) {
    throw new ImportError(
      'Format Excel lama (.xls) tidak didukung. Simpan sebagai .xlsx atau .csv.',
    );
  }
  return isZip
    ? parseXlsx(buffer, BROADCAST_LIMITS.maxRecipients)
    : parseCsv(buffer, BROADCAST_LIMITS.maxRecipients);
}

// ── Tabel → penerima ────────────────────────────────────────────────────────

/** Baris pertama = judul. Judul kosong → `kolom_N`; judul kembar diberi akhiran `_2`, `_3`. */
export function toTable(matrix: string[][]): ParsedTable {
  const [header, ...body] = matrix;
  if (!header || header.every((cell) => cell.trim() === '')) {
    throw new ImportError('Baris pertama harus berisi judul kolom (mis. nomor, nama, tagihan).');
  }
  const width = Math.max(header.length, ...body.map((row) => row.length));
  if (width > BROADCAST_LIMITS.maxColumns) {
    throw new ImportError(`Berkas punya lebih dari ${BROADCAST_LIMITS.maxColumns} kolom.`);
  }
  const columns: string[] = [];
  for (let index = 0; index < width; index += 1) {
    const base =
      (header[index] ?? '')
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .trim()
        .slice(0, BROADCAST_LIMITS.maxColumnNameLength) || `kolom_${String(index + 1)}`;
    let name = base;
    let suffix = 2;
    while (columns.includes(name)) {
      name = `${base}_${String(suffix)}`.slice(-BROADCAST_LIMITS.maxColumnNameLength);
      suffix += 1;
    }
    columns.push(name);
  }
  if (body.length === 0) throw new ImportError('Berkas tidak berisi data penerima.');
  return {
    columns,
    rows: body.map((values, index) => ({ row: index + 2, values })),
  };
}

const PHONE_HEADER =
  /^(no|nomor|nomer|phone|telepon|telpon|telp|tlp|hp|nohp|nowa|wa|whatsapp|handphone|mobile|msisdn|ponsel|nomorhp|nomorwa|nomorwhatsapp|nomortelepon|phonenumber|nohandphone|notelp|notelepon)$/;

/** Kolom nomor: dari nama judul, lalu dari isi (≥ 60% contoh lolos normalisasi). */
export function detectPhoneColumn(table: ParsedTable): string | null {
  const byName = table.columns.find((column) =>
    PHONE_HEADER.test(column.toLowerCase().replace(/[^a-z]/g, '')),
  );
  if (byName) return byName;
  const sample = table.rows.slice(0, 50);
  for (let index = 0; index < table.columns.length; index += 1) {
    const values = sample.map((row) => row.values[index] ?? '').filter((value) => value.trim());
    if (values.length === 0) continue;
    const ok = values.filter((value) => normalizeBroadcastPhone(value).ok).length;
    if (ok / values.length >= 0.6) return table.columns[index] ?? null;
  }
  return null;
}

export interface ImportedRecipient {
  row: number;
  phone: string;
  data: Record<string, string>;
}

export interface ImportResult {
  recipients: ImportedRecipient[];
  issues: { row: number; issue: BroadcastImportIssue }[];
  issueCounts: Record<BroadcastImportIssue, number>;
  sourceRows: number;
}

/** Saring baris → penerima (nomor E.164 unik per kampanye) + laporan baris bermasalah. */
export function buildRecipients(table: ParsedTable, phoneColumn: string): ImportResult {
  const phoneIndex = table.columns.indexOf(phoneColumn);
  if (phoneIndex < 0) throw new ImportError('Kolom nomor tidak ditemukan.');
  const issueCounts = Object.fromEntries(
    BROADCAST_IMPORT_ISSUES.map((issue) => [issue, 0]),
  ) as Record<BroadcastImportIssue, number>;
  const issues: ImportResult['issues'] = [];
  const recipients: ImportedRecipient[] = [];
  const seen = new Set<string>();
  const report = (row: number, issue: BroadcastImportIssue) => {
    issueCounts[issue] += 1;
    if (issues.length < BROADCAST_LIMITS.issuesReported) issues.push({ row, issue });
  };
  for (const { row, values } of table.rows) {
    if (values.some((value) => value.length > BROADCAST_LIMITS.maxValueLength)) {
      report(row, 'value_too_long');
      continue;
    }
    const phone = normalizeBroadcastPhone(values[phoneIndex]);
    if (!phone.ok) {
      report(row, phone.issue);
      continue;
    }
    if (seen.has(phone.phone)) {
      report(row, 'duplicate');
      continue;
    }
    seen.add(phone.phone);
    if (recipients.length >= BROADCAST_LIMITS.maxRecipients) {
      throw new ImportError(
        `Penerima melebihi ${BROADCAST_LIMITS.maxRecipients.toLocaleString('id-ID')}.`,
      );
    }
    const data: Record<string, string> = {};
    table.columns.forEach((column, index) => {
      const value = (values[index] ?? '').replace(/[\p{Cc}]/gu, ' ').trim();
      if (value !== '') data[column] = value;
    });
    recipients.push({ row, phone: phone.phone, data });
  }
  return { recipients, issues, issueCounts, sourceRows: table.rows.length };
}
