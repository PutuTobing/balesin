import {
  MAINTENANCE_JOBS,
  NOOP_INBOX_EVENT_PUBLISHER,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  SEND_CLAIM_STALE_MS,
  SENSITIVE_TEMPLATE_MAX_AGE_MS,
  SENSITIVE_TEMPLATE_WIPE_INTERVAL_MS,
  STALE_SEND_CLAIMS_INTERVAL_MS,
  WEBHOOK_PAYLOAD_RETENTION_INTERVAL_MS,
  maintenanceJobPayloadSchema,
  type InboxBusEventInput,
  isMetaApiError,
  listMessageTemplates,
  metaTemplateToSynced,
  openWhatsAppCredentials,
  type InboxEventPublisher,
  type Logger,
  type MetaGraphClient,
  type SecretBox,
} from '@balesin/core';
import {
  channels,
  conversationEvents,
  conversations,
  messages,
  recordOutgoingEvent,
  upsertSyncedTemplates,
  type Database,
} from '@balesin/db';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import type { NotificationProducer } from './notifications';
import type { QueueConnectionOptions } from './system';

/** Pemeriksa batas waktu bot: tiap menit, maks. 200 percakapan per putaran. */
export const BOT_TIMEOUTS_INTERVAL_MS = 60_000;
const BOT_TIMEOUTS_BATCH = 200;
/** Sinkron template berkala (pelengkap webhook status template & sinkron manual). */
export const TEMPLATE_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
  /** Event real-time untuk pesan yang ditandai `delivery_unknown` oleh pemeriksa klaim. */
  publisher?: InboxEventPublisher;
  /** Push "kembali ke antrian" saat bot kehabisan waktu. */
  notifications?: Pick<NotificationProducer, 'enqueue'>;
  /** Sinkron template berkala (klien Graph terpusat + kotak rahasia untuk kredensial channel). */
  meta?: MetaGraphClient;
  secretBox?: SecretBox | null;
}

/**
 * Sinkron template berkala (Fase 4): setiap channel WhatsApp aktif → `GET /{waba}/message_templates`
 * → `upsertSyncedTemplates`. Kegagalan per channel hanya dicatat (kode), channel lain tetap jalan.
 */
export async function syncAllTemplates(
  deps: Pick<MaintenanceJobDeps, 'db' | 'logger' | 'meta' | 'secretBox'>,
  now: Date,
): Promise<{ channels: number; failed: number }> {
  const { db, meta, secretBox } = deps;
  if (!meta || !secretBox) return { channels: 0, failed: 0 };
  const live = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.type, 'whatsapp'),
        eq(channels.enabled, true),
        isNull(channels.deletedAt),
        sql`${channels.waBusinessAccountId} is not null`,
      ),
    );
  let failed = 0;
  for (const channel of live) {
    try {
      const credentials = openWhatsAppCredentials(secretBox, channel);
      const wabaId = channel.waBusinessAccountId ?? '';
      const { templates } = await listMessageTemplates(meta, credentials, wabaId);
      await db.transaction((tx) =>
        upsertSyncedTemplates(tx, {
          organizationId: channel.organizationId,
          channelId: channel.id,
          wabaId,
          templates: templates.map(metaTemplateToSynced),
          now,
        }),
      );
    } catch (err) {
      failed += 1;
      deps.logger.warn(
        {
          channelId: channel.id,
          ...(isMetaApiError(err) ? { metaKind: err.kind, metaCode: err.metaCode } : {}),
        },
        'Sinkron template berkala gagal untuk satu channel',
      );
    }
  }
  return { channels: live.length, failed };
}

/**
 * Batas waktu bot (Fase 3, PRD §3.4 "Aturan handoff"): percakapan berstatus `bot` yang pesan
 * pelanggan PERTAMA-nya belum dibalas bot (`bot_awaiting_since`) lebih lama dari
 * `channels.bot_timeout_minutes` → antrian tim (`unserved`). Dicatat sebagai kejadian `handoff`
 * dengan pelaku SISTEM (tanpa pengguna/key) + webhook `conversation.handoff`; setelah commit: event
 * real-time + push "kembali ke antrian" (hanya ID). `FOR UPDATE SKIP LOCKED` → aman bila worker ganda.
 */
