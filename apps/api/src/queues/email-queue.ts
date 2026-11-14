import {
  DEFAULT_JOB_OPTIONS,
  EMAIL_JOBS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  accountLockedEmailPayloadSchema,
  accountTokenEmailPayloadSchema,
  emailSettingsChangedEmailPayloadSchema,
  invitationEmailPayloadSchema,
  securityNoticeAdminEmailPayloadSchema,
  securityNoticeEmailPayloadSchema,
  withTimeout,
  type AccountLockedEmailPayload,
  type AccountTokenEmailPayload,
  type EmailSettingsChangedEmailPayload,
  type InvitationEmailPayload,
  type Redis,
  type SecurityNoticeAdminEmailPayload,
  type SecurityNoticeEmailPayload,
} from '@balesin/core';
import { Queue } from 'bullmq';
import type { z } from 'zod';

/**
 * Sisi produsen antrian `email`: API hanya MENGANTRE; pengirimannya dikerjakan worker
 * (apps/worker/src/queues/email.ts). Payload berisi ID saja — lihat `@balesin/core` queues.
 * Token tautan TIDAK PERNAH masuk payload: worker membuka salinan terenkripsinya dari database.
 */
export interface EmailNotifier {
  /** Antrekan pemberitahuan "akun dikunci sementara". */
  accountLocked(payload: AccountLockedEmailPayload): Promise<void>;
  /** Antrekan pemberitahuan keamanan akun (2FA, kode cadangan, password diganti). */
  securityNotice(payload: SecurityNoticeEmailPayload): Promise<void>;
  /** Antrekan pemberitahuan ke SATU Owner/Admin: 2FA akun ber-peran wajib baru aktif. */
  securityNoticeAdmin(payload: SecurityNoticeAdminEmailPayload): Promise<void>;
  /** Antrekan email undangan. */
  invitation(payload: InvitationEmailPayload): Promise<void>;
  /** Antrekan tautan atur ulang password / verifikasi email. */
  accountToken(payload: AccountTokenEmailPayload): Promise<void>;
  /** Antrekan pemberitahuan ke SATU Owner: email pengirim diubah pengguna lain. */
  emailSettingsChanged(payload: EmailSettingsChangedEmailPayload): Promise<void>;
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

  function enqueue<T>(name: string, schema: z.ZodType<T>) {
    return async (payload: T): Promise<void> => {
      const data = schema.parse(payload);
      await withTimeout(queue.add(name, data), ENQUEUE_TIMEOUT_MS, 'Mengantre email');
    };
  }

  return {
    notifier: {
      accountLocked: enqueue(EMAIL_JOBS.accountLocked, accountLockedEmailPayloadSchema),
      securityNotice: enqueue(EMAIL_JOBS.securityNotice, securityNoticeEmailPayloadSchema),
      securityNoticeAdmin: enqueue(
        EMAIL_JOBS.securityNoticeAdmin,
        securityNoticeAdminEmailPayloadSchema,
      ),
      invitation: enqueue(EMAIL_JOBS.invitation, invitationEmailPayloadSchema),
      accountToken: enqueue(EMAIL_JOBS.accountToken, accountTokenEmailPayloadSchema),
      emailSettingsChanged: enqueue(
        EMAIL_JOBS.emailSettingsChanged,
        emailSettingsChangedEmailPayloadSchema,
      ),
    },
    close: () => queue.close(),
  };
}
