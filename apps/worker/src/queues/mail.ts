import {
  MAIL_COMPOSE_MAINTENANCE_INTERVAL_MS,
  MAIL_COPY_JOB_OPTIONS,
  MAIL_DRAFT_REMOTE_DELETE_JOB_OPTIONS,
  MAIL_PRESENCE_TICK_INTERVAL_MS,
  MAIL_SEND_JOB_OPTIONS,
  MAIL_SEND_JOBS,
  MAIL_SEND_TICK_INTERVAL_MS,
  mailAppendSentJobId,
  mailDraftJobPayloadSchema,
  mailDraftRemoteDeleteJobId,
  mailDraftRemoteDeletePayloadSchema,
  mailDraftSyncJobId,
  mailIdentityJobPayloadSchema,
  mailOutboxJobPayloadSchema,
  mailSendJobId,
  mailVerifyCheckJobId,
  type MailDraftJobPayload,
  type MailDraftRemoteDeletePayload,
  type MailIdentityJobPayload,
  type MailOutboxJobPayload,
  MAIL_ACTION_JOB_OPTIONS,
  MAIL_CACHE_RETENTION_INTERVAL_MS,
  MAIL_FETCH_JOB_OPTIONS,
  MAIL_JOBS,
  MAIL_JOB_OPTIONS,
  MAIL_PURGE_JOB_OPTIONS,
  MAIL_TICK_BATCH,
  MAIL_TICK_INTERVAL_MS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  mailAccountJobPayloadSchema,
  mailActionJobId,
  mailAttachmentJobPayloadSchema,
  mailFetchAttachmentJobId,
  mailFetchBodyJobId,
  mailFolderJobPayloadSchema,
  mailMessageJobPayloadSchema,
  mailPurgeJobId,
  mailSyncFolderJobId,
  mailSyncFoldersJobId,
  type Logger,
  type MailAccountJobPayload,
  type MailAttachmentJobPayload,
  type MailFolderJobPayload,
  type MailMessageJobPayload,
  type MediaStore,
  type Redis,
} from '@balesin/core';
import {
  mailAccountAvatars,
  mailAccounts,
  mailAttachments,
  mailFolders,
  mailMessageBodies,
  mailMessages,
  mailOutbox,
  mailRemoteImageCache,
  mailSettings,
  type Database,
} from '@balesin/db';
import { MAIL_CACHE_RETENTION_DAYS } from '@balesin/shared';
import { DelayedError, Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { and, eq, inArray, isNotNull, isNull, lte, notInArray, sql } from 'drizzle-orm';

import type { MailActions } from '../mail/actions';
import type { ComposeMaintenance } from '../mail/compose-maintenance';
import type { CopyResult, createMailCopies } from '../mail/copies';
import { MailSendBusyError, type MailSender } from '../mail/send';
import { acquireLease, mailWorkLeaseKey } from '../mail/lease';
import { MailReadError, type MailReader } from '../mail/read';
import type { MailSync } from '../mail/sync';
import type { QueueConnectionOptions } from './system';

/**
 * Antrian `mail` (Fase 9 tahap 9A, KONTRAK-API-EMAIL §11). Payload hanya ID; job selesai/gagal
 * langsung dihapus (ID job per sasaran bebas lagi), kegagalan dicatat di `mail_accounts` (backoff).
 *
 *  - `mail-tick` (30 dtk): pemilik akun pribadi nonaktif → `owner_inactive` (dan sebaliknya),
 *    akun jatuh tempo → `mail-sync-folders`, akun `deleting` → `mail-purge-account` (cadangan bila
 *    api gagal mengantre).
 *  - `mail-sync-folders` / `mail-sync-folder`: butuh sewa SATU sambungan kerja per akun (Redis); tidak
 *    kebagian → ditunda 5 dtk (bukan gagal).
 *  - `mail-purge-account`: hapus pesan per 1.000 + berkas cache, lalu baris akun.
 *  - `mail-cache-retention` (tiap jam): pangkas isi/lampiran yang tidak dibuka > retensi, dan cache
 *    gambar luar kedaluwarsa sampai habis (review 9A-2 P2-S8).
 */

export interface MailJobDeps {
  db: Database;
  logger: Logger;
  redis: Redis;
  /** Awalan kunci sewa (bawaan `QUEUE_PREFIX`). */
  prefix?: string;
  sync: MailSync;
  store: MediaStore | null;
  /** Bagian 2: isi & lampiran saat dibuka, aksi dua arah. Opsional untuk tes sinkron lama. */
  reader?: MailReader;
  actions?: MailActions;
  enqueueSync(payload: MailAccountJobPayload): Promise<void>;
  enqueuePurge(payload: Omit<MailAccountJobPayload, 'force'>): Promise<void>;
  enqueueAction?(payload: Omit<MailAccountJobPayload, 'force'>): Promise<void>;
  /** 9B: kirim (tick + job), salinan server (Terkirim/Draf/verifikasi), presence & pemeliharaan. */
  sender?: MailSender;
  copies?: ReturnType<typeof createMailCopies>;
  compose?: ComposeMaintenance;
  now?: () => Date;
}

/** Sewa sambungan kerja: cukup untuk satu job sinkron terpanjang. */
const WORK_LEASE_MS = 10 * 60 * 1000;
const DELAY_WHEN_BUSY_MS = 5_000;
const TICK_LEASE_MS = 10 * 60 * 1000;
const PURGE_BATCH = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Review 9A-2 P2-S8: retensi cache gambar per batch, maks. 2 menit per jalan (jalan tiap jam). */
const IMAGE_RETENTION_BATCH = 5_000;
const IMAGE_RETENTION_BUDGET_MS = 2 * 60 * 1000;

export async function runMailTick(
  deps: MailJobDeps,
): Promise<{ queued: number; purges: number; actions: number }> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  // Pemilik akun pribadi dinonaktifkan → berhenti; diaktifkan lagi → lanjut.
  await db.execute(sql`
    update mail_accounts a set sync_state = 'owner_inactive', idle_active = false, next_attempt_at = null, updated_at = now()
    from users u
    where u.organization_id = a.organization_id and u.id = a.owner_user_id and a.kind = 'personal'
      and a.deleted_at is null and u.disabled_at is not null
      and a.sync_state in ('initial_sync', 'ready', 'syncing', 'error')`);
  await db.execute(sql`
    update mail_accounts a set sync_state = 'syncing', next_attempt_at = now(), consecutive_failures = 0, updated_at = now()
    from users u
    where u.organization_id = a.organization_id and u.id = a.owner_user_id and a.kind = 'personal'
      and a.deleted_at is null and u.disabled_at is null and a.sync_state = 'owner_inactive'`);

  const due = await db
    .select({ id: mailAccounts.id, organizationId: mailAccounts.organizationId })
    .from(mailAccounts)
    .where(
      and(
        isNull(mailAccounts.deletedAt),
        notInArray(mailAccounts.syncState, ['paused', 'auth_failed', 'owner_inactive', 'deleting']),
        isNotNull(mailAccounts.nextAttemptAt),
        lte(mailAccounts.nextAttemptAt, now),
      ),
    )
    .limit(MAIL_TICK_BATCH);
  if (due.length > 0) {
    await db
      .update(mailAccounts)
      .set({ nextAttemptAt: new Date(now.getTime() + TICK_LEASE_MS) })
      .where(
        inArray(
          mailAccounts.id,
          due.map((row) => row.id),
        ),
      );
    for (const row of due)
      await deps.enqueueSync({ organizationId: row.organizationId, accountId: row.id });
  }
  const deleting = await db
    .select({ id: mailAccounts.id, organizationId: mailAccounts.organizationId })
    .from(mailAccounts)
    .where(isNotNull(mailAccounts.deletedAt))
    .limit(MAIL_TICK_BATCH);
  for (const row of deleting) {
    await deps.enqueuePurge({ organizationId: row.organizationId, accountId: row.id });
  }
  // Bagian 2: aksi dua arah tertunda > 24 jam dikembalikan; yang antreannya terlewat diantre lagi.
  let actions = 0;
  if (deps.actions && deps.enqueueAction) {
    const swept = await deps.actions.sweep();
    for (const target of swept.accounts) await deps.enqueueAction(target);
    actions = swept.accounts.length;
  }
  return { queued: due.length, purges: deleting.length, actions };
}

