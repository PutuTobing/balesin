/**
 * Pemroses antrian `webhooks` — Postgres sungguhan (+ Redis sungguhan untuk jalur BullMQ).
 * Baris `webhook_events` disusun dari notifikasi contoh lewat `splitWhatsAppWebhook` (sama dengan
 * penerima di api), lalu job berisi ID saja diproses.
 */
import { randomBytes } from 'node:crypto';

import {
  closeRedis,
  createRedis,
  pingRedis,
  splitWhatsAppWebhook,
  WEBHOOK_JOB_OPTIONS,
  WEBHOOK_JOBS,
  webhookEventJobId,
  withTimeout,
  QUEUE_NAMES,
  type NormalizedInboundMessage,
  type NormalizedStatusUpdate,
  type Redis,
} from '@balesin/core';
import { createLogCapture, type LogCapture } from '@balesin/core/testing';
import {
  channels,
  closeDb,
  createDb,
  newId,
  webhookEvents,
  type Database,
  type NewWebhookEvent,
} from '@balesin/db';
import { insertOrganization } from '@balesin/db/testing';
import { Queue, UnrecoverableError, type Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  createWebhookWorker,
  errorCodeOf,
  processWebhookJob,
  type InboundEventHandlers,
  type WebhookJob,
} from './webhooks';

const WABA = '102290129340398';
const PHONE = '106540352242922';
const SECRET_TEXT = 'ISI-PESAN-PELANGGAN-RAHASIA-5521';
const DEFAULT_TEST_REDIS_URL = 'redis://:balesin@localhost:6379/15';

let logs: LogCapture;
let db: Database;

beforeAll(() => {
  logs = createLogCapture();
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-worker-webhooks' });
}, 30_000);

afterAll(async () => {
  if (db) await closeDb(db);
}, 30_000);

async function organizationWithChannel() {
  const organization = await insertOrganization(db);
  const channelId = newId();
  await db.insert(channels).values({
    id: channelId,
    organizationId: organization.id,
    type: 'whatsapp',
    name: 'CS Utama',
    waPhoneNumberId: PHONE,
    waBusinessAccountId: WABA,
    // Worker tidak membuka rahasia untuk butir ini; nilai tiruan cukup memenuhi CHECK database.
    waAccessTokenEncrypted: 'tiruan',
    waAppSecretEncrypted: 'tiruan',
    waVerifyTokenEncrypted: 'tiruan',
    waVerifyTokenRotatedAt: new Date(),
  });
  return { organizationId: organization.id, channelId };
}

function notification(value: Record<string, unknown>, field = 'messages') {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: WABA, changes: [{ field, value }] }],
  };
}

const metadata = { display_phone_number: '6281100001111', phone_number_id: PHONE };

function textMessage(wamid = `wamid.${randomBytes(12).toString('hex')}`) {
  return notification({
    messaging_product: 'whatsapp',
    metadata,
    contacts: [{ profile: { name: 'Budi' }, wa_id: '6281234567890', user_id: 'ID.1' }],
    messages: [
      {
        from: '6281234567890',
        from_user_id: 'ID.1',
        id: wamid,
        timestamp: '1763190000',
        type: 'text',
        text: { body: SECRET_TEXT },
      },
    ],
  });
}

/** Menyimpan semua kejadian notifikasi untuk channel ini, persis seperti penerima di api. */
async function storeEvents(
  target: { organizationId: string; channelId: string },
  body: unknown,
  overrides: Partial<NewWebhookEvent> = {},
) {
  const { items } = splitWhatsAppWebhook(body);
  const rows = await db
    .insert(webhookEvents)
    .values(
      items.map((item) => ({
        organizationId: target.organizationId,
        channelId: target.channelId,
        source: 'whatsapp' as const,
        kind: item.kind,
        field: item.field,
        dedupKey: item.dedupKey,
        externalId: item.externalId,
        payload: item.payload as unknown as Record<string, unknown>,
        occurredAt: item.occurredAt,
        ...overrides,
      })),
    )
    .returning();
  return rows;
}

const jobFor = (
  event: { id: string; organizationId: string },
  extra: Partial<WebhookJob> = {},
): WebhookJob => ({
  name: WEBHOOK_JOBS.whatsappEvent,
  data: { organizationId: event.organizationId, eventId: event.id },
  attemptsMade: 0,
  opts: { attempts: 3 },
  ...extra,
});

async function rowOf(id: string) {
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, id));
  return row;
}

