import { META_ERROR_MESSAGES } from '@balesin/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Secret } from '../secret';
import { classifyMetaError, MetaApiError } from './errors';
import {
  appSecretProof,
  asciiJson,
  backoffDelayMs,
  createMetaGraphClient,
  DEFAULT_META_GRAPH_VERSION,
  rateLimitWaitSeconds,
  type MetaGraphClientOptions,
} from './graph-client';
import { readPhoneNumber, updateBusinessProfile, wabaHasPhoneNumber } from './whatsapp';

const TOKEN = 'EAAGtesTokenRahasiaYangPanjangSekali0123456789';
const APP_SECRET = '0123456789abcdef0123456789abcdef';
const credentials = { accessToken: new Secret(TOKEN), appSecret: new Secret(APP_SECRET) };

function metaError(code: number, message = 'x', extra: Record<string, unknown> = {}) {
  return { error: { message, type: 'OAuthException', code, fbtrace_id: 'AbCdEf', ...extra } };
}

describe('classifyMetaError — kode error Meta → jenis + pesan Indonesia', () => {
  it.each([
    [190, 'Invalid OAuth access token - Cannot parse access token', 'token_invalid'],
    [190, 'Error validating access token: Session has expired on Monday', 'token_expired'],
    [0, 'App user could not be authenticated', 'token_invalid'],
    [100, 'Invalid appsecret_proof provided in the API argument', 'app_secret_invalid'],
    [100, 'API calls from the server require an appsecret_proof argument', 'app_secret_invalid'],
    [
      100,
      "Unsupported get request. Object with ID '123' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
      'not_found',
    ],
    [100, '(#100) Tried accessing nonexisting field (foo)', 'invalid_parameter'],
    [100, '(#100) Param about must be at most 139 characters long', 'invalid_parameter'],
    [33, 'This phone number has been deleted', 'not_found'],
    [10, 'Application does not have permission for this action', 'permission_denied'],
    [200, 'Provide valid app ID', 'permission_denied'],
    [299, 'Permission denied', 'permission_denied'],
    [131005, 'Access denied', 'permission_denied'],
    [4, 'Application request limit reached', 'rate_limited'],
    [80007, 'Rate limit hit', 'rate_limited'],
    [80008, 'Rate limit hit', 'rate_limited'],
    [130429, 'Rate limit hit', 'rate_limited'],
    [368, 'Temporarily blocked for policies violations', 'account_restricted'],
    [131031, 'Account has been locked', 'account_restricted'],
    [133010, 'Account not registered', 'phone_not_registered'],
    [131042, 'Business eligibility payment issue', 'payment_required'],
    [1, 'An unknown error occurred', 'temporarily_unavailable'],
    [2, 'Service temporarily unavailable', 'temporarily_unavailable'],
    [131000, 'Something went wrong', 'temporarily_unavailable'],
    [999999, 'Kode baru yang belum dikenal', 'unknown'],
  ] as const)('kode %i "%s" → %s', (code, message, kind) => {
    const info = classifyMetaError(400, metaError(code, message));
    expect(info.kind).toBe(kind);
    expect(info.metaCode).toBe(code);
    expect(info.fbtraceId).toBe('AbCdEf');
  });

  it('subkode 463 pada 190 = kedaluwarsa; subkode 33 pada 100 = tidak ditemukan', () => {
    expect(classifyMetaError(401, metaError(190, 'x', { error_subcode: 463 })).kind).toBe(
      'token_expired',
    );
    expect(classifyMetaError(400, metaError(100, 'x', { error_subcode: 33 })).kind).toBe(
      'not_found',
    );
  });

  it('hanya gangguan sementara dan batas laju yang boleh diulang', () => {
    expect(classifyMetaError(400, metaError(4)).retryable).toBe(true);
    expect(classifyMetaError(500, metaError(2)).retryable).toBe(true);
    expect(classifyMetaError(401, metaError(190)).retryable).toBe(false);
    expect(classifyMetaError(400, metaError(100)).retryable).toBe(false);
  });

  it('kode tak dikenal yang ditandai is_transient / 5xx dianggap sementara', () => {
    expect(classifyMetaError(400, metaError(424242, 'x', { is_transient: true })).kind).toBe(
      'temporarily_unavailable',
    );
    expect(classifyMetaError(503, metaError(424242)).kind).toBe('temporarily_unavailable');
  });

  it('jawaban tanpa amplop error Meta dipetakan dari status HTTP', () => {
    expect(classifyMetaError(502, undefined).kind).toBe('temporarily_unavailable');
    expect(classifyMetaError(429, '<html>').kind).toBe('rate_limited');
    expect(classifyMetaError(401, {}).kind).toBe('token_invalid');
    expect(classifyMetaError(404, { error: 'teks' }).kind).toBe('not_found');
    expect(classifyMetaError(418, null).kind).toBe('unknown');
  });

  it('isian berbeda tipe tidak membuat pemetaan gagal (toleran)', () => {
    const info = classifyMetaError(400, {
      error: { code: '190', message: 42, fbtrace_id: { a: 1 }, error_data: 'bukan objek' },
    });
    expect(info.kind).toBe('token_invalid');
    expect(info.fbtraceId).toBeNull();
  });

  it('MetaApiError membawa pesan Indonesia yang menjelaskan solusinya', () => {
    const error = new MetaApiError({ kind: 'token_expired', operation: 'phone_number.read' });
    expect(error.message).toBe(META_ERROR_MESSAGES.token_expired);
    expect(error.message).toMatch(/Pengguna Sistem/);
    for (const message of Object.values(META_ERROR_MESSAGES)) {
      expect(message).not.toMatch(/\banda\b/i);
      expect(message).toMatch(/\.$/);
    }
  });
});

