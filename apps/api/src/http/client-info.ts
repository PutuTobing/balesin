import { isIP } from 'node:net';

import type { FastifyRequest } from 'fastify';

/** Asal permintaan untuk audit log, sesi, dan batas laju. */
export interface ClientInfo {
  /**
   * Alamat IP klien, atau `null` bila `request.ip` bukan alamat IP yang sah — lewat proxy
   * tepercaya `X-Forwarded-For` bisa berisi teks apa pun, dan kolom `inet` Postgres menolak
   * nilai seperti itu (catatan F.7 review Fase 0).
   */
  ip: string | null;
  userAgent: string | null;
}

export const USER_AGENT_MAX_LENGTH = 512;

export function clientInfo(request: Pick<FastifyRequest, 'ip' | 'headers'>): ClientInfo {
  const userAgent = request.headers['user-agent'];
  return {
    ip: isIP(request.ip) === 0 ? null : request.ip,
    userAgent:
      typeof userAgent === 'string' && userAgent.length > 0
        ? userAgent.slice(0, USER_AGENT_MAX_LENGTH)
        : null,
  };
}

/**
 * Kunci batas laju per IP.
 *  - IPv4: alamatnya sendiri.
 *  - IPv6: awalan /64-nya — satu pelanggan biasanya memegang seluruh /64, jadi berganti-ganti
 *    alamat di dalamnya tidak boleh memberi jatah baru.
 *  - Alamat tidak sah: berbagi satu ember (lebih ketat, bukan lebih longgar).
 */
export function ipRateLimitKey(client: ClientInfo): string {
  if (client.ip === null) return 'ip-tidak-sah';
  if (isIP(client.ip) === 4) return client.ip;

  const address = client.ip.split('%')[0] ?? '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  if (mapped) return mapped;

  const [head = '', tail] = address.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = tail === undefined ? 0 : Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups];
  const prefix = groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':');
  return `${prefix}::/64`;
}
