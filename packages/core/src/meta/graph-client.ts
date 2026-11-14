import { createHmac } from 'node:crypto';

import type { z } from 'zod';

import type { Secret } from '../secret';
import { classifyMetaError, MetaApiError } from './errors';

/**
 * Klien Graph API Meta TERPUSAT (ARCHITECTURE.md §6, SECURITY.md §3–4). Semua panggilan ke Meta —
 * dari api maupun worker — lewat sini:
 *
 * - Host tetap `https://graph.facebook.com` + versi yang dikunci di config (`META_GRAPH_VERSION`).
 *   Path disusun dari SEGMEN yang divalidasi (huruf/angka/garis bawah), jadi isian pengguna (ID
 *   Meta) tidak bisa membelokkan permintaan ke host/path lain (cegah SSRF). Base URL lain hanya bisa
 *   dipasang lewat config server di development/test (server Meta tiruan), tidak pernah dari UI.
 * - Token dikirim di header `Authorization`, bukan di URL; `appsecret_proof` (HMAC-SHA256 token
 *   dengan App Secret, heks) ikut di setiap panggilan yang App Secret-nya diketahui.
 * - Batas waktu per percobaan, tidak mengikuti redirect, ukuran jawaban dibatasi.
 * - Ulang otomatis dengan backoff eksponensial + jitter untuk gangguan sementara (hanya GET atau
 *   permintaan yang ditandai `idempotent`). Batas laju dihormati: waktu tunggu dari header
 *   `Retry-After` / `X-Business-Use-Case-Usage` (`estimated_time_to_regain_access`, menit); bila
 *   terlalu lama, langsung gagal `rate_limited` dan objek itu "didinginkan" di proses ini.
 * - Log hanya memuat operasi, status, kode Meta, percobaan, durasi, fbtrace_id — tidak pernah URL,
 *   query, token, atau App Secret.
 */

export const META_GRAPH_HOST = 'https://graph.facebook.com';

/**
 * Versi Graph API bawaan bila `META_GRAPH_VERSION` kosong. v26.0 rilis 29 Juli 2026 (changelog
 * developers.facebook.com/docs/graph-api/changelog, dibaca 14 Nov 2026); v27.0 baru rilis 4 Nov 2026
 * sehingga belum dipilih. Dinaikkan dengan sengaja (catat di docs/DECISIONS.md).
 */
export const DEFAULT_META_GRAPH_VERSION = 'v26.0';

export const META_GRAPH_VERSION_PATTERN = /^v\d{1,3}\.\d{1,2}$/;

export interface MetaCredentials {
  accessToken: Secret<string>;
  /** `null` = tanpa `appsecret_proof` (hanya untuk panggilan tanpa App Secret yang diketahui). */
  appSecret: Secret<string> | null;
}

export type MetaQueryValue = string | number | boolean | undefined;

export interface MetaRequest<T> {
  /** Nama tetap untuk log, mis. `phone_number.read`. Bukan data pengguna. */
  operation: string;
  method: 'GET' | 'POST' | 'DELETE';
  /** Segmen path setelah versi, mis. `[phoneNumberId, 'whatsapp_business_profile']`. */
  path: readonly string[];
  query?: Readonly<Record<string, MetaQueryValue>>;
  /** Dikirim sebagai JSON (karakter non-ASCII di-escape `\uXXXX`). */
  body?: Readonly<Record<string, unknown>>;
  /** Skema jawaban sukses. Jawaban yang tidak cocok → `unexpected_response`. */
  schema: z.ZodType<T>;
  /** `true` = aman diulang otomatis walau bukan GET (hasilnya sama bila terkirim dua kali). */
  idempotent?: boolean;
}

export interface MetaGraphLogger {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
}

