import { createHmac } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { Resolver } from 'node:dns/promises';
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
  // Membungkus IPv4 (review webhook keluar R2): IPv4-compatible (usang), 6to4, NAT64 local-use
  // (RFC 8215), Teredo — bisa menjangkau alamat internal lewat relay/terjemahan.
  ['::', 96],
  ['2002::', 16],
  ['64:ff9b:1::', 48],
  ['2001::', 32],
  // Review 9A-1 R1: IPv4-translated SIIT (`::ffff:0:a.b.c.d`, RFC 2765/6145).
  ['::ffff:0:0:0', 96],
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

/** `true` bila alamat IP ada di salah satu CIDR (bentuk baku `normalizePrivateCidr`). */
export function addressInCidrs(ip: string, cidrs: readonly string[]): boolean {
  return inCidrs(ip, cidrs);
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

/**
 * Resolusi bawaan (review webhook keluar R1): `dns.promises.Resolver` (c-ares, TANPA threadpool libuv
 * yang dipakai bersama kirim Meta/email/DB) dengan batas waktu per percobaan kecil; A + AAAA
 * paralel. Tidak membaca `/etc/hosts` — tujuan LAN dipakai lewat IP/DNS. Pemanggil tetap membungkusnya
 * dengan tenggat total (`withDeadline`).
 */
const defaultLookup: Lookup = async (hostname) => {
  const resolver = new Resolver({ timeout: 2_000, tries: 2 });
  const [v4, v6] = await Promise.allSettled([
    resolver.resolve4(hostname),
    resolver.resolve6(hostname),
  ]);
  const addresses: LookupAddress[] = [
    ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []),
    ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : []),
  ];
  if (addresses.length === 0) {
    resolver.cancel();
    throw new Error('dns');
  }
  return addresses;
};

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
    // Tenggat TOTAL mencakup DNS (review R1): DNS lambat tidak menahan worker melewati timeoutMs.
    try {
      addresses = await withDeadline(
        (request.lookup ?? defaultLookup)(host),
        request.timeoutMs ?? 10_000,
      );
    } catch (error) {
      const timedOut = error instanceof DeadlineError;
      return finish({
        ok: false,
        httpStatus: null,
        errorCode: timedOut ? 'timeout' : 'dns',
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

  // Sisa tenggat setelah DNS.
  const timeoutMs = Math.max(1, (request.timeoutMs ?? 10_000) - (Date.now() - started));
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

// ── Unduh berkas dari URL (media_url lapisan kompatibel MobiChat) ──────────

export type RemoteFileError =
  | WebhookTargetError
  | 'timeout'
  | 'network'
  | 'redirect'
  | 'too_large'
  | 'http'
  /** Tahap 9.1: host (awal ATAU tujuan redirect) di luar allowlist pemanggil (`allowHost`). */
  | 'host_not_allowed';

export interface RemoteFileRequest {
  url: string;
  privateCidrs: readonly string[];
  /** Batas ukuran; lebih dari ini → `too_large` (unduhan dihentikan). */
  maxBytes: number;
  /** Tenggat TOTAL (semua lompatan redirect + DNS). Bawaan 15 dtk. */
  timeoutMs?: number;
  /** Bawaan 3. Setiap lompatan diperiksa ulang aturan SSRF yang sama. */
  maxRedirects?: number;
  /**
   * Tahap 9.1 (lampiran email API): allowlist host milik pemanggil, diperiksa SEBELUM DNS di SETIAP
   * lompatan (URL awal + tiap redirect). `false` → `host_not_allowed` tanpa permintaan keluar.
   */
  allowHost?: (hostname: string) => boolean;
  lookup?: Lookup;
  /** HANYA tes: izinkan 127.0.0.1/::1 + port bebas (server tiruan). */
  allowLoopback?: boolean;
  /**
   * Header tambahan (mis. autentikasi konektor REST broadcast). HANYA dikirim ke origin URL awal —
   * redirect ke origin lain tidak membawanya. `accept`/`user-agent` bawaan bisa diganti.
   */
  headers?: Readonly<Record<string, string>>;
}

export type RemoteFileResult =
  | { ok: true; body: Buffer; contentType: string | null; finalUrl: URL }
  | { ok: false; error: RemoteFileError; httpStatus: number | null };

/**
 * GET berkas dari URL pihak ketiga dengan aturan SSRF yang SAMA dengan webhook keluar (alamat
 * terlarang selalu ditolak, privat hanya lewat allowlist, https wajib untuk publik, port dibatasi,
 * DNS sekali + soket ke alamat yang diperiksa). Redirect diikuti maks. `maxRedirects` kali dan SETIAP
 * lompatan diperiksa ulang. Isi dibaca maks. `maxBytes`. Tanpa cookie/kredensial apa pun.
 */
export async function fetchRemoteFile(request: RemoteFileRequest): Promise<RemoteFileResult> {
  const deadline = Date.now() + (request.timeoutMs ?? 15_000);
  const options = { allowLoopback: request.allowLoopback ?? false };
  let current = request.url;
  let originalOrigin: string | null = null;
  for (let hop = 0; hop <= (request.maxRedirects ?? 3); hop += 1) {
    if (request.allowHost) {
      // Allowlist host pemanggil diperiksa PALING DULU di setiap lompatan (sebelum port/DNS).
      let candidate: string | null;
      try {
        candidate = new URL(current).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      } catch {
        candidate = null;
      }
      if (candidate !== null && !request.allowHost(candidate)) {
        return { ok: false, error: 'host_not_allowed', httpStatus: null };
      }
    }
    const parsed = parseWebhookUrl(current, request.privateCidrs, options);
    if ('error' in parsed) return { ok: false, error: parsed.error, httpStatus: null };
    const { url, port } = parsed;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: readonly LookupAddress[];
    if (isIP(host) !== 0) {
      addresses = [{ address: host, family: isIP(host) }];
    } else {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, error: 'timeout', httpStatus: null };
      try {
        addresses = await withDeadline((request.lookup ?? defaultLookup)(host), remaining);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof DeadlineError ? 'timeout' : 'dns',
          httpStatus: null,
        };
      }
    }
    if (addresses.length === 0) return { ok: false, error: 'dns', httpStatus: null };
    for (const address of addresses) {
      const verdict = checkAddress(address.address, url.protocol, request.privateCidrs, options);
      if (verdict) return { ok: false, error: verdict, httpStatus: null };
    }
    const chosen = addresses[0] as LookupAddress;
    originalOrigin ??= url.origin;
    const extraHeaders = url.origin === originalOrigin ? (request.headers ?? {}) : {};
    const result = await getOnce(url, host, port, chosen, request.maxBytes, deadline, extraHeaders);
    if (result.kind === 'redirect') {
      try {
        current = new URL(result.location, url).href;
      } catch {
        return { ok: false, error: 'redirect', httpStatus: result.status };
      }
      continue;
    }
    return result.value;
  }
  return { ok: false, error: 'redirect', httpStatus: null };
}

class DeadlineError extends Error {}

/** Janji yang ditolak `DeadlineError` bila belum selesai dalam `ms`. */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DeadlineError('deadline'));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

