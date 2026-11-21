import { randomBytes } from 'node:crypto';

import { AppError, closeRedis, type Redis } from '@balesin/core';
import { connectTestRedis, createLogCapture, deleteRedisKeys } from '@balesin/core/testing';
import { Redis as IoRedis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRateLimiter,
  enforceRateLimit,
  type RateLimitRule,
  type RateLimiter,
} from './rate-limit';

/** Batas laju terhadap Redis sungguhan (skrip Lua dan TTL tidak bisa ditiru dengan benar). */
const prefix = `balesin-tes-${randomBytes(6).toString('hex')}`;
let redis: Redis;
let limiter: RateLimiter;

beforeAll(async () => {
  redis = await connectTestRedis('client', createLogCapture('silent').logger);
  limiter = createRateLimiter(redis, { prefix });
});

afterAll(async () => {
  if (!redis) return;
  await deleteRedisKeys(redis, prefix);
  await closeRedis(redis);
});

const rule = (name: string, limit: number, windowSeconds = 60): RateLimitRule => ({
  name,
  limit,
  windowSeconds,
});

describe('batas laju (Redis sungguhan)', () => {
  it('mengizinkan sampai batas, lalu menolak dengan sisa waktu jendela', async () => {
    const login = rule('uji-batas', 3, 60);

    const states = [];
    for (let attempt = 0; attempt < 5; attempt += 1) states.push(await limiter.consume(login, 'a'));

    expect(states.map((state) => state.allowed)).toEqual([true, true, true, false, false]);
    expect(states.map((state) => state.count)).toEqual([1, 2, 3, 4, 5]);
    expect(states[3]?.retryAfterSeconds).toBeGreaterThan(55);
    expect(states[3]?.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('kunci dan aturan yang berbeda dihitung terpisah', async () => {
    const first = rule('uji-pisah-1', 1);
    const second = rule('uji-pisah-2', 1);

    expect((await limiter.consume(first, 'a')).allowed).toBe(true);
    expect((await limiter.consume(first, 'b')).allowed).toBe(true);
    expect((await limiter.consume(second, 'a')).allowed).toBe(true);
    expect((await limiter.consume(first, 'a')).allowed).toBe(false);
  });

  it('serbuan bersamaan dihitung atomik: tepat `limit` yang lolos', async () => {
    const burst = rule('uji-serbuan', 5);

    const states = await Promise.all(
      Array.from({ length: 50 }, () => limiter.consume(burst, 'serentak')),
    );

    expect(states.filter((state) => state.allowed)).toHaveLength(5);
    expect(new Set(states.map((state) => state.count)).size).toBe(50);
  });

  it('jendela berakhir sendiri (TTL terpasang sejak hitungan pertama)', async () => {
    const short = rule('uji-jendela', 1, 1);

    expect((await limiter.consume(short, 'a')).allowed).toBe(true);
    expect((await limiter.consume(short, 'a')).allowed).toBe(false);
    expect(await redis.pttl(`${prefix}:rl:uji-jendela:a`)).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    expect((await limiter.consume(short, 'a')).allowed).toBe(true);
  });

  it('refund mengembalikan satu jatah tanpa memperpanjang jendela; reset menghapus hitungan', async () => {
    const refundable = rule('uji-refund', 2);

    await limiter.consume(refundable, 'a');
    await limiter.consume(refundable, 'a');
    await limiter.refund(refundable, 'a');
    expect((await limiter.consume(refundable, 'a')).count).toBe(2);
    expect((await limiter.consume(refundable, 'a')).allowed).toBe(false);

    await limiter.reset(refundable, 'a');
    expect((await limiter.consume(refundable, 'a')).count).toBe(1);

    // Refund pada hitungan kosong tidak membuat hitungan negatif.
    await limiter.refund(refundable, 'belum-ada');
    await limiter.refund(refundable, 'belum-ada');
    expect((await limiter.consume(refundable, 'belum-ada')).count).toBe(1);
  });

  it('penanda (kunci akun) punya umur dan bisa dihapus', async () => {
    expect(await limiter.flagTtl('uji-kunci', 'akun')).toBe(0);

    await limiter.setFlag('uji-kunci', 'akun', 900);
    const ttl = await limiter.flagTtl('uji-kunci', 'akun');
    expect(ttl).toBeGreaterThan(895);
    expect(ttl).toBeLessThanOrEqual(900);
    expect(await limiter.flagTtl('uji-kunci', 'akun-lain')).toBe(0);

    await limiter.clearFlag('uji-kunci', 'akun');
    expect(await limiter.flagTtl('uji-kunci', 'akun')).toBe(0);
  });

  it('enforceRateLimit melempar AppError RATE_LIMITED dengan pesan dan Retry-After', async () => {
    const strict = rule('uji-tegakkan', 1);
    const message = (wait: string) => `Terlalu sering. Coba lagi dalam ${wait}.`;

    await expect(enforceRateLimit(limiter, strict, 'a', message)).resolves.toMatchObject({
      allowed: true,
    });
    const error = await enforceRateLimit(limiter, strict, 'a', message).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'RATE_LIMITED',
      statusCode: 429,
      message: 'Terlalu sering. Coba lagi dalam 1 menit.',
    });
    expect((error as AppError).retryAfterSeconds).toBeGreaterThan(55);
  });

  it('semua kunci berada di bawah awalan yang diberikan', async () => {
    const keys = await redis.keys(`${prefix}:*`);

    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith(`${prefix}:rl:`))).toBe(true);
  });
});

describe('penghitung per anggota (tally)', () => {
  it('menghitung per anggota, membatasi jumlah anggota berbeda, dan kedaluwarsa', async () => {
    const options = { ttlSeconds: 60, maxMembers: 2 };
    expect(await limiter.readTally('uji-tally', 'kosong')).toEqual({});
    await limiter.tally('uji-tally', 'c', '198.51.100.1', options);
    await limiter.tally('uji-tally', 'c', '198.51.100.1', options);
    await limiter.tally('uji-tally', 'c', '198.51.100.2', options);
    // Anggota ketiga tidak dicatat (batas), anggota lama tetap dihitung.
    await limiter.tally('uji-tally', 'c', '198.51.100.3', options);
    await limiter.tally('uji-tally', 'c', '198.51.100.2', options);
    expect(await limiter.readTally('uji-tally', 'c')).toEqual({
      '198.51.100.1': 2,
      '198.51.100.2': 2,
    });
    expect(await limiter.readTally('uji-tally', 'kunci-lain')).toEqual({});

    await limiter.tally('uji-tally', 'singkat', 'a', { ttlSeconds: 1, maxMembers: 5 });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(await limiter.readTally('uji-tally', 'singkat')).toEqual({});
  });
});

describe('batas laju saat Redis mati', () => {
  it('gagal tertutup: SERVICE_UNAVAILABLE (503), bukan meloloskan permintaan', async () => {
    const offline = new IoRedis({
      host: '127.0.0.1',
      port: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    offline.on('error', () => undefined);
    const broken = createRateLimiter(offline, { prefix });
    const login = rule('uji-mati', 5);

    for (const attempt of [
      broken.consume(login, 'a'),
      broken.refund(login, 'a'),
      broken.reset(login, 'a'),
      broken.setFlag('x', 'a', 10),
      broken.flagTtl('x', 'a'),
      broken.clearFlag('x', 'a'),
      broken.tally('x', 'a', 'b', { ttlSeconds: 10, maxMembers: 1 }),
      broken.readTally('x', 'a'),
    ]) {
      const error = await attempt.then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', statusCode: 503 });
    }
    offline.disconnect();
  });
});
