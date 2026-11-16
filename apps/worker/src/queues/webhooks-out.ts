import {
  EMAIL_JOBS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  WEBHOOKS_OUT_JOBS,
  WEBHOOKS_OUT_TICK_INTERVAL_MS,
  deliverWebhook,
  securityNoticeAdminEmailPayloadSchema,
  webhookSignature,
  webhooksOutJobPayloadSchema,
  type Logger,
  type Lookup,
  type SecretBox,
  type SecurityNoticeAdminEmailPayload,
} from '@balesin/core';
import {
  auditLogs,
  contactTags,
  contacts,
  conversations,
  messages,
  organizations,
  outgoingEvents,
  tags,
  users,
  webhookDeliveries,
  webhookEndpoints,
  type Database,
  type DbExecutor,
  type OutgoingEventRow,
  type WebhookDeliveryRow,
  type WebhookEndpointRow,
} from '@balesin/db';
import {
  OUTGOING_WEBHOOK_AUTO_DISABLE_FAILURES,
  OUTGOING_WEBHOOK_PAYLOAD_RETENTION_DAYS,
} from '@balesin/shared';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import type { QueueConnectionOptions } from './system';

/**
 * Antrian `webhooks-out` (Fase 3, docs/KONTRAK-WEBHOOK-KELUAR.md). Satu job berkala `tick`:
 *  1. **Dispatch** — ambil `outgoing_events` (outbox, `FOR UPDATE SKIP LOCKED`), bangun payload dari
 *     database, buat satu `webhook_deliveries` per endpoint AKTIF yang melanggan, hapus kejadiannya;
 *  2. **Kirim** — pengiriman `pending` yang jatuh tempo diklaim (sewa 2 menit), dikirim lewat
 *     `deliverWebhook` (SSRF: DNS sekali + alamat diperiksa, tanpa redirect) dengan tanda tangan
 *     HMAC; gagal → dicoba lagi bertahap (6 percobaan), 4xx/alamat terlarang → langsung gagal;
 *  3. **Nonaktif otomatis** — 20 gagal final beruntun → endpoint dimatikan + audit + email Owner;
 *  4. **Retensi** — isi payload & potongan respons dikosongkan setelah 7 hari, baris dihapus 30 hari.
 * Isi payload/rahasia/URL lengkap tidak pernah ditulis ke log.
 */

export const WEBHOOK_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 3600_000];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROW_RETENTION_DAYS = 30;
const LEASE_MS = 2 * 60_000;
const DISPATCH_BATCH = 200;
const DELIVERY_BATCH = 50;
const PARALLEL = 10;

export interface WebhooksOutDeps {
  db: Database;
  logger: Logger;
  secretBox: SecretBox | null;
  now?: () => Date;
  /** Email ke Owner saat endpoint dinonaktifkan otomatis. */
  notifyOwner?: (payload: SecurityNoticeAdminEmailPayload) => Promise<void>;
  /** Tes saja. */
  lookup?: Lookup;
  /** Tes saja: izinkan server penerima tiruan di 127.0.0.1. */
  allowLoopback?: boolean;
  timeoutMs?: number;
}

export interface TickResult {
  dispatched: number;
  delivered: number;
  failed: number;
  retried: number;
  purged: number;
}

export function secretContext(endpoint: Pick<WebhookEndpointRow, 'organizationId' | 'id'>) {
  return {
    organizationId: endpoint.organizationId,
    purpose: 'webhook_endpoints.secret',
    subjectId: endpoint.id,
  };
}

// ── Payload ─────────────────────────────────────────────────────────────────

async function contactData(db: DbExecutor, organizationId: string, contactId: string | null) {
  if (!contactId) return null;
  const [row] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)));
  if (!row) return null;
  const tagRows = await db
    .select({ name: tags.name })
    .from(contactTags)
    .innerJoin(
      tags,
      and(eq(tags.organizationId, contactTags.organizationId), eq(tags.id, contactTags.tagId)),
    )
    .where(and(eq(contactTags.organizationId, organizationId), eq(contactTags.contactId, row.id)));
  return {
    id: row.id,
    number: row.number,
    phone: row.phone,
    wa_username: row.waUsername,
    name: row.name,
    profile_name: row.profileName,
    email: row.email,
    attributes: Array.isArray(row.attributes) ? row.attributes : [],
    tags: tagRows.map((tag) => tag.name),
  };
}

async function userRef(db: DbExecutor, organizationId: string, userId: string | null) {
  if (!userId) return null;
  const [row] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)));
  return row ?? null;
}

