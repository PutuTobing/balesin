import {
  MAIL_JOBS,
  MAIL_JOB_OPTIONS,
  MAIL_PURGE_JOB_OPTIONS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  mailAccountJobPayloadSchema,
  mailPurgeJobId,
  mailSyncFoldersJobId,
  withTimeout,
  type MailAccountJobPayload,
  type Redis,
} from '@balesin/core';
import { Queue } from 'bullmq';

/**
 * Sisi produsen antrian `mail` (Fase 9): "Sinkron sekarang" dan putuskan akun. Payload hanya ID.
 * Tanpa produsen (tes), worker tetap mengambilnya dari jadwal `next_attempt_at` / status `deleting`
 * lewat `mail-tick` — antrean langsung hanya mempercepat.
 */
export interface MailJobEnqueuer {
  sync(payload: MailAccountJobPayload): Promise<void>;
  purge(payload: Omit<MailAccountJobPayload, 'force'>): Promise<void>;
}

export interface MailQueue {
  enqueuer: MailJobEnqueuer;
  close(): Promise<void>;
}

const ENQUEUE_TIMEOUT_MS = 2_000;

export function createMailQueue(options: { connection: Redis; prefix?: string }): MailQueue {
  const queue = new Queue(QUEUE_NAMES.mail, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
  });
  queue.on('error', () => undefined);
  return {
    enqueuer: {
      async sync(payload) {
        const data = mailAccountJobPayloadSchema.parse(payload);
        await withTimeout(
          queue.add(MAIL_JOBS.syncFolders, data, {
            ...MAIL_JOB_OPTIONS,
            jobId: mailSyncFoldersJobId(data.accountId),
          }),
          ENQUEUE_TIMEOUT_MS,
          'Mengantre sinkron akun email',
        );
      },
      async purge(payload) {
        const data = mailAccountJobPayloadSchema.parse(payload);
        await withTimeout(
          queue.add(MAIL_JOBS.purgeAccount, data, {
            ...MAIL_PURGE_JOB_OPTIONS,
            jobId: mailPurgeJobId(data.accountId),
          }),
          ENQUEUE_TIMEOUT_MS,
          'Mengantre pemutusan akun email',
        );
      },
    },
    close: () => queue.close(),
  };
}