export interface MetaGraphClientOptions {
  /** Versi Graph API, mis. `v26.0`. */
  version: string;
  /**
   * Hanya development/test (server Meta tiruan) — divalidasi config: production menolak. Bawaan
   * `META_GRAPH_HOST`.
   */
  baseUrl?: string | null;
  fetch?: typeof fetch;
  logger?: MetaGraphLogger;
  /** Batas waktu satu percobaan. Bawaan 10 detik. */
  timeoutMs?: number;
  /** Jumlah percobaan maksimal (termasuk yang pertama). Bawaan 3. */
  maxAttempts?: number;
  /** Tunda dasar backoff. Bawaan 500 ms (lalu 1 dtk, 2 dtk, … dengan jitter). */
  baseDelayMs?: number;
  /** Tunda maksimal satu backoff. Bawaan 8 detik. */
  maxDelayMs?: number;
  /** Batas laju yang tunggunya lebih lama dari ini tidak ditunggu (langsung gagal). Bawaan 5 dtk. */
  maxRateLimitWaitMs?: number;
  /** Ukuran jawaban maksimal. Bawaan 1 MiB. */
  maxResponseBytes?: number;
  /** Titik ganti untuk tes. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface MetaGraphClient {
  readonly version: string;
  request<T>(credentials: MetaCredentials, request: MetaRequest<T>): Promise<T>;
}

/** HMAC-SHA256 token akses dengan App Secret sebagai kunci, heks huruf kecil (dokumentasi Meta). */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

const SEGMENT_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const QUERY_KEY_PATTERN = /^[a-z_]{1,64}$/;

/** Tunda backoff ke-`attempt` (mulai 1): eksponensial, dibatasi, dengan jitter 50–100%. */
export function backoffDelayMs(
  attempt: number,
  options: { baseDelayMs: number; maxDelayMs: number; random: () => number },
): number {
  const exponential = options.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(options.maxDelayMs, exponential);
  return Math.round(capped * (0.5 + options.random() * 0.5));
}

/**
 * Detik tunggu dari header batas laju Meta: `Retry-After` (detik) atau
 * `X-Business-Use-Case-Usage` `{ "<id>": [{ "estimated_time_to_regain_access": <menit> }] }`.
 * `null` bila tidak ada keterangan.
 */
export function rateLimitWaitSeconds(headers: Headers): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null && /^\d{1,6}$/.test(retryAfter.trim())) {
    return Number(retryAfter.trim());
  }
  const usage = headers.get('x-business-use-case-usage');
  if (usage === null || usage.length > 16_384) return null;
  try {
    const parsed: unknown = JSON.parse(usage);
    if (typeof parsed !== 'object' || parsed === null) return null;
    let minutes: number | null = null;
    for (const entries of Object.values(parsed as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries.slice(0, 32)) {
        const value = (entry as { estimated_time_to_regain_access?: unknown } | null)
          ?.estimated_time_to_regain_access;
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          minutes = Math.max(minutes ?? 0, value);
        }
      }
    }
    return minutes === null ? null : Math.ceil(minutes * 60);
  } catch {
    return null;
  }
}

