import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { jsonItemsToTable } from './connector-source';
import { csvCell } from './broadcasts.service';
import {
  ImportError,
  buildRecipients,
  detectPhoneColumn,
  parseCsv,
  parseSpreadsheet,
  toTable,
} from './recipient-import';

/** ZIP minimal (deflate) — cukup untuk pembaca XLSX Balesin (CRC tidak diperiksa). */
function zip(entries: Record<string, string | Buffer>, options: { stored?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const data = options.stored ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(options.stored ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(options.stored ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

function xlsx(sheet: string, shared: string[] = []): Buffer {
  return zip({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml':
      '<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst>${shared.map((text) => `<si><t>${text}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
  });
}

describe('CSV', () => {
  it('pemisah titik koma, kutip ganda, baris baru dalam kutip, BOM, baris kosong', () => {
    const rows = parseCsv(
      Buffer.from(
        '\ufeffnama;nomor;catatan\r\n"Budi; S";0812 3456 7890;"baris1\nbaris2"\r\n\r\nSari;"6281234567891";"kata ""kutip"""\n',
      ),
      100,
    );
    expect(rows).toEqual([
      ['nama', 'nomor', 'catatan'],
      ['Budi; S', '0812 3456 7890', 'baris1\nbaris2'],
      ['Sari', '6281234567891', 'kata "kutip"'],
    ]);
  });

  it('berkas biner / .xls lama / terlalu besar ditolak dengan pesan Indonesia', () => {
    expect(() => parseCsv(Buffer.from([0x61, 0x00, 0x62]), 10)).toThrow(ImportError);
    const xls = Buffer.alloc(16);
    xls.writeUInt32LE(0xe011cfd0, 0);
    expect(() => parseSpreadsheet(xls)).toThrow(/xls/);
    expect(() => parseSpreadsheet(Buffer.alloc(6 * 1024 * 1024, 0x61))).toThrow(/5 MB/);
    expect(() => parseSpreadsheet(Buffer.alloc(0))).toThrow(/kosong/);
  });
});

describe('XLSX', () => {
  it('string bersama, string sebaris, angka besar → digit utuh, sel kosong dilompati', () => {
    const buffer = xlsx(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>tagihan</t></is></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>6.2812345678900003E+12</v></c><c r="C2" t="str"><v>Rp150.000 &amp; denda</v></c></row>' +
        '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3"><v>81234567891</v></c></row>' +
        '<row r="4"/>',
      ['nama', 'nomor', 'Budi', 'Sari'],
    );
    expect(parseSpreadsheet(buffer)).toEqual([
      ['nama', 'nomor', 'tagihan'],
      ['Budi', '6281234567890', 'Rp150.000 & denda'],
      ['Sari', '', '81234567891'],
    ]);
  });

  it('zip bomb (isi terlalu besar setelah dibuka) ditolak', () => {
    const huge = `<row r="1"><c r="A1" t="inlineStr"><is><t>${'a'.repeat(45 * 1024 * 1024)}</t></is></c></row>`;
    expect(() => parseSpreadsheet(xlsx(huge))).toThrow(/terlalu besar/);
  });

  it('ZIP rusak ditolak', () => {
    const buffer = Buffer.alloc(40);
    buffer.writeUInt32LE(0x04034b50, 0);
    expect(() => parseSpreadsheet(buffer)).toThrow(ImportError);
  });
});

describe('tabel → penerima', () => {
  it('judul unik, kolom nomor dideteksi dari nama/isi, masalah per baris dilaporkan', () => {
    const table = toTable([
      ['Nama', 'No. HP', 'Nama', ''],
      ['Budi', '0812-3456-7890', 'B', 'x'],
      ['Sari', '081234567890', 'S', ''],
      ['Tono', '6,28E+12', '', ''],
      ['Ani', '123', '', ''],
      ['Dedi', '', '', ''],
      ['Eko', '6281234567899', 'a'.repeat(501), ''],
      ['Fajar', '6281234567898', '', ''],
    ]);
    expect(table.columns).toEqual(['Nama', 'No. HP', 'Nama_2', 'kolom_4']);
    expect(detectPhoneColumn(table)).toBe('No. HP');
    const result = buildRecipients(table, 'No. HP');
    expect(result.recipients.map((recipient) => [recipient.row, recipient.phone])).toEqual([
      [2, '+6281234567890'],
      [8, '+6281234567898'],
    ]);
    expect(result.recipients[0]?.data).toEqual({
      Nama: 'Budi',
      'No. HP': '0812-3456-7890',
      Nama_2: 'B',
      kolom_4: 'x',
    });
    expect(result.issues).toEqual([
      { row: 3, issue: 'duplicate' },
      { row: 4, issue: 'phone_scientific' },
      { row: 5, issue: 'phone_invalid' },
      { row: 6, issue: 'phone_missing' },
      { row: 7, issue: 'value_too_long' },
    ]);
    expect(result.sourceRows).toBe(7);
  });

  it('kolom nomor tanpa judul dikenali dari isinya; tanpa data / tanpa judul ditolak', () => {
    const table = toTable([
      ['pelanggan', 'kontak'],
      ['A', '081234567890'],
      ['B', '081234567891'],
    ]);
    expect(detectPhoneColumn(table)).toBe('kontak');
    expect(() => toTable([['a', 'b']])).toThrow(/tidak berisi data/);
    expect(() => toTable([['', '']])).toThrow(/judul kolom/);
    expect(() => toTable([Array.from({ length: 31 }, (_, index) => `k${String(index)}`)])).toThrow(
      /30 kolom/,
    );
  });
});

describe('konektor & CSV keluar', () => {
  it('JSON di jalur data → tabel kolom primitif', () => {
    const parsed = jsonItemsToTable(
      {
        data: {
          items: [
            { hp: '0812', nama: 'A', alamat: { kota: 'x' }, aktif: true },
            { hp: 62, nama: null },
          ],
        },
      },
      'data.items',
    );
    expect(parsed).toEqual({
      ok: true,
      table: {
        columns: ['hp', 'nama', 'aktif'],
        rows: [
          { row: 1, values: ['0812', 'A', 'true'] },
          { row: 2, values: ['62', '', ''] },
        ],
      },
    });
    expect(jsonItemsToTable({ data: {} }, 'data.items')).toEqual({
      ok: false,
      code: 'items_not_found',
    });
    // Kunci warisan prototipe (bukan milik objek) tidak pernah diikuti.
    expect(jsonItemsToTable({}, 'constructor')).toEqual({ ok: false, code: 'items_not_found' });
  });

  it('sel CSV kebal injeksi rumus', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+6281234')).toBe("'+6281234");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@a')).toBe("'@a");
    expect(csvCell('biasa')).toBe('biasa');
    expect(csvCell(null)).toBe('');
  });
});
