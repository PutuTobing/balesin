import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { addressInCidrs, classifyAddress } from '../net/outgoing-webhook';
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

const BLOCKED_IPV4 = new BlockList();
// "Jaringan ini" / alamat tak-tentu.
BLOCKED_IPV4.addSubnet('0.0.0.0', 8, 'ipv4');
// Link-local, termasuk metadata cloud 169.254.169.254.
BLOCKED_IPV4.addSubnet('169.254.0.0', 16, 'ipv4');
// Multicast, cadangan, dan broadcast.
BLOCKED_IPV4.addSubnet('224.0.0.0', 4, 'ipv4');
BLOCKED_IPV4.addSubnet('240.0.0.0', 4, 'ipv4');
// Endpoint metadata cloud di luar rentang link-local.
BLOCKED_IPV4.addAddress('100.100.100.200', 'ipv4');
BLOCKED_IPV4.addAddress('192.0.0.192', 'ipv4');

const BLOCKED_IPV6 = new BlockList();
BLOCKED_IPV6.addSubnet('fe80::', 10, 'ipv6');
BLOCKED_IPV6.addSubnet('ff00::', 8, 'ipv6');
BLOCKED_IPV6.addAddress('fd00:ec2::254', 'ipv6');
// Teredo: alamat IPv4 tujuan tersamar di dalamnya (dan butuh relay pihak ketiga).
BLOCKED_IPV6.addSubnet('2001::', 32, 'ipv6');

/** Jaringan lokal: sah untuk relay internal, dan satu-satunya tempat "Tanpa enkripsi" + login boleh. */
const PRIVATE_IPV4 = new BlockList();
PRIVATE_IPV4.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_IPV4.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_IPV4.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_IPV4.addSubnet('127.0.0.0', 8, 'ipv4');
// Shared address space (CGNAT).
PRIVATE_IPV4.addSubnet('100.64.0.0', 10, 'ipv4');

const PRIVATE_IPV6 = new BlockList();
PRIVATE_IPV6.addAddress('::1', 'ipv6');
// Unique local (fc00::/7).
PRIVATE_IPV6.addSubnet('fc00::', 7, 'ipv6');

/** `blocked` = tidak boleh dituju; `private` = jaringan lokal/loopback; `public` = internet. */
export type MailAddressClass = 'blocked' | 'private' | 'public';

/** 16 byte alamat IPv6, atau `undefined` bila bentuknya tidak sah. */
function ipv6Bytes(address: string): number[] | undefined {
  const text = address.split('%')[0] ?? '';
  if (isIP(text) !== 6) return undefined;

  let head = text;
  const tail: number[] = [];
  // Bentuk berakhiran IPv4 bertitik, mis. `::ffff:1.2.3.4` atau `64:ff9b::1.2.3.4`.
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted?.[1] && dotted[2]) {
    head = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1);
    for (const part of dotted[2].split('.')) tail.push(Number(part));
  }

  const toBytes = (groups: string[]) =>
    groups.flatMap((group) => {
      const value = Number.parseInt(group, 16);
      return [value >> 8, value & 0xff];
    });
  const [left = '', right] = head.split('::');
  const leftBytes = left === '' ? [] : toBytes(left.split(':'));
  const rightBytes = right === undefined || right === '' ? [] : toBytes(right.split(':'));
  const missing = 16 - leftBytes.length - rightBytes.length - tail.length;
  if (missing < 0 || (right === undefined && missing !== 0)) return undefined;
  return [...leftBytes, ...Array<number>(missing).fill(0), ...rightBytes, ...tail];
}

const ipv4Of = (bytes: number[], indexes: number[]): string =>
  indexes.map((index) => bytes[index] ?? 0).join('.');

const startsWith = (bytes: number[], prefix: number[]): boolean =>
  prefix.every((value, index) => bytes[index] === value);

/**
 * Alamat IPv4 yang terbawa di dalam alamat IPv6 (dan ikut menentukan ke mana sambungan
 * sebenarnya sampai): IPv4-mapped `::ffff:0:0/96`, SIIT `::ffff:0:0:0/96`, NAT64
 * `64:ff9b::/96` dan `64:ff9b:1::/48` (semua posisi RFC 6052), serta 6to4 `2002::/16`.
 */
function embeddedIpv4(bytes: number[]): { addresses: string[]; translated: boolean } {
  const last32 = ipv4Of(bytes, [12, 13, 14, 15]);
  const zero = (from: number, to: number) => bytes.slice(from, to).every((value) => value === 0);

  // ::ffff:a.b.c.d (IPv4-mapped) dan ::ffff:0:a.b.c.d (SIIT) = alamat IPv4 itu sendiri.
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return { addresses: [last32], translated: true };
  }
  if (zero(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zero(10, 12)) {
    return { addresses: [last32], translated: true };
  }
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b]) && zero(4, 12)) {
    return { addresses: [last32], translated: true };
  }
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) {
    return {
      addresses: [
        ipv4Of(bytes, [6, 7, 9, 10]),
        ipv4Of(bytes, [7, 9, 10, 11]),
        ipv4Of(bytes, [9, 10, 11, 12]),
        last32,
      ],
      translated: true,
    };
  }
  if (startsWith(bytes, [0x20, 0x02])) {
    return { addresses: [ipv4Of(bytes, [2, 3, 4, 5])], translated: false };
  }
  return { addresses: [], translated: false };
}

