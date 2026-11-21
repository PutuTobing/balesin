import { Redis, type RedisOptions } from 'ioredis';

import type { Logger } from './logger';
import { withTimeout } from './timeout';

export type { Redis } from 'ioredis';

/**
 * - `client`: pemakaian umum di API (cek kesiapan, rate limit, cache). Gagal cepat saat Redis
 *   mati supaya request tidak menggantung.
 * - `queue`: koneksi untuk BullMQ. BullMQ mewajibkan `maxRetriesPerRequest: null` dan
 *   perintah boleh menunggu sampai koneksi pulih.
 */
export type RedisRole = 'client' | 'queue';

export interface CreateRedisOptions {
  role: RedisRole;
  /** Nama koneksi (terlihat di `CLIENT LIST` Redis dan di log). */
  name: string;
  logger: Logger;
}

const ERROR_LOG_INTERVAL_MS = 30_000;

/** Koneksi yang sedang ditutup lewat `closeRedis` — error-nya tidak perlu dicatat. */
const closing = new WeakSet<Redis>();

export function buildRedisOptions(role: RedisRole, name: string): RedisOptions {
  const common: RedisOptions = {
    connectionName: name,
    connectTimeout: 5_000,
    // Coba sambung ulang selamanya dengan jeda bertambah, maksimal 5 detik.
    retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
  };
  if (role === 'queue') {
    return { ...common, maxRetriesPerRequest: null };
  }
  return { ...common, maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 5_000 };
}

/**
 * Membuat koneksi Redis (ioredis). Koneksi dibuka di latar belakang dan disambung ulang
 * otomatis; aplikasi tetap bisa start walau Redis sedang mati.
 */
export function createRedis(url: string, options: CreateRedisOptions): Redis {
  const { logger, name } = options;
  const redis = new Redis(url, buildRedisOptions(options.role, name));

  // Wajib ada listener `error`; tanpa itu ioredis menulis ke console. Dibatasi agar log tidak
  // banjir selama Redis mati (ioredis memancarkan error di setiap percobaan sambung ulang).
  let lastErrorLogAt = 0;
  redis.on('error', (err: Error) => {
    // Error yang muncul karena kita sendiri sedang menutup koneksi bukan masalah.
    if (closing.has(redis)) return;
    const now = Date.now();
    if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
    lastErrorLogAt = now;
    logger.warn({ err, connection: name }, 'Koneksi Redis bermasalah, mencoba sambung ulang');
  });
  redis.on('ready', () => {
    lastErrorLogAt = 0;
    logger.info({ connection: name }, 'Redis terhubung');
  });

  return redis;
}

/** Melempar error bila Redis tidak menjawab PING. */
export async function pingRedis(redis: Redis): Promise<void> {
  const reply = await redis.ping();
  if (reply !== 'PONG') throw new Error('Balasan PING dari Redis tidak dikenali');
}

/**
 * Tutup koneksi: dengan sopan (QUIT) bila sedang tersambung, langsung putus bila tidak
 * (QUIT pada koneksi yang belum siap hanya akan menggantung atau gagal).
 */
export async function closeRedis(redis: Redis): Promise<void> {
  if (redis.status === 'end') return;
  closing.add(redis);
  const ended = new Promise<void>((resolve) => redis.once('end', resolve));
  if (redis.status === 'ready') {
    try {
      await withTimeout(redis.quit(), 2_000, 'Redis QUIT');
    } catch {
      redis.disconnect();
    }
  } else {
    redis.disconnect();
  }
  await withTimeout(ended, 2_000, 'Penutupan koneksi Redis').catch(() => undefined);
}
