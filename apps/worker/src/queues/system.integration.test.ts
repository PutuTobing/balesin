/**
 * Tes integrasi antrian terhadap Redis sungguhan (BullMQ butuh Redis asli).
 *
 * Redis diambil dari `REDIS_URL_TEST` (bawaan: Redis dari `pnpm db:up`, database nomor 15).
 * Tiap kali jalan memakai awalan kunci acak sendiri dan menghapusnya di akhir, jadi aman
 * diulang dan tidak menyentuh antrian pengembangan. Bila Redis tidak bisa dihubungi, tes
 * GAGAL dengan pesan jelas (tidak dilewati diam-diam).
 */
import { randomBytes } from 'node:crypto';

import {
  closeRedis,
  createRedis,
  pingRedis,
  QUEUE_PREFIX,
  systemPingResultSchema,
  withTimeout,
  type Redis,
} from '@balesin/core';
import { createLogCapture, type LogCapture } from '@balesin/core/testing';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startWorkers, type WorkerRuntime } from '../runtime';
import { createSystemQueue } from './system';

const DEFAULT_TEST_REDIS_URL = 'redis://:balesin@localhost:6379/15';

let logs: LogCapture;
let redis: Redis;
let queue: Queue;
let runtime: WorkerRuntime;

beforeAll(async () => {
  const redisUrl = process.env.REDIS_URL_TEST?.trim() || DEFAULT_TEST_REDIS_URL;
  const { hostname, port } = new URL(redisUrl);
  const prefix = `balesin-tes-${randomBytes(6).toString('hex')}`;

  logs = createLogCapture();
  redis = createRedis(redisUrl, { role: 'queue', name: 'balesin-tes', logger: logs.logger });
  try {
    await withTimeout(pingRedis(redis), 3_000, 'PING Redis');
  } catch (error) {
    redis.disconnect();
    throw new Error(
      `Redis untuk tes tidak bisa dihubungi di ${hostname}:${port || '6379'}. ` +
        'Jalankan `pnpm db:up` lalu ulangi, atau arahkan REDIS_URL_TEST ke Redis yang hidup.',
      { cause: error },
    );
  }

  queue = createSystemQueue({ connection: redis, prefix });
  runtime = startWorkers({ connection: redis, prefix }, logs.logger);
}, 30_000);

afterAll(async () => {
  await runtime?.close();
  await queue?.obliterate({ force: true });
  await queue?.close();
  if (redis) await closeRedis(redis);
}, 30_000);

async function waitUntilFinished(jobId: string | undefined) {
  if (!jobId) throw new Error('Job tidak punya ID');
  await expect
    .poll(() => queue.getJobState(jobId), { timeout: 15_000, interval: 50 })
    .toMatch(/^(completed|failed)$/);
  const job = await queue.getJob(jobId);
  if (!job) throw new Error('Job hilang dari antrian');
  return job;
}

describe('antrian system (Redis sungguhan)', () => {
  it('job ping diproses worker dan hasilnya tersimpan', async () => {
    const added = await queue.add('ping', { requestedAt: new Date().toISOString() });

    const job = await waitUntilFinished(added.id);

    expect(await job.getState()).toBe('completed');
    const result = systemPingResultSchema.parse(job.returnvalue);
    expect(result.waitedMs).toBeGreaterThanOrEqual(0);
    expect(result.waitedMs).toBeLessThan(15_000);
    expect(logs.entries()).toContainEqual(
      expect.objectContaining({ msg: 'Antrian system merespons ping', jobId: added.id }),
    );
  }, 30_000);

  it('payload rusak gagal sekali saja walau jatah percobaannya 3 kali', async () => {
    const added = await queue.add('ping', { requestedAt: 'bukan tanggal' });

    const job = await waitUntilFinished(added.id);

    expect(await job.getState()).toBe('failed');
    expect(job.opts.attempts).toBe(3);
    expect(job.attemptsMade).toBe(1);
    expect(job.failedReason).toBe('Payload job system:ping tidak valid');
    expect(logs.entries()).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'Job gagal', jobId: added.id }),
    );
  }, 30_000);

  it('job yang tidak dikenal gagal permanen', async () => {
    const added = await queue.add('tidak-dikenal', {});

    const job = await waitUntilFinished(added.id);

    expect(await job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(1);
  }, 30_000);

  it('semua kunci Redis memakai awalan khusus tes, bukan awalan aplikasi', async () => {
    const prefix = queue.opts.prefix;

    expect(prefix).not.toBe(QUEUE_PREFIX);
    expect(prefix).toMatch(/^balesin-tes-[0-9a-f]{12}$/);
    expect((await redis.keys(`${prefix}:system:*`)).length).toBeGreaterThan(0);
  });
});