describe('appsecret_proof', () => {
  it('HMAC-SHA256(token, kunci = App Secret) dalam heks huruf kecil', () => {
    // Vektor uji HMAC-SHA256 yang dikenal luas (kunci "key").
    expect(appSecretProof('The quick brown fox jumps over the lazy dog', 'key')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
  });
});

describe('backoff dan batas laju', () => {
  it('eksponensial dengan jitter 50–100%, dibatasi maksimal', () => {
    const options = { baseDelayMs: 500, maxDelayMs: 8_000 };
    expect(backoffDelayMs(1, { ...options, random: () => 1 })).toBe(500);
    expect(backoffDelayMs(2, { ...options, random: () => 1 })).toBe(1_000);
    expect(backoffDelayMs(3, { ...options, random: () => 0 })).toBe(1_000);
    expect(backoffDelayMs(10, { ...options, random: () => 1 })).toBe(8_000);
  });

  it('waktu tunggu dari Retry-After (detik) atau X-Business-Use-Case-Usage (menit)', () => {
    expect(rateLimitWaitSeconds(new Headers({ 'retry-after': '7' }))).toBe(7);
    expect(
      rateLimitWaitSeconds(
        new Headers({
          'x-business-use-case-usage': JSON.stringify({
            '102345': [
              { type: 'whatsapp', call_count: 100, estimated_time_to_regain_access: 2 },
              { type: 'whatsapp', call_count: 90, estimated_time_to_regain_access: 0 },
            ],
          }),
        }),
      ),
    ).toBe(120);
    expect(rateLimitWaitSeconds(new Headers({ 'x-business-use-case-usage': '{rusak' }))).toBeNull();
    expect(rateLimitWaitSeconds(new Headers())).toBeNull();
  });

  it('JSON dengan karakter non-ASCII di-escape (emoji di profil bisnis)', () => {
    const text = asciiJson({ about: 'Halo 👋 café' });
    expect(text).toBe('{"about":"Halo \\ud83d\\udc4b caf\\u00e9"}');
    expect(JSON.parse(text)).toEqual({ about: 'Halo 👋 café' });
  });
});

// ── Klien dengan fetch tiruan ───────────────────────────────────────────────

interface Captured {
  url: URL;
  init: RequestInit;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function clientWith(
  responses: Array<Response | Error>,
  options: Partial<MetaGraphClientOptions> = {},
) {
  const calls: Captured[] = [];
  const sleeps: number[] = [];
  const logs: Array<{ level: string; object: Record<string, unknown>; message: string }> = [];
  const queue = [...responses];
  const client = createMetaGraphClient({
    version: DEFAULT_META_GRAPH_VERSION,
    fetch: ((input: URL, init: RequestInit) => {
      calls.push({ url: new URL(String(input)), init });
      const next = queue.shift();
      if (!next) throw new Error('fetch dipanggil lebih banyak dari yang disiapkan');
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }) as typeof fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 1,
    logger: {
      info: (object, message) => logs.push({ level: 'info', object, message }),
      warn: (object, message) => logs.push({ level: 'warn', object, message }),
    },
    ...options,
  });
  return { client, calls, sleeps, logs };
}

const okSchema = z.object({ id: z.string() });

describe('createMetaGraphClient', () => {
  it('host tetap graph.facebook.com + versi; token di header, appsecret_proof di query', async () => {
    const { client, calls } = clientWith([json(200, { id: '123' })]);
    await client.request(credentials, {
      operation: 'tes',
      method: 'GET',
      path: ['123'],
      query: { fields: 'id' },
      schema: okSchema,
    });

    const [call] = calls;
    expect(call?.url.origin).toBe('https://graph.facebook.com');
    expect(call?.url.pathname).toBe(`/${DEFAULT_META_GRAPH_VERSION}/123`);
    expect(call?.url.searchParams.get('appsecret_proof')).toBe(appSecretProof(TOKEN, APP_SECRET));
    expect(call?.url.toString()).not.toContain(TOKEN);
    expect(call?.url.toString()).not.toContain(APP_SECRET);
    expect((call?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.init.redirect).toBe('manual');
  });

  it('menolak segmen path / kunci query yang bisa membelokkan permintaan (cegah SSRF)', async () => {
    const { client, calls } = clientWith([]);
    for (const path of [['..', 'me'], ['123/../../x'], ['a?b=1'], ['evil.com'], []]) {
      await expect(
        client.request(credentials, { operation: 'tes', method: 'GET', path, schema: okSchema }),
      ).rejects.toMatchObject({ kind: 'invalid_parameter' });
    }
    for (const key of ['access_token', 'appsecret_proof', 'Fields', 'a&b']) {
      await expect(
        client.request(credentials, {
          operation: 'tes',
          method: 'GET',
          path: ['123'],
          query: { [key]: 'x' },
          schema: okSchema,
        }),
      ).rejects.toMatchObject({ kind: 'invalid_parameter' });
    }
    expect(calls).toHaveLength(0);
  });

  it('base URL hanya http(s) tanpa kredensial/query; versi harus vNN.0', () => {
    expect(() => createMetaGraphClient({ version: 'v26' })).toThrow();
    expect(() => createMetaGraphClient({ version: 'v26.0', baseUrl: 'ftp://127.0.0.1' })).toThrow();
    expect(() =>
      createMetaGraphClient({ version: 'v26.0', baseUrl: 'http://a:b@127.0.0.1' }),
    ).toThrow();
  });

  it('mengulang gangguan sementara dengan backoff lalu berhasil', async () => {
    const { client, calls, sleeps } = clientWith([
      json(500, metaError(2, 'Service temporarily unavailable')),
      new TypeError('fetch failed'),
      json(200, { id: '123' }),
    ]);
    await expect(
      client.request(credentials, {
        operation: 'tes',
        method: 'GET',
        path: ['123'],
        schema: okSchema,
      }),
    ).resolves.toEqual({ id: '123' });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1_000]);
  });

  it('berhenti setelah percobaan maksimal', async () => {
    const { client, calls } = clientWith([
      json(500, metaError(1)),
      json(500, metaError(1)),
      json(500, metaError(1)),
    ]);
    await expect(
      client.request(credentials, {
        operation: 'tes',
        method: 'GET',
        path: ['123'],
        schema: okSchema,
      }),
    ).rejects.toMatchObject({ kind: 'temporarily_unavailable', attempts: 3 });
    expect(calls).toHaveLength(3);
  });

  it('kesalahan permanen (token) tidak diulang', async () => {
    const { client, calls } = clientWith([
      json(401, metaError(190, 'expired', { error_subcode: 463 })),
    ]);
    await expect(
      client.request(credentials, {
        operation: 'tes',
        method: 'GET',
        path: ['1'],
        schema: okSchema,
      }),
    ).rejects.toMatchObject({ kind: 'token_expired', retryable: false, httpStatus: 401 });
    expect(calls).toHaveLength(1);
  });

  it('POST yang tidak idempoten tidak diulang saat jaringan putus', async () => {
    const { client, calls } = clientWith([new TypeError('fetch failed')]);
    await expect(
      client.request(credentials, {
        operation: 'tes',
        method: 'POST',
        path: ['1', 'messages'],
        body: { a: 1 },
        schema: okSchema,
      }),
    ).rejects.toMatchObject({ kind: 'network_error' });
    expect(calls).toHaveLength(1);
  });

  it('batas laju: menunggu Retry-After bila singkat; bila lama langsung gagal + objek didinginkan', async () => {
    const short = clientWith([
      json(429, metaError(80007), { 'retry-after': '2' }),
      json(200, { id: '1' }),
    ]);
    await short.client.request(credentials, {
      operation: 'tes',
      method: 'GET',
      path: ['1'],
      schema: okSchema,
    });
    expect(short.sleeps).toEqual([2_000]);

    let clock = 1_000_000;
    const long = clientWith(
      [
        json(400, metaError(80007), {
          'x-business-use-case-usage': JSON.stringify({
            '1': [{ estimated_time_to_regain_access: 3 }],
          }),
        }),
      ],
      { now: () => clock },
    );
    const request = { operation: 'tes', method: 'GET' as const, path: ['1'], schema: okSchema };
    await expect(long.client.request(credentials, request)).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterSeconds: 180,
    });
    // Selama didinginkan, Meta tidak dipanggil sama sekali.
    await expect(long.client.request(credentials, request)).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    expect(long.calls).toHaveLength(1);
    clock += 181_000;
    // Setelah masa dingin lewat, Meta dipanggil lagi.
    await long.client.request(credentials, request).catch(() => undefined);
    expect(long.calls.length).toBeGreaterThan(1);
  });

  it('masa dingin: per kelompok operasi, dan paling lama 60 menit walau header Meta menyebut lebih', async () => {
    let clock = 5_000_000;
    const { client, calls } = clientWith(
      [
        json(400, metaError(80007), { 'retry-after': '999999' }),
        json(200, { id: '1' }),
        json(200, { id: '1' }),
      ],
      { now: () => clock },
    );
    const request = { operation: 'tes', method: 'GET' as const, path: ['1'], schema: okSchema };
    await expect(client.request(credentials, request)).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    // Kelompok pengiriman pesan tidak ikut didinginkan oleh batas laju pengelolaan.
    await expect(
      client.request(credentials, { ...request, rateLimitGroup: 'messaging' }),
    ).resolves.toEqual({ id: '1' });
    // Masih didinginkan (tanpa memanggil Meta), dengan sisa waktu dibatasi 60 menit.
    await expect(client.request(credentials, request)).rejects.toMatchObject({
      kind: 'rate_limited',
      retryAfterSeconds: 3600,
    });
    expect(calls).toHaveLength(2);
    clock += 60 * 60 * 1000 + 1;
    await expect(client.request(credentials, request)).resolves.toEqual({ id: '1' });
    expect(calls).toHaveLength(3);
  });

  it('tenggat total (signal): tidak ada ulangan setelah tenggat lewat; tenggat yang sudah lewat tidak memanggil Meta', async () => {
    const controller = new AbortController();
    const { client, calls } = clientWith(
      [json(503, metaError(2)), json(503, metaError(2)), json(200, { id: '1' })],
      {
        sleep: () => {
          controller.abort();
          return Promise.resolve();
        },
      },
    );
    const request = {
      operation: 'tes',
      method: 'GET' as const,
      path: ['1'],
      schema: okSchema,
      signal: controller.signal,
    };
    await expect(client.request(credentials, request)).rejects.toMatchObject({
      kind: 'network_error',
      attempts: 1,
    });
    expect(calls).toHaveLength(1);
    await expect(client.request(credentials, request)).rejects.toMatchObject({
      kind: 'network_error',
      attempts: 0,
    });
    expect(calls).toHaveLength(1);

    // Signal ikut diteruskan ke fetch (percobaan yang berjalan ikut dihentikan).
    const live = new AbortController();
    const forwarded = clientWith([json(200, { id: '1' })]);
    await forwarded.client.request(credentials, { ...request, signal: live.signal });
    const signal = forwarded.calls[0]?.init.signal;
    expect(signal?.aborted).toBe(false);
    live.abort();
    expect(signal?.aborted).toBe(true);
  });

  it('base URL tiruan hanya loopback dan hanya development/test (penjaga di klien, R6)', () => {
    const make = (baseUrl: string, nodeEnv: string | undefined) =>
      createMetaGraphClient({
        version: 'v26.0',
        baseUrl,
        environment: { NODE_ENV: nodeEnv },
      });
    expect(() => make('http://127.0.0.1:4010', 'test')).not.toThrow();
    expect(() => make('http://localhost:4010', 'development')).not.toThrow();
    expect(() => make('http://[::1]:4010', 'test')).not.toThrow();
    for (const nodeEnv of ['production', 'staging', undefined]) {
      expect(() => make('http://127.0.0.1:4010', nodeEnv)).toThrow(/development\/test/);
    }
    for (const host of [
      'http://graph.penyerang.test',
      'https://10.0.0.5',
      'http://169.254.169.254',
    ]) {
      expect(() => make(host, 'test')).toThrow(/loopback/);
    }
    // Host resmi selalu boleh, di lingkungan apa pun.
    expect(() => make('https://graph.facebook.com', 'production')).not.toThrow();
  });

  it('redirect tidak diikuti; jawaban kebesaran / tidak sesuai skema = unexpected_response', async () => {
    const { client } = clientWith(
      [
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
        new Response('x'.repeat(2_000), { status: 200 }),
        json(200, { bukan: 'id' }),
      ],
      { maxResponseBytes: 1_000 },
    );
    const request = { operation: 'tes', method: 'GET' as const, path: ['1'], schema: okSchema };
    for (let index = 0; index < 3; index += 1) {
      await expect(client.request(credentials, request)).rejects.toMatchObject({
        kind: 'unexpected_response',
      });
    }
  });

  it('log tidak pernah memuat token, App Secret, proof, atau URL', async () => {
    const { client, logs } = clientWith([json(401, metaError(190, 'Invalid OAuth access token'))]);
    await client
      .request(credentials, { operation: 'tes', method: 'GET', path: ['1'], schema: okSchema })
      .catch(() => undefined);
    const text = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [TOKEN, APP_SECRET, appSecretProof(TOKEN, APP_SECRET), 'graph.facebook']) {
      expect(text).not.toContain(secret);
    }
    expect(logs[0]?.object).toMatchObject({ operation: 'tes', status: 401, metaCode: 190 });
  });
});

