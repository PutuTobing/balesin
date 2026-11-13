import { AppError } from '@balesin/core';
import { CSRF_HEADER_NAME } from '@balesin/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { clearedSessionCookie, readSessionToken } from '../../http/cookies';
import type { CsrfProtection } from './csrf';
import type { AuthContext, SessionService } from './session.service';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Identitas pemanggil; `null` di rute publik. Di rute non-publik SELALU terisi — hook auth
     * menolak permintaan sebelum handler jalan bila sesi tidak sah. Ambil lewat `requireAuth`.
     */
    auth: AuthContext | null;
  }
}

export interface AuthHookOptions {
  /** Origin web aplikasi; satu-satunya asal yang boleh mengirim permintaan pengubah data. */
  appOrigin: string;
  /** `true` = cookie `__Host-` + `Secure` (HTTPS). */
  cookieSecure: boolean;
  sessions: SessionService;
  csrf: CsrfProtection;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Hook `onRequest` di ROOT — bawaan tolak (temuan N1 review Fase 0).
 *
 * Dipasang di root, bukan di dalam plugin modul, supaya berlaku untuk SEMUA rute termasuk
 * rute pelengkap 405. Urutan pemeriksaan untuk setiap permintaan yang cocok dengan sebuah rute:
 *
 *  1. Permintaan pengubah data: header `Origin`, bila ada, harus origin aplikasi.
 *  2. Rute publik (`config.access = PUBLIC`): lanjut tanpa sesi.
 *  3. Selain itu wajib ada sesi yang sah → 401 bila tidak.
 *  4. Permintaan pengubah data wajib membawa `Origin` aplikasi dan token CSRF sesi itu → 403.
 *  5. Rute `allowRoles(...)`: peran pengguna harus termasuk → 403.
 *
 * Rute tanpa `config.access` ditolak 403 (seharusnya tidak pernah ada: pendaftarannya sudah
 * digagalkan `enforceRouteDeclarations`). Alamat yang tidak cocok dengan rute mana pun tetap
 * dijawab 404 — tidak ada handler yang perlu dilindungi di sana.
 *
 * Pemeriksaan izin yang lebih rinci (kepemilikan data, departemen) dilakukan handler/service
 * memakai `request.auth`; hook ini hanya memutuskan "boleh masuk ke rute ini atau tidak".
 */
export function registerAuthHook(app: FastifyInstance, options: AuthHookOptions): void {
  const { appOrigin, cookieSecure, sessions, csrf } = options;

  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Preflight CORS sudah ditangani plugin keamanan dan tidak pernah membawa kredensial.
    if (request.method === 'OPTIONS' || request.is404) return;

    const unsafe = !SAFE_METHODS.has(request.method);
    const { origin } = request.headers;
    if (unsafe && origin !== undefined && origin !== appOrigin) {
      throw new AppError('FORBIDDEN', {
        message: 'Permintaan dari asal ini tidak diizinkan. Buka aplikasi dari alamat resminya.',
      });
    }

    const access = request.routeOptions.config.access;
    if (!access) throw new AppError('FORBIDDEN');
    if (access.kind === 'public') return;

    const token = readSessionToken(request.headers.cookie, cookieSecure);
    if (!token) throw new AppError('UNAUTHENTICATED');

    const auth = await sessions.resolve(token);
    if (!auth) {
      // Cookie-nya sudah tidak berguna (kedaluwarsa, dicabut, akun dinonaktifkan): hapus.
      void reply.header('set-cookie', clearedSessionCookie(cookieSecure));
      throw new AppError('UNAUTHENTICATED', {
        message: 'Sesi kamu sudah berakhir. Masuk lagi untuk melanjutkan.',
      });
    }

    if (unsafe) {
      // Browser selalu mengirim `Origin` pada permintaan pengubah data; tanpa itu permintaan
      // bercookie sesi tidak diterima.
      if (
        origin !== appOrigin ||
        !csrf.verify(auth.sessionTokenHash, request.headers[CSRF_HEADER_NAME])
      ) {
        throw new AppError('CSRF_INVALID');
      }
    }

    if (access.kind === 'roles' && !access.roles.includes(auth.user.role)) {
      throw new AppError('FORBIDDEN');
    }

    request.auth = auth;
  });
}

/** Identitas pemanggil di handler rute non-publik. */
export function requireAuth(request: FastifyRequest): AuthContext {
  // Tidak mungkin terjadi di rute non-publik; dijaga supaya salah pasang rute gagal aman.
  if (!request.auth) throw new AppError('UNAUTHENTICATED');
  return request.auth;
}
