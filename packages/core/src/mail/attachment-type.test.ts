import { describe, expect, it } from 'vitest';

import { classifyOutboundEmailAttachment } from './attachment-type';

const bytes = (...values: number[]) => Buffer.from(values);
const text = (value: string) => Buffer.from(value, 'utf8');
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);

/** ZIP minimal dengan direktori pusat berisi `names` (cukup untuk pemeriksaan wadah Office). */
function zipWith(names: string[]): Buffer {
  const local = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array<number>(26).fill(0)]);
  const entries = names.map((name) => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(Buffer.byteLength(name), 28);
    return Buffer.concat([header, Buffer.from(name)]);
  });
  const central = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

describe('classifyOutboundEmailAttachment', () => {
  it('kosong → empty', () => {
    expect(classifyOutboundEmailAttachment(Buffer.alloc(0), 'a.pdf')).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it.each([
    ['PDF', text('%PDF-1.7\n...'), 'invoice.pdf', 'application/pdf', false, 'invoice.pdf'],
    ['PNG', PNG, 'stempel.png', 'image/png', true, 'stempel.png'],
    ['JPEG', bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10), 'foto.jpg', 'image/jpeg', true, 'foto.jpg'],
    ['GIF', text('GIF89a\x01\x00\x01\x00'), 'animasi.gif', 'image/gif', true, 'animasi.gif'],
    ['BMP', text('BM\x00\x00\x00\x00'), 'gambar.bmp', 'image/bmp', false, 'gambar.bmp'],
    ['TIFF', bytes(0x49, 0x49, 0x2a, 0x00, 8, 0), 'scan.tif', 'image/tiff', false, 'scan.tif'],
    ['CSV', text('id,total\nPLG-1,185000\n'), 'tagihan.csv', 'text/csv', false, 'tagihan.csv'],
    ['TXT', text('Terima kasih.\n'), 'catatan.txt', 'text/plain', false, 'catatan.txt'],
    // Review 9.1 R2: ekstensi dipaksa sesuai jenis isi.
    ['teks lain', text('nama: Budi\n'), 'catatan.log', 'text/plain', false, 'catatan.txt'],
    ['tanpa ekstensi', text('%PDF-1.4'), 'invoice', 'application/pdf', false, 'invoice.pdf'],
  ])('%s diizinkan', (_label, content, filename, mimeType, rasterImage, finalName) => {
    expect(classifyOutboundEmailAttachment(content, filename)).toEqual({
      ok: true,
      mimeType,
      rasterImage,
      filename: finalName,
    });
  });

  it.each([
    ['biner tak dikenal', bytes(0x00, 0x01, 0x02, 0x03, 0xfe), 'data.bin'],
    ['audio', text('ID3\x03\x00'), 'lagu.mp3'],
    ['OneNote', bytes(0xe4, 0x52, 0x5c, 0x7b, 0x8c, 0xd8), 'tagihan.one'],
  ])('review 9.1 R2: %s di luar daftar izin → ditolak', (_label, content, filename) => {
    expect(classifyOutboundEmailAttachment(content, filename)).toEqual({
      ok: false,
      reason: 'blocked',
    });
  });

  it('nama berkas tidak menentukan jenis (PDF bernama .png tetap PDF)', () => {
    expect(classifyOutboundEmailAttachment(text('%PDF-1.4'), 'gambar.png')).toMatchObject({
      ok: true,
      mimeType: 'application/pdf',
      rasterImage: false,
      filename: 'gambar.pdf',
    });
  });

  it('DOCX tanpa makro diizinkan', () => {
    const docx = zipWith(['[Content_Types].xml', 'word/document.xml']);
    expect(classifyOutboundEmailAttachment(docx, 'surat.docx')).toMatchObject({
      ok: true,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });

  it.each([
    ['ekstensi .exe', text('isi apa pun'), 'bayar.exe'],
    ['ekstensi .zip', text('isi'), 'arsip.zip'],
    ['ekstensi .html', text('halo'), 'tagihan.html'],
    ['ekstensi makro .docm', text('x'), 'surat.docm'],
    ['PE (MZ) bernama .pdf', text('MZ\x90\x00'), 'invoice.pdf'],
    ['ELF', bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1), 'program'],
    ['Mach-O', bytes(0xcf, 0xfa, 0xed, 0xfe, 7, 0), 'aplikasi'],
    ['shebang', text('#!/bin/sh\nrm -rf /\n'), 'skrip.txt'],
    ['ZIP biasa bernama .docx', zipWith(['berkas.txt']), 'surat.docx'],
    [
      'ZIP Office bermakro',
      zipWith(['[Content_Types].xml', 'word/document.xml', 'word/vbaProject.bin']),
      'surat.docx',
    ],
    ['ZIP tanpa ekstensi', zipWith(['a.txt']), 'berkas'],
    ['RAR', text('Rar!\x1a\x07\x01\x00'), 'berkas'],
    ['7z', bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4), 'berkas'],
    ['gzip', bytes(0x1f, 0x8b, 8, 0), 'berkas'],
    ['bzip2', text('BZh91AY'), 'berkas'],
    ['xz', bytes(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00), 'berkas'],
    ['CAB', text('MSCF\x00\x00\x00\x00'), 'berkas'],
    ['LNK', bytes(0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0x00, 0, 0), 'pintasan'],
    ['OLE bukan Office', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0), 'berkas.msg'],
    // Review 9.1 R2b: Office format lama (CFB) selalu ditolak, juga tanpa penanda makro.
    ['.doc format lama', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0), 'surat.doc'],
    ['.xls format lama', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0), 'data.xls'],
    ['.ppt format lama', bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0), 'slide.ppt'],
    [
      'CFB bernama .pdf',
      bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0),
      'invoice.pdf',
    ],
    ['HTML', text('  <!DOCTYPE html><html><body>x</body></html>'), 'tagihan.txt'],
    [
      'HTML ber-BOM',
      text(`${String.fromCharCode(0xfeff)}<html><script>alert(1)</script></html>`),
      'berkas',
    ],
    ['SVG', text('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'logo.txt'],
    ['XML berisi SVG', text('<?xml version="1.0"?>\n<svg></svg>'), 'gambar'],
    ['skrip', text('<script>alert(1)</script>'), 'catatan.csv'],
  ])('%s ditolak', (_label, content, filename) => {
    expect(classifyOutboundEmailAttachment(content, filename)).toEqual({
      ok: false,
      reason: 'blocked',
    });
  });

  it('citra disk ISO 9660 ditolak dari isinya', () => {
    const iso = Buffer.alloc(0x8006);
    iso.write('CD001', 0x8001, 'latin1');
    expect(classifyOutboundEmailAttachment(iso, 'data.bin')).toEqual({
      ok: false,
      reason: 'blocked',
    });
  });
});
