import { errorEnvelopeSchema } from '@balesin/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { handleError, handleNotFound } from './error-handler';
import { trackRoutesForMethodNotAllowed } from './method-not-allowed';
import {
  AUTHENTICATED,
  AUTHENTICATED_OR_ENROLLING,
  PUBLIC,
  requirePermission,
  type RouteAccess,
} from './route-access';

let app: FastifyInstance | undefined;

/** Aplikasi Fastify polos + pelacak 405; `routes` didaftarkan sebelum rute pelengkap dibuat. */
async function build(routes: (instance: FastifyInstance) => void | Promise<void>) {
  const instance = Fastify();
  app = instance;
  instance.setErrorHandler(handleError);
  instance.setNotFoundHandler(handleNotFound);

  const registerMethodNotAllowedRoutes = trackRoutesForMethodNotAllowed(instance);
  await routes(instance);
  registerMethodNotAllowedRoutes();
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const ok = () => Promise.resolve({ ok: true });

describe('trackRoutesForMethodNotAllowed', () => {
  it('405 + Allow untuk metode yang tidak ada, menggabungkan semua metode alamat itu', async () => {
    const instance = await build((fastify) => {
      fastify.get('/barang/:id', ok);
      fastify.put('/barang/:id', ok);
      fastify.post('/aksi', ok);
    });

    const wrongOnParam = await instance.inject({ method: 'DELETE', url: '/barang/42' });
    const wrongOnPostOnly = await instance.inject({ method: 'GET', url: '/aksi' });
    const headOnPostOnly = await instance.inject({ method: 'HEAD', url: '/aksi' });

    expect(wrongOnParam.statusCode).toBe(405);
    expect(wrongOnParam.headers.allow).toBe('GET, HEAD, PUT');
    expect(errorEnvelopeSchema.parse(wrongOnParam.json()).error.code).toBe('METHOD_NOT_ALLOWED');
    expect(wrongOnPostOnly.statusCode).toBe(405);
    expect(wrongOnPostOnly.headers.allow).toBe('POST');
    expect(headOnPostOnly.statusCode).toBe(405);
  });

  it('rute asli tetap berjalan, termasuk HEAD otomatis untuk GET', async () => {
    const instance = await build((fastify) => {
      fastify.get('/barang/:id', ok);
      fastify.put('/barang/:id', ok);
    });

    expect((await instance.inject({ method: 'GET', url: '/barang/42' })).statusCode).toBe(200);
    expect((await instance.inject({ method: 'PUT', url: '/barang/42' })).statusCode).toBe(200);
    expect((await instance.inject({ method: 'HEAD', url: '/barang/42' })).statusCode).toBe(200);
  });

  it('mencakup rute di dalam plugin ber-prefix dan rute wildcard', async () => {
    const instance = await build(async (fastify) => {
      await fastify.register(
        (plugin, _options, done) => {
          plugin.get('/kontak', ok);
          plugin.delete('/berkas/*', ok);
          done();
        },
        { prefix: '/api/v1' },
      );
    });

    const prefixed = await instance.inject({ method: 'POST', url: '/api/v1/kontak' });
    const wildcard = await instance.inject({ method: 'GET', url: '/api/v1/berkas/a/b.png' });

    expect(prefixed.statusCode).toBe(405);
    expect(prefixed.headers.allow).toBe('GET, HEAD');
    expect(wildcard.statusCode).toBe(405);
    expect(wildcard.headers.allow).toBe('DELETE');
  });

  it('alamat yang tidak ada tetap 404, dan rute khusus OPTIONS tidak dilengkapi', async () => {
    const instance = await build((fastify) => {
      fastify.get('/ada', ok);
      fastify.options('*', (_request, reply) => reply.status(204).send());
    });

    const missing = await instance.inject({ method: 'POST', url: '/tidak-ada' });
    const options = await instance.inject({ method: 'OPTIONS', url: '/ada' });

    expect(missing.statusCode).toBe(404);
    expect(missing.headers.allow).toBeUndefined();
    expect(options.statusCode).toBe(204);
  });

  it('alamat yang sudah punya semua metode tidak diubah', async () => {
    const instance = await build((fastify) => {
      fastify.all('/semua', ok);
    });

    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await instance.inject({ method, url: '/semua' })).statusCode, method).toBe(200);
    }
  });

  it('akses rute pelengkap: publik bila semua publik, izin yang sama bila semua sama, selain itu cukup sesi', async () => {
    const complements = new Map<string, RouteAccess | undefined>();
    const instance = Fastify();
    app = instance;
    instance.addHook('onRoute', (route) => {
      if (route.config?.methodNotAllowed) complements.set(route.url, route.config.access);
    });
    const registerMethodNotAllowedRoutes = trackRoutesForMethodNotAllowed(instance);
    const email = requirePermission('settings.email.manage');
    instance.get('/publik', { config: { access: PUBLIC } }, ok);
    instance.get('/email', { config: { access: email } }, ok);
    instance.put('/email', { config: { access: email } }, ok);
    instance.get('/campur-izin', { config: { access: email } }, ok);
    instance.put('/campur-izin', { config: { access: requirePermission('team.invite') } }, ok);
    instance.get('/izin-dan-sesi', { config: { access: email } }, ok);
    instance.put('/izin-dan-sesi', { config: { access: AUTHENTICATED } }, ok);
    instance.get('/pendaftaran', { config: { access: AUTHENTICATED_OR_ENROLLING } }, ok);
    instance.get('/publik-dan-izin', { config: { access: PUBLIC } }, ok);
    instance.put('/publik-dan-izin', { config: { access: email } }, ok);
    instance.get('/tanpa-deklarasi', ok);
    registerMethodNotAllowedRoutes();
    await instance.ready();

    expect(complements.get('/publik')).toEqual(PUBLIC);
    expect(complements.get('/email')).toEqual(email);
    expect(complements.get('/campur-izin')).toEqual(AUTHENTICATED);
    expect(complements.get('/izin-dan-sesi')).toEqual(AUTHENTICATED);
    // Pelengkap rute pendaftaran 2FA TIDAK ikut boleh dipakai sesi terbatas.
    expect(complements.get('/pendaftaran')).toEqual(AUTHENTICATED);
    expect(complements.get('/publik-dan-izin')).toEqual(AUTHENTICATED);
    expect(complements.get('/tanpa-deklarasi')).toEqual(AUTHENTICATED);
  });
});
