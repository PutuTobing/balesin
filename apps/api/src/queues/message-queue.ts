import {
  MESSAGE_JOBS,
  MESSAGE_JOB_OPTIONS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  sendMessageJobId,
  sendMessageJobPayloadSchema,
  withTimeout,
  type Redis,
  type SendMessageJobPayload,
} from '@balesin/core';
import { Queue } from 'bullmq';

/**
 * Sisi produsen antrian `messages`: api menyimpan pesan keluar `pending` lalu mengantre ID-nya;
 * worker (apps/worker/src/queues/messages.ts) yang mengirim ke Meta. Payload hanya ID.
 */
export interface OutboundMessageEnqueuer {
  /** `attempt` = nomor percobaan (1 = kirim pertama; kirim ulang manual menaikkannya). */
  enqueue(job: SendMessageJobPayload, attempt: number): Promise<void>;
}

export interface MessageQueue {
  enqueuer: OutboundMessageEnqueuer;
  close(): Promise<void>;
}

const ENQUEUE_TIMEOUT_MS = 2_000;

export function createMessageQueue(options: { connection: Redis; prefix?: string }): MessageQueue {
  const queue = new Queue(QUEUE_NAMES.messages, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    defaultJobOptions: MESSAGE_JOB_OPTIONS,
  });
  queue.on('error', () => undefined);
  return {
    enqueuer: {
      async enqueue(job, attempt) {
        const data = sendMessageJobPayloadSchema.parse(job);
        await withTimeout(
          queue.add(MESSAGE_JOBS.send, data, { jobId: sendMessageJobId(data.messageId, attempt) }),
          ENQUEUE_TIMEOUT_MS,
          'Mengantre pesan keluar',
        );
      },
    },
    close: () => queue.close(),
  };
}
