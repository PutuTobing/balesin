import { createHmac } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

import { OUTGOING_WEBHOOK_PORTS } from '@balesin/shared';

/**
 * Pengiriman webhook keluar yang aman dari SSRF (Fase 3, SECURITY §6):
 *  - alamat SELALU ditolak: loopback, link-local (termasuk metadata cloud 169.254.169.254 dan
 *    fd00:ec2::254), "this network" 0/8, multicast, broadcast, cadangan 240/4, IPv6 unspecified;
 *  - jaringan PRIVAT (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) hanya bila masuk allowlist
 *    IP privat organisasi;
 *  - DNS di-resolve SEKALI, SEMUA alamatnya diperiksa, lalu soket disambungkan ke alamat yang sudah
 *    diperiksa (`lookup` diganti) — tidak ada resolusi kedua (cegah DNS rebinding); SNI/Host tetap
 *    nama aslinya;
 *  - HTTPS wajib, kecuali tujuan IP privat yang diizinkan; port hanya `OUTGOING_WEBHOOK_PORTS`;
 *  - tanpa redirect, batas waktu total, isi jawaban dibaca maks. beberapa ratus byte.
 */

export type AddressClass = 'public' | 'private' | 'forbidden';

const FORBIDDEN = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
  ['192.0.0.0', 24],
  ['198.18.0.0', 15],
] as const) {
  FORBIDDEN.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fe80::', 10],
  ['ff00::', 8],
  ['fd00:ec2::254', 128],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
] as const) {
  FORBIDDEN.addSubnet(address, prefix, 'ipv6');
}

const PRIVATE = new BlockList();
for (const [address, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
] as const) {
  PRIVATE.addSubnet(address, prefix, 'ipv4');
}
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

/** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) → IPv4-nya. */
function unwrap(ip: string): { address: string; family: 'ipv4' | 'ipv6' } | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped) return { address: mapped, family: 'ipv4' };
  const family = isIP(ip);
  if (family === 0) return null;
  return { address: ip, family: family === 4 ? 'ipv4' : 'ipv6' };
}

export function classifyAddress(ip: string): AddressClass {
  const parsed = unwrap(ip);
  if (!parsed) return 'forbidden';
  if (FORBIDDEN.check(parsed.address, parsed.family)) return 'forbidden';
  if (PRIVATE.check(parsed.address, parsed.family)) return 'private';
  return 'public';
}

/**
 * CIDR allowlist yang sah dalam bentuk baku, atau `null`. Hanya jaringan PRIVAT yang boleh masuk
 * allowlist (CIDR yang menyentuh alamat terlarang/publik ditolak).
 */
export function normalizePrivateCidr(value: string): string | null {
  const [address, prefixText, ...rest] = value.trim().split('/');
  if (!address || rest.length > 0) return null;
  const parsed = unwrap(address);
  if (!parsed) return null;
  const max = parsed.family === 'ipv4' ? 32 : 128;
  const prefix =
    prefixText === undefined ? max : /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : -1;
  if (prefix < 0 || prefix > max) return null;
  if (classifyAddress(parsed.address) !== 'private') return null;
  // Prefiks harus seluruhnya di dalam rentang privat (mis. 10.0.0.0/7 menyentuh 11/8 → ditolak).
  const minimum =
    parsed.family === 'ipv6'
      ? 7
      : parsed.address.startsWith('10.')
        ? 8
        : parsed.address.startsWith('172.')
          ? 12
          : parsed.address.startsWith('192.168.')
            ? 16
            : 10;
  if (prefix < minimum) return null;
  return `${parsed.address.toLowerCase()}/${String(prefix)}`;
}

function inCidrs(ip: string, cidrs: readonly string[]): boolean {
  const parsed = unwrap(ip);
  if (!parsed) return false;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.split('/');
    if (!address || prefix === undefined) continue;
    list.addSubnet(address, Number(prefix), isIP(address) === 6 ? 'ipv6' : 'ipv4');
  }
  return list.check(parsed.address, parsed.family);
}

export type WebhookTargetError =
  | 'invalid_url'
  | 'scheme'
  | 'port'
  | 'credentials'
  | 'https_required'
  | 'blocked_address'
  | 'private_not_allowed'
  | 'dns';

