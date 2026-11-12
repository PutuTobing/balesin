import type { Logger } from '@balesin/core';
import type { Worker } from 'bullmq';

import { createSystemWorker, type QueueConnectionOptions } from './queues/system';

export interface WorkerRuntime {
  workers: Worker[];
  /** Berhenti mengambil job baru dan menunggu job yang sedang berjalan selesai. */
  close(): Promise<void>;
}

const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Menyalakan semua pemroses antrian. Setiap antrian baru didaftarkan di sini.
 * Tidak melempar bila Redis mati: BullMQ menunggu koneksi pulih lalu lanjut memproses.
 */
export function startWorkers(options: QueueConnectionOptions, logger: Logger): WorkerRuntime {
  const workers = [createSystemWorker(options, { logger })];

  for (const worker of workers) {
    const queue = worker.name;

    // Wajib ada listener `error`: tanpa itu error koneksi menjatuhkan proses. Dibatasi agar
    // log tidak banjir selama Redis mati.
    let lastErrorLogAt = 0;
    worker.on('error', (err) => {
      const now = Date.now();
      if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
      lastErrorLogAt = now;
      logger.error({ err, queue }, 'Worker antrian bermasalah');
    });

    worker.on('failed', (job, err) => {
      logger.warn(
        { err, queue, jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade },
        'Job gagal',
      );
    });

    worker.on('completed', (job) => {
      logger.debug({ queue, jobId: job.id, jobName: job.name }, 'Job selesai');
    });
  }

  return {
    workers,
    async close() {
      // Tanpa koneksi Redis tidak ada job yang bisa diselesaikan, dan penutupan biasa akan
      // menunggu Redis selamanya — jadi tutup paksa (langsung putus) bila Redis sedang mati.
      const force = options.connection.status !== 'ready';
      await Promise.all(workers.map((worker) => worker.close(force)));
    },
  };
}
