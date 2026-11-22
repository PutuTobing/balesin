import {
  MAIL_CACHE_RETENTION_INTERVAL_MS,
  MAIL_JOBS,
  MAIL_JOB_OPTIONS,
  MAIL_PURGE_JOB_OPTIONS,
  MAIL_TICK_BATCH,
  MAIL_TICK_INTERVAL_MS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  mailAccountJobPayloadSchema,
  mailFolderJobPayloadSchema,
  mailPurgeJobId,
  mailSyncFolderJobId,
  mailSyncFoldersJobId,
  type Logger,
  type MailAccountJobPayload,
  type MailFolderJobPayload,
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
  mailSettings,
  type Database,
} from '@balesin/db';
import { MAIL_CACHE_RETENTION_DAYS } from '@balesin/shared';
import { DelayedError, Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { and, eq, inArray, isNotNull, isNull, lte, notInArray, sql } from 'drizzle-orm';

import { acquireLease, mailWorkLeaseKey } from '../mail/lease';
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
 *  - `mail-cache-retention` (harian): pangkas isi/lampiran yang tidak dibuka > retensi.
 */

export interface MailJobDeps {
  db: Database;
  logger: Logger;
  redis: Redis;
  /** Awalan kunci sewa (bawaan `QUEUE_PREFIX`). */
  prefix?: string;
  sync: MailSync;
  store: MediaStore | null;
  enqueueSync(payload: MailAccountJobPayload): Promise<void>;
  enqueuePurge(payload: Omit<MailAccountJobPayload, 'force'>): Promise<void>;
  now?: () => Date;
}

/** Sewa sambungan kerja: cukup untuk satu job sinkron terpanjang. */
const WORK_LEASE_MS = 10 * 60 * 1000;
const DELAY_WHEN_BUSY_MS = 5_000;
const TICK_LEASE_MS = 10 * 60 * 1000;
const PURGE_BATCH = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function runMailTick(deps: MailJobDeps): Promise<{ queued: number; purges: number }> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  // Pemilik akun pribadi dinonaktifkan → berhenti; diaktifkan lagi → lanjut.
  await db.execute(sql`
    update mail_accounts a set sync_state = 'owner_inactive', idle_active = false, next_attempt_at = null, updated_at = now()
    from users u
    where u.organization_id = a.organization_id and u.id = a.owner_user_id and a.kind = 'personal'
      and a.deleted_at is null and u.disabled_at is not null
      and a.sync_state not in ('owner_inactive', 'deleting')`);
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
  return { queued: due.length, purges: deleting.length };
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
  try {
    return await run();
  } finally {
    await lease.release();
  }
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

export async function scheduleMailJobs(queue: Queue): Promise<void> {
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
