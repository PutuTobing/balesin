import { AppError } from '@balesin/core';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

export interface SecurityOptions {
  /** Origin web aplikasi (dari `APP_URL`). Hanya origin ini yang boleh memanggil API dari browser. */
  appOrigin: string;
  /** HSTS hanya dikirim di production (di belakang HTTPS). */
  isProduction: boolean;
}

/** 180 hari — disarankan untuk HSTS tanpa preload. */
const HSTS_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/** API tidak pernah menyajikan HTML, jadi CSP-nya paling ketat. */
const CSP_DIRECTIVES = {
  'default-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
};
const CSP_HEADER = Object.entries(CSP_DIRECTIVES)
  .map(([name, values]) => `${name} ${values.join(' ')}`)
  .join(';');

/** Respons API tidak butuh fitur perangkat apa pun (SECURITY.md §8). */
const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()';

/**
 * Header keamanan dasar untuk respons yang TIDAK melewati hook — yaitu error tingkat framework
 * (URL rusak, parameter rute terlalu panjang), yang dijawab Fastify sebelum hook mana pun jalan.
 */
export function applyBaselineHeaders(reply: FastifyReply, requestId: string): void {
  void reply.headers({
    'x-request-id': requestId,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': CSP_HEADER,
    'referrer-policy': 'no-referrer',
    'permissions-policy': PERMISSIONS_POLICY,
    'cache-control': 'no-store',
  });
}

/**
 * Header keamanan + CORS untuk API JSON (SECURITY.md §8).
 *
 * CSP untuk halaman web diatur di server statis/reverse proxy, bukan di sini.
 */
export const securityPlugin = fp<SecurityOptions>(
  async (app, options) => {
    // Hook pertama: header ini harus ada juga di respons yang ditolak hook-hook berikutnya.
    app.addHook('onRequest', (request, reply, done) => {
      // ID yang sama muncul di log dan di amplop error — untuk menelusuri laporan pengguna.
      void reply.header('x-request-id', request.id);
      void reply.header('permissions-policy', PERMISSIONS_POLICY);
      done();
    });

    await app.register(helmet, {
      contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      // Web dan API bisa beda subdomain (satu "site"); selain itu dilarang memuat respons API.
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: options.isProduction
        ? { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true }
        : false,
      xFrameOptions: { action: 'deny' },
    });

    // Preflight CORS diperiksa di sini supaya penolakannya berbentuk amplop error JSON seperti
    // respons gagal lainnya (plugin CORS menjawab teks polos).
    app.addHook('onRequest', (request, _reply, done) => {
      if (request.method !== 'OPTIONS') return done();

      const { origin } = request.headers;
      if (!origin || !request.headers['access-control-request-method']) {
        return done(
          new AppError('BAD_REQUEST', {
            message:
              'Permintaan preflight CORS tidak lengkap (butuh header Origin dan Access-Control-Request-Method).',
          }),
        );
      }
      if (origin !== options.appOrigin) {
        return done(
          new AppError('FORBIDDEN', { message: 'Origin ini tidak diizinkan mengakses API.' }),
        );
      }
      done();
    });

    await app.register(cors, {
      // Hanya origin aplikasi yang mendapat header CORS. Untuk origin lain plugin tidak
      // menambahkan header izin apa pun; `Vary: Origin` tetap dikirim (wajib, supaya cache
      // tidak menyajikan respons satu origin ke origin lain).
      origin: (origin, callback) => {
        callback(null, origin === options.appOrigin ? options.appOrigin : false);
      },
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['content-type', 'x-csrf-token'],
      exposedHeaders: ['x-request-id'],
      maxAge: 600,
    });

    app.addHook('onSend', (_request, reply, payload, done) => {
      // Respons API berisi data pengguna/pelanggan: jangan disimpan cache browser atau proxy.
      if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
      done(null, payload);
    });
  },
  { name: 'balesin-security' },
);
