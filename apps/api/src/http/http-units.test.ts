import { AppError } from '@balesin/core';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildTestApp, TEST_ROUTE } from '../testing/build-test-app';
import { clientInfo, ipRateLimitKey } from './client-info';
import {
  clearedSessionCookie,
  readSessionToken,
  sessionCookie,
  sessionCookieName,
} from './cookies';
import { formatWait, rateLimited } from './rate-limit';
import {
  AUTHENTICATED,
  enforceRouteDeclarations,
  PUBLIC,
  requirePermission,
  type RouteAccess,
} from './route-access';

const TOKEN = 'A'.repeat(43);
const OTHER = 'B'.repeat(43);

describe('cookie sesi', () => {
  it('HTTPS: awalan __Host- + Secure; http://localhost: nama polos tanpa Secure', () => {
    expect(sessionCookieName(true)).toBe('__Host-balesin_session');
    expect(sessionCookieName(false)).toBe('balesin_session');
    expect(sessionCookie(TOKEN, true, 60)).toBe(
      `__Host-balesin_session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure`,
    );
    expect(sessionCookie(TOKEN, false, 60)).toBe(
      `balesin_session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`,
    );
    // Syarat browser untuk awalan __Host-: Secure, Path=/, tanpa Domain.
    expect(sessionCookie(TOKEN, true, 60)).not.toMatch(/domain/i);
    expect(clearedSessionCookie(true)).toBe(
      '__Host-balesin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    );
  });

  it('membaca token di antara cookie lain', () => {
    expect(readSessionToken(`tema=gelap; balesin_session=${TOKEN}; lain=1`, false)).toBe(TOKEN);
    expect(readSessionToken(`__Host-balesin_session=${TOKEN}`, true)).toBe(TOKEN);
    expect(readSessionToken(`  balesin_session = ${TOKEN} `, false)).toBe(TOKEN);
  });

  it('mode aman hanya menerima cookie __Host-, dan sebaliknya', () => {
    expect(readSessionToken(`balesin_session=${TOKEN}`, true)).toBeUndefined();
    expect(readSessionToken(`__Host-balesin_session=${TOKEN}`, false)).toBeUndefined();
    // Nama mirip tidak dianggap sama.
    expect(readSessionToken(`xbalesin_session=${TOKEN}`, false)).toBeUndefined();
    expect(readSessionToken(`balesin_session_lama=${TOKEN}`, false)).toBeUndefined();
  });

  it('menolak bentuk token yang salah, cookie ganda, dan header raksasa', () => {
    for (const header of [
      undefined,
      '',
      'balesin_session=',
      'balesin_session=pendek',
      `balesin_session=${TOKEN}x`,
      `balesin_session=${'A'.repeat(42)}!`,
      `balesin_session="${TOKEN}"`,
      `balesin_session=${TOKEN}; balesin_session=${OTHER}`,
      `balesin_session=${OTHER}; balesin_session=${TOKEN}`,
      `balesin_session=${TOKEN}; ${'x=1; '.repeat(3_000)}`,
    ]) {
      expect(readSessionToken(header, false), String(header).slice(0, 60)).toBeUndefined();
    }
  });
});

describe('info klien', () => {
  const request = (ip: string, userAgent?: string | string[]) =>
    ({ ip, headers: { 'user-agent': userAgent } }) as Parameters<typeof clientInfo>[0];

  it('IP yang bukan alamat sah menjadi null; user agent dipotong 512 karakter', () => {
    expect(clientInfo(request('203.0.113.5', 'Mozilla/5.0'))).toEqual({
      ip: '203.0.113.5',
      userAgent: 'Mozilla/5.0',
    });
    expect(clientInfo(request('2001:db8::1')).ip).toBe('2001:db8::1');
    expect(clientInfo(request('bukan-alamat-ip')).ip).toBeNull();
    expect(clientInfo(request("1.2.3.4'; drop table users;--")).ip).toBeNull();
    expect(clientInfo(request('')).ip).toBeNull();
    expect(clientInfo(request('1.2.3.4', 'x'.repeat(5_000))).userAgent).toHaveLength(512);
    expect(clientInfo(request('1.2.3.4', '')).userAgent).toBeNull();
  });

  it('kunci batas laju: IPv4 apa adanya, IPv6 per /64, alamat tidak sah satu ember', () => {
    const key = (ip: string | null) => ipRateLimitKey({ ip, userAgent: null });

    expect(key('203.0.113.5')).toBe('203.0.113.5');
    expect(key('2001:db8:abcd:12::1')).toBe('2001:db8:abcd:12::/64');
    expect(key('2001:db8:abcd:12:ffff:ffff:ffff:ffff')).toBe('2001:db8:abcd:12::/64');
    expect(key('2001:0DB8:ABCD:0012::9')).toBe('2001:db8:abcd:12::/64');
    expect(key('2001:db8:abcd:13::1')).toBe('2001:db8:abcd:13::/64');
    expect(key('::1')).toBe('0:0:0:0::/64');
    expect(key('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(key('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(key(null)).toBe('ip-tidak-sah');
  });
});

describe('batas laju — pesan', () => {
  it('formatWait memakai detik di bawah semenit dan membulatkan menit ke atas', () => {
    expect(formatWait(1)).toBe('1 detik');
    expect(formatWait(59)).toBe('59 detik');
    expect(formatWait(60)).toBe('1 menit');
    expect(formatWait(61)).toBe('2 menit');
    expect(formatWait(900)).toBe('15 menit');
    expect(formatWait(0)).toBe('1 detik');
  });

  it('penolakan berupa AppError RATE_LIMITED (429) dengan Retry-After', async () => {
    const error = rateLimited(42.2, 'Coba lagi nanti.');
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', statusCode: 429, retryAfterSeconds: 43 });

    const { app } = await buildTestApp();
    app.get('/__tes/batas', TEST_ROUTE, () => {
      throw rateLimited(120, 'Terlalu sering. Coba lagi dalam 2 menit.');
    });
    const response = await app.inject({ method: 'GET', url: '/__tes/batas' });
    await app.close();

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('120');
    expect(response.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', message: 'Terlalu sering. Coba lagi dalam 2 menit.' },
    });
  });

  it('setiap 429 membawa Retry-After, juga yang tidak berasal dari rateLimited()', async () => {
    const { app } = await buildTestApp();
    app.get('/__tes/batas-lain', TEST_ROUTE, () => {
      // Mis. 429 dari Fastify/plugin (kode `FST_…`) tanpa waktu tunggu sendiri.
      throw Object.assign(new Error('terlalu sering'), { statusCode: 429, code: 'FST_TES_BATAS' });
    });
    const response = await app.inject({ method: 'GET', url: '/__tes/batas-lain' });
    await app.close();

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('deklarasi akses rute (bawaan tolak)', () => {
  const ok = () => Promise.resolve({ ok: true });
  const response = { 200: z.object({ ok: z.boolean() }) };

  function plain() {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    return app;
  }

  function guarded() {
    const app = plain();
    enforceRouteDeclarations(app);
    return app;
  }

  it('rute tanpa config.access membuat aplikasi menolak start', async () => {
    const app = guarded();
    app.get('/tanpa-akses', { schema: { response } }, ok);
    app.post('/tanpa-opsi', ok);

    const failure = await app.ready().then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toContain('rute belum lengkap deklarasinya');
    expect(failure?.message).toContain('GET /tanpa-akses belum menyatakan akses');
    expect(failure?.message).toContain('POST /tanpa-opsi belum menyatakan akses');
  });

  it('rute tanpa skema respons membuat aplikasi menolak start, kecuali ditandai rawResponse', async () => {
    const strict = guarded();
    strict.get('/tanpa-skema', { config: { access: PUBLIC } }, ok);
    strict.get('/skema-kosong', { config: { access: PUBLIC }, schema: { response: {} } }, ok);
    const raw = guarded();
    raw.get('/biner', { config: { access: PUBLIC, rawResponse: true } }, ok);

    await expect(strict.ready()).rejects.toThrow('GET /tanpa-skema belum punya skema respons');
    await expect(strict.ready()).rejects.toThrow('GET /skema-kosong belum punya skema respons');
    await expect(raw.ready()).resolves.toBeDefined();
  });

  it('rute yang lengkap diterima untuk ketiga jenis akses; OPTIONS milik CORS (sebelum penjaga) dilewati', async () => {
    const app = plain();
    // Seperti plugin CORS di buildApp: didaftarkan SEBELUM penjaga dipasang.
    app.options('*', ok);
    const declarations = enforceRouteDeclarations(app);
    app.get('/publik', { config: { access: PUBLIC }, schema: { response } }, ok);
    app.get('/masuk', { config: { access: AUTHENTICATED }, schema: { response } }, ok);
    app.put(
      '/admin',
      { config: { access: requirePermission('settings.email.manage') }, schema: { response } },
      ok,
    );

    await expect(app.ready()).resolves.toBeDefined();
    expect(declarations).toEqual(
      expect.arrayContaining([
        { method: 'GET', url: '/publik', access: { kind: 'public' }, methodNotAllowed: false },
        {
          method: 'GET',
          url: '/masuk',
          access: { kind: 'authenticated' },
          methodNotAllowed: false,
        },
        {
          method: 'PUT',
          url: '/admin',
          access: { kind: 'permission', permission: 'settings.email.manage' },
          methodNotAllowed: false,
        },
      ]),
    );
    expect(declarations.some((route) => route.method === 'OPTIONS')).toBe(false);
  });

  it('izin yang tidak ada di matriks (mis. lewat `as`) atau jenis akses asing: menolak start', async () => {
    const app = guarded();
    const unknownPermission = {
      kind: 'permission',
      permission: 'superuser',
    } as unknown as RouteAccess;
    const rolesKind = { kind: 'roles', roles: ['owner'] } as unknown as RouteAccess;
    app.get('/izin-asing', { config: { access: unknownPermission }, schema: { response } }, ok);
    app.get('/peran-langsung', { config: { access: rolesKind }, schema: { response } }, ok);

    const failure = await app.ready().then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toContain('GET /izin-asing menyatakan akses yang tidak dikenal');
    expect(failure?.message).toContain('GET /peran-langsung menyatakan akses yang tidak dikenal');
  });

  it('rute aplikasi yang menerima OPTIONS (sendiri atau bersama metode lain): menolak start', async () => {
    const app = guarded();
    app.route({
      method: ['GET', 'OPTIONS'],
      url: '/campur-opsi',
      config: { access: PUBLIC },
      schema: { response },
      handler: ok,
    });
    app.options('/opsi-saja', { config: { access: PUBLIC }, schema: { response } }, ok);

    const failure = await app.ready().then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toContain('GET/OPTIONS /campur-opsi menerima OPTIONS');
    expect(failure?.message).toContain('OPTIONS /opsi-saja menerima OPTIONS');
  });

  it('berlaku juga untuk rute di dalam plugin ber-prefix', async () => {
    const app = guarded();
    void app.register(
      (scope, _options, done) => {
        scope.get('/lupa', ok);
        done();
      },
      { prefix: '/api/v1' },
    );

    await expect(app.ready()).rejects.toThrow('GET /api/v1/lupa belum menyatakan akses');
  });

  it('aplikasi sungguhan ikut menolak siap bila ada rute tanpa deklarasi', async () => {
    const { app } = await buildTestApp();
    app.get('/__tes/lupa-deklarasi', ok);

    const response = app.inject({ method: 'GET', url: '/health' });

    await expect(response).rejects.toThrow('GET /__tes/lupa-deklarasi belum menyatakan akses');
  });

  it('aplikasi sungguhan: daftar rute publik persis seperti yang disengaja', async () => {
    const { app } = await buildTestApp();
    const declarations = [...app.routeDeclarations];
    await app.close();

    const publicUrls = [
      ...new Set(
        declarations.filter((route) => route.access.kind === 'public').map((route) => route.url),
      ),
    ].sort();
    // Daftar rute publik EKSPLISIT. Menambah rute publik baru harus disengaja: ubah daftar ini
    // dan minta review keamanan.
    expect(publicUrls).toEqual([
      // Dokumentasi API publik (Fase 3): statis + OpenAPI, bisa dimatikan Pengaturan → API.
      '/api/docs',
      '/api/docs/app.css',
      '/api/docs/app.js',
      '/api/docs/openapi.json',
      // URL media bertanda tangan lapisan kompatibel MobiChat (HMAC + key penanda tangan dicek ulang).
      '/api/public/media/:messageNumber',
      '/api/v1/auth/2fa/verify',
      '/api/v1/auth/email/verify',
      '/api/v1/auth/invitation/accept',
      '/api/v1/auth/invitation/inspect',
      '/api/v1/auth/login',
      '/api/v1/auth/password-reset',
      '/api/v1/auth/password-reset/complete',
      '/api/v1/auth/password-reset/inspect',
      '/api/v1/auth/password-reset/request',
      '/api/v1/branding',
      // Ikon PWA/favicon dari logo (Fase 7 white-label): hanya nama berkas dari daftar tetap.
      '/api/v1/branding/icons/:file',
      '/api/v1/branding/logo',
      // Dokumen tampilan email (9A, KONTRAK-API-EMAIL §8): iframe sandbox ber-origin opak tanpa
      // cookie → diautentikasi token HMAC ber-sesi di path; service memeriksa ulang sesi & hak baca.
      '/api/v1/mail/view/:token',
      '/api/v1/mail/view/:token/cid/:attachmentId',
      '/api/v1/mail/view/:token/images/:index',
      '/api/v1/setup/check-password',
      '/api/v1/setup/complete',
      '/api/v1/setup/email/detect-host',
      '/api/v1/setup/email/send-test',
      '/api/v1/setup/email/test-connection',
      '/api/v1/setup/status',
      '/api/v1/setup/verify-token',
      '/health',
      '/ready',
      // Penerima webhook Fase 6: Telegram (secret token), Messenger/Instagram (tanda tangan App Secret).
      '/webhooks/instagram/:channelId',
      '/webhooks/messenger/:channelId',
      '/webhooks/telegram/:channelId',
      // Penerima webhook Meta (Fase 2): keaslian dari verify token / tanda tangan App Secret.
      '/webhooks/whatsapp/:channelId',
    ]);

    // Semua rute lain menuntut sesi, dan rute pengaturan email (termasuk pelengkap 405-nya)
    // butuh izin `settings.email.manage`. Matriks lengkap rute × peran: rbac-matrix.integration.test.ts.
    // Hanya Pengaturan → Email pengirim (`/settings/email` dan turunannya). Rute 9.1
    // `/settings/email-templates|email-senders|email-outbound` punya izin sendiri (matriks RBAC).
    const emailRoutes = declarations.filter(
      (route) =>
        route.url === '/api/v1/settings/email' || route.url.startsWith('/api/v1/settings/email/'),
    );
    expect(emailRoutes.length).toBeGreaterThanOrEqual(5);
    for (const route of emailRoutes) {
      expect(route.access, `${route.method} ${route.url}`).toEqual({
        kind: 'permission',
        permission: 'settings.email.manage',
      });
    }
    expect(declarations.find((route) => route.url === '/api/v1/auth/me')?.access.kind).toBe(
      'authenticated',
    );

    // Sesi terbatas "wajib mendaftar 2FA" hanya boleh ke daftar EKSPLISIT ini (termasuk rute
    // pelengkap 405 di alamat yang sama, yang memakai AUTHENTICATED biasa = ditolak).
    const enrollmentUrls = [
      ...new Set(
        declarations
          .filter(
            (route) =>
              route.access.kind === 'authenticated' && route.access.allowTwoFactorEnrollment,
          )
          .map((route) => `${route.method} ${route.url}`),
      ),
    ].sort();
    expect(enrollmentUrls).toEqual([
      'GET /api/v1/auth/2fa',
      'GET /api/v1/auth/me',
      'HEAD /api/v1/auth/2fa',
      'HEAD /api/v1/auth/me',
      'POST /api/v1/auth/2fa/enroll',
      'POST /api/v1/auth/2fa/enroll/confirm',
      'POST /api/v1/auth/logout',
    ]);
    expect(
      declarations.find((route) => route.method === 'POST' && route.url === '/api/v1/auth/logout')
        ?.access.kind,
    ).toBe('authenticated');
  });
});