/** Putuskan akun: hapus bertahap. Akun yang ternyata masih hidup tidak disentuh. */
export async function runMailPurge(
  payload: { organizationId: string; accountId: string },
  deps: MailJobDeps,
): Promise<{ status: 'purged' | 'skipped'; messages: number }> {
  const { db } = deps;
  const [row] = await db
    .select({ id: mailAccounts.id, deletedAt: mailAccounts.deletedAt })
    .from(mailAccounts)
    .where(
      and(
        eq(mailAccounts.organizationId, payload.organizationId),
        eq(mailAccounts.id, payload.accountId),
      ),
    )
    .limit(1);
  if (!row || row.deletedAt === null) return { status: 'skipped', messages: 0 };
  // 9B: berkas lampiran draf & `.eml` outbox akun ini (barisnya ikut terhapus kaskade).
  await deps.compose?.purgeAccountFiles(payload.organizationId, row.id);
  let removed = 0;
  for (;;) {
    const batch = await db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.organizationId, payload.organizationId),
          eq(mailMessages.accountId, row.id),
        ),
      )
      .limit(PURGE_BATCH);
    if (batch.length === 0) break;
    const ids = batch.map((item) => item.id);
    const files = await db
      .select({ storageKey: mailAttachments.storageKey })
      .from(mailAttachments)
      .where(
        and(
          eq(mailAttachments.organizationId, payload.organizationId),
          inArray(mailAttachments.messageId, ids),
          isNotNull(mailAttachments.storageKey),
        ),
      );
    for (const file of files) {
      if (file.storageKey) await deps.store?.remove(file.storageKey).catch(() => undefined);
    }
    await db
      .delete(mailMessages)
      .where(
        and(eq(mailMessages.organizationId, payload.organizationId), inArray(mailMessages.id, ids)),
      );
    removed += ids.length;
  }
  // Review 9A-2 S5: cache proksi gambar akun ini (baris ikut terhapus kaskade; berkasnya di sini).
  for (;;) {
    const images = await db
      .select({ id: mailRemoteImageCache.id, storageKey: mailRemoteImageCache.storageKey })
      .from(mailRemoteImageCache)
      .where(
        and(
          eq(mailRemoteImageCache.organizationId, payload.organizationId),
          eq(mailRemoteImageCache.accountId, row.id),
        ),
      )
      .limit(PURGE_BATCH);
    if (images.length === 0) break;
    for (const image of images) await deps.store?.remove(image.storageKey).catch(() => undefined);
    await db.delete(mailRemoteImageCache).where(
      inArray(
        mailRemoteImageCache.id,
        images.map((image) => image.id),
      ),
    );
  }
  await db
    .delete(mailFolders)
    .where(
      and(
        eq(mailFolders.organizationId, payload.organizationId),
        eq(mailFolders.accountId, row.id),
      ),
    );
  await db
    .delete(mailAccountAvatars)
    .where(
      and(
        eq(mailAccountAvatars.organizationId, payload.organizationId),
        eq(mailAccountAvatars.accountId, row.id),
      ),
    );
  await db
    .delete(mailAccounts)
    .where(
      and(eq(mailAccounts.organizationId, payload.organizationId), eq(mailAccounts.id, row.id)),
    );
  deps.logger.info({ accountId: row.id, messages: removed }, 'Akun email diputus: cache dihapus');
  return { status: 'purged', messages: removed };
}

