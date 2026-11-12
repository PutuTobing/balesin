import { AppError } from '@balesin/core';
import { errorEnvelopeSchema, type ErrorEnvelope } from '@balesin/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DEFAULT_BODY_LIMIT_BYTES } from './app';
import { buildTestApp, TEST_APP_ORIGIN, type TestApp } from './testing/build-test-app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let current: TestApp | undefined;

/** Aplikasi tes + beberapa rute contoh untuk memancing tiap jenis error. */
async function setup(options: Parameters<typeof buildTestApp>[0] = {}): Promise<TestApp> {
  current = await buildTestApp(options);
  const { app } = current;

  app.post(
    '/__tes/pengguna/:id',
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        querystring: z.object({ halaman: z.coerce.number().int().min(1).default(1) }),
        body: z.object({
          email: z.email(),
          umur: z.number().int().min(17),
          alamat: z.object({ kota: z.string().min(1) }),
        }),
        response: { 200: z.object({ id: z.string(), email: z.string() }) },
      },
    },
    (request) =>
      Promise.resolve({
        id: request.params.id,
        email: request.body.email,
        // Kolom di luar skema respons tidak boleh ikut terkirim.
        passwordHash: 'hash-yang-tidak-boleh-bocor',
      }),
  );
  app.get('/__tes/galat-internal', () => {
    throw Object.assign(
      new Error('query gagal ke postgres://balesin:sandi-internal@db:5432/balesin'),
      { detail: 'Failing row contains (rahasia-baris)' },
    );
  });
  app.get('/__tes/galat-aplikasi', () => {
    throw new AppError('CONFLICT', {
      message: 'Email sudah dipakai pengguna lain.',
      details: [{ location: 'body', field: 'email', message: 'Email sudah dipakai.' }],
      cause: new Error('duplicate key (penyebab-internal)'),
    });
  });
  app.get('/__tes/terlarang', () => {
    throw new AppError('FORBIDDEN');
  });
  app.get('/__tes/galat-pustaka', () => {
    throw Object.assign(new Error('Too Many Requests from upstream-internal'), { statusCode: 429 });
  });
  app.get(
    '/__tes/respons-rusak',
    { schema: { response: { 200: z.object({ jumlah: z.number() }) } } },
    () => Promise.resolve({ jumlah: 'bukan angka' } as unknown as { jumlah: number }),
  );
  app.get('/__tes/ip', (request) => Promise.resolve({ ip: request.ip }));

  return current;
}

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

function parseEnvelope(body: string): ErrorEnvelope['error'] {
  return errorEnvelopeSchema.parse(JSON.parse(body)).error;
}

