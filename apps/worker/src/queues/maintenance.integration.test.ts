/**
 * Retensi payload `webhook_events` (review webhook S4) — Postgres sungguhan.
 */
import { MAINTENANCE_JOBS } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import {
  channels,
  closeDb,
  createDb,
  newId,
  organizations,
  webhookEvents,
  type Database,
  type NewWebhookEvent,
} from '@balesin/db';
import { insertOrganization } from '@balesin/db/testing';
import { UnrecoverableError } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  WEBHOOK_EVENT_ROW_RETENTION_DAYS,
  processMaintenanceJob,
  purgeWebhookPayloads,
} from './maintenance';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-16T12:00:00Z');

let db: Database;

beforeAll(() => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-worker-maintenance' });
}, 30_000);

afterAll(async () => {
  if (db) await closeDb(db);
}, 30_000);

let sequence = 0;

async function organizationWithChannel(retentionDays?: number) {
  const organization = await insertOrganization(
    db,
    retentionDays === undefined ? {} : { webhookPayloadRetentionDays: retentionDays },
  );
  const channelId = newId();
  sequence += 1;
  await db.insert(channels).values({
    id: channelId,
    organizationId: organization.id,
    type: 'whatsapp',
    name: 'CS',
    waPhoneNumberId: `9${String(Date.now())}${String(sequence)}`,
    waBusinessAccountId: '102290129340398',
    waAccessTokenEncrypted: 'x',
    waAppSecretEncrypted: 'x',
    waVerifyTokenEncrypted: 'x',
    waVerifyTokenRotatedAt: new Date(),
  });
  return { organizationId: organization.id, channelId };
}

async function eventAt(
  target: { organizationId: string; channelId: string },
  ageDays: number,
  overrides: Partial<NewWebhookEvent> = {},
) {
  sequence += 1;
  const receivedAt = new Date(NOW.getTime() - ageDays * DAY);
  const status = overrides.status ?? 'processed';
  const [row] = await db
    .insert(webhookEvents)
    .values({
      organizationId: target.organizationId,
      channelId: target.channelId,
      source: 'whatsapp',
      kind: 'message',
      field: 'messages',
      dedupKey: `m:wamid.retensi-${String(sequence)}`,
      externalId: `wamid.retensi-${String(sequence)}`,
      payload: { message: { text: { body: 'ISI PESAN PRIBADI' } } },
      receivedAt,
      status,
      processedAt: status === 'processed' || status === 'skipped' ? receivedAt : null,
      ...overrides,
    })
    .returning();
  return row!.id;
}

