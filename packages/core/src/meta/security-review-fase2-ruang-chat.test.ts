/**
 * Review keamanan Fase 2 butir 6 — deteksi jenis berkas unggahan
 * (docs/security-reviews/2026-11-17-fase2-ruang-chat.md). `it.fails` = temuan yang belum diperbaiki.
 */
import { describe, expect, it } from 'vitest';

import { detectMedia } from './media-sniff';

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

const utf16 = (text: string) => Buffer.from(text, 'utf16le');

describe('penjaga regresi', () => {
  it('ZIP/CFB tanpa ekstensi Office dan berkas tak dikenal tetap ditolak', () => {
    expect(detectMedia(Buffer.from([...ZIP_SIGNATURE, 0x14]), 'pembaruan.apk')).toBeNull();
    expect(detectMedia(Buffer.from(CFB_SIGNATURE), 'setup.msi')).toBeNull();
    expect(detectMedia(Buffer.from('MZ\u0090\u0000'), 'faktur.docx')).toBeNull();
  });
});

describe('R1 — dokumen Office hanya diperiksa tanda tangan wadahnya', () => {
  // ZIP apa pun bernama `.docx/.xlsx/.pptx` dan CFB apa pun bernama `.doc/.xls/.ppt` diterima, lalu
  // dikirim ke pelanggan dari nomor resmi perusahaan. Akun CS curian bisa mengirim arsip berisi
  // program (berkedok .docx) atau dokumen Office lama ber-makro VBA.
  it.fails('ZIP bernama .docx tanpa [Content_Types].xml / word/ ditolak', () => {
    const zip = Buffer.concat([
      Buffer.from(ZIP_SIGNATURE),
      Buffer.alloc(26, 0),
      Buffer.from('payload/setup.exe'),
      Buffer.from('MZ\u0090\u0000'),
    ]);
    expect(detectMedia(zip, 'tagihan.docx')).toBeNull(); // saat ini diterima sebagai Word
  });

  it.fails('dokumen Office lama (CFB) yang memuat proyek makro VBA ditolak', () => {
    const doc = Buffer.concat([
      Buffer.from(CFB_SIGNATURE),
      Buffer.alloc(504, 0),
      utf16('WordDocument'),
      utf16('_VBA_PROJECT'),
      utf16('Macros'),
    ]);
    expect(detectMedia(doc, 'tagihan.doc')).toBeNull(); // saat ini diterima sebagai application/msword
  });
});