async function conversationData(
  db: DbExecutor,
  organizationId: string,
  conversationId: string | null,
) {
  if (!conversationId) return null;
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.organizationId, organizationId), eq(conversations.id, conversationId)),
    );
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    channel_id: row.channelId,
    assignee: await userRef(db, organizationId, row.assigneeUserId),
    window_expires_at: row.windowExpiresAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    resolved_at: row.resolvedAt?.toISOString() ?? null,
  };
}

async function messageData(db: DbExecutor, organizationId: string, messageId: string | null) {
  if (!messageId) return null;
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.organizationId, organizationId), eq(messages.id, messageId)));
  if (!row) return null;
  const media = row.media as {
    kind?: string;
    mimeType?: string | null;
    filename?: string | null;
  } | null;
  return {
    id: row.id,
    number: row.number,
    direction: row.direction,
    sender_kind: row.senderKind,
    type: row.type,
    text: row.text,
    media: media
      ? {
          kind: media.kind ?? null,
          mime_type: media.mimeType ?? null,
          filename: media.filename ?? null,
        }
      : null,
    location: row.location ?? null,
    status: row.status,
    error_code: row.errorCode,
    created_at: row.occurredAt.toISOString(),
  };
}

/**
 * Body `{ id, event, created_at, data }` (API-N8N §3), dibangun SAAT DISPATCH (keadaan terbaru).
 * `null` = subjeknya sudah tidak ada (mis. kontak dihapus) → tidak dikirim.
 */
export async function buildEventBody(
  db: DbExecutor,
  event: OutgoingEventRow,
): Promise<Record<string, unknown> | null> {
  const org = event.organizationId;
  const data: Record<string, unknown> = {};
  if (event.type.startsWith('message.')) {
    const message = await messageData(db, org, event.messageId);
    if (!message) return null;
    data.message = message;
  }
  if (event.conversationId) {
    const conversation = await conversationData(db, org, event.conversationId);
    if (!conversation && !event.type.startsWith('contact.')) return null;
    if (conversation) data.conversation = conversation;
  }
  const contact = await contactData(db, org, event.contactId);
  if (!contact && event.type.startsWith('contact.')) return null;
  if (contact) data.contact = contact;
  if (event.actorUserId) data.actor = await userRef(db, org, event.actorUserId);
  // TITIK KAIT mode kompatibel MobiChat: endpoint `format = 'mobichat'` menambah
  // `mobichat_base_url`/`mobichat_api_key` + bentuk body MobiChat (butir berikutnya).
  return { id: event.id, event: event.type, created_at: event.createdAt.toISOString(), data };
}

// ── Langkah tick ───────────────────────────────────────────────────────────

async function dispatch(db: Database, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const batch = await tx
      .select()
      .from(outgoingEvents)
      .orderBy(asc(outgoingEvents.createdAt))
      .limit(DISPATCH_BATCH)
      .for('update', { skipLocked: true });
    if (batch.length === 0) return 0;
    let created = 0;
    for (const event of batch) {
      const endpoints = await tx
        .select({ id: webhookEndpoints.id })
        .from(webhookEndpoints)
        .where(
          and(
            eq(webhookEndpoints.organizationId, event.organizationId),
            eq(webhookEndpoints.enabled, true),
            sql`${event.type} = any(${webhookEndpoints.events})`,
          ),
        );
      if (endpoints.length === 0) continue;
      const body = await buildEventBody(tx, event);
      if (!body) continue;
      await tx.insert(webhookDeliveries).values(
        endpoints.map((endpoint) => ({
          organizationId: event.organizationId,
          endpointId: endpoint.id,
          eventId: event.id,
          event: event.type,
          payload: body,
          nextAttemptAt: now,
        })),
      );
      created += endpoints.length;
    }
    await tx.delete(outgoingEvents).where(
      inArray(
        outgoingEvents.id,
        batch.map((event) => event.id),
      ),
    );
    return created;
  });
}

/** Klaim pengiriman jatuh tempo (sewa) supaya proses lain tidak mengirim yang sama. */
async function claimDue(db: Database, now: Date): Promise<WebhookDeliveryRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(webhookDeliveries)
      .where(
        and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, now)),
      )
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(DELIVERY_BATCH)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    await tx
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(now.getTime() + LEASE_MS) })
      .where(
        inArray(
          webhookDeliveries.id,
          due.map((row) => row.id),
        ),
      );
    return due;
  });
}

type Outcome = 'delivered' | 'failed' | 'retried';