export const WEBHOOK_TARGET_ERROR_MESSAGES: Readonly<Record<WebhookTargetError, string>> = {
  invalid_url: 'URL webhook tidak valid.',
  scheme: 'URL webhook harus diawali https:// (atau http:// untuk IP privat yang diizinkan).',
  port: `Port tidak diizinkan. Pakai ${OUTGOING_WEBHOOK_PORTS.join(', ')}.`,
  credentials: 'URL webhook tidak boleh memuat nama pengguna/password.',
  https_required: 'Webhook ke alamat publik wajib memakai https://.',
  blocked_address:
    'Alamat tujuan tidak diizinkan (loopback, link-local, metadata cloud, multicast, atau cadangan).',
  private_not_allowed:
    'Alamat tujuan ada di jaringan privat yang belum diizinkan. Tambahkan CIDR-nya di allowlist IP privat.',
  dns: 'Nama host tidak bisa di-resolve.',
};

export interface ParsedTarget {
  url: URL;
  port: number;
}

/** Pemeriksaan sintaksis URL (tanpa DNS) — dipakai saat menyimpan dan sebelum mengirim. */
export function parseWebhookUrl(
  raw: string,
  privateCidrs: readonly string[],
  options: { allowLoopback?: boolean } = {},
): ParsedTarget | { error: WebhookTargetError } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'invalid_url' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'scheme' };
  if (url.username !== '' || url.password !== '') return { error: 'credentials' };
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // Port bebas HANYA untuk server tiruan di loopback (tes).
  const loopbackTest = options.allowLoopback === true && (host === '127.0.0.1' || host === '::1');
  if (!(OUTGOING_WEBHOOK_PORTS as readonly number[]).includes(port) && !loopbackTest) {
    return { error: 'port' };
  }
  if (isIP(host) !== 0) {
    const verdict = checkAddress(host, url.protocol, privateCidrs, options);
    if (verdict) return { error: verdict };
  }
  return { url, port };
}

function checkAddress(
  ip: string,
  protocol: string,
  privateCidrs: readonly string[],
  options: { allowLoopback?: boolean },
): WebhookTargetError | null {
  const kind = classifyAddress(ip);
  if (kind === 'forbidden') {
    // Hanya tes: server penerima tiruan di 127.0.0.1 (diatur pemanggil, tidak pernah di produksi).
    const loopback = unwrap(ip)?.address;
    if (options.allowLoopback && (loopback === '127.0.0.1' || loopback === '::1')) return null;
    return 'blocked_address';
  }
  if (kind === 'private') return inCidrs(ip, privateCidrs) ? null : 'private_not_allowed';
  return protocol === 'https:' ? null : 'https_required';
}

export type Lookup = (hostname: string) => Promise<readonly LookupAddress[]>;

const defaultLookup: Lookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** `X-Balesin-Signature`: `t=<unix>,v1=<hex>` (+ `v1` rahasia lama selama masa tumpang tindih). */
export function webhookSignature(
  secrets: readonly string[],
  timestamp: number,
  body: string,
): string {
  const parts = [`t=${String(timestamp)}`];
  for (const secret of secrets) {
    parts.push(
      `v1=${createHmac('sha256', secret)
        .update(`${String(timestamp)}.${body}`)
        .digest('hex')}`,
    );
  }
  return parts.join(',');
}

export interface WebhookDeliveryRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  privateCidrs: readonly string[];
  timeoutMs?: number;
  /** Panjang potongan jawaban yang disimpan. */
  snippetBytes?: number;
  lookup?: Lookup;
  /** HANYA tes: izinkan 127.0.0.1/::1 + port bebas (server penerima tiruan). */
  allowLoopback?: boolean;
}

export interface WebhookDeliveryResult {
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  /** `http_<kode>` / `timeout` / `network` / `redirect` / galat target. */
  errorCode: string | null;
  snippet: string | null;
  /** Layak dicoba ulang (jaringan, 408/429/5xx). */
  retryable: boolean;
}

