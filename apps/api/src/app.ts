import { randomUUID } from 'node:crypto';

import type { Logger } from '@balesin/core';
import { configureZodLocale } from '@balesin/shared';
import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import type { ApiConfig } from './config';
import { handleError, handleNotFound } from './http/error-handler';
import { trackRoutesForMethodNotAllowed } from './http/method-not-allowed';
import { applyBaselineHeaders, securityPlugin } from './http/security';
import { HEALTH_PATHS, healthRoutes } from './modules/health/health.routes';
import { createReadinessService, type ReadinessProbes } from './modules/health/health.service';

export interface AppDeps {
  config: Pick<ApiConfig, 'appOrigin' | 'isProduction' | 'trustProxy'>;
  logger: Logger;
  /** Pemeriksaan dependensi untuk `GET /ready`. */
  readinessProbes: ReadinessProbes;
  /** Batas waktu tiap pemeriksaan `/ready` (bawaan 2 detik). */
  readinessTimeoutMs?: number;
}

/**
 * Batas ukuran body bawaan (1 MiB) — cukup untuk JSON biasa. Rute yang butuh lebih
 * (webhook Meta, unggah media) menetapkan `bodyLimit` sendiri di rutenya.
 */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

const REQUEST_TIMEOUT_MS = 30_000;
const QUIET_PATHS = new Set<string>(HEALTH_PATHS);

/**
 * Merakit aplikasi Fastify tanpa mulai mendengarkan port, supaya bisa dites dengan
 * `app.inject()`. Semua dependensi luar masuk lewat `deps`.
 */
export async function buildApp(deps: AppDeps) {
  configureZodLocale();

  // Diketik sebagai logger dasar Fastify supaya tipe plugin dan rute tetap sederhana.
  const loggerInstance: FastifyBaseLogger = deps.logger;

  const app = Fastify({
    loggerInstance,
    logController: new LogController({
      requestIdLogLabel: 'requestId',
      // Healthcheck dipanggil tiap beberapa detik — tidak perlu memenuhi log.
      disableRequestLogging: (request) => QUIET_PATHS.has(request.routeOptions.url ?? ''),
    }),
    // ID dibuat server; header dari klien tidak dipercaya (mencegah pemalsuan jejak log).
    genReqId: () => randomUUID(),
    trustProxy: deps.config.trustProxy,
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    frameworkErrors: (error, request, reply) => {
      // Error di tingkat ini (URL rusak, parameter terlalu panjang) dijawab sebelum hook mana
      // pun berjalan, jadi header keamanan dasarnya dipasang di sini.
      applyBaselineHeaders(reply, request.id);
      void handleError(error, request, reply);
    },
  }).withTypeProvider<ZodTypeProvider>();

  // Zod memvalidasi request DAN menyaring respons (kolom di luar skema tidak ikut terkirim).
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(handleError);
  app.setNotFoundHandler(handleNotFound);

  // API hanya menerima body JSON. Parser teks bawaan Fastify dibuang: `text/plain` adalah
  // satu-satunya tipe body yang bisa dikirim lintas situs tanpa preflight CORS.
  app.removeContentTypeParser('text/plain');

  const registerMethodNotAllowedRoutes = trackRoutesForMethodNotAllowed(app);

  await app.register(securityPlugin, {
    appOrigin: deps.config.appOrigin,
    isProduction: deps.config.isProduction,
  });

  await app.register(healthRoutes, {
    readiness: createReadinessService({
      probes: deps.readinessProbes,
      logger: app.log,
      timeoutMs: deps.readinessTimeoutMs,
    }),
  });

  // Harus setelah SEMUA rute modul didaftarkan (lihat http/method-not-allowed.ts).
  registerMethodNotAllowedRoutes();

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
