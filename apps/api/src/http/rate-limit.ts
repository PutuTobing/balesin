import { AppError, type Redis } from '@balesin/core';

/**
 * Batas laju berbasis Redis (jendela tetap) untuk endpoint yang rawan disalahgunakan:
 * login, token setup, tes koneksi email.
 *
 * - Hitungan dinaikkan SEBELUM pekerjaan dijalankan dan secara atomik (skrip Lua), jadi
 *   serbuan permintaan bersamaan tidak bisa melewati batas.
 * - Redis mati = permintaan DITOLAK (503), bukan diloloskan: tanpa penghitung, batasnya hilang.
 * - Penolakan selalu berupa `AppError('RATE_LIMITED')` (429) dengan header `Retry-After`.
 * - Kunci Redis tidak pernah memuat rahasia; identitas seperti email dipakai dalam bentuk hash.
 */

export interface RateLimitRule {
  /** Bagian nama kunci Redis, mis. `login-ip`. */
  name: string;
  /** Jumlah maksimal dalam satu jendela. */
  limit: number;
  windowSeconds: number;
}

export interface RateLimitState {
  allowed: boolean;
  /** Hitungan di jendela ini, termasuk permintaan ini. */
  count: number;
  /** Detik sampai jendela berakhir. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Menaikkan hitungan lalu melaporkan apakah masih di dalam batas. */
  consume(rule: RateLimitRule, key: string): Promise<RateLimitState>;
  /**
   * Membaca hitungan TANPA menaikkannya. `allowed` = masih ada jatah untuk satu lagi
   * (`count < limit`). Untuk ember yang hanya diisi oleh hasil gagal (lihat login per IP).
   */
  peek(rule: RateLimitRule, key: string): Promise<RateLimitState>;
  /** Mengembalikan satu jatah (mis. login berhasil tidak dihitung sebagai percobaan gagal). */
  refund(rule: RateLimitRule, key: string): Promise<void>;
  /** Menghapus hitungan. */
  reset(rule: RateLimitRule, key: string): Promise<void>;
  /** Memasang penanda berumur `ttlSeconds` (dipakai untuk kunci akun). */
  setFlag(name: string, key: string, ttlSeconds: number): Promise<void>;
  /**
   * Memasang penanda HANYA bila belum ada (SET NX). `true` = penanda baru dipasang oleh
   * pemanggil ini (dipakai untuk "paling banyak sekali per jam").
   */
  claimFlag(name: string, key: string, ttlSeconds: number): Promise<boolean>;
  /** Sisa umur penanda dalam detik; 0 bila tidak ada. */
  flagTtl(name: string, key: string): Promise<number>;
  clearFlag(name: string, key: string): Promise<void>;
  /**
   * Menambah hitungan `member` di penghitung bernama (jendela tetap `ttlSeconds` sejak anggota
   * pertama). Paling banyak `maxMembers` anggota berbeda; anggota baru setelah itu tidak dicatat.
   * Dipakai untuk "berapa sumber berbeda" (mis. IP per channel) tanpa memindai Redis.
   */
  tally(
    name: string,
    key: string,
    member: string,
    options: { ttlSeconds: number; maxMembers: number },
  ): Promise<void>;
  /** Isi penghitung `tally` (anggota → hitungan); kosong bila tidak ada / kedaluwarsa. */
  readTally(name: string, key: string): Promise<Record<string, number>>;
}

// Pesan error skrip tidak boleh disusun dari data (lihat catatan I8 review Fase 0).
const CONSUME_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`;

const PEEK_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local ttl = redis.call('PTTL', KEYS[1])
return {current, ttl}
`;

const TALLY_SCRIPT = `
local exists = redis.call('HEXISTS', KEYS[1], ARGV[1])
if exists == 0 and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then
  return 0
end
redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 1
`;

const REFUND_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 1 then
  redis.call('DEL', KEYS[1])
else
  redis.call('DECR', KEYS[1])