/** Pangkas isi & lampiran yang tidak dibuka sejak `cache_retention_days` (header tetap). */
export async function runMailCacheRetention(
  deps: MailJobDeps,
): Promise<{ bodies: number; files: number }> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const settings = await db.select().from(mailSettings);
  const retention = new Map(settings.map((row) => [row.organizationId, row.cacheRetentionDays]));
  const organizations = await db
    .selectDistinct({ organizationId: mailMessageBodies.organizationId })
    .from(mailMessageBodies);
  let bodies = 0;
  let files = 0;
  for (const { organizationId } of organizations) {
    const days = retention.get(organizationId) ?? MAIL_CACHE_RETENTION_DAYS.default;
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    const stale = await db
      .select({ messageId: mailMessageBodies.messageId })
      .from(mailMessageBodies)
      .where(
        and(
          eq(mailMessageBodies.organizationId, organizationId),
          sql`coalesce(${mailMessageBodies.lastOpenedAt}, ${mailMessageBodies.fetchedAt}) < ${cutoff}`,
        ),
      )
      .limit(5_000);
    const ids = stale.map((row) => row.messageId);
    if (ids.length > 0) {
      await db
        .delete(mailMessageBodies)
        .where(
          and(
            eq(mailMessageBodies.organizationId, organizationId),
            inArray(mailMessageBodies.messageId, ids),
          ),
        );
      await db
        .update(mailMessages)
        .set({ bodyState: 'none' })
        .where(and(eq(mailMessages.organizationId, organizationId), inArray(mailMessages.id, ids)));
      bodies += ids.length;
    }
  }
  const expired = await db
    .select({ id: mailAttachments.id, storageKey: mailAttachments.storageKey })
    .from(mailAttachments)
    .where(and(isNotNull(mailAttachments.storageKey), lte(mailAttachments.expiresAt, now)))
    .limit(5_000);
  for (const file of expired) {
    if (file.storageKey) await deps.store?.remove(file.storageKey).catch(() => undefined);
    await db
      .update(mailAttachments)
      .set({ storageKey: null, fetchedAt: null, expiresAt: null })
      .where(eq(mailAttachments.id, file.id));
    files += 1;
  }
  // Review 9A-2 S5 + P2-S8: cache proksi gambar luar kedaluwarsa (24 jam). Diulang per batch sampai
  // habis (dengan anggaran waktu supaya `mail-tick` di slot jadwal yang sama tidak tertahan); sisa
  // backlog diteruskan jalan berikutnya (tiap jam). Baris dihapus DULU (`returning`) baru berkasnya:
  // baris yang baru diperbarui `rememberImage` (kedaluwarsa → segar) tidak ikut terhapus.
  const imagesDeadline = performance.now() + IMAGE_RETENTION_BUDGET_MS;
  for (;;) {
    const expiredIds = db
      .select({ id: mailRemoteImageCache.id })
      .from(mailRemoteImageCache)
      .where(lte(mailRemoteImageCache.expiresAt, now))
      .limit(IMAGE_RETENTION_BATCH);
    const removed = await db
      .delete(mailRemoteImageCache)
      .where(
        and(inArray(mailRemoteImageCache.id, expiredIds), lte(mailRemoteImageCache.expiresAt, now)),
      )
      .returning({ storageKey: mailRemoteImageCache.storageKey });
    for (const image of removed) {
      await deps.store?.remove(image.storageKey).catch(() => undefined);
      files += 1;
    }
    if (removed.length < IMAGE_RETENTION_BATCH) break;
    if (performance.now() >= imagesDeadline) {
      deps.logger.warn(
        { files },
        'Retensi cache gambar email belum tuntas dalam anggaran waktu; dilanjutkan jalan berikutnya',
      );
      break;
    }
  }
  return { bodies, files };
}

