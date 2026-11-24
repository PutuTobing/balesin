import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { crc16CcittFalse, encodeGrayscalePng, renderQrPng, validateQrisPayload } from './qris';

/** Contoh A docs/KONTRAK-API-EMAIL-KIRIM.md §12 (data fiktif, CRC `5195` valid). */
const SAMPLE =
  '00020101021226680016ID.CO.CONTOH.WWW01189360000000000000010215ID10200000000010303UMI52044899530336054061850005802ID5911TOKO CONTOH6007JAKARTA61051234563045195';

/** Payload sah buatan tes: isi elemen + `6304` + CRC yang dihitung. */
function withCrc(body: string): string {
  const head = `${body}6304`;
  return `${head}${crc16CcittFalse(head)}`;
}

function pngInfo(png: Buffer) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  return { width, height, raw: inflateSync(Buffer.concat(idat)) };
}

describe('CRC-16/CCITT-FALSE', () => {
  it('nilai uji baku "123456789" → 29B1', () => {
    expect(crc16CcittFalse('123456789')).toBe('29B1');
  });
  it('selalu 4 hex huruf besar', () => {
    expect(crc16CcittFalse('')).toBe('FFFF');
    expect(crc16CcittFalse('A')).toMatch(/^[0-9A-F]{4}$/);
  });
});

describe('validateQrisPayload', () => {
  it('contoh A kontrak valid', () => {
    expect(validateQrisPayload(SAMPLE)).toEqual({ ok: true });
  });

  it('CRC huruf kecil tetap diterima', () => {
    const payload = withCrc('000201010211520448995303360540410005802ID');
    expect(validateQrisPayload(payload.slice(0, -4) + payload.slice(-4).toLowerCase())).toEqual({
      ok: true,
    });
  });

  it('CRC rusak (5195 → 5196) → qris_crc_mismatch', () => {
    expect(validateQrisPayload(`${SAMPLE.slice(0, -4)}5196`)).toEqual({
      ok: false,
      reason: 'qris_crc_mismatch',
    });
  });

  it('isi diubah tanpa menghitung ulang CRC → qris_crc_mismatch', () => {
    expect(validateQrisPayload(SAMPLE.replace('185000', '185001'))).toEqual({
      ok: false,
      reason: 'qris_crc_mismatch',
    });
  });

  it.each([
    ['terlalu pendek', '000201010211'],
    ['terlalu panjang', withCrc(`000201${'5999'}${'X'.repeat(99)}`.padEnd(520, '0'))],
    ['karakter non-ASCII', withCrc('0002010102115911TOKO CONTÖH')],
    ['karakter kendali', withCrc('000201010211591\nTOKO CONTOH')],
    ['tidak diawali 000201', withCrc('000202010211520448995303360')],
    ['panjang TLV melewati akhir', `${SAMPLE.slice(0, -8)}6399ABCD`],
    ['sisa byte setelah TLV terakhir', `${SAMPLE}0`],
    [
      'elemen terakhir bukan 63',
      withCrc('0002010102115204489953033605802ID').replace(/6304/, '6404'),
    ],
    ['panjang CRC bukan 04', `${SAMPLE.slice(0, -8)}630351950`],
    ['CRC bukan hex', `${SAMPLE.slice(0, -4)}51ZZ`],
    ['ID bukan angka', withCrc('000201AB0211520448995303360')],
    ['terpotong', SAMPLE.slice(0, -2)],
  ])('%s → qris_invalid_format', (_label, payload) => {
    expect(validateQrisPayload(payload)).toEqual({ ok: false, reason: 'qris_invalid_format' });
  });
});

describe('PNG & kode QR', () => {
  it('encodeGrayscalePng menghasilkan PNG yang bisa didekode ulang', () => {
    const pixels = new Uint8Array([0, 255, 128, 64, 32, 16]);
    const png = encodeGrayscalePng(3, 2, pixels);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const { width, height, raw } = pngInfo(png);
    expect([width, height]).toEqual([3, 2]);
    expect([...raw]).toEqual([0, 0, 255, 128, 0, 64, 32, 16]);
  });

  it('menolak jumlah piksel yang tidak cocok', () => {
    expect(() => encodeGrayscalePng(2, 2, new Uint8Array(3))).toThrow();
  });

  it.each([240, 480, 1024])('renderQrPng %ipx → tepat sizePx × sizePx', (size) => {
    const png = renderQrPng(SAMPLE, size);
    const { width, height, raw } = pngInfo(png);
    expect([width, height]).toEqual([size, size]);
    expect(raw.length).toBe((size + 1) * size);
    // Ada modul gelap dan sudut kiri atas (zona tenang) putih.
    expect(raw.includes(0)).toBe(true);
    expect(raw[1]).toBe(255);
  });
});