async function rowsOf(ids: string[]) {
  const rows = await db.select().from(webhookEvents).where(inArray(webhookEvents.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}

describe('purgeWebhookPayloads', () => {
  it('mengosongkan payload kejadian selesai yang lebih tua dari retensi organisasi; kunci dedup tetap', async () => {
    const standard = await organizationWithChannel();
    const short = await organizationWithChannel(1);
    const ids = {
      old: await eventAt(standard, 9),
      fresh: await eventAt(standard, 7),
      oldSkipped: await eventAt(standard, 9, { status: 'skipped' }),
      oldFailed: await eventAt(standard, 9, { status: 'failed' }),
      freshPending: await eventAt(standard, 7, { status: 'pending' }),
      // R5: `pending` lebih tua dari retensi organisasi (8 hari) → gagal & dikosongkan.
      stalePending: await eventAt(standard, 9, { status: 'pending' }),
      shortStalePending: await eventAt(short, 2, { status: 'pending' }),
      shortOld: await eventAt(short, 2),
      shortFresh: await eventAt(short, 0.5),
    };

    const result = await purgeWebhookPayloads(db, { now: NOW });
    expect(result.purged).toBeGreaterThanOrEqual(4);
    expect(result.expiredPending).toBeGreaterThanOrEqual(2);

    const rows = await rowsOf(Object.values(ids));
    for (const id of [ids.old, ids.oldSkipped, ids.oldFailed, ids.shortOld]) {
      expect(rows.get(id)).toMatchObject({ payload: {}, payloadPurgedAt: NOW });
      expect(rows.get(id)?.dedupKey).toMatch(/^m:wamid\.retensi-/);
    }
    for (const id of [ids.fresh, ids.freshPending, ids.shortFresh]) {
      expect(rows.get(id)?.payloadPurgedAt).toBeNull();
      expect(JSON.stringify(rows.get(id)?.payload)).toContain('ISI PESAN PRIBADI');
    }
    expect(rows.get(ids.freshPending)?.status).toBe('pending');
    for (const id of [ids.stalePending, ids.shortStalePending]) {
      expect(rows.get(id)).toMatchObject({
        status: 'failed',
        lastError: 'expired_pending',
        payload: {},
        payloadPurgedAt: NOW,
      });
    }

    // Putaran berikutnya tidak menyentuh baris yang sudah dikosongkan (cap waktunya tetap).
    await purgeWebhookPayloads(db, { now: new Date(NOW.getTime() + DAY) });
    expect((await rowsOf([ids.old])).get(ids.old)?.payloadPurgedAt).toEqual(NOW);
  });

  it('retensi diubah lewat pengaturan organisasi (DB) langsung berlaku', async () => {
    const target = await organizationWithChannel();
    const id = await eventAt(target, 3);
    await purgeWebhookPayloads(db, { now: NOW });
    expect((await rowsOf([id])).get(id)?.payloadPurgedAt).toBeNull();

    await db
      .update(organizations)
      .set({ webhookPayloadRetentionDays: 2 })
      .where(eq(organizations.id, target.organizationId));
    await purgeWebhookPayloads(db, { now: NOW });
    expect((await rowsOf([id])).get(id)?.payloadPurgedAt).toEqual(NOW);
  });

  it('baris dihapus setelah max(35 hari, retensi organisasi); pending tidak dihapus langsung', async () => {
    const standard = await organizationWithChannel();
    const long = await organizationWithChannel(60);
    const ids = {
      keep: await eventAt(standard, WEBHOOK_EVENT_ROW_RETENTION_DAYS - 1),
      drop: await eventAt(standard, WEBHOOK_EVENT_ROW_RETENTION_DAYS + 1),
      dropPurged: await eventAt(standard, WEBHOOK_EVENT_ROW_RETENTION_DAYS + 1, {
        payload: {},
        payloadPurgedAt: new Date(NOW.getTime() - 20 * DAY),
      }),
      // Pending lama: lebih dulu menjadi `failed` (expired), lalu baris lama itu ikut dihapus.
      oldPending: await eventAt(standard, WEBHOOK_EVENT_ROW_RETENTION_DAYS + 5, {
        status: 'pending',
      }),
      longKeep: await eventAt(long, 40),
      longDrop: await eventAt(long, 61),
    };
    const result = await purgeWebhookPayloads(db, { now: NOW });
    expect(result.deleted).toBeGreaterThanOrEqual(4);
    const rows = await rowsOf(Object.values(ids));
    expect([...rows.keys()].sort()).toEqual([ids.keep, ids.longKeep].sort());
    // Organisasi dengan retensi 60 hari: payload hari ke-40 masih ada.
    expect(rows.get(ids.longKeep)?.payloadPurgedAt).toBeNull();
  });

  it('bekerja per batch sampai habis', async () => {
    const target = await organizationWithChannel();
    const ids = [];
    for (let index = 0; index < 5; index += 1) ids.push(await eventAt(target, 20));
    await purgeWebhookPayloads(db, { now: NOW, batchSize: 2 });
    const rows = await rowsOf(ids);
    expect([...rows.values()].every((row) => row.payloadPurgedAt !== null)).toBe(true);
  });
});

describe('processMaintenanceJob', () => {
  it('menjalankan retensi; job tak dikenal / payload rusak gagal permanen', async () => {
    const { logger } = createLogCapture();
    const result = await processMaintenanceJob(
      { name: MAINTENANCE_JOBS.webhookPayloadRetention, data: {} },
      { db, logger, now: () => NOW },
    );
    expect(typeof result.purged).toBe('number');
    await expect(
      processMaintenanceJob({ name: 'lain', data: {} }, { db, logger }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      processMaintenanceJob(
        { name: MAINTENANCE_JOBS.webhookPayloadRetention, data: { organizationId: 'x' } },
        { db, logger },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('startWorkers + jadwal pemeliharaan (Redis sungguhan)', () => {
  it('mendaftarkan jadwal retensi berkala sekali (idempoten) dan menutup rapi', async () => {
    const { createRedis, closeRedis, pingRedis, withTimeout, QUEUE_NAMES } =
      await import('@balesin/core');
    const { Queue } = await import('bullmq');
    const { startWorkers } = await import('../runtime');
    const { scheduleMaintenanceJobs } = await import('./maintenance');
    const { logger } = createLogCapture();
    const redis = createRedis(
      process.env.REDIS_URL_TEST?.trim() || 'redis://:balesin@localhost:6379/15',
      { role: 'queue', name: 'balesin-tes-maintenance', logger },
    );
    const prefix = `balesin-tes-maint-${String(Date.now())}`;
    try {
      await withTimeout(pingRedis(redis), 3_000, 'PING Redis');
      const runtime = startWorkers({ connection: redis, prefix }, logger, {
        email: {
          appUrl: 'http://localhost:5173',
          db,
          secretBox: null,
          fallback: null,
          allowedPorts: [],
        },
        webhooks: { db },
        maintenance: { db },
      });
      expect(runtime.workers.map((worker) => worker.name)).toContain('maintenance');
      const queue = new Queue(QUEUE_NAMES.maintenance, { connection: redis, prefix });
      await expect
        .poll(async () => (await queue.getJobSchedulers()).map((item) => item.key), {
          timeout: 5_000,
        })
        .toEqual([MAINTENANCE_JOBS.webhookPayloadRetention]);
      await scheduleMaintenanceJobs(queue);
      expect(await queue.getJobSchedulersCount()).toBe(1);
      await runtime.close();
      await queue.obliterate({ force: true });
      await queue.close();
    } finally {
      await closeRedis(redis);
    }
  });
});
