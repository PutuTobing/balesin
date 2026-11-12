import { z } from 'zod';

/**
 * Definisi antrian BullMQ yang dipakai bersama: api (produsen) dan worker (konsumen).
 * Hanya nama, skema payload, dan opsi — tanpa impor BullMQ, supaya paket ini tetap ringan.
 */

/** Awalan semua kunci BullMQ di Redis. */
export const QUEUE_PREFIX = 'balesin';

export const QUEUE_NAMES = {
  /** Pekerjaan internal: uji antrian, nanti pembersihan sesi kedaluwarsa, dsb. */
  system: 'system',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Opsi bawaan setiap job: 3 percobaan dengan jeda eksponensial; riwayat dibatasi. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 5_000 },
};

// ── Antrian `system` ────────────────────────────────────────────────────────

export const SYSTEM_JOBS = {
  /** Uji ujung-ke-ujung: produsen → Redis → worker. Dipakai pemeriksaan kesehatan antrian. */
  ping: 'ping',
} as const;
export type SystemJobName = (typeof SYSTEM_JOBS)[keyof typeof SYSTEM_JOBS];

export const systemPingPayloadSchema = z.strictObject({
  /** Waktu job dibuat (ISO 8601), untuk mengukur lama menunggu di antrian. */
  requestedAt: z.iso.datetime(),
});
export type SystemPingPayload = z.infer<typeof systemPingPayloadSchema>;

export const systemPingResultSchema = z.object({
  processedAt: z.iso.datetime(),
  /** Lama job menunggu sampai diproses, dalam milidetik. */
  waitedMs: z.number(),
});
export type SystemPingResult = z.infer<typeof systemPingResultSchema>;