const validBody = { email: 'budi@contoh.com', umur: 20, alamat: { kota: 'Denpasar' } };
const validUrl = '/__tes/pengguna/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('amplop error', () => {
  it('404 untuk alamat yang tidak ada', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/tidak-ada' });

    expect(response.statusCode).toBe(404);
    const error = parseEnvelope(response.body);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Data atau alamat yang diminta tidak ditemukan.');
    expect(error.requestId).toMatch(UUID);
    expect(error.requestId).toBe(response.headers['x-request-id']);
  });

  it('400 dengan rincian per isian untuk body yang tidak valid', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: validUrl,
      payload: { email: 'bukan-email', umur: 12, alamat: {} },
    });

    expect(response.statusCode).toBe(400);
    const error = parseEnvelope(response.body);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('Data yang dikirim tidak valid. Periksa kembali isian Anda.');
    expect(error.details?.map((detail) => [detail.location, detail.field])).toEqual([
      ['body', 'email'],
      ['body', 'umur'],
      ['body', 'alamat.kota'],
    ]);
    // Pesan per isian berbahasa Indonesia dan tidak mengulang nilai yang dikirim.
    expect(error.details?.[0]?.message).toBe('alamat email tidak valid');
    expect(error.details?.[1]?.message).toMatch(/^Terlalu kecil/);
    expect(response.body).not.toContain('bukan-email');
  });

  it('isian wajib yang tidak dikirim diberi pesan "Wajib diisi."', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'POST', url: validUrl, payload: {} });

    expect(response.statusCode).toBe(400);
    expect(parseEnvelope(response.body).details).toEqual([
      { location: 'body', field: 'email', message: 'Wajib diisi.' },
      { location: 'body', field: 'umur', message: 'Wajib diisi.' },
      { location: 'body', field: 'alamat', message: 'Wajib diisi.' },
    ]);
  });

  it('400 untuk query dan params yang tidak valid, dengan lokasinya', async () => {
    const { app } = await setup();

    const badQuery = await app.inject({
      method: 'POST',
      url: `${validUrl}?halaman=0`,
      payload: validBody,
    });
    const badParams = await app.inject({
      method: 'POST',
      url: '/__tes/pengguna/bukan-uuid',
      payload: validBody,
    });

    expect(badQuery.statusCode).toBe(400);
    expect(parseEnvelope(badQuery.body).details).toMatchObject([
      { location: 'query', field: 'halaman' },
    ]);
    expect(badParams.statusCode).toBe(400);
    expect(parseEnvelope(badParams.body).details).toMatchObject([
      { location: 'params', field: 'id' },
    ]);
  });

  it('request yang valid lolos, dan respons disaring sesuai skema', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'POST', url: validUrl, payload: validBody });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      email: 'budi@contoh.com',
    });
    expect(response.body).not.toContain('hash-yang-tidak-boleh-bocor');
  });

  it('AppError dikirim apa adanya (kode, pesan, rincian), tanpa penyebab internalnya', async () => {
    const { app, logs } = await setup();

    const conflict = await app.inject({ method: 'GET', url: '/__tes/galat-aplikasi' });
    const forbidden = await app.inject({ method: 'GET', url: '/__tes/terlarang' });

    expect(conflict.statusCode).toBe(409);
    expect(parseEnvelope(conflict.body)).toMatchObject({
      code: 'CONFLICT',
      message: 'Email sudah dipakai pengguna lain.',
      details: [{ location: 'body', field: 'email', message: 'Email sudah dipakai.' }],
    });
    expect(conflict.body).not.toContain('penyebab-internal');
    expect(logs.text()).toContain('penyebab-internal');

    expect(forbidden.statusCode).toBe(403);
    const error = parseEnvelope(forbidden.body);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe('Anda tidak memiliki izin untuk melakukan tindakan ini.');
    expect(error.details).toBeUndefined();
  });

  it('error tak dikenal jadi 500 dengan pesan umum; detailnya hanya di log (tersensor)', async () => {
    const { app, logs } = await setup();

    const response = await app.inject({ method: 'GET', url: '/__tes/galat-internal' });

    expect(response.statusCode).toBe(500);
    const error = parseEnvelope(response.body);
    expect(error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Terjadi kesalahan di server. Coba lagi beberapa saat lagi.',
      requestId: response.headers['x-request-id'],
    });
    for (const leak of [
      'query gagal',
      'postgres://',
      'sandi-internal',
      'rahasia-baris',
      'app.test',
    ]) {
      expect(response.body).not.toContain(leak);
    }

    const logged = logs.entries().find((entry) => entry.level === 'error');
    expect(logged).toMatchObject({ requestId: error.requestId });
    const err = logged?.err as { message: string; stack: string };
    expect(err.message).toContain('query gagal ke postgres://');
    expect(err.stack).toContain('app.test');
    expect(logs.text()).not.toContain('sandi-internal');
    expect(logs.text()).not.toContain('rahasia-baris');
  });

  it('error 4xx dari pustaka memakai pesan umum, bukan pesan aslinya', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/__tes/galat-pustaka' });

    expect(response.statusCode).toBe(429);
    const error = parseEnvelope(response.body);
    expect(error.code).toBe('RATE_LIMITED');
    expect(response.body).not.toContain('upstream-internal');
  });

  it('respons yang tidak cocok dengan skemanya jadi 500, bukan data setengah benar', async () => {
    const { app, logs } = await setup();

    const response = await app.inject({ method: 'GET', url: '/__tes/respons-rusak' });

    expect(response.statusCode).toBe(500);
    expect(parseEnvelope(response.body).code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('bukan angka');
    expect(logs.entries().some((entry) => entry.level === 'error')).toBe(true);
  });

  it('400 untuk JSON yang rusak', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: validUrl,
      headers: { 'content-type': 'application/json' },
      payload: '{"email": "budi@contoh.com", ',
    });

    expect(response.statusCode).toBe(400);
    expect(parseEnvelope(response.body)).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Isi permintaan bukan JSON yang valid.',
    });
  });

  it('413 untuk body yang melewati batas ukuran', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: validUrl,
      payload: { ...validBody, catatan: 'x'.repeat(DEFAULT_BODY_LIMIT_BYTES) },
    });

    expect(response.statusCode).toBe(413);
    expect(parseEnvelope(response.body)).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Ukuran data yang dikirim terlalu besar.',
    });
  });

  it('415 untuk tipe konten yang tidak didukung', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: validUrl,
      headers: { 'content-type': 'application/xml' },
      payload: '<x/>',
    });

    expect(response.statusCode).toBe(415);
    expect(parseEnvelope(response.body).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('400 untuk URL yang rusak', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/__tes/%E0%A4%A' });

    expect(response.statusCode).toBe(400);
    expect(parseEnvelope(response.body)).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Alamat yang diminta tidak valid.',
    });
  });
});

