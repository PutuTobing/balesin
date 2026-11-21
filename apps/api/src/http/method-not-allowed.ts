import { AppError } from '@balesin/core';
import type { FastifyInstance, HTTPMethods } from 'fastify';

import { handleError } from './error-handler';
import { AUTHENTICATED, PUBLIC, requirePermission, type RouteAccess } from './route-access';

/** Metode yang dijawab 405 bila alamatnya ada tetapi metodenya tidak. OPTIONS milik CORS. */
const COVERED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

type CoveredMethod = (typeof COVERED_METHODS)[number];

/** Bagian instance Fastify yang dipakai di sini (lepas dari type provider aplikasinya). */
type RouteRegistry = Pick<FastifyInstance, 'addHook' | 'route'>;

interface KnownRoute {
  methods: Set<string>;
  /** Akses semua rute asli di alamat ini (yang tanpa deklarasi dicatat `undefined`). */
  accesses: (RouteAccess | undefined)[];
}

/**
 * Akses rute pelengkap = yang PALING ketat yang masih jujur untuk alamat itu:
 *  - semua rute asli publik → publik (405 + `Allow` untuk siapa pun);
 *  - semua rute asli butuh izin yang SAMA → izin itu (peran tanpa izin mendapat 403 + audit,
 *    bukan 405 + `Allow` yang memetakan metode rute yang tidak boleh ia pakai);
 *  - selain itu → cukup sesi.
 */
function complementAccess(accesses: readonly (RouteAccess | undefined)[]): RouteAccess {
  if (accesses.every((access) => access?.kind === 'public')) return PUBLIC;
  // API publik: key sah apa pun (scope sama → scope itu), tanpa sesi.
  if (accesses.every((access) => access?.kind === 'apiKey')) {
    const scopes = new Set(
      accesses.map((access) => (access?.kind === 'apiKey' ? access.scope : null)),
    );
    const [onlyScope] = scopes;
    const credentials = new Set(
      accesses.map((access) => (access?.kind === 'apiKey' ? access.credential : undefined)),
    );
    const [credential] = credentials;
    return {
      kind: 'apiKey',
      scope: scopes.size === 1 ? (onlyScope ?? null) : null,
      // Cara kirim key sama di semua rute alamat itu → dipertahankan (MobiChat: `X-API-Key`).
      ...(credentials.size === 1 && credential ? { credential } : {}),
    };
  }
  const permissions = new Set(
    accesses.map((access) => (access?.kind === 'permission' ? access.permission : undefined)),
  );
  const [only] = permissions;
  if (permissions.size === 1 && only !== undefined) return requirePermission(only);
  return AUTHENTICATED;
}

/**
 * Fastify menjawab 404 untuk metode yang salah pada alamat yang ada (mis. `POST /health`).
 * Yang benar menurut HTTP: 405 dengan header `Allow` berisi metode yang tersedia.
 *
 * Cara kerjanya umum untuk semua rute: setiap rute yang didaftarkan dicatat lewat hook
 * `onRoute`, lalu `registerMethodNotAllowedRoutes()` mendaftarkan rute pelengkap (alamat yang
 * sama, metode yang belum ada) yang menjawab 405. Pencocokan alamat tetap dilakukan router
 * Fastify sendiri, jadi parameter (`/users/:id`) dan wildcard berperilaku persis sama.
 *
 * Akses rute pelengkap mengikuti rute aslinya (temuan N1 review Fase 0, `complementAccess`): bila
 * ada satu saja rute non-publik di alamat itu, pelengkapnya menuntut sesi — orang yang belum masuk
 * mendapat 401, bukan 405 + `Allow`, sehingga tidak bisa memetakan metode rute yang terlindungi.
 * Bila semua rute di alamat itu butuh izin yang sama, pelengkapnya juga butuh izin itu.
 *
 * Panggil `trackRoutes` SEBELUM rute pertama didaftarkan dan fungsi yang dikembalikannya
 * SETELAH rute terakhir (rute yang didaftarkan sesudahnya tetap dijawab 404 untuk metode salah).
 */
export function trackRoutesForMethodNotAllowed(app: RouteRegistry): () => void {
  const routesByUrl = new Map<string, KnownRoute>();
  let registering = false;

  app.addHook('onRoute', (route) => {
    if (registering) return;
    // Rute dengan constraint (host/versi) dilewati: pelengkapnya bisa menutupi rute lain.
    if (route.constraints && Object.keys(route.constraints).length > 0) return;

    const known = routesByUrl.get(route.url) ?? { methods: new Set<string>(), accesses: [] };
    for (const method of [route.method].flat()) known.methods.add(method.toUpperCase());
    // Rute tanpa deklarasi dicatat `undefined` = tidak publik (bawaan tolak).
    known.accesses.push(route.config?.access);
    routesByUrl.set(route.url, known);
  });

  return function registerMethodNotAllowedRoutes(): void {
    registering = true;
    try {
      for (const [url, known] of routesByUrl) {
        // HEAD ikut tersedia untuk setiap rute GET (dibuat otomatis oleh Fastify).
        const isAllowed = (method: CoveredMethod): boolean =>
          known.methods.has(method) || (method === 'HEAD' && known.methods.has('GET'));
        const allowed = COVERED_METHODS.filter(isAllowed);
        const missing: HTTPMethods[] = COVERED_METHODS.filter((method) => !isAllowed(method));
        // Tanpa metode "biasa" (mis. rute `OPTIONS *` milik CORS) tidak ada yang perlu dilengkapi.
        if (allowed.length === 0 || missing.length === 0) continue;

        const allow = allowed.join(', ');
        app.route({
          method: missing,
          url,
          // Selalu menjawab lewat amplop error, jadi tidak butuh skema respons.
          config: {
            access: complementAccess(known.accesses),
            rawResponse: true,
            methodNotAllowed: true,
          },
          handler: (request, reply) => {
            void reply.header('allow', allow);
            return handleError(new AppError('METHOD_NOT_ALLOWED'), request, reply);
          },
        });
      }
    } finally {
      registering = false;
    }
  };
}
