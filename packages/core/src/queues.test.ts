import { describe, expect, it } from 'vitest';

import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  systemPingPayloadSchema,
  systemPingResultSchema,
} from './queues';

describe('definisi antrian', () => {
  it('nama antrian dan awalan stabil (dipakai api dan worker)', () => {
    expect(QUEUE_PREFIX).toBe('balesin');
    expect(QUEUE_NAMES.system).toBe('system');
  });

  it('opsi job bawaan: percobaan ulang dengan backoff dan riwayat terbatas', () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBeGreaterThan(1);
    expect(DEFAULT_JOB_OPTIONS.backoff.type).toBe('exponential');
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete.count).toBeGreaterThan(0);
    expect(DEFAULT_JOB_OPTIONS.removeOnFail.count).toBeGreaterThan(0);
  });

  describe('payload ping', () => {
    it('menerima waktu ISO 8601', () => {
      expect(
        systemPingPayloadSchema.safeParse({ requestedAt: '2026-11-13T10:00:00.000Z' }).success,
      ).toBe(true);
    });

    it.each([
      ['tanpa requestedAt', {}],
      ['waktu bukan ISO', { requestedAt: 'kemarin' }],
      ['tanggal tanpa jam', { requestedAt: '2026-11-13' }],
      ['bukan string', { requestedAt: 12345 }],
      ['kolom tambahan', { requestedAt: '2026-11-13T10:00:00.000Z', extra: 1 }],
    ])('menolak payload %s', (_nama, payload) => {
      expect(systemPingPayloadSchema.safeParse(payload).success).toBe(false);
    });
  });

  it('hasil ping memerlukan processedAt dan waitedMs numerik', () => {
    const processedAt = '2026-11-13T10:00:00.000Z';
    expect(systemPingResultSchema.safeParse({ processedAt, waitedMs: 5 }).success).toBe(true);
    expect(systemPingResultSchema.safeParse({ processedAt, waitedMs: '5' }).success).toBe(false);
  });
});