async function attempt(
  deps: WebhooksOutDeps,
  delivery: WebhookDeliveryRow,
  now: Date,
): Promise<Outcome> {
  const { db, secretBox } = deps;
  const [endpoint] = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.organizationId, delivery.organizationId),
        eq(webhookEndpoints.id, delivery.endpointId),
      ),
    );
  const [org] = await db
    .select({ cidrs: organizations.webhookPrivateCidrs })
    .from(organizations)
    .where(eq(organizations.id, delivery.organizationId));
  const finalize = async (patch: Partial<typeof webhookDeliveries.$inferInsert>) => {
    await db.update(webhookDeliveries).set(patch).where(eq(webhookDeliveries.id, delivery.id));
  };
  if (!endpoint || !endpoint.enabled || !delivery.payload || !secretBox) {
    await finalize({
      status: 'failed',
      nextAttemptAt: null,
      errorCode:
        !endpoint || !endpoint.enabled
          ? 'endpoint_disabled'
          : !delivery.payload
            ? 'payload_purged'
            : 'no_master_key',
    });
    return 'failed';
  }
  const secrets = [secretBox.decrypt(endpoint.secretEncrypted, secretContext(endpoint))];
  if (
    endpoint.previousSecretEncrypted &&
    endpoint.previousSecretExpiresAt &&
    endpoint.previousSecretExpiresAt.getTime() > now.getTime()
  ) {
    secrets.push(secretBox.decrypt(endpoint.previousSecretEncrypted, secretContext(endpoint)));
  }
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(now.getTime() / 1000);
  const result = await deliverWebhook({
    url: endpoint.url,
    body,
    headers: {
      'user-agent': 'Balesin-Webhook/1.0',
      'x-balesin-event': delivery.event,
      'x-balesin-delivery': delivery.id,
      'x-balesin-signature': webhookSignature(secrets, timestamp, body),
    },
    privateCidrs: org?.cidrs ?? [],
    ...(deps.lookup ? { lookup: deps.lookup } : {}),
    ...(deps.allowLoopback ? { allowLoopback: true } : {}),
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
  });
  const attempts = delivery.attempts + 1;
  const common = {
    attempts,
    httpStatus: result.httpStatus,
    durationMs: result.durationMs,
    errorCode: result.errorCode,
    responseSnippet: result.snippet,
  };
  if (result.ok) {
    await finalize({ ...common, status: 'succeeded', nextAttemptAt: null, deliveredAt: now });
    await db
      .update(webhookEndpoints)
      .set({ consecutiveFailures: 0, lastDeliveryAt: now })
      .where(eq(webhookEndpoints.id, endpoint.id));
    return 'delivered';
  }
  const delay = WEBHOOK_RETRY_DELAYS_MS[attempts - 1];
  if (result.retryable && delay !== undefined) {
    await finalize({ ...common, nextAttemptAt: new Date(now.getTime() + delay) });
    return 'retried';
  }
  await finalize({ ...common, status: 'failed', nextAttemptAt: null });
  await recordFinalFailure(deps, endpoint, now);
  return 'failed';
}

