import {
  EMAIL_JOBS,
  MAIL_COPY_JOB_OPTIONS,
  MAIL_DRAFT_REMOTE_DELETE_JOB_OPTIONS,
  mailDraftJobPayloadSchema,
  mailDraftRemoteDeleteJobId,
  mailDraftRemoteDeletePayloadSchema,
  mailDraftSyncJobId,
  mailIdentityJobPayloadSchema,
  mailIdentityVerificationPayloadSchema,
  mailVerifyCheckJobId,
  type MailDraftJobPayload,
  type MailDraftRemoteDeletePayload,
  type MailIdentityJobPayload,
  type MailIdentityVerificationPayload,
  MAIL_ACTION_JOB_OPTIONS,
  MAIL_FETCH_JOB_OPTIONS,
  MAIL_JOBS,
  MAIL_JOB_OPTIONS,
  MAIL_PURGE_JOB_OPTIONS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  mailAccountJobPayloadSchema,
  mailActionJobId,
  mailAttachmentJobPayloadSchema,
  mailFetchAttachmentJobId,
  mailFetchBodyJobId,
  mailMessageJobPayloadSchema,
  mailPurgeJobId,
  mailSyncFoldersJobId,
  withTimeout,
  type MailAccountJobPayload,
  type MailAttachmentJobPayload,
  type MailMessageJobPayload,
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
  /** Bagian 2: ambil isi email saat dibuka (prioritas tinggi). */
  fetchBody?(payload: MailMessageJobPayload): Promise<void>;
  /** Bagian 2: ambil lampiran saat diunduh. */
  fetchAttachment?(payload: MailAttachmentJobPayload): Promise<void>;
  /** Bagian 2: terapkan aksi dua arah tertunda akun ini ke server. */
  action?(payload: Omit<MailAccountJobPayload, 'force'>): Promise<void>;
  // ── 9B (cadangan semua: tick worker) ──
  /** Email verifikasi alamat pengirim — antrian email SISTEM (SMTP sistem, bukan akun). */
  identityVerification?(payload: MailIdentityVerificationPayload): Promise<void>;
  /** Cadangan `UID SEARCH HEADER Message-ID` (tunda `delayMs`). */
  verifyCheck?(payload: MailIdentityJobPayload, delayMs: number): Promise<void>;
  /** Salinan draf ke folder Draf server (tunda `delayMs`; ID job = draf). */
  draftSync?(payload: MailDraftJobPayload, delayMs: number): Promise<void>;
  /** Hapus salinan draf terakhir di server. */
  draftRemoteDelete?(payload: MailDraftRemoteDeletePayload): Promise<void>;
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
  // 9B: email verifikasi alamat pengirim lewat antrian email SISTEM.
  const emailQueue = new Queue(QUEUE_NAMES.email, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
  });
  emailQueue.on('error', () => undefined);
  return {
    enqueuer: {
      async identityVerification(payload) {
        const data = mailIdentityVerificationPayloadSchema.parse(payload);
        await withTimeout(
          emailQueue.add(EMAIL_JOBS.mailIdentityVerification, data, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 10_000 },
            removeOnComplete: true,
            removeOnFail: { count: 1_000 },
          }),
          ENQUEUE_TIMEOUT_MS,
          'Mengantre email verifikasi alamat',
        );
      },
      async verifyCheck(payload, delayMs) {
        const data = mailIdentityJobPayloadSchema.parse(payload);
        await withTimeout(
          queue.add(MAIL_JOBS.verifyCheck, data, {
            ...MAIL_COPY_JOB_OPTIONS,
            delay: delayMs,
            jobId: mailVerifyCheckJobId(data.identityId),
          }),
          ENQUEUE_TIMEOUT_MS,
          'Mengantre pemeriksaan verifikasi alamat',
        );
      },
      async draftSync(payload, delayMs) {
        const data = mailDraftJobPayloadSchema.parse(payload);
        await withTimeout(
          queue.add(MAIL_JOBS.draftSync, data, {
            ...MAIL_COPY_JOB_OPTIONS,
            delay: delayMs,
            jobId: mailDraftSyncJobId(data.draftId),
          }),
          ENQUEUE_TIMEOUT_MS,
          'Mengantre salinan draf',
        );
      },
      async draftRemoteDelete(payload) {
        const data = mailDraftRemoteDeletePayloadSchema.parse(payload);
        await withTimeout(
          queue.add(MAIL_JOBS.draftRemoteDelete, data, {
            ...MAIL_DRAFT_REMOTE_DELETE_JOB_OPTIONS,
            jobId: mailDraftRemoteDeleteJobId(data.folderId, data.uid),
          }),
          ENQUEUE_TIMEOUT_MS,
          'Mengantre penghapusan salinan draf',
        );
      },
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
      async fetchBody(payload) {
        const data = mailMessageJobPayloadSchema.parse(payload);
        await withTimeout(
          queue.add(MAIL_JOBS.fetchBody, data, {
            ...MAIL_FETCH_JOB_OPTIONS,
            priority: 1,
            jobId: mailFetchBodyJobId(data.messageId),
          }),
          ENQUEUE_TIMEOUT_MS,
          'Mengantre pengambilan isi email',
        );
      },
      async fetchAttachment(payload) {
        const data = mailAttachmentJobPayloadSchema.parse(payload);
        await withTimeout(
          queue.add(MAIL_JOBS.fetchAttachment, data, {
            ...MAIL_FETCH_JOB_OPTIONS,
            priority: 2,
            jobId: mailFetchAttachmentJobId(data.attachmentId),
          }),
          ENQUEUE_TIMEOUT_MS,
          'Mengantre pengambilan lampiran email',
        );
      },
      async action(payload) {
        const data = mailAccountJobPayloadSchema.parse(payload);
        await withTimeout(
          queue.add(MAIL_JOBS.action, data, {
            ...MAIL_ACTION_JOB_OPTIONS,
            jobId: mailActionJobId(data.accountId),
          }),
          ENQUEUE_TIMEOUT_MS,
          'Mengantre aksi email',
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
    close: async () => {
      await Promise.all([queue.close(), emailQueue.close()]);
    },
  };
}
