import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  SYSTEM_JOBS,
  systemPingPayloadSchema,
  type Logger,
  type Redis,
  type SystemPingResult,
} from '@balesin/core';
import { Queue, UnrecoverableError, Worker } from 'bullmq';

/** Bagian job BullMQ yang dipakai pemroses — memudahkan tes tanpa Redis. */
export interface SystemJob {
  id?: string;
  name: string;
  data: unknown;
}

export interface SystemJobDeps {
  logger: Logger;
  /** Bisa diganti di tes. */
  now?: () => Date;
}

export interface QueueConnectionOptions {
  /** Koneksi ioredis ber-peran `queue` (lihat `createRedis` di `@balesin/core`). */
  connection: Redis;
  /** Awalan kunci Redis. Bawaan `balesin`; tes memakai awalan sendiri. */
  prefix?: string;
}

/**
 * Pemroses antrian `system`. Payload SELALU divalidasi (bisa datang dari versi aplikasi lain).
 * Job yang tidak dikenal atau payload-nya rusak gagal permanen (`UnrecoverableError`):
 * mengulang job seperti itu tidak akan pernah berhasil.
 */
export function processSystemJob(job: SystemJob, deps: SystemJobDeps): SystemPingResult {
  if (job.name !== SYSTEM_JOBS.ping) {
    throw new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian system`);
  }

  const payload = systemPingPayloadSchema.safeParse(job.data);
  if (!payload.success) {
    throw new UnrecoverableError('Payload job system:ping tidak valid');
  }

  const processedAt = (deps.now ?? (() => new Date()))();
  const waitedMs = Math.max(0, processedAt.getTime() - Date.parse(payload.data.requestedAt));
  deps.logger.info({ jobId: job.id, waitedMs }, 'Antrian system merespons ping');
  return { processedAt: processedAt.toISOString(), waitedMs };
}

/** Sisi produsen antrian `system` (dipakai tes; nanti juga api). */
export function createSystemQueue(options: QueueConnectionOptions): Queue {
  return new Queue(QUEUE_NAMES.system, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

/** Sisi konsumen antrian `system`. */
export function createSystemWorker(options: QueueConnectionOptions, deps: SystemJobDeps): Worker {
  return new Worker(QUEUE_NAMES.system, (job) => Promise.resolve(processSystemJob(job, deps)), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    concurrency: 5,
  });
}