type HopResult =
  | { kind: 'redirect'; location: string; status: number }
  | { kind: 'done'; value: RemoteFileResult };

function getOnce(
  url: URL,
  host: string,
  port: number,
  chosen: LookupAddress,
  maxBytes: number,
  deadline: number,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<HopResult> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<HopResult>((resolve) => {
    let settled = false;
    const done = (result: HopResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (error: RemoteFileError, httpStatus: number | null = null) => {
      done({ kind: 'done', value: { ok: false, error, httpStatus } });
    };
    const outgoing = send(
      {
        protocol: url.protocol,
        hostname: host,
        port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { 'user-agent': 'Balesin-Media/1.0', accept: '*/*', ...extraHeaders },
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
        if (status >= 300 && status < 400) {
          const location = response.headers.location;
          response.destroy();
          if (typeof location === 'string' && location !== '') {
            done({ kind: 'redirect', location, status });
          } else {
            fail('redirect', status);
          }
          return;
        }
        if (status < 200 || status >= 300) {
          response.destroy();
          fail('http', status);
          return;
        }
        const declared = Number(response.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          response.destroy();
          fail('too_large', status);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            fail('too_large', status);
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const type = response.headers['content-type'];
          done({
            kind: 'done',
            value: {
              ok: true,
              body: Buffer.concat(chunks),
              contentType: typeof type === 'string' ? type : null,
              finalUrl: url,
            },
          });
        });
        response.on('error', () => {
          fail('network', status);
        });
        response.on('close', () => {
          if (!response.complete) fail('network', status);
        });
      },
    );
    const timer = setTimeout(
      () => {
        outgoing.destroy();
        fail('timeout');
      },
      Math.max(1, deadline - Date.now()),
    );
    outgoing.on('error', () => {
      fail('network');
    });
    outgoing.end();
  });
}
