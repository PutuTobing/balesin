import { createServer, type AddressInfo } from 'node:net';

import { closeRedis, createRedis, systemPingResultSchema } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { startWorkers } from '../runtime';
import { processSystemJob } from './system';

describe('processSystemJob', () => {
  it('ping: menghitung lama menunggu dan mencatat log', () => {
    const logs = createLogCapture();
    const now = new Date('2026-11-13T01:00:02.500Z');

    const result = processSystemJob(
      { id: '7', name: 'ping', data: { requestedAt: '2026-11-13T01:00:00.000Z' } },
      { logger: logs.logger, now: () => now },
    );

    expect(systemPingResultSchema.parse(result)).toEqual({
      processedAt: '2026-11-13T01:00:02.500Z',
      waitedMs: 2500,
    });
    expect(logs.entries()).toContainEqual(
      expect.objectContaining({ level: 'info', jobId: '7', waitedMs: 2500 }),
    );
  });

  it('ping: selisih jam antar-server tidak menghasilkan waktu tunggu negatif', () => {
    const result = processSystemJob(
      { name: 'ping', data: { requestedAt: '2026-11-13T01:00:05.000Z' } },
      { logger: createLogCapture().logger, now: () => new Date('2026-11-13T01:00:00.000Z') },
    );

    expect(result.waitedMs).toBe(0);
  });

  it.each([
    ['bukan objek', 'teks'],
    ['kosong', {}],
    ['tanggal tidak valid', { requestedAt: 'kemarin sore' }],
    ['ada kolom tak dikenal', { requestedAt: '2026-11-13T01:00:00.000Z', perintah: 'rm -rf' }],
    ['null', null],
  ])('ping: payload %s gagal permanen (tidak diulang)', (_label, data) => {
    expect(() =>
      processSystemJob({ name: 'ping', data }, { logger: createLogCapture().logger }),
    ).toThrow(UnrecoverableError);
  });

  it('job yang tidak dikenal gagal permanen', () => {
    expect(() =>
      processSystemJob({ name: 'hapus-semua', data: {} }, { logger: createLogCapture().logger }),
    ).toThrow(UnrecoverableError);
  });
});

describe('startWorkers saat Redis tidak bisa dihubungi', () => {
  /** Port lokal yang dijamin tidak ada pendengarnya. */
  async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  it('tetap menyala tanpa melempar, lalu bisa ditutup dengan rapi', async () => {
    const logs = createLogCapture();
    const redis = createRedis(`redis://:sandi-antrian@127.0.0.1:${await closedPort()}`, {
      role: 'queue',
      name: 'tes-worker',
      logger: logs.logger,
    });

    const runtime = startWorkers({ connection: redis, prefix: 'balesin-tes' }, logs.logger);
    expect(runtime.workers.map((worker) => worker.name)).toEqual(['system']);

    // Beri waktu beberapa percobaan sambung gagal — proses tidak boleh jatuh.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(runtime.workers[0]?.isRunning()).toBe(true);

    await runtime.close();
    await closeRedis(redis);

    expect(logs.text()).not.toContain('sandi-antrian');
  }, 20_000);
});
