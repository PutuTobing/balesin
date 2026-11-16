import {
  NOTIFICATION_JOBS,
  NOTIFICATION_JOB_OPTIONS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  notificationJobId,
  notificationJobPayloadSchema,
  withTimeout,
  type Logger,
  type NotificationJobPayload,
  type Redis,
} from '@balesin/core';
import { Queue } from 'bullmq';

/**
 * Sisi produsen antrian `notifications` (Fase 2 butir 10): api mengantre kejadian inbox (ditugaskan,
 * kembali ke antrian, tes); worker menentukan penerima & mengirim Web Push. Payload hanya ID.
 * USAHA TERBAIK: gagal mengantre tidak pernah menggagalkan aksi pengguna (cukup dicatat).
 */
export interface NotificationEnqueuer {
  enqueue(job: NotificationJobPayload): Promise<void>;
}

export const NOOP_NOTIFICATION_ENQUEUER: NotificationEnqueuer = {
  enqueue: () => Promise.resolve(),
};

export interface NotificationQueue {
  enqueuer: NotificationEnqueuer;
  close(): Promise<void>;
}

const ENQUEUE_TIMEOUT_MS = 2_000;

export function createNotificationQueue(options: {
  connection: Redis;
  prefix?: string;
  logger: Pick<Logger, 'warn'>;
}): NotificationQueue {
  const queue = new Queue(QUEUE_NAMES.notifications, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    defaultJobOptions: NOTIFICATION_JOB_OPTIONS,
  });
  queue.on('error', () => undefined);
  return {
    enqueuer: {
      async enqueue(job) {
        try {
          const data = notificationJobPayloadSchema.parse(job);
          const jobId = notificationJobId(data);
          await withTimeout(
            queue.add(NOTIFICATION_JOBS.inbox, data, jobId ? { jobId } : {}),
            ENQUEUE_TIMEOUT_MS,
            'Mengantre notifikasi',
          );
        } catch (err) {
          options.logger.warn({ err, kind: job.kind }, 'Notifikasi tidak terantre');
        }
      },
    },
    close: () => queue.close(),
  };
}
