/**
 * Review merek B4 + Info 2: dekode logo dibatasi satu per proses, dan ikon yang melewati batas
 * ukuran CHECK database ditolak sebagai 400 berbahasa Indonesia (bukan 500).
 */
import { randomBytes } from 'node:crypto';

import type * as Shared from '@balesin/shared';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

// Batas ikon diperkecil supaya logo derau biasa sudah melewatinya (aslinya 1 MiB).
vi.mock('@balesin/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof Shared>()),
  BRAND_ICON_MAX_BYTES: 2_000,
}));

const { withDecodeSlot } = await import('./icons');
const { prepareLogoUpload } = await import('./logo');

describe('slot dekode', () => {
  it('tugas berjalan satu per satu, berurutan, dan slot dilepas walau tugas gagal', async () => {
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (id: number, fail = false) =>
      withDecodeSlot(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(id);
        running -= 1;
        if (fail) throw new Error('gagal');
        return id;
      });
    const results = await Promise.allSettled([task(1), task(2, true), task(3), task(4)]);
    expect(peak).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
    // Slot kembali bebas.
    await expect(withDecodeSlot(() => Promise.resolve('bebas'))).resolves.toBe('bebas');
  });
});

describe('ikon terlalu besar', () => {
  it('logo penuh derau → 400 di field logo dengan pesan Indonesia', async () => {
    const noise = await sharp(randomBytes(64 * 64 * 3), {
      raw: { width: 64, height: 64, channels: 3 },
    })
      .png()
      .toBuffer();
    const error: unknown = await prepareLogoUpload(
      { contentType: 'image/png', dataBase64: noise.toString('base64') },
      'logo',
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR' });
    const [detail] = (error as { details: { field: string; message: string }[] }).details;
    expect(detail?.field).toBe('logo');
    expect(detail?.message).toContain('terlalu rumit untuk dijadikan ikon');
  });
});
