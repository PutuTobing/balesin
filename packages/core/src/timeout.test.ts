import { afterEach, describe, expect, it, vi } from 'vitest';

import { TimeoutError, withTimeout } from './timeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout', () => {
  it('mengembalikan hasil bila selesai sebelum batas waktu', async () => {
    await expect(withTimeout(Promise.resolve(42), 100, 'tes')).resolves.toBe(42);
  });

  it('meneruskan galat asli bila promise gagal sebelum batas waktu', async () => {
    await expect(withTimeout(Promise.reject(new Error('rusak')), 100, 'tes')).rejects.toThrow(
      'rusak',
    );
  });

  it('melempar TimeoutError berlabel bila melewati batas waktu', async () => {
    vi.useFakeTimers();
    const result = withTimeout(new Promise<never>(() => undefined), 50, 'Postgres');
    const assertion = expect(result).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Postgres melewati batas waktu 50 ms',
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    await expect(result).rejects.toBeInstanceOf(TimeoutError);
  });

  it('tidak meninggalkan timer yang menggantung setelah selesai', async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve('ok'), 10_000, 'tes');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('galat yang datang setelah batas waktu tidak menjadi unhandled rejection', async () => {
    vi.useFakeTimers();
    let rejectLate!: (error: Error) => void;
    const late = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });
    const result = withTimeout(late, 10, 'tes');
    const assertion = expect(result).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    // Bila galat terlambat tidak ditangani, Vitest melaporkan unhandled rejection dan gagal.
    rejectLate(new Error('terlambat'));
    vi.useRealTimers();
    await new Promise((resolve) => setImmediate(resolve));
  });
});
