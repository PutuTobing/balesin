import { healthResponseSchema, readyResponseSchema } from '@balesin/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildTestApp, type TestApp } from '../../testing/build-test-app';

let current: TestApp | undefined;

async function setup(options: Parameters<typeof buildTestApp>[0] = {}): Promise<TestApp> {
  current = await buildTestApp(options);
  return current;
}

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

const DATABASE_FAILURE = () =>
  Promise.reject(
    Object.assign(
      new Error(
        'connect ECONNREFUSED postgres://balesin:sandi-db-rahasia@db-internal:5432/balesin',
      ),
      { code: 'ECONNREFUSED', address: 'db-internal' },
    ),
  );

describe('GET /health', () => {
  it('menjawab 200 tanpa menyentuh dependensi', async () => {
    const postgres = vi.fn(() => Promise.resolve());
    const redis = vi.fn(() => Promise.resolve());
    const { app } = await setup({ readinessProbes: { postgres, redis } });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.parse(response.json())).toEqual({ status: 'ok' });
    expect(postgres).not.toHaveBeenCalled();
    expect(redis).not.toHaveBeenCalled();
  });

  it('tetap 200 walau semua dependensi mati', async () => {
    const { app } = await setup({
      readinessProbes: { postgres: DATABASE_FAILURE, redis: DATABASE_FAILURE },
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
  });
});

describe('GET /ready', () => {
  it('200 bila Postgres dan Redis sehat', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(readyResponseSchema.parse(response.json())).toEqual({
      status: 'ok',
      dependencies: { postgres: 'ok', redis: 'ok' },
    });
  });

  it('503 bila Postgres mati, tanpa membocorkan penyebabnya ke klien', async () => {
    const { app, logs } = await setup({ readinessProbes: { postgres: DATABASE_FAILURE } });

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(readyResponseSchema.parse(response.json())).toEqual({
      status: 'unavailable',
      dependencies: { postgres: 'down', redis: 'ok' },
    });
    for (const leak of ['ECONNREFUSED', 'db-internal', 'sandi-db-rahasia', 'postgres://']) {
      expect(response.body).not.toContain(leak);
    }

    // Penyebabnya ada di log server — tanpa password.
    const warning = logs.entries().find((entry) => entry.dependency === 'postgres');
    expect(warning).toMatchObject({ level: 'warn', msg: 'Postgres tidak bisa dihubungi' });
    expect((warning?.err as { code?: string }).code).toBe('ECONNREFUSED');
    expect(logs.text()).not.toContain('sandi-db-rahasia');
  });

  it('503 bila Redis mati', async () => {
    const { app } = await setup({
      readinessProbes: { redis: () => Promise.reject(new Error('Connection is closed.')) },
    });

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'unavailable',
      dependencies: { postgres: 'ok', redis: 'down' },
    });
  });

  it('503 bila semua mati, dan probe yang melempar secara sinkron tidak menjatuhkan server', async () => {
    const { app } = await setup({
      readinessProbes: {
        postgres: () => {
          throw new Error('sinkron');
        },
        redis: DATABASE_FAILURE,
      },
    });

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ dependencies: { postgres: 'down', redis: 'down' } });
  });

  it('dependensi yang menggantung dianggap mati setelah batas waktu', async () => {
    const { app } = await setup({
      readinessTimeoutMs: 50,
      readinessProbes: { redis: () => new Promise<void>(() => undefined) },
    });

    const startedAt = Date.now();
    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ dependencies: { postgres: 'ok', redis: 'down' } });
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it('permintaan bersamaan berbagi satu pemeriksaan', async () => {
    let release: () => void = () => undefined;
    const postgres = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { app } = await setup({ readinessProbes: { postgres } });

    const responses = Promise.all(
      Array.from({ length: 5 }, () => app.inject({ method: 'GET', url: '/ready' })),
    );
    await vi.waitFor(() => expect(postgres).toHaveBeenCalled());
    release();

    expect((await responses).map((response) => response.statusCode)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    expect(postgres).toHaveBeenCalledTimes(1);

    // Pemeriksaan berikutnya (tidak bersamaan) berjalan lagi.
    const next = app.inject({ method: 'GET', url: '/ready' });
    await vi.waitFor(() => expect(postgres).toHaveBeenCalledTimes(2));
    release();
    expect((await next).statusCode).toBe(200);
  });

  it('hanya mencatat log saat status berubah', async () => {
    let healthy = false;
    const { app, logs } = await setup({
      readinessProbes: {
        redis: () => (healthy ? Promise.resolve() : Promise.reject(new Error('mati'))),
      },
    });

    await app.inject({ method: 'GET', url: '/ready' });
    await app.inject({ method: 'GET', url: '/ready' });
    await app.inject({ method: 'GET', url: '/ready' });
    healthy = true;
    const recovered = await app.inject({ method: 'GET', url: '/ready' });
    await app.inject({ method: 'GET', url: '/ready' });

    expect(recovered.statusCode).toBe(200);
    const redisLogs = logs.entries().filter((entry) => entry.dependency === 'redis');
    expect(redisLogs.map((entry) => [entry.level, entry.msg])).toEqual([
      ['warn', 'Redis tidak bisa dihubungi'],
      ['info', 'Redis kembali terhubung'],
    ]);
  });

  it('rute kesehatan tidak memenuhi log per-request', async () => {
    const { app, logs } = await setup();

    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/ready' });

    expect(logs.entries()).toEqual([]);
  });
});