function recordingHandlers() {
  const messages: NormalizedInboundMessage[] = [];
  const statuses: NormalizedStatusUpdate[] = [];
  const handlers: InboundEventHandlers = {
    message: (message) => {
      messages.push(message);
      return Promise.resolve();
    },
    status: (status) => {
      statuses.push(status);
      return Promise.resolve();
    },
    error: () => Promise.resolve(),
  };
  return { messages, statuses, handlers };
}

describe('processWebhookJob', () => {
  it('pesan masuk dinormalisasi, diteruskan, ditandai processed; job ganda tidak memproses ulang', async () => {
    const target = await organizationWithChannel();
    const [event] = await storeEvents(target, textMessage());
    const { messages, handlers } = recordingHandlers();
    const deps = { db, logger: logs.logger, handlers };

    expect(await processWebhookJob(jobFor(event!), deps)).toEqual({ status: 'processed' });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'text',
      text: SECRET_TEXT,
      phoneNumberId: PHONE,
      sender: { waId: '6281234567890', profileName: 'Budi' },
    });
    expect(await rowOf(event!.id)).toMatchObject({
      status: 'processed',
      attempts: 1,
      lastError: null,
    });
    expect((await rowOf(event!.id))?.processedAt).toBeInstanceOf(Date);

    expect(await processWebhookJob(jobFor(event!), deps)).toEqual({
      status: 'skipped',
      reason: 'already_done',
    });
    expect(messages).toHaveLength(1);
  });

  it('dua job bersamaan untuk kejadian yang sama → diproses tepat sekali', async () => {
    const target = await organizationWithChannel();
    const [event] = await storeEvents(target, textMessage());
    const { messages, handlers } = recordingHandlers();
    const slow: InboundEventHandlers = {
      ...handlers,
      message: async (message, context) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await handlers.message(message, context);
      },
    };
    const results = await Promise.all([
      processWebhookJob(jobFor(event!), { db, logger: logs.logger, handlers: slow }),
      processWebhookJob(jobFor(event!), { db, logger: logs.logger, handlers: slow }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['processed', 'skipped']);
    expect(messages).toHaveLength(1);
  });

  it('status dinormalisasi; field lain dilewati; ID tidak dikenal / organisasi lain dilewati', async () => {
    const target = await organizationWithChannel();
    const [status] = await storeEvents(
      target,
      notification({
        messaging_product: 'whatsapp',
        metadata,
        statuses: [{ id: 'wamid.keluar', status: 'read', timestamp: '1763190000' }],
      }),
    );
    const { statuses, handlers } = recordingHandlers();
    const deps = { db, logger: logs.logger, handlers };
    expect(await processWebhookJob(jobFor(status!), deps)).toEqual({ status: 'processed' });
    expect(statuses[0]).toMatchObject({ wamid: 'wamid.keluar', status: 'read' });

    const [other] = await storeEvents(
      target,
      notification({ event: 'APPROVED' }, 'account_update'),
    );
    expect(await processWebhookJob(jobFor(other!), deps)).toEqual({
      status: 'skipped',
      reason: 'unhandled',
    });
    expect(await rowOf(other!.id)).toMatchObject({ status: 'skipped', attempts: 1 });

    const stranger = await organizationWithChannel();
    expect(
      await processWebhookJob(
        jobFor({ id: status!.id, organizationId: stranger.organizationId }),
        deps,
      ),
    ).toEqual({ status: 'skipped', reason: 'not_found' });
    expect(
      await processWebhookJob(jobFor({ id: newId(), organizationId: target.organizationId }), deps),
    ).toEqual({
      status: 'skipped',
      reason: 'not_found',
    });
  });

  it('handler gagal → attempts + last_error (kode saja), tetap pending sampai percobaan terakhir → failed', async () => {
    const target = await organizationWithChannel();
    const [event] = await storeEvents(target, textMessage());
    const failing: InboundEventHandlers = {
      ...recordingHandlers().handlers,
      message: () => Promise.reject(new TypeError(`gagal memproses "${SECRET_TEXT}"`)),
    };
    const deps = { db, logger: logs.logger, handlers: failing };

    await expect(processWebhookJob(jobFor(event!, { attemptsMade: 0 }), deps)).rejects.toThrow(
      'Kejadian webhook gagal diproses (TypeError)',
    );
    expect(await rowOf(event!.id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'TypeError',
      processedAt: null,
    });

    await expect(processWebhookJob(jobFor(event!, { attemptsMade: 2 }), deps)).rejects.toThrow();
    expect(await rowOf(event!.id)).toMatchObject({ status: 'failed', attempts: 2 });
    // Isi pesan tidak pernah ikut ke log maupun kolom error.
    expect(logs.text()).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(await rowOf(event!.id))).not.toContain('gagal memproses');
  });

  it('payload tersimpan rusak → failed permanen (UnrecoverableError), tanpa mengulang', async () => {
    const target = await organizationWithChannel();
    const [event] = await storeEvents(target, textMessage());
    await db
      .update(webhookEvents)
      .set({ payload: { rusak: true } })
      .where(eq(webhookEvents.id, event!.id));
    await expect(
      processWebhookJob(jobFor(event!), { db, logger: logs.logger }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await rowOf(event!.id)).toMatchObject({
      status: 'failed',
      lastError: 'WebhookPayloadError',
    });
  });

  it('nama job / payload job tidak dikenal → gagal permanen', async () => {
    await expect(
      processWebhookJob({ name: 'lain', data: {} }, { db, logger: logs.logger }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      processWebhookJob(
        { name: WEBHOOK_JOBS.whatsappEvent, data: { eventId: 'x', isi: SECRET_TEXT } },
        { db, logger: logs.logger },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('errorCodeOf', () => {
  it('hanya nama + kode Postgres, tidak pernah pesan', () => {
    expect(errorCodeOf(new TypeError('isi rahasia'))).toBe('TypeError');
    const pg = Object.assign(new Error('Failed query: insert … params: rahasia'), {
      cause: { code: '23505' },
    });
    expect(errorCodeOf(pg)).toBe('Error:23505');
    expect(errorCodeOf('bukan error')).toBe('unknown_error');
    const weird = new Error('x');
    weird.name = 'Nama <aneh> dengan spasi';
    expect(errorCodeOf(weird)).toBe('Error');
  });
});

describe('antrian webhooks (Redis sungguhan)', () => {
  let redis: Redis;
  let queue: Queue;
  let worker: Worker | undefined;
  const prefix = `balesin-tes-${randomBytes(6).toString('hex')}`;

  beforeAll(async () => {
    const redisUrl = process.env.REDIS_URL_TEST?.trim() || DEFAULT_TEST_REDIS_URL;
    redis = createRedis(redisUrl, { role: 'queue', name: 'balesin-tes', logger: logs.logger });
    await withTimeout(pingRedis(redis), 3_000, 'PING Redis');
    queue = new Queue(QUEUE_NAMES.webhooks, {
      connection: redis,
      prefix,
      defaultJobOptions: WEBHOOK_JOB_OPTIONS,
    });
  }, 30_000);

  afterAll(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true });
    await queue?.close();
    if (redis) await closeRedis(redis);
  }, 30_000);

  it('gagal sekali lalu berhasil diulang BullMQ; ID job = ID kejadian (tidak tergandakan)', async () => {
    const target = await organizationWithChannel();
    const [event] = await storeEvents(target, textMessage());
    let calls = 0;
    worker = createWebhookWorker(
      { connection: redis, prefix },
      {
        db,
        logger: logs.logger,
        handlers: {
          ...recordingHandlers().handlers,
          message: () => {
            calls += 1;
            return calls === 1 ? Promise.reject(new Error('sementara')) : Promise.resolve();
          },
        },
      },
    );
    const data = { organizationId: target.organizationId, eventId: event!.id };
    const jobId = webhookEventJobId(event!.id);
    const options = { jobId, backoff: { type: 'fixed', delay: 50 } };
    await queue.add(WEBHOOK_JOBS.whatsappEvent, data, options);
    await queue.add(WEBHOOK_JOBS.whatsappEvent, data, options);

    await expect
      .poll(() => queue.getJobState(jobId), { timeout: 15_000, interval: 50 })
      .toBe('completed');
    const job = await queue.getJob(jobId);
    expect(job?.attemptsMade).toBe(2);
    expect(job?.opts.attempts).toBe(WEBHOOK_JOB_OPTIONS.attempts);
    expect(job?.data).toEqual(data);
    expect(calls).toBe(2);
    expect(await rowOf(event!.id)).toMatchObject({ status: 'processed', attempts: 2 });
    expect(await queue.getJobCounts('waiting', 'delayed', 'active')).toEqual({
      waiting: 0,
      delayed: 0,
      active: 0,
    });
    // `failedReason` di Redis tidak memuat isi pesan.
    expect(JSON.stringify(job)).not.toContain(SECRET_TEXT);
  }, 30_000);
});
