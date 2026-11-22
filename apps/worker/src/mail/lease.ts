import { randomUUID } from 'node:crypto';

import type { Redis } from '@balesin/core';

/**
 * Sewa Redis modul Email (KONTRAK-API-EMAIL §11):
 *  - `mail:idle:<accountId>` — pemilik SATU sambungan IDLE per akun di semua replika worker
 *    (`SET NX PX 60000`, diperpanjang tiap 20 dtk oleh pemiliknya saja).
 *  - `mail:conn:<accountId>:work` — SATU sambungan kerja (sinkron) per akun. Bersama IDLE = maks. 2
 *    sambungan per akun (banyak server cPanel/Dovecot membatasi sambungan per pengguna+IP).
 * Melepas/memperpanjang hanya bila nilainya masih milik kita (skrip Lua bandingkan-lalu-ubah).
 */

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

export interface Lease {
  readonly key: string;
  readonly token: string;
  renew(ttlMs: number): Promise<boolean>;
  release(): Promise<void>;
}

export function mailIdleLeaseKey(prefix: string, accountId: string): string {
  return `${prefix}:mail:idle:${accountId}`;
}

export function mailWorkLeaseKey(prefix: string, accountId: string): string {
  return `${prefix}:mail:conn:${accountId}:work`;
}

export async function acquireLease(
  redis: Redis,
  key: string,
  ttlMs: number,
): Promise<Lease | null> {
  const token = randomUUID();
  const result = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (result !== 'OK') return null;
  return {
    key,
    token,
    async renew(nextTtlMs) {
      const renewed = (await redis.eval(RENEW, 1, key, token, String(nextTtlMs))) as number;
      return renewed === 1;
    },
    async release() {
      await redis.eval(RELEASE, 1, key, token).catch(() => undefined);
    },
  };
}
