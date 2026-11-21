/**
 * Review keamanan white-label (docs/security-reviews/2026-11-24-branding-white-label.md):
 * pengunci regresi pertahanan dekoder logo. Semua tes di sini LULUS (tidak ada temuan
 * Kritis/Tinggi/Sedang); gunanya mencegah pelonggaran rantai "magic bytes → format sharp = sniff".
 *
 * Berkas poliglot di bawah dibuat lokal di memori — tidak menyentuh sistem nyata.
 */
import { deflateSync } from 'node:zlib';

import { LOGO_MAX_DIMENSION } from '@balesin/shared';
import { describe, expect, it } from 'vitest';

import { renderBrandIcons } from './icons';
import { prepareLogoUpload } from './logo';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)"/>';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function upload(data: Buffer, contentType: 'image/png' | 'image/jpeg' | 'image/webp') {
  return { contentType, dataBase64: data.toString('base64') };
}

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
/** PNG RGBA kecil yang mengaku `width`×`height` (IDAT terpotong). */
function claimedPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(4096))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('review keamanan merek — poliglot tidak pernah sampai ke loader lain', () => {
  const cases: [string, Buffer, 'image/png' | 'image/jpeg' | 'image/webp'][] = [
    [
      'RIFF/WEBP + SVG',
      Buffer.concat([Buffer.from('RIFF    WEBP'), Buffer.from(SVG)]),
      'image/webp',
    ],
    [
      'RIFF/WEBP + GIF',
      Buffer.concat([Buffer.from('RIFF    WEBPGIF89a'), Buffer.alloc(64)]),
      'image/webp',
    ],
    [
      'RIFF/WEBP + kotak ftyp HEIF',
      Buffer.concat([Buffer.from('RIFFftypWEBPmif1heic'), Buffer.alloc(64)]),
      'image/webp',
    ],
    ['tanda PNG + SVG', Buffer.concat([PNG_SIGNATURE, Buffer.from(SVG)]), 'image/png'],
    [
      'FFD8FF + SVG',
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(SVG)]),
      'image/jpeg',
    ],
  ];

  for (const [name, data, contentType] of cases) {
    it(`${name} → 400 "rusak", bukan diolah loader SVG/GIF/HEIF`, async () => {
      const error: unknown = await prepareLogoUpload(upload(data, contentType), 'logo').then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
      expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
      const [detail] = (error as { details: { field: string; message: string }[] }).details;
      expect(detail?.field).toBe('logo');
      expect(detail?.message).toContain('rusak');
    });
  }
});

describe('review keamanan merek — jalur isi ulang ikon (logo lama, tanpa inspectLogoImage)', () => {
  it('bom piksel tetap ditolak `limitInputPixels` sebelum dekode', async () => {
    await expect(renderBrandIcons(claimedPng(60_000, 60_000))).rejects.toMatchObject({
      reason: 'unreadable',
    });
    await expect(
      renderBrandIcons(claimedPng(LOGO_MAX_DIMENSION, LOGO_MAX_DIMENSION + 1)),
    ).rejects.toMatchObject({ reason: 'unreadable' });
  });
});
