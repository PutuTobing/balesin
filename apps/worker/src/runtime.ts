import type { Logger } from '@balesin/core';
import type { Queue, Worker } from 'bullmq';

import { createEmailWorker, type EmailJobDeps } from './queues/email';
import { createMessageWorker, type MessageJobDeps } from './queues/messages';
import { createNotificationWorker, type NotificationJobDeps } from './queues/notifications';
import {
  createMaintenanceQueue,
  createMaintenanceWorker,
  scheduleMaintenanceJobs,
  type MaintenanceJobDeps,
} from './queues/maintenance';
import { createSystemWorker, type QueueConnectionOptions } from './queues/system';
import {
  createWebhooksOutQueue,
  createWebhooksOutWorker,
  scheduleWebhooksOut,
  type WebhooksOutDeps,
} from './queues/webhooks-out';
import { createWebhookWorker, type WebhookJobDeps } from './queues/webhooks';

export interface WorkerRuntime {
  workers: Worker[];
  /** Berhenti mengambil job baru dan menunggu job yang sedang berjalan selesai. */
  close(): Promise<void>;
}

/** Dependensi pemroses job selain koneksi antrian. */
export interface WorkerServices {
  /** Untuk antrian `email` (database, kotak rahasia, cadangan SMTP). */
  email: Omit<EmailJobDeps, 'logger'>;
  /** Untuk antrian `webhooks` (kejadian webhook masuk yang sudah tersimpan). */
  webhooks: Omit<WebhookJobDeps, 'logger'>;
  /**
   * Antrian `maintenance` + jadwal berkalanya (retensi payload webhook). Opsional supaya tes yang
   * tidak membutuhkannya tidak mendaftarkan jadwal di Redis.
   */
  maintenance?: Omit<MaintenanceJobDeps, 'logger'>;
  /** Antrian `messages` (pesan keluar ke Meta). Opsional untuk tes yang tidak membutuhkannya. */
  messages?: Omit<MessageJobDeps, 'logger'>;
  /** Antrian `notifications` (Web Push). Opsional untuk tes yang tidak membutuhkannya. */
  notifications?: Omit<NotificationJobDeps, 'logger'>;
  /** Antrian `webhooks-out` (webhook keluar, job berkala tiap 5 dtk). Opsional untuk tes. */
  webhooksOut?: Omit<WebhooksOutDeps, 'logger'>;
}

const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Menyalakan semua pemroses antrian. Setiap antrian baru didaftarkan di sini.
 * Tidak melempar bila Redis mati: BullMQ menunggu koneksi pulih lalu lanjut memproses.
 */
export function startWorkers(
  options: QueueConnectionOptions,
  logger: Logger,
  services: WorkerServices,
): WorkerRuntime {
  const workers = [
    createSystemWorker(options, { logger }),
    createEmailWorker(options, { ...services.email, logger }),
    createWebhookWorker(options, { ...services.webhooks, logger }),
  ];
  if (services.messages) {
    workers.push(createMessageWorker(options, { ...services.messages, logger }));
  }
  if (services.notifications) {
    workers.push(createNotificationWorker(options, { ...services.notifications, logger }));
  }
  let maintenanceQueue: Queue | undefined;
  let webhooksOutQueue: Queue | undefined;
  if (services.webhooksOut) {
    workers.push(createWebhooksOutWorker(options, { ...services.webhooksOut, logger }));
    const queue = createWebhooksOutQueue(options);
    webhooksOutQueue = queue;
    scheduleWebhooksOut(queue).catch((err: unknown) => {
      logger.error({ err }, 'Jadwal webhook keluar gagal didaftarkan');
    });
    queue.on('error', () => undefined);
  }
  if (services.maintenance) {
    workers.push(createMaintenanceWorker(options, { ...services.maintenance, logger }));
    const queue = createMaintenanceQueue(options);
    maintenanceQueue = queue;
    // Tidak ditunggu: Redis yang belum siap tidak boleh menahan start. Gagal = dicoba lagi saat
    // worker dijalankan ulang (retensi tertunda, bukan data hilang).
    scheduleMaintenanceJobs(queue).catch((err: unknown) => {
      logger.error({ err }, 'Jadwal pemeliharaan (retensi payload webhook) gagal didaftarkan');
    });
    queue.on('error', () => {
      // Error koneksi sudah dicatat listener worker; listener ini mencegah proses jatuh.
    });
  }

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
      if (webhooksOutQueue) {
        if (force) await webhooksOutQueue.disconnect();
        else await webhooksOutQueue.close();
      }
      if (maintenanceQueue) {
        if (force) await maintenanceQueue.disconnect();
        else await maintenanceQueue.close();
      }
    },
  };
}