/** JSON dengan karakter non-ASCII di-escape (`\uXXXX`) — saran Meta untuk emoji di profil bisnis. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

async function readLimited(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizeBaseUrl(baseUrl: string | null | undefined): string {
  const value = baseUrl ?? META_GRAPH_HOST;
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Base URL Graph API harus http(s)');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Base URL Graph API tidak boleh memuat kredensial, query, atau fragmen');
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function createMetaGraphClient(options: MetaGraphClientOptions): MetaGraphClient {
  if (!META_GRAPH_VERSION_PATTERN.test(options.version)) {
    throw new Error('Versi Graph API harus berformat vNN.0');
  }
  const base = `${normalizeBaseUrl(options.baseUrl)}/${options.version}`;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 5_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const logger = options.logger;

  /**
   * Objek Meta (segmen pertama path, mis. Phone Number ID) yang sedang kena batas laju → kapan
   * boleh dicoba lagi. Selama itu permintaan ke objek yang sama langsung gagal tanpa memanggil
   * Meta (tidak memperparah hitungan batas laju).
   */
  const cooldowns = new Map<string, number>();

  function buildUrl(request: MetaRequest<unknown>, proof: string | null): URL {
    if (request.path.length === 0 || !request.path.every((part) => SEGMENT_PATTERN.test(part))) {
      throw new MetaApiError({ kind: 'invalid_parameter', operation: request.operation });
    }
    const url = new URL(`${base}/${request.path.join('/')}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value === undefined) continue;
      if (!QUERY_KEY_PATTERN.test(key) || key === 'access_token' || key === 'appsecret_proof') {
        throw new MetaApiError({ kind: 'invalid_parameter', operation: request.operation });
      }
      url.searchParams.set(key, String(value));
    }
    if (proof !== null) url.searchParams.set('appsecret_proof', proof);
    return url;
  }

  function cooldownKey(request: MetaRequest<unknown>): string {
    return request.path[0] ?? '';
  }

  async function attemptOnce<T>(
    credentials: MetaCredentials,
    request: MetaRequest<T>,
    url: URL,
    attempt: number,
  ): Promise<
    { ok: true; data: T } | { ok: false; error: MetaApiError; waitSeconds: number | null }
  > {
    const startedAt = now();
    const headers: Record<string, string> = {
      authorization: `Bearer ${credentials.accessToken.reveal()}`,
      accept: 'application/json',
    };
    let body: string | undefined;
    if (request.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = asciiJson(request.body);
    }

    let response: Response;
    try {
      response = await doFetch(url, {
        method: request.method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const timedOut =
        cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
      logger?.warn(
        {
          operation: request.operation,
          attempt,
          durationMs: now() - startedAt,
          reason: timedOut ? 'timeout' : 'network',
        },
        'Panggilan Graph API Meta gagal tersambung',
      );
      return {
        ok: false,
        error: new MetaApiError({
          kind: 'network_error',
          retryable: true,
          operation: request.operation,
          attempts: attempt,
        }),
        waitSeconds: null,
      };
    }

    const text = await readLimited(response, maxResponseBytes).catch(() => null);
    const json = text === null ? undefined : parseJson(text);
    const logBase = {
      operation: request.operation,
      attempt,
      status: response.status,
      durationMs: now() - startedAt,
    };

    if (response.status >= 200 && response.status < 300) {
      const parsed = json === undefined ? undefined : request.schema.safeParse(json);
      if (parsed?.success) {
        logger?.info(logBase, 'Panggilan Graph API Meta berhasil');
        return { ok: true, data: parsed.data };
      }
      logger?.warn(
        { ...logBase, reason: text === null ? 'too_large' : 'schema_mismatch' },
        'Jawaban Graph API Meta tidak sesuai bentuk yang diharapkan',
      );
      return {
        ok: false,
        error: new MetaApiError({
          kind: 'unexpected_response',
          httpStatus: response.status,
          operation: request.operation,
          attempts: attempt,
        }),
        waitSeconds: null,
      };
    }

    // 3xx (redirect tidak diikuti) dan jawaban non-JSON tanpa kode Meta.
    if (response.status >= 300 && response.status < 400) {
      logger?.warn({ ...logBase, reason: 'redirect' }, 'Graph API Meta menjawab redirect');
      return {
        ok: false,
        error: new MetaApiError({
          kind: 'unexpected_response',
          httpStatus: response.status,
          operation: request.operation,
          attempts: attempt,
        }),
        waitSeconds: null,
      };
    }

    const info = classifyMetaError(response.status, json);
    const waitSeconds =
      info.kind === 'rate_limited' ? rateLimitWaitSeconds(response.headers) : null;
    logger?.warn(
      {
        ...logBase,
        kind: info.kind,
        metaCode: info.metaCode,
        metaSubcode: info.metaSubcode,
        fbtraceId: info.fbtraceId,
        // Pesan Meta berguna untuk diagnosis; logger menyensor pola rahasia di dalamnya.
        metaMessage: info.metaMessage,
        waitSeconds,
      },
      'Graph API Meta menolak permintaan',
    );
    return {
      ok: false,
      error: new MetaApiError({
        kind: info.kind,
        retryable: info.retryable,
        httpStatus: response.status,
        metaCode: info.metaCode,
        metaSubcode: info.metaSubcode,
        fbtraceId: info.fbtraceId,
        retryAfterSeconds: waitSeconds,
        operation: request.operation,
        attempts: attempt,
      }),
      waitSeconds,
    };
  }

  return {
    version: options.version,

    async request<T>(credentials: MetaCredentials, request: MetaRequest<T>): Promise<T> {
      const proof =
        credentials.appSecret === null
          ? null
          : appSecretProof(credentials.accessToken.reveal(), credentials.appSecret.reveal());
      const url = buildUrl(request, proof);
      const repeatable = request.method === 'GET' || request.idempotent === true;
      const key = cooldownKey(request);

      for (let attempt = 1; ; attempt += 1) {
        const blockedUntil = cooldowns.get(key);
        if (blockedUntil !== undefined) {
          const remainingMs = blockedUntil - now();
          if (remainingMs > 0) {
            throw new MetaApiError({
              kind: 'rate_limited',
              retryable: true,
              retryAfterSeconds: Math.ceil(remainingMs / 1000),
              operation: request.operation,
              attempts: attempt - 1,
            });
          }
          cooldowns.delete(key);
        }

        const outcome = await attemptOnce(credentials, request, url, attempt);
        if (outcome.ok) return outcome.data;

        const { error } = outcome;
        // Jaringan putus pada permintaan yang tidak aman diulang: tidak diketahui apakah sudah
        // diproses Meta, jadi tidak diulang.
        const canRetry = error.retryable && repeatable && attempt < maxAttempts;

        if (error.kind === 'rate_limited') {
          const waitMs =
            outcome.waitSeconds === null
              ? backoffDelayMs(attempt, { baseDelayMs, maxDelayMs, random })
              : outcome.waitSeconds * 1000;
          if (!canRetry || waitMs > maxRateLimitWaitMs) {
            if (outcome.waitSeconds !== null && outcome.waitSeconds > 0) {
              cooldowns.set(key, now() + outcome.waitSeconds * 1000);
            }
            throw error;
          }
          await sleep(waitMs);
          continue;
        }

        if (!canRetry) throw error;
        await sleep(backoffDelayMs(attempt, { baseDelayMs, maxDelayMs, random }));
      }
    },
  };
}