describe('request ID', () => {
  it('dibuat server untuk tiap request; header dari klien diabaikan', async () => {
    const { app } = await setup();

    const first = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'id-palsu-dari-klien', 'request-id': 'id-palsu-lain' },
    });
    const second = await app.inject({ method: 'GET', url: '/health' });

    expect(first.headers['x-request-id']).toMatch(UUID);
    expect(second.headers['x-request-id']).toMatch(UUID);
    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });
});

describe('header keamanan', () => {
  it('memasang header keamanan untuk API JSON dan melarang cache', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers).toMatchObject({
      'content-security-policy':
        "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-site',
      'cross-origin-opener-policy': 'same-origin',
      'cache-control': 'no-store',
    });
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('header keamanan juga ada di respons error', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/tidak-ada' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('HSTS hanya di production', async () => {
    const { app } = await setup({ config: { isProduction: true } });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['strict-transport-security']).toBe(
      'max-age=15552000; includeSubDomains',
    );
  });
});

describe('CORS', () => {
  it('mengizinkan origin aplikasi dengan kredensial', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: TEST_APP_ORIGIN },
    });

    expect(response.headers['access-control-allow-origin']).toBe(TEST_APP_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-expose-headers']).toBe('x-request-id');
  });

  it('origin lain tidak mendapat izin CORS', async () => {
    const { app } = await setup();

    for (const origin of ['https://jahat.example', 'http://localhost:5174', 'null']) {
      const response = await app.inject({ method: 'GET', url: '/health', headers: { origin } });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('menjawab preflight dari origin aplikasi', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'OPTIONS',
      url: validUrl,
      headers: {
        origin: TEST_APP_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-csrf-token',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(TEST_APP_ORIGIN);
    expect(response.headers['access-control-allow-methods']).toBe(
      'GET, HEAD, POST, PUT, PATCH, DELETE',
    );
    expect(response.headers['access-control-allow-headers']).toBe('content-type, x-csrf-token');
  });

  it('preflight dari origin lain tidak diberi izin', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'OPTIONS',
      url: validUrl,
      headers: { origin: 'https://jahat.example', 'access-control-request-method': 'POST' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('log request', () => {
  it('mencatat method, path, dan status — tanpa header, query, atau body', async () => {
    const { app, logs } = await setup();

    await app.inject({
      method: 'POST',
      url: `${validUrl}?halaman=1&token=token-di-query`,
      headers: {
        authorization: 'Bearer token-di-header-123456',
        cookie: 'balesin_sid=sesi-di-cookie',
        'x-api-key': 'blsn_live_kunci-di-header',
      },
      payload: { ...validBody, email: 'pelanggan-rahasia@contoh.com' },
    });

    const entries = logs.entries();
    const incoming = entries.find((entry) => entry.msg === 'incoming request');
    const completed = entries.find((entry) => entry.msg === 'request completed');

    expect(incoming?.req).toMatchObject({ method: 'POST', url: validUrl });
    expect(incoming?.requestId).toMatch(UUID);
    expect(completed?.res).toEqual({ statusCode: 200 });
    expect(completed?.requestId).toBe(incoming?.requestId);
    for (const secret of [
      'token-di-query',
      'token-di-header-123456',
      'sesi-di-cookie',
      'kunci-di-header',
      'pelanggan-rahasia',
    ]) {
      expect(logs.text()).not.toContain(secret);
    }
  });
});

describe('trustProxy', () => {
  it('mengabaikan X-Forwarded-For bila proxy tidak dipercaya', async () => {
    const { app } = await setup({ config: { trustProxy: false } });

    const response = await app.inject({
      method: 'GET',
      url: '/__tes/ip',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });

    expect(response.json()).toEqual({ ip: '127.0.0.1' });
  });

  it('memakai X-Forwarded-For bila proxy dipercaya', async () => {
    const { app } = await setup({ config: { trustProxy: ['127.0.0.1'] } });

    const response = await app.inject({
      method: 'GET',
      url: '/__tes/ip',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });

    expect(response.json()).toEqual({ ip: '203.0.113.9' });
  });
});
