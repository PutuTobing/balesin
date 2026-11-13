/**
 * Tes keamanan dari review Fase 0 (docs/security-reviews/2026-11-13-fase0-fondasi.md).
 *
 * Cara membaca berkas ini:
 *  - `it(...)` biasa = penjaga regresi: perilaku ini SUDAH aman dan harus tetap begitu.
 *  - `it(...)` = CELAH YANG MASIH TERBUKA. Isi tesnya menyatakan perilaku yang BENAR dan
 *    saat ini memang gagal. Setelah celahnya diperbaiki, Vitest melaporkan tes itu "diharapkan
 *    gagal tetapi lulus" — saat itu hapus `.fails`-nya supaya menjadi penjaga regresi biasa.
 *    Kode temuan (S3, R4, R5, R6) merujuk ke laporan review.
 */
import { EnvValidationError, type EnvSource } from '@balesin/core';
import { errorEnvelopeSchema } from '@balesin/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config';
import { buildTestApp, type TestApp } from './testing/build-test-app';

let current: TestApp | undefined;

async function setup(options: Parameters<typeof buildTestApp>[0] = {}): Promise<TestApp> {
  current = await buildTestApp(options);
  const { app } = current;

  app.get('/__tes/klien', (request) =>
    Promise.resolve({ ip: request.ip, host: request.host, protocol: request.protocol }),
  );
  app.post('/__tes/aksi', (request) => Promise.resolve({ bodyType: typeof request.body }));
  app.get('/__tes/lempar-teks', () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- sengaja: pustaka pihak ketiga kadang melempar bukan-Error
    throw 'gagal ke postgres://balesin:sandi-teks@db:5432/balesin';
  });
  app.get('/__tes/lempar-objek', () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- sengaja: pustaka pihak ketiga kadang melempar bukan-Error
    throw { message: 'ditolak upstream', password: 'sandi-objek', token: 'token-objek' };
  });
  app.get('/__tes/upstream-401', () => {
    // Bentuk error klien HTTP pihak ketiga saat API luar (mis. Graph API Meta) menjawab 401.
    throw Object.assign(new Error('token Meta kedaluwarsa (penyebab-upstream)'), {
      statusCode: 401,
    });
  });

  return current;
}

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

const productionEnv: EnvSource = {
  NODE_ENV: 'production',
  APP_URL: 'https://balesin.contoh.co.id',
  API_URL: 'https://balesin.contoh.co.id/api',
  DATABASE_URL: 'postgres://balesin:sandi-db@db:5432/balesin',
  REDIS_URL: 'redis://:sandi-redis@redis:6379',
  BALESIN_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_SECRET: 'rahasia-sesi-yang-panjangnya-lebih-dari-32-karakter',
};

describe('S3 — TRUST_PROXY dan alamat IP klien', () => {
  const spoofed = {
    'x-forwarded-for': '6.6.6.6, 203.0.113.9',
    'x-forwarded-host': 'jahat.example',
    'x-forwarded-proto': 'https',
  };

  it('tanpa proxy tepercaya, semua header X-Forwarded-* diabaikan', async () => {
    const { app } = await setup({ config: { trustProxy: false } });

    const response = await app.inject({
      method: 'GET',
      url: '/__tes/klien',
      headers: { ...spoofed, host: 'api.contoh.id' },
    });

    expect(response.json()).toEqual({ ip: '127.0.0.1', host: 'api.contoh.id', protocol: 'http' });
  });

  it('dengan daftar IP proxy, IP klien = hop terakhir yang ditulis proxy, bukan kiriman klien', async () => {
    const { app } = await setup({ config: { trustProxy: ['127.0.0.1'] } });

    const response = await app.inject({ method: 'GET', url: '/__tes/klien', headers: spoofed });

    // "6.6.6.6" dikirim klien sendiri; "203.0.113.9" ditambahkan proxy tepercaya.
    expect(response.json<{ ip: string }>().ip).toBe('203.0.113.9');
  });

  it('fakta pustaka: `true` mempercayai SEMUA hop, jadi IP klien bisa dipalsukan', async () => {
    const { app } = await setup({ config: { trustProxy: true } });

    const response = await app.inject({ method: 'GET', url: '/__tes/klien', headers: spoofed });

    // Inilah sebabnya TRUST_PROXY=true tidak boleh diterima di production: batas login
    // per IP dan IP di audit log (Fase 1) memakai nilai ini.
    expect(response.json<{ ip: string }>().ip).toBe('6.6.6.6');
  });

  it('production menolak TRUST_PROXY=true dan meminta IP/CIDR proxy', () => {
    expect(() => loadConfig({ ...productionEnv, TRUST_PROXY: 'true' })).toThrow(EnvValidationError);
  });

  it('production menerima daftar IP/CIDR proxy', () => {
    const config = loadConfig({ ...productionEnv, TRUST_PROXY: '10.0.0.2,10.0.1.0/24' });

    expect(config.trustProxy).toEqual(['10.0.0.2', '10.0.1.0/24']);
  });

  it('fakta pustaka: lewat proxy tepercaya, `request.ip` bisa bukan alamat IP dan host/protokol ikut header', async () => {
    const { app } = await setup({ config: { trustProxy: ['127.0.0.1'] } });

    const response = await app.inject({
      method: 'GET',
      url: '/__tes/klien',
      headers: {
        'x-forwarded-for': 'bukan-alamat-ip',
        'x-forwarded-host': 'jahat.example',
        'x-forwarded-proto': 'gopher',
      },
    });

    // Catatan Fase 1: validasi `request.ip` (net.isIP) sebelum masuk kolom `inet` / kunci rate
    // limit, dan JANGAN menyusun tautan (reset password, undangan) dari `request.host` atau
    // `request.protocol` — selalu dari `config.appUrl`.
    expect(response.json()).toEqual({
      ip: 'bukan-alamat-ip',
      host: 'jahat.example',
      protocol: 'gopher',
    });
  });
});

