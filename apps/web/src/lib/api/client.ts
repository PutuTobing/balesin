import {
  API_ROUTES,
  CSRF_HEADER_NAME,
  ERROR_MESSAGES,
  errorEnvelopeSchema,
  meResponseSchema,
  type ErrorCode,
  type ErrorDetail,
} from '@balesin/shared';
import type { z } from 'zod';
import { t } from '../../i18n/id';

/**
 * Klien HTTP tunggal untuk API (docs/KONTRAK-API-AUTH.md, "Aturan umum").
 *
 * - Selalu lewat proxy `/api` di origin yang sama, dengan `credentials: 'include'`.
 * - Token CSRF HANYA di memori (variabel modul), tidak pernah di localStorage/sessionStorage.
 *   Dipasang otomatis di header `X-CSRF-Token` untuk POST/PUT/PATCH/DELETE.
 * - 403 `CSRF_INVALID` → ambil token baru dari `/auth/me`, ulangi permintaan SEKALI.
 * - 401 `UNAUTHENTICATED` → sesi habis: pendengar `onSessionExpired` dipanggil (aplikasi
 *   membersihkan data dan membuka halaman masuk). 401 `INVALID_CREDENTIALS` dari login bukan
 *   sesi habis dan tidak memicunya.
 * - 429 → `retryAfterSeconds` dari header `Retry-After`.
 * - Respons sukses divalidasi dengan skema Zod dari `@balesin/shared`.
 */

/** Kode tambahan dari sisi web (bukan dari server). */
export type ClientErrorCode = 'NETWORK_ERROR' | 'INVALID_RESPONSE';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | ClientErrorCode | (string & {});
  readonly details: readonly ErrorDetail[];
  readonly requestId: string | null;
  /** Detik tunggu dari `Retry-After` (hanya 429/503). */
  readonly retryAfterSeconds: number | null;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    details?: readonly ErrorDetail[];
    requestId?: string | null;
    retryAfterSeconds?: number | null;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? [];
    this.requestId = init.requestId ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** `Retry-After` berupa detik atau tanggal HTTP → detik (dibulatkan ke atas, minimal 1). */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.max(1, Number(trimmed));
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(1, Math.ceil((date - now) / 1000));
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions<S extends z.ZodType> {
  method?: HttpMethod;
  body?: unknown;
  /** Skema respons sukses. */
  schema: S;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  /** Bawaan: `fetch` global (dipanggil saat request, jadi tes bisa menggantinya). */
  fetch?: typeof fetch;
}

export interface ApiClient {
  request<S extends z.ZodType>(path: string, options: RequestOptions<S>): Promise<z.output<S>>;
  setCsrfToken(token: string | null): void;
  getCsrfToken(): string | null;
  /** Dipanggil saat API menjawab 401 `UNAUTHENTICATED` (sesi habis/dicabut). */
  onSessionExpired(listener: (error: ApiError) => void): () => void;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  let csrfToken: string | null = null;
  const expiredListeners = new Set<(error: ApiError) => void>();
  const doFetch: typeof fetch = (...args) => (options.fetch ?? globalThis.fetch)(...args);

  async function send(path: string, method: HttpMethod, body: unknown, signal?: AbortSignal) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (MUTATING.has(method) && csrfToken) headers[CSRF_HEADER_NAME] = csrfToken;
    try {
      return await doFetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'include',
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: t.api.network });
    }
  }

  async function toError(response: Response): Promise<ApiError> {
    const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Bukan JSON (mis. halaman proxy). Pakai pesan cadangan di bawah.
    }
    const envelope = errorEnvelopeSchema.safeParse(payload);
    if (envelope.success) {
      const { code, message, details, requestId } = envelope.data.error;
      return new ApiError({
        status: response.status,
        code,
        message,
        details,
        requestId,
        retryAfterSeconds,
      });
    }
    return new ApiError({
      status: response.status,
      code: fallbackCode(response.status),
      message: fallbackMessage(response.status),
      retryAfterSeconds,
    });
  }

  /** Ambil token CSRF baru dari sesi yang masih hidup. */
  async function refreshCsrf(): Promise<boolean> {
    const response = await send(API_ROUTES.auth.me, 'GET', undefined);
    if (!response.ok) return false;
    const parsed = meResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return false;
    csrfToken = parsed.data.csrfToken;
    return true;
  }

  async function request<S extends z.ZodType>(
    path: string,
    { method = 'GET', body, schema, signal }: RequestOptions<S>,
  ): Promise<z.output<S>> {
    let response = await send(path, method, body, signal);

    if (!response.ok) {
      let error = await toError(response);
      if (error.code === 'CSRF_INVALID' && MUTATING.has(method) && (await refreshCsrf())) {
        response = await send(path, method, body, signal);
        error = response.ok ? error : await toError(response);
        if (!response.ok) throw handleFailure(error);
      } else {
        throw handleFailure(error);
      }
    }

    const payload: unknown =
      response.status === 204
        ? null
        : await response.json().catch(() => {
            throw new ApiError({
              status: response.status,
              code: 'INVALID_RESPONSE',
              message: t.api.invalidResponse,
            });
          });
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError({
        status: response.status,
        code: 'INVALID_RESPONSE',
        message: t.api.invalidResponse,
      });
    }
    return parsed.data;
  }

  function handleFailure(error: ApiError): ApiError {
    if (error.status === 401 && error.code === 'UNAUTHENTICATED') {
      csrfToken = null;
      for (const listener of expiredListeners) listener(error);
    }
    return error;
  }

  return {
    request,
    setCsrfToken(token) {
      csrfToken = token;
    },
    getCsrfToken() {
      return csrfToken;
    },
    onSessionExpired(listener) {
      expiredListeners.add(listener);
      return () => expiredListeners.delete(listener);
    },
  };
}

function fallbackCode(status: number): string {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503 || status === 502 || status === 504) return 'SERVICE_UNAVAILABLE';
  if (status === 404) return 'NOT_FOUND';
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status >= 500) return 'INTERNAL_ERROR';
  return 'BAD_REQUEST';
}

function fallbackMessage(status: number): string {
  const code = fallbackCode(status) as ErrorCode;
  // 502/504 dari proxy biasanya berarti API belum menyala.
  if (status === 502 || status === 504) return t.api.unreachable;
  return ERROR_MESSAGES[code];
}

/** Klien bersama aplikasi. */
export const api = createApiClient();
