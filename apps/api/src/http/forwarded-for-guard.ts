import { BlockList, isIP } from 'node:net';

import type { FastifyBaseLogger, FastifyRequest } from 'fastify';

/**
 * Penjaga salah konfigurasi `TRUST_PROXY` (review webhook S3, sebagian).
 *
 * Di production Balesin biasanya di belakang reverse proxy (vm-nginx / Caddy / cloudflared). Bila
 * `TRUST_PROXY=false`, semua permintaan tampak berasal dari IP proxy, sehingga batas laju per IP
 * (login, webhook) berubah menjadi SATU batas bersama untuk semua orang. Tandanya: permintaan datang
 * dari alamat privat/loopback DAN membawa `X-Forwarded-For`.
 *
 * Saat itu terjadi, log `error` ditulis SEKALI per proses (tanpa isi header — hanya alamat proxy,
 * yang memang alamat privat). Pengisian `TRUST_PROXY` otomatis oleh installer menyusul di Fase 7
 * (docs/DECISIONS.md).
 */

const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  // CGNAT / jaringan overlay (Tailscale, dsb.).
  ['100.64.0.0', 10],
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, 'ipv6');
}

/** `true` bila alamat ini privat/loopback (termasuk IPv4 yang dipetakan ke IPv6). */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  const candidate = mapped ?? address.split('%')[0] ?? '';
  const family = isIP(candidate);
  if (family === 0) return false;
  return PRIVATE_RANGES.check(candidate, family === 4 ? 'ipv4' : 'ipv6');
}

export interface ForwardedForGuardOptions {
  isProduction: boolean;
  trustProxy: boolean | string[];
  logger: FastifyBaseLogger;
}

type GuardedRequest = Pick<FastifyRequest, 'headers'> & {
  socket: { remoteAddress?: string | undefined };
};

/**
 * Hook `onRequest`, atau `null` bila tidak perlu (bukan production, atau `TRUST_PROXY` sudah diisi).
 * Hanya memeriksa ADA/TIDAKNYA header — isinya tidak pernah dibaca maupun di-log.
 */
export function createForwardedForGuard(
  options: ForwardedForGuardOptions,
): ((request: GuardedRequest) => void) | null {
  if (!options.isProduction || options.trustProxy !== false) return null;
  let reported = false;
  return (request) => {
    if (reported || request.headers['x-forwarded-for'] === undefined) return;
    const remote = request.socket.remoteAddress;
    if (!remote || !isPrivateAddress(remote)) return;
    reported = true;
    options.logger.error(
      { proxyAddress: remote },
      'TRUST_PROXY=false, tetapi permintaan datang lewat proxy (alamat privat + X-Forwarded-For). ' +
        'Alamat IP klien tidak terbaca: batas laju per IP berlaku bersama untuk semua orang. ' +
        'Isi TRUST_PROXY dengan alamat proxy tepercaya.',
    );
  };
}