describe('error handler tidak membocorkan apa pun, apa pun yang dilempar', () => {
  it.each(['/__tes/lempar-teks', '/__tes/lempar-objek'])(
    '%s → 500 dengan pesan umum; rahasia tidak ada di respons maupun log',
    async (url) => {
      const { app, logs } = await setup();

      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(500);
      const { error } = errorEnvelopeSchema.parse(response.json());
      expect(error.code).toBe('INTERNAL_ERROR');
      for (const leak of ['sandi-teks', 'sandi-objek', 'token-objek', 'upstream', 'postgres://']) {
        expect(response.body).not.toContain(leak);
      }
      for (const secret of ['sandi-teks', 'sandi-objek', 'token-objek']) {
        expect(logs.text()).not.toContain(secret);
      }
      expect(logs.entries().some((entry) => entry.level === 'error')).toBe(true);
    },
  );

  it('404 tidak memantulkan alamat yang diminta', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: '/tidak-ada/<script>alert(1)</script>?token=token-di-query',
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).not.toContain('script');
    expect(response.body).not.toContain('token-di-query');
  });

  it('R4 — error 4xx dari pustaka/upstream tetap tercatat penyebabnya di log', async () => {
    const { app, logs } = await setup();

    const response = await app.inject({ method: 'GET', url: '/__tes/upstream-401' });

    // Pesan asli tidak boleh sampai ke klien (ini sudah benar) …
    expect(response.body).not.toContain('penyebab-upstream');
    // … tetapi harus ada di log; sekarang hilang sama sekali sehingga insiden tidak terlacak.
    expect(logs.text()).toContain('penyebab-upstream');
  });

  it('R4 — 401 dari API luar tidak diteruskan sebagai "kamu belum login"', async () => {
    const { app } = await setup();

    const response = await app.inject({ method: 'GET', url: '/__tes/upstream-401' });

    // Hanya AppError (dan error Fastify sendiri) yang boleh menentukan status 4xx.
    expect(response.statusCode).toBe(500);
  });
});

describe('R6 — respons error dari tingkat framework (sebelum hook berjalan)', () => {
  const urls = ['/%zz', `/__tes/barang/${'a'.repeat(300)}`];

  it('tetap berbentuk amplop JSON umum dan tidak memantulkan alamat yang diminta', async () => {
    const { app } = await setup();
    app.get('/__tes/barang/:id', () => Promise.resolve({ ok: true }));

    for (const url of urls) {
      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(response.statusCode, url).toBeLessThan(500);
      expect(response.headers['content-type'], url).toContain('application/json');
      expect(errorEnvelopeSchema.parse(response.json()).error.code, url).toBe('BAD_REQUEST');
      expect(response.body, url).not.toContain('zz');
      expect(response.body, url).not.toContain('aaaa');
    }
  });

  it('tetap membawa header keamanan, larangan cache, dan x-request-id', async () => {
    const { app } = await setup();
    app.get('/__tes/barang/:id', () => Promise.resolve({ ok: true }));

    for (const url of urls) {
      const response = await app.inject({ method: 'GET', url });

      expect(response.headers['x-content-type-options'], url).toBe('nosniff');
      expect(response.headers['cache-control'], url).toBe('no-store');
      expect(response.headers['x-request-id'], url).toBeTypeOf('string');
    }
  });
});

describe('R5 — permintaan lintas-situs "sederhana" (tanpa preflight CORS)', () => {
  it('origin asing tidak pernah mendapat izin membaca respons', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/__tes/aksi',
      headers: { origin: 'https://jahat.example', 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('form lintas-situs (urlencoded / multipart) ditolak 415', async () => {
    const { app } = await setup();

    for (const contentType of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/__tes/aksi',
        headers: { origin: 'https://jahat.example', 'content-type': contentType },
        payload: 'a=1',
      });
      expect(response.statusCode, contentType).toBe(415);
    }
  });

  it('body text/plain ditolak 415 (satu-satunya tipe body lintas-situs yang masih diterima)', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/__tes/aksi',
      headers: { origin: 'https://jahat.example', 'content-type': 'text/plain' },
      payload: '{"aksi":"hapus"}',
    });

    expect(response.statusCode).toBe(415);
  });

  it('fakta: POST tanpa body dari origin asing tetap sampai ke handler', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/__tes/aksi',
      headers: { origin: 'https://jahat.example' },
    });

    // CORS bukan pelindung CSRF. Fase 1 WAJIB: cookie SameSite=Lax + token CSRF
    // (SECURITY.md §1) pada semua rute yang mengubah data.
    expect(response.statusCode).toBe(200);
  });
});
