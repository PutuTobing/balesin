import { AppError } from '@balesin/core';
import type { FastifyInstance, HTTPMethods } from 'fastify';

import { handleError } from './error-handler';

/** Metode yang dijawab 405 bila alamatnya ada tetapi metodenya tidak. OPTIONS milik CORS. */
const COVERED_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

type CoveredMethod = (typeof COVERED_METHODS)[number];

/** Bagian instance Fastify yang dipakai di sini (lepas dari type provider aplikasinya). */
type RouteRegistry = Pick<FastifyInstance, 'addHook' | 'route'>;

/**
 * Fastify menjawab 404 untuk metode yang salah pada alamat yang ada (mis. `POST /health`).
 * Yang benar menurut HTTP: 405 dengan header `Allow` berisi metode yang tersedia.
 *
 * Cara kerjanya umum untuk semua rute: setiap rute yang didaftarkan dicatat lewat hook
 * `onRoute`, lalu `registerMethodNotAllowedRoutes()` mendaftarkan rute pelengkap (alamat yang
 * sama, metode yang belum ada) yang menjawab 405. Pencocokan alamat tetap dilakukan router
 * Fastify sendiri, jadi parameter (`/users/:id`) dan wildcard berperilaku persis sama.
 *
 * Panggil `trackRoutes` SEBELUM rute pertama didaftarkan dan fungsi yang dikembalikannya
 * SETELAH rute terakhir (rute yang didaftarkan sesudahnya tetap dijawab 404 untuk metode salah).
 */
export function trackRoutesForMethodNotAllowed(app: RouteRegistry): () => void {
  const methodsByUrl = new Map<string, Set<string>>();
  let registering = false;

  app.addHook('onRoute', (route) => {
    if (registering) return;
    // Rute dengan constraint (host/versi) dilewati: pelengkapnya bisa menutupi rute lain.
    if (route.constraints && Object.keys(route.constraints).length > 0) return;

    const known = methodsByUrl.get(route.url) ?? new Set<string>();
    for (const method of [route.method].flat()) known.add(method.toUpperCase());
    methodsByUrl.set(route.url, known);
  });

  return function registerMethodNotAllowedRoutes(): void {
    registering = true;
    try {
      for (const [url, known] of methodsByUrl) {
        // HEAD ikut tersedia untuk setiap rute GET (dibuat otomatis oleh Fastify).
        const isAllowed = (method: CoveredMethod): boolean =>
          known.has(method) || (method === 'HEAD' && known.has('GET'));
        const allowed = COVERED_METHODS.filter(isAllowed);
        const missing: HTTPMethods[] = COVERED_METHODS.filter((method) => !isAllowed(method));
        // Tanpa metode "biasa" (mis. rute `OPTIONS *` milik CORS) tidak ada yang perlu dilengkapi.
        if (allowed.length === 0 || missing.length === 0) continue;

        const allow = allowed.join(', ');
        app.route({
          method: missing,
          url,
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