export async function handoffTimedOutBots(
  db: Database,
  options: {
    now?: Date | undefined;
    publisher?: InboxEventPublisher;
    notifications?: Pick<NotificationProducer, 'enqueue'>;
  } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const moved = await db.transaction(async (tx) => {
    const due = await tx
      .select({
        id: conversations.id,
        organizationId: conversations.organizationId,
        contactId: conversations.contactId,
      })
      .from(conversations)
      .innerJoin(
        channels,
        and(
          eq(channels.organizationId, conversations.organizationId),
          eq(channels.id, conversations.channelId),
        ),
      )
      .where(
        and(
          eq(conversations.status, 'bot'),
          sql`${conversations.botAwaitingSince} is not null`,
          sql`${channels.botTimeoutMinutes} is not null`,
          sql`${conversations.botAwaitingSince} <= ${now}::timestamptz - make_interval(mins => ${channels.botTimeoutMinutes})`,
        ),
      )
      .limit(BOT_TIMEOUTS_BATCH)
      .for('update', { of: conversations, skipLocked: true });
    for (const row of due) {
      await tx
        .update(conversations)
        .set({ status: 'unserved', assigneeUserId: null, botAwaitingSince: null })
        .where(
          and(eq(conversations.organizationId, row.organizationId), eq(conversations.id, row.id)),
        );
      await tx.insert(conversationEvents).values({
        organizationId: row.organizationId,
        conversationId: row.id,
        kind: 'handoff',
        actorUserId: null,
        apiKeyId: null,
      });
      await recordOutgoingEvent(tx, {
        organizationId: row.organizationId,
        type: 'conversation.handoff',
        conversationId: row.id,
        contactId: row.contactId,
      });
    }
    return due;
  });
  if (moved.length === 0) return 0;
  await (options.publisher ?? NOOP_INBOX_EVENT_PUBLISHER).publish(
    moved.map((row) => ({
      type: 'conversation.updated' as const,
      organizationId: row.organizationId,
      conversationId: row.id,
    })),
  );
  await options.notifications?.enqueue(
    moved.map((row) => ({
      organizationId: row.organizationId,
      kind: 'queued' as const,
      conversationId: row.id,
    })),
  );
  return moved.length;
}

/**
 * Pemeriksa klaim kirim macet (review ruang chat R5): pesan keluar `pending` tanpa wamid yang
 * klaimnya lebih tua dari `SEND_CLAIM_STALE_MS` → `failed` (`delivery_unknown`, TIDAK diulang
 * otomatis — bisa saja sudah terkirim). Bila jawaban Meta ternyata datang belakangan, worker pesan
 * memulihkannya (wamid disimpan, status `sent`).
 */
export async function markStaleSendClaims(
  db: Database,
  options: { now?: Date; publisher?: InboxEventPublisher } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const publisher = options.publisher ?? NOOP_INBOX_EVENT_PUBLISHER;
  const rows = await db
    .update(messages)
    .set({ status: 'failed', failureReason: 'delivery_unknown', statusUpdatedAt: now })
    .where(
      and(
        eq(messages.direction, 'outbound'),
        eq(messages.status, 'pending'),
        isNull(messages.wamid),
        lt(messages.sendClaimedAt, new Date(now.getTime() - SEND_CLAIM_STALE_MS)),
      ),
    )
    .returning({
      id: messages.id,
      organizationId: messages.organizationId,
      conversationId: messages.conversationId,
    });
  const events: InboxBusEventInput[] = rows.flatMap((row) => [
    {
      type: 'message.status' as const,
      organizationId: row.organizationId,
      conversationId: row.conversationId,
      messageId: row.id,
    },
    {
      type: 'conversation.updated' as const,
      organizationId: row.organizationId,
      conversationId: row.conversationId,
    },
  ]);
  await publisher.publish(events);
  return rows.length;
}

/**
 * Jaring pengaman kode OTP (review template Info 1): pesan template `sensitive` yang nilainya belum
 * dikosongkan dan lebih tua dari `SENSITIVE_TEMPLATE_MAX_AGE_MS` → `values = {}`, `headerText = null`,
 * nilai tombol dikosongkan. Memakai indeks parsial `messages_sensitive_template_idx` (baris keluar dari
 * indeks setelah dikosongkan). Maks. 500 baris per putaran.
 */
