import { API_ROUTES, CSRF_HEADER_NAME, logoutResponseSchema } from '@balesin/shared';
import { describe, expect, it, vi } from 'vitest';
import { apiError, fakeSession, json } from '../../test/fake-api';
import { ApiError, createApiClient, parseRetryAfter } from './client';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      init,
    });
    const next = responses.shift();
    if (!next) throw new Error('Tidak ada respons tersisa');
    return Promise.resolve(next());
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const headerOf = (call: Call | undefined, name: string) =>
  (call?.init.headers as Record<string, string> | undefined)?.[name];

describe('klien API', () => {
  it('selalu credentials include; CSRF hanya untuk metode pengubah data', async () => {
    const { fetch, calls } = fakeFetch([
      () => json({ status: 'logged_out' }),
      () => json({ status: 'logged_out' }),
    ]);
    const client = createApiClient({ fetch });
    client.setCsrfToken('token-a');

    await client.request('/api/v1/x', { schema: logoutResponseSchema });
    await client.request('/api/v1/x', { method: 'POST', schema: logoutResponseSchema });

    expect(calls[0]?.init.credentials).toBe('include');
    expect(headerOf(calls[0], CSRF_HEADER_NAME)).toBeUndefined();
    expect(headerOf(calls[1], CSRF_HEADER_NAME)).toBe('token-a');
  });

  it('CSRF_INVALID: ambil token baru dari /auth/me lalu ulangi permintaan sekali', async () => {
    const fresh = { ...fakeSession(), csrfToken: 'token-baru' };
    const { fetch, calls } = fakeFetch([
      () => apiError(403, 'CSRF_INVALID', 'Halaman ini sudah terlalu lama terbuka.'),
      () => json(fresh),
      () => json({ status: 'logged_out' }),
    ]);
    const client = createApiClient({ fetch });
    client.setCsrfToken('token-lama');

    const result = await client.request(API_ROUTES.auth.logout, {
      method: 'POST',
      schema: logoutResponseSchema,
    });

    expect(result).toEqual({ status: 'logged_out' });
    expect(calls.map((call) => call.url)).toEqual([
      API_ROUTES.auth.logout,
      API_ROUTES.auth.me,
      API_ROUTES.auth.logout,
    ]);
    expect(headerOf(calls[2], CSRF_HEADER_NAME)).toBe('token-baru');
    expect(client.getCsrfToken()).toBe('token-baru');
  });

  it('CSRF_INVALID kedua kali tidak diulang lagi', async () => {
    const { fetch, calls } = fakeFetch([
      () => apiError(403, 'CSRF_INVALID', 'a'),
      () => json(fakeSession()),
      () => apiError(403, 'CSRF_INVALID', 'b'),
    ]);
    const client = createApiClient({ fetch });

    await expect(
      client.request('/api/v1/x', { method: 'PUT', schema: logoutResponseSchema }),
    ).rejects.toMatchObject({ code: 'CSRF_INVALID', message: 'b' });
    expect(calls).toHaveLength(3);
  });

  it('401 UNAUTHENTICATED = sesi habis: pendengar dipanggil dan token CSRF dibuang', async () => {
    const { fetch } = fakeFetch([
      () => apiError(401, 'UNAUTHENTICATED', 'Sesi kamu sudah berakhir.'),
    ]);
    const client = createApiClient({ fetch });
    client.setCsrfToken('token-a');
    const listener = vi.fn();
    client.onSessionExpired(listener);

    await expect(
      client.request('/api/v1/x', { schema: logoutResponseSchema }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(client.getCsrfToken()).toBeNull();
  });

  it('401 INVALID_CREDENTIALS (password salah) bukan sesi habis', async () => {
    const { fetch } = fakeFetch([
      () => apiError(401, 'INVALID_CREDENTIALS', 'Email atau password salah.'),
    ]);
    const client = createApiClient({ fetch });
    const listener = vi.fn();
    client.onSessionExpired(listener);

    await expect(
      client.request(API_ROUTES.auth.login, { method: 'POST', schema: logoutResponseSchema }),
    ).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('429 membawa detik tunggu dari Retry-After dan pesan server apa adanya', async () => {
    const { fetch } = fakeFetch([
      () => apiError(429, 'RATE_LIMITED', 'Coba lagi dalam 15 menit.', { retryAfter: 900 }),
    ]);
    const client = createApiClient({ fetch });

    const error = await client
      .request('/api/v1/x', { method: 'POST', schema: logoutResponseSchema })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'Coba lagi dalam 15 menit.',
      retryAfterSeconds: 900,
    });
  });

  it('error validasi membawa detail per isian', async () => {
    const { fetch } = fakeFetch([
      () =>
        apiError(400, 'VALIDATION_ERROR', 'Data tidak valid.', {
          details: [{ field: 'owner.password', message: 'Terlalu umum.' }],
        }),
    ]);
    const client = createApiClient({ fetch });
    await expect(
      client.request('/api/v1/x', { method: 'POST', schema: logoutResponseSchema }),
    ).rejects.toMatchObject({ details: [{ field: 'owner.password', message: 'Terlalu umum.' }] });
  });

  it('jaringan putus, jawaban bukan JSON, dan jawaban tak sesuai skema punya pesan Indonesia', async () => {
    const { fetch } = fakeFetch([
      () => {
        throw new TypeError('Failed to fetch');
      },
      () => new Response('<html>Bad Gateway</html>', { status: 502 }),
      () => json({ status: 'lain' }),
    ]);
    const client = createApiClient({ fetch });
    const call = () => client.request('/api/v1/x', { schema: logoutResponseSchema });

    await expect(call()).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
    await expect(call()).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('belum bisa dihubungi') as string,
    });
    await expect(call()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('parseRetryAfter', () => {
  it('menerima detik atau tanggal HTTP', () => {
    const now = Date.parse('2026-11-13T10:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter('Fri, 13 Nov 2026 10:01:00 GMT', now)).toBe(60);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('besok')).toBeNull();
    expect(parseRetryAfter('0')).toBe(1);
  });
});
