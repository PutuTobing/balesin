import { errorEnvelopeSchema } from '@balesin/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { handleError, handleNotFound } from './error-handler';
import { trackRoutesForMethodNotAllowed } from './method-not-allowed';

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
});
