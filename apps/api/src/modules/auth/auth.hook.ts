import { AppError, sha256Hex } from '@balesin/core';
import { CSRF_HEADER_NAME, hasPermission } from '@balesin/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { clientInfo } from '../../http/client-info';
import { clearedSessionCookie, readSessionToken } from '../../http/cookies';
import { allowsTwoFactorEnrollment } from '../../http/route-access';
import { fetchSiteOf, type AccessDeniedRecorder } from './access-denied';
import type { CsrfProtection } from './csrf';
import type { CsrfRejectionRecorder, CsrfRejectionReason } from './csrf-rejection';
import type { AuthContext, SessionService } from './session.service';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Identitas pemanggil; `null` di rute publik. Di rute non-publik SELALU terisi — hook auth
     * menolak permintaan sebelum handler jalan bila sesi tidak sah. Ambil lewat `requireAuth`.
     */
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    /** Pencatat audit penolakan izin (dipakai hook auth dan `permissionGrant`). */
    accessDenied: AccessDeniedRecorder;
    /** Pencatat audit penolakan CSRF/Origin bersesi sah (hook auth, WebSocket inbox). */
    csrfRejections: CsrfRejectionRecorder;
  }
}

export interface AuthHookOptions {
  /** Origin web aplikasi; satu-satunya asal yang boleh mengirim permintaan pengubah data. */
  appOrigin: string;
  /** `true` = cookie `__Host-` + `Secure` (HTTPS). */
  cookieSecure: boolean;
  sessions: SessionService;
  csrf: CsrfProtection;
  accessDenied: AccessDeniedRecorder;
  csrfRejections: CsrfRejectionRecorder;
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
 *     GET bertanda `config.requireCsrf` (efek samping) juga wajib token CSRF, tanpa `Origin`
 *     asing dan tanpa `Sec-Fetch-Site` selain `same-origin` → 403 `CSRF_INVALID`.
 *  5. Sesi terbatas (Owner/Admin/Supervisor yang 2FA-nya belum aktif) hanya boleh ke rute
 *     `AUTHENTICATED_OR_ENROLLING` → selain itu 403 `TWO_FACTOR_ENROLLMENT_REQUIRED`. Keadaan 2FA
 *     dibaca dari database setiap permintaan, jadi peran yang baru dinaikkan langsung ikut.
 *  6. Rute `requirePermission(izin)`: peran pengguna harus memegang izin itu di matriks
 *     (`@balesin/shared` `ROLE_PERMISSIONS`, cakupan apa pun) → selain itu 403 `FORBIDDEN` dan
 *     audit `auth.access.denied` (dibatasi, lihat `access-denied.ts`).
 *
 * Rute tanpa `config.access` ditolak 403 (seharusnya tidak pernah ada: pendaftarannya sudah
 * digagalkan `enforceRouteDeclarations`). Alamat yang tidak cocok dengan rute mana pun tetap
 * dijawab 404 — tidak ada handler yang perlu dilindungi di sana.
 *
 * Pemeriksaan CAKUPAN (Teknisi hanya data yang di-assign kepadanya, kepemilikan, departemen)
 * dilakukan handler/service lewat `permissionGrant` (`permission-grant.ts`); hook ini hanya
 * memutuskan "boleh masuk ke rute ini atau tidak".
 */
export function registerAuthHook(app: FastifyInstance, options: AuthHookOptions): void {
  const { appOrigin, cookieSecure, sessions, csrf, accessDenied, csrfRejections } = options;

  app.decorateRequest('auth', null);
  app.decorate('accessDenied', accessDenied);
  app.decorate('csrfRejections', csrfRejections);

  /** Audit penolakan CSRF/Origin bila permintaan membawa sesi sah (review akhir Fase 1 R1). */
  const recordRejection = async (
    request: FastifyRequest,
    reason: CsrfRejectionReason,
    session: Parameters<CsrfRejectionRecorder['record']>[0]['session'] | undefined,
  ) => {
    if (!session) return;
    await csrfRejections.record({
      session,
      reason,
      method: request.method,
      route: request.routeOptions.url ?? '',
      origin: request.headers.origin,
      fetchSite: fetchSiteOf(request),
      client: clientInfo(request),
    });
  };

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Preflight CORS sudah ditangani plugin keamanan dan tidak pernah membawa kredensial.
    if (request.method === 'OPTIONS' || request.is404) return;

    const unsafe = !SAFE_METHODS.has(request.method);
    const { origin } = request.headers;
    if (unsafe && origin !== undefined && origin !== appOrigin) {
      // Sesi dibaca TANPA efek samping (tidak memperpanjang sesi korban) hanya untuk audit.
      const cookieToken = readSessionToken(request.headers.cookie, cookieSecure);
      if (cookieToken) {
        const session = await sessions.peek(sha256Hex(cookieToken)).catch(() => undefined);
        await recordRejection(request, 'origin', session);
      }
      throw new AppError('FORBIDDEN', {
        message: 'Permintaan dari asal ini tidak diizinkan. Buka aplikasi dari alamat resminya.',
      });
    }

    const access = request.routeOptions.config.access;
    if (!access) throw new AppError('FORBIDDEN');
    if (access.kind === 'public') return;
    // Jenis yang tidak dikenal (seharusnya sudah digagalkan saat start) tidak pernah diloloskan.
    if (access.kind !== 'authenticated' && access.kind !== 'permission') {
      throw new AppError('FORBIDDEN');
    }

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
        await recordRejection(request, origin === appOrigin ? 'token' : 'origin', auth);
        throw new AppError('CSRF_INVALID');
      }
    } else if (request.routeOptions.config.requireCsrf === true) {
      // GET ber-efek-samping (`config.requireCsrf`): browser tidak mengirim `Origin` pada GET
      // same-origin, jadi yang diwajibkan adalah token CSRF + bukan permintaan lintas situs.
      const fetchSite = request.headers['sec-fetch-site'];
      if (
        (origin !== undefined && origin !== appOrigin) ||
        (typeof fetchSite === 'string' && fetchSite !== 'same-origin') ||
        !csrf.verify(auth.sessionTokenHash, request.headers[CSRF_HEADER_NAME])
      ) {
        const foreign =
          (origin !== undefined && origin !== appOrigin) ||
          (typeof fetchSite === 'string' && fetchSite !== 'same-origin');
        await recordRejection(request, foreign ? 'origin' : 'token', auth);
        throw new AppError('CSRF_INVALID');
      }
    }

    if (auth.twoFactor.enrollmentRequired && !allowsTwoFactorEnrollment(access)) {
      throw new AppError('TWO_FACTOR_ENROLLMENT_REQUIRED');
    }

    if (access.kind === 'permission' && !hasPermission(auth.user.role, access.permission)) {
      await accessDenied.record({
        auth,
        permission: access.permission,
        method: request.method,
        route: request.routeOptions.url ?? '',
        client: clientInfo(request),
        fetchSite: fetchSiteOf(request),
      });
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