export async function deliverWebhook(
  request: WebhookDeliveryRequest,
): Promise<WebhookDeliveryResult> {
  const started = Date.now();
  const finish = (partial: Omit<WebhookDeliveryResult, 'durationMs'>): WebhookDeliveryResult => ({
    ...partial,
    durationMs: Date.now() - started,
  });
  const options = { allowLoopback: request.allowLoopback ?? false };
  const parsed = parseWebhookUrl(request.url, request.privateCidrs, options);
  if ('error' in parsed) {
    return finish({
      ok: false,
      httpStatus: null,
      errorCode: parsed.error,
      snippet: null,
      retryable: false,
    });
  }
  const { url, port } = parsed;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: readonly LookupAddress[];
  if (isIP(host) !== 0) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await (request.lookup ?? defaultLookup)(host);
    } catch {
      return finish({
        ok: false,
        httpStatus: null,
        errorCode: 'dns',
        snippet: null,
        retryable: true,
      });
    }
    if (addresses.length === 0) {
      return finish({
        ok: false,
        httpStatus: null,
        errorCode: 'dns',
        snippet: null,
        retryable: true,
      });
    }
  }
  // SEMUA alamat hasil DNS harus lolos (satu alamat terlarang = tolak; cegah campuran publik/privat).
  for (const address of addresses) {
    const verdict = checkAddress(address.address, url.protocol, request.privateCidrs, options);
    if (verdict) {
      return finish({
        ok: false,
        httpStatus: null,
        errorCode: verdict,
        snippet: null,
        retryable: false,
      });
    }
  }
  const chosen = addresses[0];
  if (!chosen) {
    return finish({
      ok: false,
      httpStatus: null,
      errorCode: 'dns',
      snippet: null,
      retryable: true,
    });
  }

  const timeoutMs = request.timeoutMs ?? 10_000;
  const snippetBytes = request.snippetBytes ?? 500;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<WebhookDeliveryResult>((resolve) => {
    let settled = false;
    const done = (result: Omit<WebhookDeliveryResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(finish(result));
    };
    const outgoing = send(
      {
        protocol: url.protocol,
        hostname: host,
        port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          ...request.headers,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(request.body)),
        },
        // Sambung ke alamat yang SUDAH diperiksa — tidak ada resolusi DNS kedua (rebinding).
        lookup: ((
          _hostname: string,
          lookupOptions: { all?: boolean },
          callback: (...args: unknown[]) => void,
        ) => {
          if (lookupOptions.all)
            callback(null, [{ address: chosen.address, family: chosen.family }]);
          else callback(null, chosen.address, chosen.family);
        }) as unknown as RequestOptions['lookup'],
        ...(url.protocol === 'https:' ? { servername: isIP(host) === 0 ? host : undefined } : {}),
        agent: false,
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          if (size < snippetBytes) chunks.push(chunk.subarray(0, snippetBytes - size));
          size += chunk.length;
          if (size >= snippetBytes) response.destroy();
        });
        const complete = () => {
          const snippet =
            Buffer.concat(chunks)
              .toString('utf8')
              .replace(/\p{Cc}/gu, ' ')
              .slice(0, snippetBytes) || null;
          if (status >= 200 && status < 300) {
            done({ ok: true, httpStatus: status, errorCode: null, snippet, retryable: false });
          } else if (status >= 300 && status < 400) {
            done({
              ok: false,
              httpStatus: status,
              errorCode: 'redirect',
              snippet,
              retryable: false,
            });
          } else {
            done({
              ok: false,
              httpStatus: status,
              errorCode: `http_${String(status)}`,
              snippet,
              retryable: status === 408 || status === 429 || status >= 500,
            });
          }
        };
        response.on('end', complete);
        response.on('close', complete);
        response.on('error', complete);
      },
    );
    const timer = setTimeout(() => {
      outgoing.destroy();
      done({ ok: false, httpStatus: null, errorCode: 'timeout', snippet: null, retryable: true });
    }, timeoutMs);
    outgoing.on('error', () => {
      done({ ok: false, httpStatus: null, errorCode: 'network', snippet: null, retryable: true });
    });
    outgoing.end(request.body);
  });
}
