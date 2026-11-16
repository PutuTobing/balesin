import {
  MAINTENANCE_JOBS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  WEBHOOK_PAYLOAD_RETENTION_INTERVAL_MS,
  maintenanceJobPayloadSchema,
  type Logger,
} from '@balesin/core';
import type { Database } from '@balesin/db';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import type { QueueConnectionOptions } from './system';

/**
 * Antrian `maintenance`: pekerjaan berkala worker (BullMQ Job Scheduler, payload kosong).
 *
 * **Retensi payload `webhook_events` (review webhook S4, UU PDP).** Isi pesan pelanggan di
 * `payload` kejadian yang sudah selesai (`processed`/`skipped`/`failed`) dikosongkan (`{}` +
 * `payload_purged_at`) setelah `organizations.webhook_payload_retention_days` hari (bawaan 8, diatur
 * lewat UI — bukan `.env`). `dedup_key`/`external_id` TETAP disimpan, jadi kiriman ulang Meta tetap
 * terdeteksi duplikat. Isi pesan yang dipakai inbox sudah ada di tabel `messages`.
 *
 * Kejadian yang macet `pending` lebih lama dari retensi organisasi (percobaan job habis dalam ±10
 * menit; selebihnya artinya job-nya hilang, mis. Redis dikosongkan) ditandai `failed`
 * (`expired_pending`) dan payload-nya ikut dikosongkan — tidak ada isi pesan yang tertahan melewati
 * retensi yang dipilih organisasi (review kontak R5). Konsekuensinya: bila worker mati lebih lama
 * dari retensi, kejadian lama itu tidak diproses lagi.
 *
 * **Baris** dihapus seluruhnya setelah `max(WEBHOOK_EVENT_ROW_RETENTION_DAYS, retensi organisasi)`
 * hari (review kontak R5). Kunci dedup hanya perlu bertahan lebih lama dari jendela kirim ulang Meta
 * (7 hari) dan batas umur kejadian di penerima (8 hari); 35 hari memberi margin untuk diagnosis.
 * Baris `pending` tidak pernah dihapus langsung (lebih dulu menjadi `failed` lewat aturan di atas).
 *
 * Batch kecil + `FOR UPDATE SKIP LOCKED`: tidak pernah menunggu baris yang sedang diproses worker
 * webhook, dan tidak mengunci tabel lama.
 */

/** Umur minimal baris `webhook_events` sebelum dihapus (hari). */
export const WEBHOOK_EVENT_ROW_RETENTION_DAYS = 35;
const BATCH_SIZE = 1_000;
const MAX_BATCHES_PER_RUN = 50;

export interface RetentionResult {
  purged: number;
  expiredPending: number;
  deleted: number;
}

export interface RetentionOptions {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
}

async function runBatches(
  maxBatches: number,
  batch: () => Promise<number>,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (let index = 0; index < maxBatches; index += 1) {
    const count = await batch();
    total += count;
    if (count < batchSize) break;
  }
  return total;
}

/** Satu putaran retensi untuk SEMUA organisasi (masing-masing dengan retensinya sendiri). */
export async function purgeWebhookPayloads(
  db: Database,
  options: RetentionOptions = {},
): Promise<RetentionResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const maxBatches = options.maxBatches ?? MAX_BATCHES_PER_RUN;

  const purged = await runBatches(
    maxBatches,
    async () => {
      const result = await db.execute(sql`
        with due as (
          select w.id
          from webhook_events w
          join organizations o on o.id = w.organization_id
          where w.payload_purged_at is null
            and w.status <> 'pending'
            and w.received_at < ${now}::timestamptz - make_interval(days => o.webhook_payload_retention_days)
          order by w.received_at
          limit ${batchSize}
          for update of w skip locked
        )
        update webhook_events w
        set payload = '{}'::jsonb, payload_purged_at = ${now}::timestamptz, updated_at = now()
        from due
        where w.id = due.id
        returning w.id`);
      return result.rows.length;
    },
    batchSize,
  );

  const expiredPending = await runBatches(
    maxBatches,
    async () => {
      const result = await db.execute(sql`
        with due as (
          select w.id
          from webhook_events w
          join organizations o on o.id = w.organization_id
          where w.payload_purged_at is null
            and w.status = 'pending'
            and w.received_at < ${now}::timestamptz - make_interval(days => o.webhook_payload_retention_days)
          order by w.received_at
          limit ${batchSize}
          for update of w skip locked
        )
        update webhook_events w
        set status = 'failed', last_error = 'expired_pending', payload = '{}'::jsonb,
            payload_purged_at = ${now}::timestamptz, updated_at = now()
        from due
        where w.id = due.id
        returning w.id`);
      return result.rows.length;
    },
    batchSize,
  );

  const deleted = await runBatches(
    maxBatches,
    async () => {
      const result = await db.execute(sql`
        with due as (
          select w.id
          from webhook_events w
          join organizations o on o.id = w.organization_id
          where w.status <> 'pending'
            and w.received_at < ${now}::timestamptz - make_interval(days => greatest(${WEBHOOK_EVENT_ROW_RETENTION_DAYS}, o.webhook_payload_retention_days))
          order by w.received_at
          limit ${batchSize}
          for update of w skip locked
        )
        delete from webhook_events w
        using due
        where w.id = due.id
        returning w.id`);
      return result.rows.length;
    },
    batchSize,
  );

  return { purged, expiredPending, deleted };
}

export interface MaintenanceJob {
  id?: string;
  name: string;
  data: unknown;
}

export interface MaintenanceJobDeps {
  db: Database;
  logger: Logger;
  now?: () => Date;
}

export async function processMaintenanceJob(
  job: MaintenanceJob,
  deps: MaintenanceJobDeps,
): Promise<RetentionResult> {
  if (job.name !== MAINTENANCE_JOBS.webhookPayloadRetention) {
    throw new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian maintenance`);
  }
  if (!maintenanceJobPayloadSchema.safeParse(job.data ?? {}).success) {
    throw new UnrecoverableError('Payload job maintenance tidak valid');
  }
  const result = await purgeWebhookPayloads(deps.db, { now: deps.now?.() });
  if (result.purged > 0 || result.expiredPending > 0 || result.deleted > 0) {
    deps.logger.info(result, 'Retensi webhook: isi kejadian lama dikosongkan / baris lama dihapus');
  }
  return result;
}

export function createMaintenanceQueue(options: QueueConnectionOptions): Queue {
  return new Queue(QUEUE_NAMES.maintenance, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
  });
}

/** Mendaftarkan jadwal berkala (idempoten: memanggil ulang hanya memperbarui jadwal yang sama). */
export async function scheduleMaintenanceJobs(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    MAINTENANCE_JOBS.webhookPayloadRetention,
    { every: WEBHOOK_PAYLOAD_RETENTION_INTERVAL_MS },
    {
      name: MAINTENANCE_JOBS.webhookPayloadRetention,
      data: {},
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    },
  );
}

export function createMaintenanceWorker(
  options: QueueConnectionOptions,
  deps: MaintenanceJobDeps,
): Worker {
  return new Worker(QUEUE_NAMES.maintenance, (job) => processMaintenanceJob(job, deps), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    concurrency: 1,
  });
}
