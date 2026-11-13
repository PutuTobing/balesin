/**
 * Tes keamanan dari review Fase 0, PUTARAN 2
 * (docs/security-reviews/2026-11-13-fase0-fondasi.md, bagian "Putaran 2").
 *
 * Menilai hal BARU yang dibawa perbaikan putaran 1: rute pelengkap 405 dan penolakan
 * preflight. Semuanya penjaga regresi, kecuali satu tes "fakta" (N1) yang mendokumentasikan
 * perilaku yang wajib diperhitungkan saat auth dibangun di Fase 1.
 */
import { AppError } from '@balesin/core';
import { errorEnvelopeSchema } from '@balesin/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { trackRoutesForMethodNotAllowed } from './http/method-not-allowed';
import { buildTestApp, TEST_APP_ORIGIN, type TestApp } from './testing/build-test-app';

let current: TestApp | undefined;

async function setup(options: Parameters<typeof buildTestApp>[0] = {}): Promise<TestApp> {
  current = await buildTestApp(options);
  return current;
}

afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

describe('405 — metode salah pada alamat yang ada', () => {
  it('menjawab amplop JSON umum dengan header keamanan, tanpa izin CORS untuk origin asing', async () => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'DELETE',
      url: '/ready',
      headers: { origin: 'https://jahat.example' },
    });

    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe('GET, HEAD');
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('METHOD_NOT_ALLOWED');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('alamat yang tidak ada tetap 404 untuk metode apa pun (405 tidak membuat rute baru)', async () => {
    const { app } = await setup();

    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      for (const url of ['/tidak-ada', '/health/', '/HEALTH', '/ready/x']) {
        const response = await app.inject({ method, url });

        expect(response.statusCode, `${method} ${url}`).toBe(404);
        expect(response.headers.allow, `${method} ${url}`).toBeUndefined();
      }
    }
  });

  it('rute pelengkap tidak menerima body non-JSON dan tidak menjalankan pemeriksaan dependensi', async () => {
    let probed = 0;
    const { app } = await setup({
      readinessProbes: {
        postgres: () => {
          probed += 1;
          return Promise.resolve();
        },
      },
    });

    const plain = await app.inject({
      method: 'POST',
      url: '/ready',
      headers: { 'content-type': 'text/plain' },
      payload: 'x',
    });
    const json = await app.inject({
      method: 'POST',
      url: '/ready',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });

    expect(plain.statusCode).toBe(415);
    expect(json.statusCode).toBe(405);
    expect(probed).toBe(0);
  });

  it('N1 — fakta: rute pelengkap berada di LUAR scope plugin, jadi hook auth milik scope tidak berlaku', async () => {
    const { app } = await setup();
    // Meniru modul Fase 1: hook auth dipasang di dalam scope plugin modulnya.
    const registerMethodNotAllowedRoutes = trackRoutesForMethodNotAllowed(app);
    await app.register((scope, _options, done) => {
      scope.addHook('onRequest', (_request, _reply, next) => {
        next(new AppError('UNAUTHENTICATED'));
      });
      scope.get('/__tes/laporan/:id', () => Promise.resolve({ ok: true }));
      done();
    });
    registerMethodNotAllowedRoutes();

    const read = await app.inject({ method: 'GET', url: '/__tes/laporan/1' });
    const wrongMethod = await app.inject({ method: 'DELETE', url: '/__tes/laporan/1' });
    const missing = await app.inject({ method: 'DELETE', url: '/__tes/tidak-ada/1' });

    // Tanpa login, 405 + `Allow` membedakan alamat yang ada dari yang tidak ada. Catatan Fase 1:
    // pasang auth sebagai hook `onRequest` di ROOT (bawaan tolak, daftar rute publik eksplisit)
    // supaya rute pelengkap ikut terlindungi; hook per-scope saja tidak cukup.
    expect(read.statusCode).toBe(401);
    expect(wrongMethod.statusCode).toBe(405);
    expect(wrongMethod.headers.allow).toBe('GET, HEAD');
    expect(missing.statusCode).toBe(404);
  });
});

describe('preflight CORS', () => {
  it.each([
    ['origin asing', 'https://jahat.example'],
    ['origin null', 'null'],
    ['origin berawalan sama', `${TEST_APP_ORIGIN}.jahat.example`],
    ['origin beda huruf besar/kecil', TEST_APP_ORIGIN.toUpperCase()],
  ])('%s ditolak 403 tanpa header izin apa pun', async (_label, origin) => {
    const { app } = await setup();

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: { origin, 'access-control-request-method': 'POST' },
    });

    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('FORBIDDEN');
    for (const header of [
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-allow-methods',
      'access-control-allow-headers',
    ]) {
      expect(response.headers[header], header).toBeUndefined();
    }
    expect(response.body).not.toContain(origin);
  });

  it('jawaban preflight sama untuk alamat yang ada dan yang tidak ada (tidak membuka daftar rute)', async () => {
    const { app } = await setup();
    const preflight = (url: string) =>
      app.inject({
        method: 'OPTIONS',
        url,
        headers: { origin: TEST_APP_ORIGIN, 'access-control-request-method': 'DELETE' },
      });

    const existing = await preflight('/health');
    const missing = await preflight('/tidak-ada/sama-sekali');

    expect(existing.statusCode).toBe(204);
    expect(missing.statusCode).toBe(204);
    expect(existing.headers.allow).toBeUndefined();
    expect(missing.headers['access-control-allow-methods']).toBe(
      existing.headers['access-control-allow-methods'],
    );
  });
});
