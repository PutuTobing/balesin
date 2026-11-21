import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api/client';
import { RATE_LIMIT_RETRIES, retryQuery, retryQueryDelay } from './query-client';

const limited = (retryAfterSeconds: number | null) =>
  new ApiError({ status: 429, code: 'RATE_LIMITED', message: 'x', retryAfterSeconds });

describe('coba ulang bawaan query (audit akhir QA S1)', () => {
  it('429 dengan Retry-After pendek ditunggu sampai beberapa kali, lalu galat tampil', () => {
    for (let count = 0; count < RATE_LIMIT_RETRIES; count += 1) {
      expect(retryQuery(count, limited(5))).toBe(true);
    }
    expect(retryQuery(RATE_LIMIT_RETRIES, limited(5))).toBe(false);
    expect(retryQueryDelay(0, limited(5))).toBe(5000);
    // Tanpa header: jeda cadangan 5 dtk.
    expect(retryQuery(0, limited(null))).toBe(true);
    expect(retryQueryDelay(1, limited(null))).toBe(5000);
  });

  it('429 dengan jeda panjang (batas per menit) tidak ditunggu diam-diam', () => {
    expect(retryQuery(0, limited(60))).toBe(false);
  });

  it('galat lain tetap dicoba ulang sekali dengan mundur eksponensial', () => {
    const failed = new ApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'x' });
    expect(retryQuery(0, failed)).toBe(true);
    expect(retryQuery(1, failed)).toBe(false);
    expect(retryQueryDelay(0, failed)).toBe(1000);
    expect(retryQueryDelay(1, failed)).toBe(2000);
  });
});