export async function wipeStaleSensitiveTemplates(
  db: Database,
  options: { now?: Date | undefined; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - SENSITIVE_TEMPLATE_MAX_AGE_MS);
  const result = await db.execute(sql`
    update messages m set
      extras = jsonb_set(
        jsonb_set(
          jsonb_set(m.extras, '{template,values}', '{}'::jsonb),
          '{template,headerText}', 'null'::jsonb
        ),
        '{template,buttons}',
        coalesce(
          (select jsonb_agg(b || '{"value": ""}'::jsonb)
             from jsonb_array_elements(m.extras -> 'template' -> 'buttons') b),
          '[]'::jsonb
        )
      ),
      updated_at = now()
    where m.id in (
      select id from messages
      where (extras -> 'template' ->> 'sensitive') = 'true'
        and (extras -> 'template' -> 'values') <> '{}'::jsonb
        and created_at < ${cutoff}::timestamptz
      order by created_at
      limit ${options.limit ?? 500}
      for update skip locked
    )
    returning m.id`);
  return result.rows.length;
}

export async function processMaintenanceJob(
  job: MaintenanceJob,
  deps: MaintenanceJobDeps,
): Promise<Record<string, number>> {
  if (!maintenanceJobPayloadSchema.safeParse(job.data ?? {}).success) {
    throw new UnrecoverableError('Payload job maintenance tidak valid');
  }
  switch (job.name) {
    case MAINTENANCE_JOBS.webhookPayloadRetention: {
      const result = await purgeWebhookPayloads(deps.db, { now: deps.now?.() });
      if (result.purged > 0 || result.expiredPending > 0 || result.deleted > 0) {
        deps.logger.info(
          result,
          'Retensi webhook: isi kejadian lama dikosongkan / baris lama dihapus',
        );
      }
      return { ...result };
    }
    case MAINTENANCE_JOBS.staleSendClaims: {
      const stale = await markStaleSendClaims(deps.db, {
        now: deps.now?.(),
        ...(deps.publisher ? { publisher: deps.publisher } : {}),
      });
      if (stale > 0) {
        deps.logger.warn({ stale }, 'Klaim kirim macet ditandai "mungkin terkirim"');
      }
      return { stale };
    }
    case MAINTENANCE_JOBS.sensitiveTemplateWipe: {
      const wiped = await wipeStaleSensitiveTemplates(deps.db, { now: deps.now?.() });
      if (wiped > 0) deps.logger.info({ wiped }, 'Nilai template sensitif lama dikosongkan');
      return { wiped };
    }
    case MAINTENANCE_JOBS.templateSync: {
      const result = await syncAllTemplates(deps, deps.now?.() ?? new Date());
      if (result.channels > 0) deps.logger.info(result, 'Sinkron template berkala selesai');
      return result;
    }
    case MAINTENANCE_JOBS.botTimeouts: {
      const moved = await handoffTimedOutBots(deps.db, {
        now: deps.now?.(),
        ...(deps.publisher ? { publisher: deps.publisher } : {}),
        ...(deps.notifications ? { notifications: deps.notifications } : {}),
      });
      if (moved > 0) {
        deps.logger.info({ moved }, 'Bot tidak membalas sampai batas waktu: percakapan ke antrian');
      }
      return { moved };
    }
    default:
      throw new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian maintenance`);
  }
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
    MAINTENANCE_JOBS.templateSync,
    { every: TEMPLATE_SYNC_INTERVAL_MS },
    {
      name: MAINTENANCE_JOBS.templateSync,
      data: {},
      opts: { attempts: 1, removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } },
    },
  );
  await queue.upsertJobScheduler(
    MAINTENANCE_JOBS.sensitiveTemplateWipe,
    { every: SENSITIVE_TEMPLATE_WIPE_INTERVAL_MS },
    {
      name: MAINTENANCE_JOBS.sensitiveTemplateWipe,
      data: {},
      opts: { attempts: 1, removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } },
    },
  );
  await queue.upsertJobScheduler(
    MAINTENANCE_JOBS.botTimeouts,
    { every: BOT_TIMEOUTS_INTERVAL_MS },
    {
      name: MAINTENANCE_JOBS.botTimeouts,
      data: {},
      opts: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } },
    },
  );
  await queue.upsertJobScheduler(
    MAINTENANCE_JOBS.staleSendClaims,
    { every: STALE_SEND_CLAIMS_INTERVAL_MS },
    {
      name: MAINTENANCE_JOBS.staleSendClaims,
      data: {},
      opts: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } },
    },
  );
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