end
return 1
`;

function unavailable(cause: unknown): AppError {
  return new AppError('SERVICE_UNAVAILABLE', {
    message: 'Layanan sedang tidak bisa memproses permintaan ini. Coba lagi beberapa saat lagi.',
    cause,
  });
}

export interface RateLimiterOptions {
  /** Awalan kunci Redis. Bawaan `balesin`; tes memakai awalan sendiri. */
  prefix?: string;
}

export function createRateLimiter(redis: Redis, options: RateLimiterOptions = {}): RateLimiter {
  const prefix = `${options.prefix ?? 'balesin'}:rl`;
  const counterKey = (rule: RateLimitRule, key: string) => `${prefix}:${rule.name}:${key}`;
  const flagKey = (name: string, key: string) => `${prefix}:flag:${name}:${key}`;
  const tallyKey = (name: string, key: string) => `${prefix}:tally:${name}:${key}`;

  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw unavailable(error);
    }
  }

  return {
    consume: (rule, key) =>
      guarded(async () => {
        const reply = (await redis.eval(
          CONSUME_SCRIPT,
          1,
          counterKey(rule, key),
          String(rule.windowSeconds * 1000),
        )) as [number, number];
        const [count, ttlMs] = reply;
        return {
          allowed: count <= rule.limit,
          count,
          retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
        };
      }),

    peek: (rule, key) =>
      guarded(async () => {
        const reply = (await redis.eval(PEEK_SCRIPT, 1, counterKey(rule, key))) as [number, number];
        const [count, ttlMs] = reply;
        return {
          allowed: count < rule.limit,
          count,
          retryAfterSeconds: Math.max(1, Math.ceil((ttlMs > 0 ? ttlMs : 1000) / 1000)),
        };
      }),

    refund: (rule, key) =>
      guarded(async () => {
        await redis.eval(REFUND_SCRIPT, 1, counterKey(rule, key));
      }),

    reset: (rule, key) =>
      guarded(async () => {
        await redis.del(counterKey(rule, key));
      }),

    setFlag: (name, key, ttlSeconds) =>
      guarded(async () => {
        await redis.set(flagKey(name, key), '1', 'EX', ttlSeconds);
      }),

    claimFlag: (name, key, ttlSeconds) =>
      guarded(async () => {
        const reply = await redis.set(flagKey(name, key), '1', 'EX', ttlSeconds, 'NX');
        return reply === 'OK';
      }),

    flagTtl: (name, key) =>
      guarded(async () => {
        const ttlMs = await redis.pttl(flagKey(name, key));
        return ttlMs > 0 ? Math.ceil(ttlMs / 1000) : 0;
      }),

    clearFlag: (name, key) =>
      guarded(async () => {
        await redis.del(flagKey(name, key));
      }),

    tally: (name, key, member, { ttlSeconds, maxMembers }) =>
      guarded(async () => {
        await redis.eval(
          TALLY_SCRIPT,
          1,
          tallyKey(name, key),
          member,
          String(ttlSeconds * 1000),
          String(maxMembers),
        );
      }),

    readTally: (name, key) =>
      guarded(async () => {
        const raw = await redis.hgetall(tallyKey(name, key));
        const counts: Record<string, number> = {};
        for (const [member, value] of Object.entries(raw)) {
          const count = Number(value);
          if (Number.isSafeInteger(count) && count > 0) counts[member] = count;
        }
        return counts;
      }),
  };
}

/** "5 menit", "1 menit", atau "30 detik" — untuk pesan penolakan. */
export function formatWait(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} detik`;
  return `${Math.ceil(seconds / 60)} menit`;
}

/**
 * Error 429 + header `Retry-After`. `message` harus menjelaskan apa yang perlu dilakukan
 * pengguna (biasanya: menunggu `formatWait(retryAfterSeconds)`).
 */
export function rateLimited(retryAfterSeconds: number, message: string): AppError {
  return new AppError('RATE_LIMITED', { message, retryAfterSeconds });
}

/** Menaikkan hitungan dan langsung menolak (429) bila batas terlewati. */
export async function enforceRateLimit(
  limiter: RateLimiter,
  rule: RateLimitRule,
  key: string,
  message: (wait: string) => string,
): Promise<RateLimitState> {
  const state = await limiter.consume(rule, key);
  if (!state.allowed) {
    throw rateLimited(state.retryAfterSeconds, message(formatWait(state.retryAfterSeconds)));
  }
  return state;
}