async function withWorkSlot<T>(
  job: Job,
  token: string | undefined,
  accountId: string,
  deps: MailJobDeps,
  run: () => Promise<T>,
): Promise<T> {
  const lease = await acquireLease(
    deps.redis,
    mailWorkLeaseKey(deps.prefix ?? QUEUE_PREFIX, accountId),
    WORK_LEASE_MS,
  );
  if (!lease) {
    // Sambungan kerja akun ini sedang dipakai: tunda (bukan gagal).
    if (token) {
      await job.moveToDelayed(Date.now() + DELAY_WHEN_BUSY_MS, token);
      throw new DelayedError();
    }
    throw new Error('Sambungan akun email sedang dipakai');
  }
  // Review 9A-1 S2: sewa diperpanjang selama job berjalan (job lama tidak boleh kehilangan sewanya
  // sehingga job kedua membuka sambungan ke akun yang sama).
  const renew = setInterval(() => {
    lease.renew(WORK_LEASE_MS).catch(() => undefined);
  }, WORK_LEASE_MS / 3);
  renew.unref();
  try {
    return await run();
  } finally {
    clearInterval(renew);
    await lease.release();
  }
}

/** Hasil `delay` → job yang sama ditunda (BullMQ `moveToDelayed`), bukan gagal. */
async function settleCopy(
  job: Job,
  token: string | undefined,
  result: CopyResult,
): Promise<CopyResult> {
  if (result.status === 'delay' && token) {
    await job.moveToDelayed(Date.now() + Math.max(1_000, result.delayMs), token);
    throw new DelayedError();
  }
  return result;
}