describe('operasi WhatsApp', () => {
  it('readPhoneNumber: bentuk toleran; batas pesan dari isian baru atau lama', async () => {
    const { client } = clientWith([
      json(200, {
        id: '111',
        display_phone_number: '+62 811-0000-111',
        verified_name: 'Maju Jaya',
        quality_rating: 'GREEN',
        status: 'CONNECTED',
        name_status: 42,
        whatsapp_business_manager_messaging_limit: 'TIER_2K',
        throughput: { level: 'STANDARD' },
        isian_baru: true,
      }),
    ]);
    await expect(readPhoneNumber(client, credentials, '111')).resolves.toEqual({
      id: '111',
      displayPhoneNumber: '+62 811-0000-111',
      verifiedName: 'Maju Jaya',
      qualityRating: 'GREEN',
      status: 'CONNECTED',
      nameStatus: null,
      codeVerificationStatus: null,
      messagingLimit: 'TIER_2K',
      throughputLevel: 'STANDARD',
    });
  });

  it('readPhoneNumber: isian yang tidak dikenal versi API → ulang dengan isian dasar', async () => {
    const { client, calls } = clientWith([
      json(400, metaError(100, '(#100) Tried accessing nonexisting field (throughput)')),
      json(200, { id: '111', quality_rating: 'YELLOW' }),
    ]);
    const result = await readPhoneNumber(client, credentials, '111');
    expect(result.qualityRating).toBe('YELLOW');
    expect(calls[1]?.url.searchParams.get('fields')).not.toContain('throughput');
  });

  it('wabaHasPhoneNumber: menelusuri kursor `after`, tidak mengikuti URL `next` dari Meta', async () => {
    const { client, calls } = clientWith([
      json(200, {
        data: [{ id: '1' }],
        paging: { cursors: { after: 'QVFIUk' }, next: 'https://evil.example/steal' },
      }),
      json(200, { data: [{ id: '222' }] }),
    ]);
    await expect(wabaHasPhoneNumber(client, credentials, '999', '222')).resolves.toBe(true);
    expect(calls.map((call) => call.url.origin)).toEqual([
      'https://graph.facebook.com',
      'https://graph.facebook.com',
    ]);
    expect(calls[1]?.url.searchParams.get('after')).toBe('QVFIUk');
  });

  it('updateBusinessProfile: hanya isian yang dikirim + messaging_product', async () => {
    const { client, calls } = clientWith([json(200, { success: true })]);
    await updateBusinessProfile(client, credentials, '111', { about: 'Halo', websites: [] });
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      about: 'Halo',
      websites: [],
    });
    expect(calls[0]?.url.pathname).toBe(
      `/${DEFAULT_META_GRAPH_VERSION}/111/whatsapp_business_profile`,
    );
  });
});
