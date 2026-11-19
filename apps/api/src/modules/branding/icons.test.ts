/**
 * Ikon dari logo organisasi (Fase 7 white-label): ukuran, transparansi, latar ikon penuh, dan
 * pertahanan dekoder (format tidak cocok, dimensi raksasa, berkas rusak).
 */
import { deflateSync } from 'node:zlib';

import { BRAND_DARK_TEXT, BRAND_ICONS, LOGO_MAX_DIMENSION } from '@balesin/shared';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { LogoImageError, inspectLogoImage, opaqueBackgroundFor, renderBrandIcons } from './icons';
import { prepareLogoUpload } from './logo';

async function solidPng(
  width: number,
  height: number,
  background: { r: number; g: number; b: number; alpha: number },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background } })
    .png()
    .toBuffer();
}

/** PNG kecil (beberapa KB) yang mengaku berdimensi raksasa: "bom dekompresi". */
function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function hugePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // kedalaman bit
  header[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(1024))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('renderBrandIcons', () => {
  it('membuat semua ikon PNG persegi sesuai ukuran; ikon penuh tanpa alfa, ikon biasa transparan', async () => {
    const logo = await solidPng(300, 120, { r: 17, g: 103, b: 216, alpha: 1 });
    const icons = await renderBrandIcons(logo);
    expect(icons.map((icon) => icon.file)).toEqual(BRAND_ICONS.map((icon) => icon.file));

    for (const spec of BRAND_ICONS) {
      const icon = icons.find((item) => item.file === spec.file)!;
      const meta = await sharp(icon.data).metadata();
      expect(meta.format, spec.file).toBe('png');
      expect([meta.width, meta.height], spec.file).toEqual([spec.size, spec.size]);
      expect(meta.hasAlpha, spec.file).toBe(!spec.opaque);
    }

    // Logo melebar → ikon biasa: sudut atas transparan (logo dipusatkan, tidak diregangkan).
    const icon192 = icons.find((icon) => icon.file === 'icon-192.png')!;
    const { data } = await sharp(icon192.data).raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);

    // Maskable: logo di zona aman → tepi ikon = latar putih (logo gelap), bukan warna logo.
    const maskable = icons.find((icon) => icon.file === 'maskable-512.png')!;
    const corner = await sharp(maskable.data)
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect([...corner]).toEqual([255, 255, 255]);
    const centre = await sharp(maskable.data)
      .extract({ left: 256, top: 256, width: 1, height: 1 })
      .raw()
      .toBuffer();
    expect([...centre]).toEqual([17, 103, 216]);
  });

  it('logo terang (mis. putih untuk header gelap) → latar ikon penuh gelap supaya tetap terlihat', async () => {
    const white = await solidPng(64, 64, { r: 255, g: 255, b: 255, alpha: 1 });
    expect(await opaqueBackgroundFor(white)).toBe(BRAND_DARK_TEXT);
    const dark = await solidPng(64, 64, { r: 20, g: 32, b: 46, alpha: 1 });
    expect(await opaqueBackgroundFor(dark)).toBe('#ffffff');
    // Bagian transparan tidak dihitung.
    const transparent = await solidPng(64, 64, { r: 255, g: 255, b: 255, alpha: 0 });
    expect(await opaqueBackgroundFor(transparent)).toBe('#ffffff');
  });

  it('metadata berkas asli (EXIF) tidak ikut ke ikon', async () => {
    const withExif = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#123456' },
    })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'Rahasia lokasi' } })
      .toBuffer();
    const [icon] = await renderBrandIcons(withExif);
    const meta = await sharp(icon!.data).metadata();
    expect(meta.exif).toBeUndefined();
  });
});