async function recordFinalFailure(deps: WebhooksOutDeps, endpoint: WebhookEndpointRow, now: Date) {
  const { db, logger } = deps;
  const [updated] = await db
    .update(webhookEndpoints)
    .set({
      consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1`,
      lastDeliveryAt: now,
    })
    .where(eq(webhookEndpoints.id, endpoint.id))
    .returning({ failures: webhookEndpoints.consecutiveFailures });
  const failures = updated?.failures ?? 0;
  if (failures < OUTGOING_WEBHOOK_AUTO_DISABLE_FAILURES) return;
  // Nonaktif otomatis: sekali (hanya bila masih aktif).
  const disabled = await db
    .update(webhookEndpoints)
    .set({ enabled: false, disabledReason: 'auto_failures' })
    .where(and(eq(webhookEndpoints.id, endpoint.id), eq(webhookEndpoints.enabled, true)))
    .returning({ id: webhookEndpoints.id });
  if (disabled.length === 0) return;
  const host = hostOf(endpoint.url);
  const [audit] = await db
    .insert(auditLogs)
    .values({
      organizationId: endpoint.organizationId,
      actorUserId: null,
      action: 'webhook.auto_disabled',
      targetType: 'webhook',
      targetId: endpoint.id,
      metadata: { host, failures },
    })
    .returning({ id: auditLogs.id });
  logger.warn({ webhookId: endpoint.id, failures }, 'Webhook keluar dinonaktifkan otomatis');
  if (!deps.notifyOwner || !endpoint.createdByUserId) return;
  const owners = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, endpoint.organizationId),
        eq(users.role, 'owner'),
        isNull(users.disabledAt),
      ),
    );
  for (const owner of owners) {
    await deps
      .notifyOwner({
        organizationId: endpoint.organizationId,
        recipientUserId: owner.id,
        subjectUserId: endpoint.createdByUserId,
        event: 'webhook_disabled',
        occurredAt: now.toISOString(),
        ...(audit ? { auditLogId: audit.id } : {}),
      })
      .catch((err: unknown) => {
        logger.warn({ err, webhookId: endpoint.id }, 'Email webhook nonaktif tidak terantre');
      });
  }
}

/** Host saja (tanpa path/query yang bisa memuat token) untuk audit/email. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'url-tidak-valid';
  }
}

async function retention(db: Database, now: Date): Promise<number> {
  const purgeBefore = new Date(now.getTime() - OUTGOING_WEBHOOK_PAYLOAD_RETENTION_DAYS * DAY_MS);
  const deleteBefore = new Date(now.getTime() - ROW_RETENTION_DAYS * DAY_MS);
  const purged = await db.execute(sql`
    update ${webhookDeliveries} set payload = null, response_snippet = null,
      payload_purged_at = ${now}, updated_at = now()
    where id in (
      select id from ${webhookDeliveries}
      where ${webhookDeliveries.createdAt} < ${purgeBefore} and ${webhookDeliveries.payloadPurgedAt} is null
      limit 1000
    )`);
  await db.execute(sql`
    delete from ${webhookDeliveries}
    where id in (
      select id from ${webhookDeliveries} where ${webhookDeliveries.createdAt} < ${deleteBefore} limit 1000
    )`);
  return purged.rowCount ?? 0;
}

export async function processWebhooksOutTick(deps: WebhooksOutDeps): Promise<TickResult> {
  const now = deps.now?.() ?? new Date();
  const dispatched = await dispatch(deps.db, now);
  const due = await claimDue(deps.db, now);
  const counts = { delivered: 0, failed: 0, retried: 0 };
  for (let index = 0; index < due.length; index += PARALLEL) {
    const outcomes = await Promise.all(
      due.slice(index, index + PARALLEL).map((delivery) =>
        attempt(deps, delivery, now).catch((err: unknown) => {
          deps.logger.warn({ err, deliveryId: delivery.id }, 'Pengiriman webhook gagal diproses');
          return 'retried' as const;
        }),
      ),
    );
    for (const outcome of outcomes) counts[outcome] += 1;
  }
  const purged = await retention(deps.db, now);
  if (dispatched + due.length > 0) {
    deps.logger.info({ dispatched, ...counts }, 'Webhook keluar diproses');
  }
  return { dispatched, ...counts, purged };
}

// ── BullMQ ─────────────────────────────────────────────────────────────────

export async function processWebhooksOutJob(
  job: { name: string; data: unknown },
  deps: WebhooksOutDeps,
): Promise<TickResult> {
  if (job.name !== WEBHOOKS_OUT_JOBS.tick) {
    throw new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian webhooks-out`);
  }
  if (!webhooksOutJobPayloadSchema.safeParse(job.data ?? {}).success) {
    throw new UnrecoverableError('Payload job webhooks-out tidak valid');
  }
  return processWebhooksOutTick(deps);
}

export function createWebhooksOutQueue(options: QueueConnectionOptions): Queue {
  return new Queue(QUEUE_NAMES.webhooksOut, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
  });
}

export async function scheduleWebhooksOut(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    WEBHOOKS_OUT_JOBS.tick,
    { every: WEBHOOKS_OUT_TICK_INTERVAL_MS },
    {
      name: WEBHOOKS_OUT_JOBS.tick,
      data: {},
      opts: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } },
    },
  );
}

export function createWebhooksOutWorker(
  options: QueueConnectionOptions,
  deps: WebhooksOutDeps,
): Worker {
  return new Worker(QUEUE_NAMES.webhooksOut, (job) => processWebhooksOutJob(job, deps), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    concurrency: 1,
  });
}

/** Produsen email Owner (antrian `email`) untuk pemberitahuan webhook nonaktif. */
export function createOwnerNotifier(options: QueueConnectionOptions) {
  const queue = new Queue(QUEUE_NAMES.email, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
  });
  queue.on('error', () => undefined);
  return {
    notify: async (payload: SecurityNoticeAdminEmailPayload) => {
      const data = securityNoticeAdminEmailPayloadSchema.parse(payload);
      await queue.add(EMAIL_JOBS.securityNoticeAdmin, data, {
        jobId: `webhook-off-${data.auditLogId ?? data.occurredAt}-${data.recipientUserId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
      });
    },
    close: () => queue.close(),
  };
}