function requireCopies(deps: MailJobDeps) {
  if (!deps.copies) throw new UnrecoverableError('Salinan email belum disiapkan di worker');
  return deps.copies;
}

function requireReader(deps: MailJobDeps): MailReader {
  if (!deps.reader) throw new UnrecoverableError('Pengambil isi email belum disiapkan di worker');
  return deps.reader;
}

function isFinalAttempt(job: Job): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

function codeOf(error: unknown): string {
  return error instanceof MailReadError ? error.code : 'unknown';
}

export async function processMailJob(
  job: Job,
  token: string | undefined,
  deps: MailJobDeps,
): Promise<unknown> {
  switch (job.name) {
    case MAIL_JOBS.tick:
      return runMailTick(deps);
    case MAIL_JOBS.syncFolders: {
      const payload = mailAccountJobPayloadSchema.safeParse(job.data);
      if (!payload.success)
        throw new UnrecoverableError('Payload job mail-sync-folders tidak valid');
      return withWorkSlot(job, token, payload.data.accountId, deps, () =>
        deps.sync.syncAccount(payload.data),
      );
    }
    case MAIL_JOBS.syncFolder: {
      const payload = mailFolderJobPayloadSchema.safeParse(job.data);
      if (!payload.success)
        throw new UnrecoverableError('Payload job mail-sync-folder tidak valid');
      return withWorkSlot(job, token, payload.data.accountId, deps, () =>
        deps.sync.syncAccount(payload.data),
      );
    }
    case MAIL_JOBS.purgeAccount: {
      const payload = mailAccountJobPayloadSchema.safeParse(job.data);
      if (!payload.success)
        throw new UnrecoverableError('Payload job mail-purge-account tidak valid');
      return runMailPurge(payload.data, deps);
    }
    case MAIL_JOBS.cacheRetention:
      return runMailCacheRetention(deps);
    case MAIL_JOBS.fetchBody: {
      const payload = mailMessageJobPayloadSchema.safeParse(job.data);
      if (!payload.success) throw new UnrecoverableError('Payload job mail-fetch-body tidak valid');
      const reader = requireReader(deps);
      return withWorkSlot(job, token, payload.data.accountId, deps, async () => {
        try {
          return await reader.fetchBody(payload.data);
        } catch (error) {
          if (isFinalAttempt(job)) {
            await reader.markBodyError(
              payload.data.organizationId,
              payload.data.accountId,
              payload.data.messageId,
            );
            return { status: 'failed', code: codeOf(error) };
          }
          throw error;
        }
      });
    }
    case MAIL_JOBS.fetchAttachment: {
      const payload = mailAttachmentJobPayloadSchema.safeParse(job.data);
      if (!payload.success)
        throw new UnrecoverableError('Payload job mail-fetch-attachment tidak valid');
      const reader = requireReader(deps);
      return withWorkSlot(job, token, payload.data.accountId, deps, async () => {
        try {
          return await reader.fetchAttachment(payload.data);
        } catch (error) {
          if (isFinalAttempt(job)) {
            await reader.failAttachment(
              payload.data.organizationId,
              payload.data.accountId,
              payload.data.attachmentId,
              codeOf(error),
            );
            return { status: 'failed', code: codeOf(error) };
          }
          throw error;
        }
      });
    }
    case MAIL_JOBS.action: {
      const payload = mailAccountJobPayloadSchema.safeParse(job.data);
      if (!payload.success) throw new UnrecoverableError('Payload job mail-action tidak valid');
      const actions = deps.actions;
      if (!actions) throw new UnrecoverableError('Aksi email belum disiapkan di worker');
      return withWorkSlot(job, token, payload.data.accountId, deps, () =>
        actions.run(payload.data, { finalAttempt: isFinalAttempt(job) }),
      );
    }
    // ── 9B ──
    case MAIL_JOBS.sendTick:
      if (!deps.sender) throw new UnrecoverableError('Pengirim email belum disiapkan di worker');
      return deps.sender.tick();
    case MAIL_JOBS.presenceTick:
      return deps.compose?.presenceTick() ?? { changed: 0 };
    case MAIL_JOBS.composeMaintenance:
      return deps.compose?.maintenance() ?? {};
    case MAIL_JOBS.appendSent: {
      const payload = mailOutboxJobPayloadSchema.safeParse(job.data);
      if (!payload.success)
        throw new UnrecoverableError('Payload job mail-append-sent tidak valid');
      const copies = requireCopies(deps);
      const [row] = await deps.db
        .select({ accountId: mailOutbox.accountId })
        .from(mailOutbox)
        .where(eq(mailOutbox.id, payload.data.outboxId))
        .limit(1);
      if (!row) return { status: 'skipped' };
      return withWorkSlot(job, token, row.accountId, deps, () => copies.appendSent(payload.data));
    }
    case MAIL_JOBS.draftSync: {
      const payload = mailDraftJobPayloadSchema.safeParse(job.data);
      if (!payload.success) throw new UnrecoverableError('Payload job mail-draft-sync tidak valid');
      const copies = requireCopies(deps);
      const result = await withWorkSlot(job, token, payload.data.accountId, deps, () =>
        copies.syncDraft(payload.data),
      );
      return settleCopy(job, token, result);
    }
    case MAIL_JOBS.draftRemoteDelete: {
      const payload = mailDraftRemoteDeletePayloadSchema.safeParse(job.data);
      if (!payload.success) {
        throw new UnrecoverableError('Payload job mail-draft-remote-delete tidak valid');
      }
      const copies = requireCopies(deps);
      return withWorkSlot(job, token, payload.data.accountId, deps, () =>
        copies.removeDraftCopy(payload.data),
      );
    }
    case MAIL_JOBS.verifyCheck: {
      const payload = mailIdentityJobPayloadSchema.safeParse(job.data);
      if (!payload.success) {
        throw new UnrecoverableError('Payload job mail-identity-verify-check tidak valid');
      }
      const copies = requireCopies(deps);
      const result = await withWorkSlot(job, token, payload.data.accountId, deps, () =>
        copies.verifyCheck(payload.data),
      );
      return settleCopy(job, token, result);
    }
    default:
      throw new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian mail`);
  }
}

export function createMailQueue(options: QueueConnectionOptions): Queue {
  return new Queue(QUEUE_NAMES.mail, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
  });
}

export function createMailScheduleQueue(options: QueueConnectionOptions): Queue {
  return new Queue(QUEUE_NAMES.mailSchedule, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
  });
}

/**
 * Jadwal berkala di antrian `mail-schedule` (review 9A-1 S2). `legacy` = antrian `mail`: jadwal lama
 * di sana dihapus supaya tick tidak lagi berebut slot dengan job sinkron.
 */
export async function scheduleMailJobs(queue: Queue, legacy?: Queue): Promise<void> {
  if (legacy) {
    await legacy.removeJobScheduler(MAIL_JOBS.tick).catch(() => undefined);
    await legacy.removeJobScheduler(MAIL_JOBS.cacheRetention).catch(() => undefined);
  }
  const opts = { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } };
  await queue.upsertJobScheduler(
    MAIL_JOBS.tick,
    { every: MAIL_TICK_INTERVAL_MS },
    { name: MAIL_JOBS.tick, data: {}, opts },
  );
  await queue.upsertJobScheduler(
    MAIL_JOBS.cacheRetention,
    { every: MAIL_CACHE_RETENTION_INTERVAL_MS },
    { name: MAIL_JOBS.cacheRetention, data: {}, opts },
  );
  // 9B: tick kirim (2 dtk = jeda batal paling banyak +2 dtk), presence (15 dtk), pemeliharaan (jam).
  const quiet = { attempts: 1, removeOnComplete: true, removeOnFail: { count: 50 } };
  await queue.upsertJobScheduler(
    MAIL_JOBS.sendTick,
    { every: MAIL_SEND_TICK_INTERVAL_MS },
    { name: MAIL_JOBS.sendTick, data: {}, opts: quiet },
  );
  await queue.upsertJobScheduler(
    MAIL_JOBS.presenceTick,
    { every: MAIL_PRESENCE_TICK_INTERVAL_MS },
    { name: MAIL_JOBS.presenceTick, data: {}, opts: quiet },
  );
  await queue.upsertJobScheduler(
    MAIL_JOBS.composeMaintenance,
    { every: MAIL_COMPOSE_MAINTENANCE_INTERVAL_MS },
    { name: MAIL_JOBS.composeMaintenance, data: {}, opts },
  );
}

export function mailEnqueuers(queue: Queue) {
  return {
    async enqueueSync(payload: MailAccountJobPayload) {
      const data = mailAccountJobPayloadSchema.parse(payload);
      await queue.add(MAIL_JOBS.syncFolders, data, {
        ...MAIL_JOB_OPTIONS,
        jobId: mailSyncFoldersJobId(data.accountId),
      });
    },
    async enqueueFolder(payload: MailFolderJobPayload) {
      const data = mailFolderJobPayloadSchema.parse(payload);
      await queue.add(MAIL_JOBS.syncFolder, data, {
        ...MAIL_JOB_OPTIONS,
        jobId: mailSyncFolderJobId(data.folderId),
      });
    },
    async enqueueAction(payload: Omit<MailAccountJobPayload, 'force'>) {
      const data = mailAccountJobPayloadSchema.parse(payload);
      await queue.add(MAIL_JOBS.action, data, {
        ...MAIL_ACTION_JOB_OPTIONS,
        jobId: mailActionJobId(data.accountId),
      });
    },
    async enqueueFetchBody(payload: MailMessageJobPayload) {
      const data = mailMessageJobPayloadSchema.parse(payload);
      await queue.add(MAIL_JOBS.fetchBody, data, {
        ...MAIL_FETCH_JOB_OPTIONS,
        priority: 1,
        jobId: mailFetchBodyJobId(data.messageId),
      });
    },
    async enqueueFetchAttachment(payload: MailAttachmentJobPayload) {
      const data = mailAttachmentJobPayloadSchema.parse(payload);
      await queue.add(MAIL_JOBS.fetchAttachment, data, {
        ...MAIL_FETCH_JOB_OPTIONS,
        priority: 2,
        jobId: mailFetchAttachmentJobId(data.attachmentId),
      });
    },
    async enqueueAppendSent(payload: MailOutboxJobPayload, delayMs: number) {
      const data = mailOutboxJobPayloadSchema.parse(payload);
      await queue.add(MAIL_JOBS.appendSent, data, {
        ...MAIL_COPY_JOB_OPTIONS,
        delay: delayMs,
        jobId: mailAppendSentJobId(data.outboxId),
      });
    },
    async enqueueDraftSync(payload: MailDraftJobPayload, delayMs: number) {
      const data = mailDraftJobPayloadSchema.parse(payload);
      await queue.add(MAIL_JOBS.draftSync, data, {
        ...MAIL_COPY_JOB_OPTIONS,
        delay: delayMs,
        jobId: mailDraftSyncJobId(data.draftId),
      });
    },
    async enqueueDraftRemoteDelete(payload: MailDraftRemoteDeletePayload) {
      const data = mailDraftRemoteDeletePayloadSchema.parse(payload);
      await queue.add(MAIL_JOBS.draftRemoteDelete, data, {
        ...MAIL_DRAFT_REMOTE_DELETE_JOB_OPTIONS,
        jobId: mailDraftRemoteDeleteJobId(data.folderId, data.uid),
      });
    },
    async enqueueVerifyCheck(payload: MailIdentityJobPayload, delayMs: number) {
      const data = mailIdentityJobPayloadSchema.parse(payload);
      await queue.add(MAIL_JOBS.verifyCheck, data, {
        ...MAIL_COPY_JOB_OPTIONS,
        delay: delayMs,
        jobId: mailVerifyCheckJobId(data.identityId),
      });
    },
    async enqueuePurge(payload: Omit<MailAccountJobPayload, 'force'>) {
      const data = mailAccountJobPayloadSchema.parse(payload);
      await queue.add(MAIL_JOBS.purgeAccount, data, {
        ...MAIL_PURGE_JOB_OPTIONS,
        jobId: mailPurgeJobId(data.accountId),
      });
    },
  };
}

export function createMailWorker(options: QueueConnectionOptions, deps: MailJobDeps): Worker {
  return new Worker(QUEUE_NAMES.mail, (job, token) => processMailJob(job, token, deps), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    // Sambungan per akun dijaga sewa; beberapa AKUN boleh disinkron bersamaan.
    concurrency: 4,
  });
}

/** Pekerja jadwal (`mail-tick`, retensi) — satu slot, terpisah dari job sinkron. */
export function createMailScheduleWorker(
  options: QueueConnectionOptions,
  deps: MailJobDeps,
): Worker {
  return new Worker(QUEUE_NAMES.mailSchedule, (job, token) => processMailJob(job, token, deps), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    concurrency: 1,
  });
}

// ── 9B: antrian `mail-send` (satu job = satu baris outbox) ──────────────────

export function createMailSendQueue(options: QueueConnectionOptions): Queue {
  return new Queue(QUEUE_NAMES.mailSend, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
  });
}

export function mailSendEnqueuer(queue: Queue) {
  return async (payload: MailOutboxJobPayload) => {
    const data = mailOutboxJobPayloadSchema.parse(payload);
    await queue.add(MAIL_SEND_JOBS.send, data, {
      ...MAIL_SEND_JOB_OPTIONS,
      jobId: mailSendJobId(data.outboxId),
    });
  };
}

const SMTP_BUSY_DELAY_MS = 3_000;

export async function processMailSendJob(
  job: Job,
  token: string | undefined,
  sender: MailSender,
): Promise<unknown> {
  if (job.name !== MAIL_SEND_JOBS.send) {
    throw new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian mail-send`);
  }
  const payload = mailOutboxJobPayloadSchema.safeParse(job.data);
  if (!payload.success) throw new UnrecoverableError('Payload job mail-send tidak valid');
  try {
    return await sender.sendOne(payload.data);
  } catch (error) {
    // Satu SMTP bersamaan per akun: sedang dipakai → tunda (bukan gagal).
    if (error instanceof MailSendBusyError && token) {
      await job.moveToDelayed(Date.now() + SMTP_BUSY_DELAY_MS, token);
      throw new DelayedError();
    }
    throw error;
  }
}

export function createMailSendWorker(options: QueueConnectionOptions, sender: MailSender): Worker {
  return new Worker(QUEUE_NAMES.mailSend, (job, token) => processMailSendJob(job, token, sender), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    concurrency: 4,
  });
}
