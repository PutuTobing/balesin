import {
  DEFAULT_JOB_OPTIONS,
  EMAIL_JOBS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  accountLockedEmailPayloadSchema,
  securityNoticeEmailPayloadSchema,
  withTimeout,
  type AccountLockedEmailPayload,
  type Redis,
  type SecurityNoticeEmailPayload,
} from '@balesin/core';
import { Queue } from 'bullmq';

/**
 * Sisi produsen antrian `email`: API hanya MENGANTRE; pengirimannya dikerjakan worker
 * (apps/worker/src/queues/email.ts). Payload berisi ID saja — lihat `@balesin/core` queues.
 */
export interface EmailNotifier {
  /** Antrekan pemberitahuan "akun dikunci sementara". */
  accountLocked(payload: AccountLockedEmailPayload): Promise<void>;
  /** Antrekan pemberitahuan keamanan akun (2FA diaktifkan/dinonaktifkan, kode cadangan dipakai). */
  securityNotice(payload: SecurityNoticeEmailPayload): Promise<void>;
}

export interface EmailQueue {
  notifier: EmailNotifier;
  close(): Promise<void>;
}

export interface EmailQueueOptions {
  /** Koneksi ioredis khusus antrian (gagal cepat bila Redis mati; jangan dipakai bersama worker). */
  connection: Redis;
  /** Awalan kunci Redis. Bawaan `balesin`; tes memakai awalan sendiri. */
  prefix?: string;
}

/** Batas waktu mengantre: permintaan HTTP tidak boleh menggantung karena Redis lambat. */
const ENQUEUE_TIMEOUT_MS = 3_000;

export function createEmailQueue(options: EmailQueueOptions): EmailQueue {
  const queue = new Queue(QUEUE_NAMES.email, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  // Tanpa listener, error koneksi antrian menjadi "unhandled error". Pencatatannya sudah
  // dilakukan listener koneksi Redis (createRedis).
  queue.on('error', () => undefined);

  return {
    notifier: {
      async accountLocked(payload) {
        const data = accountLockedEmailPayloadSchema.parse(payload);
        await withTimeout(
          queue.add(EMAIL_JOBS.accountLocked, data),
          ENQUEUE_TIMEOUT_MS,
          'Mengantre email',
        );
      },
      async securityNotice(payload) {
        const data = securityNoticeEmailPayloadSchema.parse(payload);
        await withTimeout(
          queue.add(EMAIL_JOBS.securityNotice, data),
          ENQUEUE_TIMEOUT_MS,
          'Mengantre email',
        );
      },
    },
    close: () => queue.close(),
  };
}
