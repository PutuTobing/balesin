import { healthResponseSchema, readyResponseSchema } from '@balesin/shared';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import type { ReadinessService } from './health.service';

export interface HealthRoutesOptions {
  readiness: ReadinessService;
}

/** Path rute kesehatan — dipakai juga untuk mematikan log per-request rute ini. */
export const HEALTH_PATHS = ['/health', '/ready'] as const;

/**
 * - `GET /health` — liveness: proses hidup. Tidak menyentuh dependensi, selalu cepat.
 * - `GET /ready` — readiness: Postgres dan Redis terjangkau. 200 bila semua sehat, 503 bila tidak.
 *
 * Keduanya publik (dipakai healthcheck Docker dan reverse proxy) dan hanya membuka
 * status `ok`/`down` per dependensi.
 */
export const healthRoutes: FastifyPluginCallbackZod<HealthRoutesOptions> = (app, options, done) => {
  app.get('/health', { schema: { response: { 200: healthResponseSchema } } }, (_request, reply) => {
    void reply.send({ status: 'ok' });
  });

  app.get(
    '/ready',
    { schema: { response: { 200: readyResponseSchema, 503: readyResponseSchema } } },
    async (_request, reply) => {
      const result = await options.readiness.check();
      return reply.status(result.status === 'ok' ? 200 : 503).send(result);
    },
  );

  done();
};
