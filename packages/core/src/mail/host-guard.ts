import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { withTimeout } from '../timeout';

/**
 * Penjaga alamat tujuan untuk sambungan SMTP keluar.
 *
 * Host SMTP diisi pengguna, jadi tes koneksi dan pengiriman email adalah permukaan SSRF
 * (SECURITY.md §6). Server email di jaringan privat/loopback SAH (relay internal, Postfix di
 * host yang sama), jadi tidak diblokir; yang selalu diblokir adalah alamat yang tidak pernah
 * merupakan server email: link-local (termasuk endpoint metadata cloud), alamat tak-tentu,
 * multicast, dan rentang cadangan.
 *
 * Nama host di-resolve SEKALI di sini, lalu sambungan dibuat ke alamat IP hasilnya — bukan ke
 * nama host — supaya jawaban DNS tidak bisa berubah di antara pemeriksaan dan sambungan.
 */

const BLOCKED_ADDRESSES = new BlockList();
// "Jaringan ini" / alamat tak-tentu.
BLOCKED_ADDRESSES.addSubnet('0.0.0.0', 8, 'ipv4');
// Link-local, termasuk metadata cloud 169.254.169.254.
BLOCKED_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4');
// Multicast, cadangan, dan broadcast.
BLOCKED_ADDRESSES.addSubnet('224.0.0.0', 4, 'ipv4');
BLOCKED_ADDRESSES.addSubnet('240.0.0.0', 4, 'ipv4');
// Endpoint metadata cloud di luar rentang link-local.
BLOCKED_ADDRESSES.addAddress('100.100.100.200', 'ipv4');
BLOCKED_ADDRESSES.addAddress('192.0.0.192', 'ipv4');
BLOCKED_ADDRESSES.addAddress('::', 'ipv6');
BLOCKED_ADDRESSES.addSubnet('fe80::', 10, 'ipv6');
BLOCKED_ADDRESSES.addSubnet('ff00::', 8, 'ipv6');
BLOCKED_ADDRESSES.addAddress('fd00:ec2::254', 'ipv6');

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** `true` bila alamat IP ini tidak boleh dituju sambungan SMTP. Bukan alamat IP = diblokir. */
export function isBlockedMailAddress(address: string): boolean {
  const mapped = IPV4_MAPPED.exec(address)?.[1];
  const candidate = mapped ?? address;
  const family = isIP(candidate);
  if (family === 0) return true;
  return BLOCKED_ADDRESSES.check(candidate, family === 4 ? 'ipv4' : 'ipv6');
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Bisa diganti di tes. Bawaan: resolver sistem (`dns.lookup`), semua alamat. */
export type HostLookup = (host: string) => Promise<ResolvedAddress[]>;

const systemLookup: HostLookup = (host) => dnsLookup(host, { all: true, verbatim: true });

export type ResolveMailHostResult =
  | {
      ok: true;
      /** Alamat IP yang dituju. */
      address: string;
      /** Nama untuk verifikasi sertifikat TLS (SNI); `undefined` bila host berupa alamat IP. */
      servername: string | undefined;
    }
  | { ok: false; code: 'host_not_found' | 'host_blocked' | 'connection_timeout' };

export interface ResolveMailHostOptions {
  lookup?: HostLookup;
  timeoutMs?: number;
}

/**
 * Menentukan alamat IP yang akan dituju untuk `host`. Ditolak bila SALAH SATU alamat hasil
 * resolve terblokir — catatan DNS campuran (satu alamat wajar, satu alamat internal) tidak
 * bisa dipakai untuk lolos.
 */
export async function resolveMailHost(
  host: string,
  options: ResolveMailHostOptions = {},
): Promise<ResolveMailHostResult> {
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(literal) !== 0) {
    return isBlockedMailAddress(literal)
      ? { ok: false, code: 'host_blocked' }
      : { ok: true, address: literal, servername: undefined };
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await withTimeout(
      (options.lookup ?? systemLookup)(host),
      options.timeoutMs ?? 5_000,
      'Resolusi DNS host SMTP',
    );
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof Error && error.name === 'TimeoutError'
          ? 'connection_timeout'
          : 'host_not_found',
    };
  }

  if (addresses.length === 0) return { ok: false, code: 'host_not_found' };
  if (addresses.some((entry) => isBlockedMailAddress(entry.address))) {
    return { ok: false, code: 'host_blocked' };
  }

  // IPv4 didahulukan: banyak server email kecil tidak mendengarkan di IPv6 walau punya AAAA.
  const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  if (!chosen) return { ok: false, code: 'host_not_found' };
  return { ok: true, address: chosen.address, servername: host };
}
