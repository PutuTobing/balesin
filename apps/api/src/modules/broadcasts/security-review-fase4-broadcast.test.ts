/**
 * Tes penjaga review keamanan Fase 4 — broadcast, impor berkas (unit, tanpa database)
 * (docs/security-reviews/2026-11-20-fase4-broadcast.md).
 *
 * `it` = regresi. `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN; gagal sekarang).
 */
import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { csvCell } from './broadcasts.service';
import { parseCsv, parseSpreadsheet, parseXlsx } from './recipient-import';

/** ZIP minimal (deflate) untuk XLSX buatan tangan. */
function zip(files: Record<string, string | Buffer>, options: { flags?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const data = deflateRawSync(raw);
    const fileName = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(options.flags ?? 0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(options.flags ?? 0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += 30 + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const timed = (run: () => unknown) => {
  const started = performance.now();
  try {
    run();
  } catch {
    // Galat impor = ditolak; yang diukur hanya lama pemrosesan.
  }
  return performance.now() - started;
};

describe('review keamanan — impor XLSX', () => {
  it('zip bomb (isi terbuka > 40 MB dari berkas kecil) ditolak, bukan dibuka penuh', () => {
    const bomb = zip({ 'xl/worksheets/sheet1.xml': Buffer.alloc(60 * 1024 * 1024, 0x20) });
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);
    expect(() => parseSpreadsheet(bomb)).toThrow(/terlalu besar/);
  });

  it('entitas XML (DOCTYPE/ENTITY) tidak diperluas; hanya entitas bawaan & numerik', () => {
    const sheet =
      '<!DOCTYPE x [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;">]>' +
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>nomor</t></is></c></row>' +
      '<row r="2"><c r="A1" t="inlineStr"><is><t>&b;&#65;&lt;</t></is></c></row>' +
      '</sheetData></worksheet>';
    const rows = parseXlsx(zip({ 'xl/worksheets/sheet1.xml': sheet }), 100);
    expect(rows[1]?.[0]).toBe('&b;A<');
  });

  it('ZIP terenkripsi & .xls lama ditolak', () => {
    expect(() =>
      parseXlsx(zip({ 'xl/worksheets/sheet1.xml': '<row/>' }, { flags: 1 }), 10),
    ).toThrow(/terenkripsi/);
    const xls = Buffer.alloc(16);
    xls.writeUInt32LE(0xe011cfd0, 0);
    expect(() => parseSpreadsheet(xls)).toThrow(/\.xls/);
  });

  it('T1: tag pembuka tanpa penutup (<row>/<si> berulang) tidak memblokir proses (waktu ~linear)', () => {
    // 80.000 `<row>` = 400 KB terbuka (berkas ±1 KB). Budget 40 MB = 100× lebih banyak → jam-an.
    const rows = zip({ 'xl/worksheets/sheet1.xml': '<row>'.repeat(80_000) });
    const shared = zip({
      'xl/worksheets/sheet1.xml': '<row r="1"><c r="A1"><v>1</v></c></row>',
      'xl/sharedStrings.xml': '<si>'.repeat(80_000),
    });
    expect(rows.length).toBeLessThan(5_000);
    expect(timed(() => parseXlsx(rows, 20_000))).toBeLessThan(500);
    expect(timed(() => parseXlsx(shared, 20_000))).toBeLessThan(500);
  });
});

describe('review keamanan — CSV', () => {
  it('kutip tidak tertutup / baris raksasa diproses linear', () => {
    const unclosed = Buffer.from(`nomor\n"${'a'.repeat(4_000_000)}`);
    expect(timed(() => parseCsv(unclosed, 20_000))).toBeLessThan(2_000);
    const manyQuotes = Buffer.from(`nomor\n${'"",'.repeat(1_000_000)}`);
    expect(timed(() => parseCsv(manyQuotes, 20_000))).toBeLessThan(2_000);
  });

  it('ekspor: sel diawali = + - @ TAB CR diberi kutip tunggal', () => {
    for (const value of ['=1+1', '+62', '-5', '@SUM(A1)', '\t=1', '\r=1']) {
      expect(csvCell(value).replace(/^"/, '').startsWith("'")).toBe(true);
    }
  });
});
