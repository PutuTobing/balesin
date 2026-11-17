/**
 * Tes penjaga review keamanan Fase 4 broadcast — Putaran 2 (T1): parsing impor di `worker_threads`
 * (docs/security-reviews/2026-11-20-fase4-broadcast.md). Semua `it` = regresi.
 */
import { describe, expect, it } from 'vitest';

import { ImportBusyError, parseTableIsolated } from './import-runner';
import { ImportError } from './recipient-import';

const csv = (rows: number) =>
  Buffer.from(
    [
      'nama,nomor',
      ...Array.from(
        { length: rows },
        (_, i) => `Nama ${String(i)},0812${String(i).padStart(8, '0')}`,
      ),
    ].join('\n'),
  );

describe('review keamanan — pemroses impor terisolasi', () => {
  it('kelewat batas waktu → thread dihentikan, galat Indonesia; impor berikutnya tetap jalan', async () => {
    await expect(
      parseTableIsolated('uji-timeout', csv(19_000), { timeoutMs: 1 }),
    ).rejects.toBeInstanceOf(ImportError);
    const table = await parseTableIsolated('uji-timeout', csv(3));
    expect(table.rows).toHaveLength(3);
  }, 180_000);

  it('gerbang: satu impor per pengguna, maks. 2 per proses → sisanya ditolak SEKETIKA (bukan antre)', async () => {
    const big = csv(19_000);
    const first = parseTableIsolated('pengguna-a', big);
    const sameUser = parseTableIsolated('pengguna-a', big);
    await expect(sameUser).rejects.toBeInstanceOf(ImportBusyError);
    const second = parseTableIsolated('pengguna-b', big);
    const third = parseTableIsolated('pengguna-c', big);
    await expect(third).rejects.toBeInstanceOf(ImportBusyError);
    await Promise.all([first, second]);
    // Setelah selesai, slot kembali.
    expect((await parseTableIsolated('pengguna-c', csv(2))).rows).toHaveLength(2);
  }, 180_000);

  it('event loop api tetap responsif selama thread memproses berkas', async () => {
    let maxLag = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last - 10);
      last = now;
    }, 10);
    try {
      await parseTableIsolated('pengguna-lag', csv(19_000));
    } finally {
      clearInterval(ticker);
    }
    // Termasuk menyalin hasil (structured clone) — tetap jauh di bawah "membeku".
    expect(maxLag).toBeLessThan(1_000);
  }, 180_000);
});
