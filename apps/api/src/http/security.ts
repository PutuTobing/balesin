import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fp from 'fastify-plugin';

export interface SecurityOptions {
  /** Origin web aplikasi (dari `APP_URL`). Hanya origin ini yang boleh memanggil API dari browser. */
  appOrigin: string;
  /** HSTS hanya dikirim di production (di belakang HTTPS). */
  isProduction: boolean;
}

/** 180 hari — disarankan untuk HSTS tanpa preload. */
const HSTS_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/**
 * Header keamanan + CORS untuk API JSON (SECURITY.md §8).
 *
 * API tidak pernah menyajikan HTML, jadi CSP-nya paling ketat (`default-src 'none'`).
 * CSP untuk halaman web diatur di server statis/reverse proxy, bukan di sini.
 */
export const securityPlugin = fp<SecurityOptions>(
  async (app, options) => {
    await app.register(helmet, {
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'none'"],
          'frame-ancestors': ["'none'"],
        },
      },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      // Web dan API bisa beda subdomain (satu "site"); selain itu dilarang memuat respons API.
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: options.isProduction
        ? { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true }
        : false,
      xFrameOptions: { action: 'deny' },
    });

    await app.register(cors, {
      // Daftar (bukan `true`/wildcard): origin lain tidak mendapat header CORS sama sekali.
      origin: [options.appOrigin],
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['content-type', 'x-csrf-token'],
      exposedHeaders: ['x-request-id'],
      maxAge: 600,
    });

    app.addHook('onRequest', (request, reply, done) => {
      // ID yang sama muncul di log dan di amplop error — untuk menelusuri laporan pengguna.
      reply.header('x-request-id', request.id);
      done();
    });

    app.addHook('onSend', (_request, reply, payload, done) => {
      // Respons API berisi data pengguna/pelanggan: jangan disimpan cache browser atau proxy.
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
      done(null, payload);
    });
  },
  { name: 'balesin-security' },
);