function classifyIpv4(address: string): MailAddressClass {
  if (BLOCKED_IPV4.check(address, 'ipv4')) return 'blocked';
  return PRIVATE_IPV4.check(address, 'ipv4') ? 'private' : 'public';
}

/**
 * Menggolongkan alamat IP tujuan sambungan SMTP. Bukan alamat IP = `blocked`.
 *
 * Alamat IPv6 yang membawa IPv4 (lihat `embeddedIpv4`) diperiksa juga lewat IPv4-nya, supaya
 * `64:ff9b::a9fe:a9fe` (NAT64 ke 169.254.169.254) tidak lolos. `::/96` selain `::1` (bentuk
 * "IPv4-compatible" yang sudah usang) dan Teredo `2001::/32` selalu diblokir.
 */
export function classifyMailAddress(address: string): MailAddressClass {
  const family = isIP(address);
  if (family === 4) return classifyIpv4(address);
  if (family !== 6) return 'blocked';

  const bytes = ipv6Bytes(address);
  if (!bytes) return 'blocked';
  const normalized = bytes
    .reduce<string[]>((groups, value, index) => {
      if (index % 2 === 0) groups.push(((value << 8) | (bytes[index + 1] ?? 0)).toString(16));
      return groups;
    }, [])
    .join(':');

  if (BLOCKED_IPV6.check(normalized, 'ipv6')) return 'blocked';
  if (bytes.slice(0, 12).every((value) => value === 0)) {
    // ::1 = loopback; sisanya (`::`, `::a.b.c.d`) tidak pernah merupakan server email.
    return normalized === '0:0:0:0:0:0:0:1' ? 'private' : 'blocked';
  }

  const embedded = embeddedIpv4(bytes);
  const classes = embedded.addresses.map(classifyIpv4);
  if (classes.includes('blocked')) return 'blocked';
  if (embedded.translated) {
    // Sambungan sampai ke alamat IPv4 itu (lewat terjemahan): golongannya mengikuti IPv4-nya.
    return classes.every((value) => value === 'private') ? 'private' : 'public';
  }
  return PRIVATE_IPV6.check(normalized, 'ipv6') ? 'private' : 'public';
}

/** `true` bila alamat IP ini tidak boleh dituju sambungan SMTP. Bukan alamat IP = diblokir. */
export function isBlockedMailAddress(address: string): boolean {
  return classifyMailAddress(address) === 'blocked';
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
      /** Golongan alamat yang dituju (jaringan lokal atau internet). */
      addressClass: Exclude<MailAddressClass, 'blocked'>;
    }
  | { ok: false; code: 'host_not_found' | 'host_blocked' | 'connection_timeout' };

/**
 * Aturan KETAT untuk server akun Email (Fase 9, KONTRAK-API-EMAIL §4.3): selain daftar blokir di
 * atas, alamat yang SELALU ditolak webhook keluar (loopback, cadangan, pembungkus IPv4) juga ditolak,
 * dan alamat PRIVAT hanya diterima bila CIDR-nya ada di allowlist IP privat organisasi — akun Email
 * dibuat banyak orang (termasuk CS untuk akun pribadi), jadi tidak boleh menjadi jalan ke LAN.
 */
export interface StrictMailHostRule {
  privateCidrs: readonly string[];
  /** HANYA tes: server tiruan di 127.0.0.1/::1. Produksi tidak pernah mengisinya. */
  allowLoopback?: boolean;
}

export interface ResolveMailHostOptions {
  lookup?: HostLookup;
  timeoutMs?: number;
  /** Tanpa ini = aturan lama (Email pengirim sistem & channel Email: privat boleh). */
  strict?: StrictMailHostRule;
}

/** `true` bila alamat ini lolos aturan ketat (lihat `StrictMailHostRule`). */
export function strictMailAddressAllowed(address: string, rule: StrictMailHostRule): boolean {
  if (isBlockedMailAddress(address)) return false;
  const kind = classifyAddress(address);
  if (kind === 'forbidden') {
    const bare = address.replace(/^::ffff:/i, '');
    return rule.allowLoopback === true && (bare === '127.0.0.1' || bare === '::1');
  }
  if (kind === 'private') return addressInCidrs(address, rule.privateCidrs);
  return true;
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
    const addressClass = classifyMailAddress(literal);
    if (options.strict && !strictMailAddressAllowed(literal, options.strict)) {
      return { ok: false, code: 'host_blocked' };
    }
    return addressClass === 'blocked'
      ? { ok: false, code: 'host_blocked' }
      : { ok: true, address: literal, servername: undefined, addressClass };
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
  // Aturan ketat: SEMUA alamat hasil resolve harus lolos (DNS campuran tidak bisa dipakai lolos).
  const strict = options.strict;
  if (strict && addresses.some((entry) => !strictMailAddressAllowed(entry.address, strict))) {
    return { ok: false, code: 'host_blocked' };
  }

  // IPv4 didahulukan: banyak server email kecil tidak mendengarkan di IPv6 walau punya AAAA.
  const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  if (!chosen) return { ok: false, code: 'host_not_found' };
  // Golongan "jaringan lokal" hanya bila SEMUA alamat hasil resolve lokal.
  const addressClass = addresses.every((entry) => classifyMailAddress(entry.address) === 'private')
    ? 'private'
    : 'public';
  return { ok: true, address: chosen.address, servername: host, addressClass };
}