describe('inspectLogoImage', () => {
  it('menerima gambar sah dan mengembalikan dimensinya', async () => {
    const png = await solidPng(40, 20, { r: 0, g: 0, b: 0, alpha: 1 });
    expect(await inspectLogoImage(png, 'image/png')).toEqual({
      width: 40,
      height: 20,
      palette: false,
    });
  });

  it('menolak dimensi di atas batas walau berkasnya kecil (bom dekompresi)', async () => {
    const bomb = hugePng(LOGO_MAX_DIMENSION + 1, 50_000);
    expect(bomb.length).toBeLessThan(4096);
    await expect(inspectLogoImage(bomb, 'image/png')).rejects.toMatchObject({
      reason: 'too_large',
    });
  });

  it('menolak format yang tidak cocok dan berkas rusak', async () => {
    const png = await solidPng(8, 8, { r: 0, g: 0, b: 0, alpha: 1 });
    await expect(inspectLogoImage(png, 'image/webp')).rejects.toBeInstanceOf(LogoImageError);
    const truncated = png.subarray(0, 20);
    await expect(inspectLogoImage(truncated, 'image/png')).rejects.toBeInstanceOf(LogoImageError);
  });
});

describe('prepareLogoUpload', () => {
  it('yang disimpan = olah ulang format sama tanpa EXIF/XMP/ICC dan tanpa data sisipan (review merek B5)', async () => {
    const cases = [
      [
        'image/png',
        sharp({ create: { width: 48, height: 24, channels: 4, background: '#0b5394' } }).png(),
      ],
      [
        'image/webp',
        sharp({ create: { width: 48, height: 24, channels: 4, background: '#0b5394' } }).webp(),
      ],
      [
        'image/jpeg',
        sharp({ create: { width: 48, height: 24, channels: 3, background: '#0b5394' } }).jpeg(),
      ],
    ] as const;
    for (const [contentType, pipeline] of cases) {
      const original = await pipeline
        .withExif({ IFD0: { Copyright: 'Lokasi rahasia' } })
        .withIccProfile('p3')
        .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>')
        .toBuffer();
      const withTrailer = Buffer.concat([original, Buffer.from('<svg onload="alert(1)"/>')]);
      const prepared = await prepareLogoUpload(
        { contentType, dataBase64: withTrailer.toString('base64') },
        'logo',
      );
      const meta = await sharp(prepared.data).metadata();
      expect(meta.format, contentType).toBe(contentType.split('/')[1]);
      expect([meta.width, meta.height], contentType).toEqual([48, 24]);
      expect(meta.exif, contentType).toBeUndefined();
      expect(meta.xmp, contentType).toBeUndefined();
      expect(meta.icc, contentType).toBeUndefined();
      expect(prepared.data.includes(Buffer.from('<svg')), contentType).toBe(false);
      expect(prepared.data.includes(Buffer.from('Lokasi rahasia')), contentType).toBe(false);
    }
  });

  it('logo sah → data, sha256, dimensi, dan enam ikon', async () => {
    const png = await solidPng(64, 64, { r: 11, g: 83, b: 148, alpha: 1 });
    const prepared = await prepareLogoUpload(
      { contentType: 'image/png', dataBase64: png.toString('base64') },
      'logo',
    );
    expect(prepared).toMatchObject({ contentType: 'image/png', width: 64, height: 64 });
    expect(prepared.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.icons).toHaveLength(BRAND_ICONS.length);
  });

  it.each([
    ['dimensi raksasa', hugePng(10_000, 10_000), 'maksimal 4096×4096 piksel'],
    [
      'PNG terpotong (header sah, isi rusak)',
      Buffer.concat([hugePng(64, 64).subarray(0, 33), Buffer.from('rusak')]),
      'rusak atau tidak bisa dibaca',
    ],
  ])('%s → 400 di field logo', async (_name, data, message) => {
    const error: unknown = await prepareLogoUpload(
      { contentType: 'image/png', dataBase64: data.toString('base64') },
      'logo',
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
    const [detail] = (error as { details: { field: string; message: string }[] }).details;
    expect(detail?.field).toBe('logo');
    expect(detail?.message).toContain(message);
  });
});
