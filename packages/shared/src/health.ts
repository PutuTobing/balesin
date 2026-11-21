import { z } from 'zod';

/** `GET /health` — liveness: proses API hidup (tidak memeriksa dependensi). */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Status satu dependensi. Sengaja tanpa pesan error mentah (tidak membocorkan detail infrastruktur). */
export const dependencyStatusSchema = z.enum(['ok', 'down']);
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

/**
 * `GET /ready` — readiness: API siap melayani (Postgres & Redis terjangkau).
 * HTTP 200 bila `status: "ok"`, HTTP 503 bila `status: "unavailable"`.
 */
export const readyResponseSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  dependencies: z.object({
    postgres: dependencyStatusSchema,
    redis: dependencyStatusSchema,
  }),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
