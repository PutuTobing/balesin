import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REPORT_CONCURRENCY } from './reports.routes';
import { createReportGate } from './report-gate';

const limits = { global: 3, perOrganization: 2, perUser: 1, maxWaiting: 3, waitMs: 1_000 };

describe('gerbang laporan (audit akhir QA S1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('slot kosong → langsung jalan; penuh → MENUNGGU lalu jalan saat slot dilepas (bukan ditolak)', async () => {
    const gate = createReportGate(limits);
    const first = await gate.acquire('org', 'a');
    expect(first).not.toBeNull();
    // Pengguna yang sama melewati batas per pengguna → menunggu.
    let second: (() => void) | null | undefined;
    void gate.acquire('org', 'a').then((release) => (second = release));
    await Promise.resolve();
    expect(second).toBeUndefined();
    expect(gate.waiting).toBe(1);
    first!();
    await Promise.resolve();
    expect(second).toBeTypeOf('function');
    expect(gate.running).toBe(1);
  });

  it('penunggu yang terhalang batasnya sendiri tidak menghalangi organisasi/pengguna lain', async () => {
    const gate = createReportGate(limits);
    await gate.acquire('org', 'a');
    let blocked: (() => void) | null | undefined;
    void gate.acquire('org', 'a').then((release) => (blocked = release));
    const other = await gate.acquire('org', 'b');
    expect(other).not.toBeNull();
    expect(blocked).toBeUndefined();
    // Organisasi lain tetap jalan walau organisasi pertama penuh.
    expect(await gate.acquire('org-2', 'c')).not.toBeNull();
    expect(gate.running).toBe(3);
  });

  it('waktu tunggu habis → null (rute menjawab 429 + Retry-After); slot yang datang belakangan tidak bocor', async () => {
    const gate = createReportGate(limits);
    const held = await gate.acquire('org', 'a');
    const waiting = gate.acquire('org', 'a');
    vi.advanceTimersByTime(limits.waitMs);
    expect(await waiting).toBeNull();
    expect(gate.waiting).toBe(0);
    held!();
    expect(gate.running).toBe(0);
  });

  it('antrean penuh → ditolak segera', async () => {
    const gate = createReportGate(limits);
    await gate.acquire('org', 'a');
    for (let index = 0; index < limits.maxWaiting; index += 1) void gate.acquire('org', 'a');
    expect(await gate.acquire('org', 'a')).toBeNull();
  });

  it('pelepas idempoten; batas bawaan cukup untuk beberapa supervisor × beberapa kartu', async () => {
    const gate = createReportGate(limits);
    const release = await gate.acquire('org', 'a');
    release!();
    release!();
    expect(gate.running).toBe(0);
    expect(REPORT_CONCURRENCY.perOrganization).toBeGreaterThanOrEqual(4);
    expect(REPORT_CONCURRENCY.waitMs).toBeGreaterThanOrEqual(3_000);
    expect(REPORT_CONCURRENCY.waitMs).toBeLessThan(10_000);
  });
});
