import {
  QUEUE_NAMES,
  QUEUE_PREFIX,
  WEBHOOK_JOBS,
  WEBHOOK_JOB_OPTIONS,
  webhookEventJobId,
  webhookEventJobPayloadSchema,
  withTimeout,
  type Redis,
  type WebhookEventJobPayload,
} from '@balesin/core';
import { Queue } from 'bullmq';

/**
 * Sisi produsen antrian `webhooks`: penerima webhook menyimpan kejadian ke `webhook_events` lalu
 * mengantre ID-nya di sini; worker (apps/worker/src/queues/webhooks.ts) yang memproses. Payload
 * hanya `{ organizationId, eventId }` — isi pesan pelanggan dan App Secret tidak pernah masuk Redis.
 */
export interface WebhookEventEnqueuer {
  /** Antrekan sekaligus. ID job = ID kejadian, jadi mengantre ulang kejadian yang sama aman. */
  enqueue(events: readonly WebhookEventJobPayload[]): Promise<void>;
}

export interface WebhookQueue {
  enqueuer: WebhookEventEnqueuer;
  close(): Promise<void>;
}

/** Penerima harus menjawab Meta < 1 detik; Redis lambat → 503 (Meta mengirim ulang nanti). */
const ENQUEUE_TIMEOUT_MS = 2_000;

export function createWebhookQueue(options: { connection: Redis; prefix?: string }): WebhookQueue {
  const queue = new Queue(QUEUE_NAMES.webhooks, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    defaultJobOptions: WEBHOOK_JOB_OPTIONS,
  });
  queue.on('error', () => undefined);

  return {
    enqueuer: {
      async enqueue(events) {
        if (events.length === 0) return;
        const jobs = events.map((event) => {
          const data = webhookEventJobPayloadSchema.parse(event);
          return {
            name: WEBHOOK_JOBS.whatsappEvent,
            data,
            opts: { jobId: webhookEventJobId(data.eventId) },
          };
        });
        await withTimeout(queue.addBulk(jobs), ENQUEUE_TIMEOUT_MS, 'Mengantre kejadian webhook');
      },
    },
    close: () => queue.close(),
  };
}
