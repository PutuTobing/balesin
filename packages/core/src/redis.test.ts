import { createServer, type AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { buildRedisOptions, closeRedis, createRedis, pingRedis, type Redis } from './redis';
import { createLogCapture } from './testing';

/** Port lokal yang dijamin tidak ada pendengarnya (dibuka sebentar lalu ditutup). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('buildRedisOptions', () => {
  it('peran queue memenuhi syarat BullMQ', () => {
    const options = buildRedisOptions('queue', 'balesin-worker');
    expect(options.maxRetriesPerRequest).toBeNull();
    expect(options.enableOfflineQueue).toBeUndefined();
    expect(options.connectionName).toBe('balesin-worker');
  });

  it('peran client gagal cepat saat Redis mati', () => {
    const options = buildRedisOptions('client', 'balesin-api');
    expect(options.maxRetriesPerRequest).toBe(1);
    expect(options.enableOfflineQueue).toBe(false);
  });

  it('selalu mencoba sambung ulang dengan jeda terbatas', () => {
    const { retryStrategy } = buildRedisOptions('client', 'x');
    expect(retryStrategy?.(1)).toBe(250);
    expect(retryStrategy?.(1_000)).toBe(5_000);
  });
});

describe('createRedis saat Redis tidak bisa dihubungi', () => {
  let redis: Redis | undefined;

  afterEach(async () => {
    if (redis) await closeRedis(redis);
    redis = undefined;
  });

  it('tidak melempar, PING gagal cepat, dan password tidak ikut ter-log', async () => {
    const port = await closedPort();
    const capture = createLogCapture();

    redis = createRedis(`redis://:sandi-redis-rahasia@127.0.0.1:${port}`, {
      role: 'client',
      name: 'tes',
      logger: capture.logger,
    });

    await expect(pingRedis(redis)).rejects.toThrow();
    await expect.poll(() => capture.entries().length, { timeout: 5_000 }).toBeGreaterThan(0);

    const [entry] = capture.entries();
    expect(entry).toMatchObject({ level: 'warn', connection: 'tes' });
    expect(capture.text()).not.toContain('sandi-redis-rahasia');
  });

  it('closeRedis aman dipanggil pada koneksi yang belum pernah tersambung', async () => {
    const port = await closedPort();
    const client = createRedis(`redis://127.0.0.1:${port}`, {
      role: 'client',
      name: 'tes',
      logger: createLogCapture().logger,
    });

    await closeRedis(client);
    await closeRedis(client);

    expect(client.status).toBe('end');
  });
});
