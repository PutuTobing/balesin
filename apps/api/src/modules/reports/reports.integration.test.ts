/**
 * Laporan & CSAT (Fase 5) — Postgres + Redis sungguhan, Graph Meta TIRUAN, worker produksi
 * (`dispatchCsat`, `processWebhookJob`, `processSendMessageJob` dipanggil langsung): laporan kinerja
 * (cakupan all/own), biaya pesan Meta per kategori + kuota layanan, ekspor CSV ber-CSRF, survei CSAT
 * otomatis (aturan kirim, jawaban tidak membuka percakapan, terima kasih, komentar).
 */
import { randomUUID } from 'node:crypto';

import {
  createInboxEventPublisher,
  createMetaGraphClient,
  createSecretBox,
  MESSAGE_JOBS,
  sealChannelSecret,
  Secret,
  WEBHOOK_JOBS,
} from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import {
  auditLogs,
  channels,
  contactTags,
  conversations,
  csatSurveys,
  messages,
  newId,
  tags,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  REPORT_ROUTES,
  WEBHOOK_ROUTES,
  apiPath,
  csatSettingsResponseSchema,
  reportCostsResponseSchema,
  reportPerformanceResponseSchema,
  type ReportPerformance,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dispatchCsat } from '../../../../worker/src/queues/csat';
import { processSendMessageJob } from '../../../../worker/src/queues/messages';
import { processWebhookJob } from '../../../../worker/src/queues/webhooks';
import { createPasswordHasher } from '../auth/password-hasher';
import {
  FAKE_WEBHOOK_DEFAULTS,
  interactiveReplyNotification,
  signedWebhook,
  startFakeMeta,
  textMessageNotification,
  type FakeMeta,
} from '../../testing/fake-meta';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  createIntegrationHarness,
  integrationConfig,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const TOKEN = 'EAAtokenTiruanLaporan0123456789';
const PHONE = FAKE_WEBHOOK_DEFAULTS.phoneNumberId;
const WABA = FAKE_WEBHOOK_DEFAULTS.wabaId;
const PASSWORD = 'sandi-uji-laporan-00001';

let fake: FakeMeta;
let harness: IntegrationHarness;
let owner: SignedIn;
let cs: SignedIn;
let organizationId: string;
let channelId: string;
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const logs = createLogCapture();
const hasher = createPasswordHasher();
const as = (signed: SignedIn) => ({ cookie: signed.cookie, csrf: signed.csrf });
/** Tanggal hari ini di zona organisasi (bawaan Asia/Jakarta). */
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
const metaClient = () =>
  createMetaGraphClient({
    version: 'v26.0',
    baseUrl: fake.url,
    sleep: () => Promise.resolve(),
    maxAttempts: 1,
  });
const publisher = () =>
  createInboxEventPublisher(harness.redis, { prefix: harness.redisPrefix, logger: logs.logger });

async function receive(notification: unknown): Promise<void> {
  const { body, headers } = signedWebhook(notification, APP_SECRET);
  const response = await harness.app.inject({
    method: 'POST',
    url: apiPath(WEBHOOK_ROUTES.whatsapp, { channelId }),
    headers,
    payload: body,
    remoteAddress: '173.252.127.1',
  });
  expect(response.statusCode, response.body).toBe(200);
  for (const data of harness.webhookJobs.splice(0)) {
    await processWebhookJob(
      { name: WEBHOOK_JOBS.whatsappEvent, data, attemptsMade: 0, opts: { attempts: 8 } },
      { db: harness.db, logger: logs.logger, publisher: publisher() },
    );
  }
}

async function drainSends() {
  for (const job of harness.messageJobs.splice(0)) {
    await processSendMessageJob(
      {
        name: MESSAGE_JOBS.send,
        data: { organizationId: job.organizationId, messageId: job.messageId },
        attemptsMade: 0,
        opts: { attempts: 5 },
      },
      { db: harness.db, logger: logs.logger, meta: metaClient(), secretBox: box },
    );
  }
}

const csat = () =>
  dispatchCsat({
    db: harness.db,
    logger: logs.logger,
    meta: metaClient(),
    secretBox: box,
    publisher: publisher(),
  });

/** Pelanggan menulis → agen membalas → agen menandai selesai. */
async function servedAndResolved(signed: SignedIn, waId: string) {
  await receive(textMessageNotification({ customer: { waId, userId: `ID.${waId}` } }));
  const [conversation] = (await harness.db.select().from(conversations)).filter(
    (row) => row.status !== 'resolved',
  );
  const id = conversation!.id;
  const sent = await call(
    harness.app,
    'POST',
    apiPath(API_ROUTES.inbox.messages, { conversationId: id }),
    { type: 'text', clientMessageId: randomUUID(), text: 'Siap kak, sudah kami cek.' },
    as(signed),
  );
  expect(sent.statusCode, sent.body).toBe(202);
  await drainSends();
  const resolved = await call(
    harness.app,
    'POST',
    apiPath(API_ROUTES.inbox.resolve, { conversationId: id }),
    undefined,
    as(signed),
  );
  expect(resolved.statusCode, resolved.body).toBe(200);
  return id;
}

async function performance(signed: SignedIn): Promise<ReportPerformance> {
  const response = await call(
    harness.app,
    'GET',
    `${REPORT_ROUTES.performance}?from=${today()}&to=${today()}`,
    undefined,
    as(signed),
  );
  expect(response.statusCode, response.body).toBe(200);
  return reportPerformanceResponseSchema.parse(response.json()).report;
}

async function enableCsat(extra: object = {}) {
  const response = await call(
    harness.app,
    'PUT',
    REPORT_ROUTES.csatSettings,
    {
      enabled: true,
      question: 'Bagaimana pelayanan kami? Pilih 1–5 ya.',
      thanks: 'Terima kasih! Ada saran? Tulis saja di sini.',
      minIntervalHours: 24,
      ...extra,
    },
    as(owner),
  );
  return response;
}

beforeAll(async () => {
  fake = await startFakeMeta();
  harness = await createIntegrationHarness({
    config: { ...integrationConfig(), metaGraphBaseUrl: fake.url },
    overrides: { meta: { sleep: () => Promise.resolve() } },
  });
});
beforeEach(async () => {
  await harness.reset();
  fake.reset();
  fake.tokens.set(TOKEN, { appSecret: APP_SECRET });
  fake.phoneNumbers.set(PHONE, { id: PHONE, wabaId: WABA });
  fake.wabas.add(WABA);
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  channelId = newId();
  const target = { id: channelId, organizationId };
  await harness.db.insert(channels).values({
    id: channelId,
    organizationId,
    type: 'whatsapp',
    name: 'CS Utama',
    waPhoneNumberId: PHONE,
    waBusinessAccountId: WABA,
    waAccessTokenEncrypted: sealChannelSecret(box, target, 'accessToken', TOKEN),
    waAccessTokenTail: '6789',
    waAppSecretEncrypted: sealChannelSecret(box, target, 'appSecret', APP_SECRET),
    waAppSecretTail: 'cdef',
    waVerifyTokenEncrypted: sealChannelSecret(box, target, 'verifyToken', 'verify-token-01234'),
    waVerifyTokenRotatedAt: new Date(),
  });
  await insertUser(harness.db, organizationId, {
    role: 'cs',
    email: 'cs.laporan@majujaya.test',
    name: 'Sinta CS',
    passwordHash: await hasher.hash(PASSWORD),
  });
  cs = await login(harness.app, { email: 'cs.laporan@majujaya.test', password: PASSWORD });
});
afterAll(async () => {
  await harness?.close();
  await fake?.close();
});

describe('laporan kinerja', () => {
  it('cakupan all: ringkasan, tren, agen, tag; cakupan own (CS): hanya dirinya', async () => {
    const first = await servedAndResolved(owner, '6281200000001');
    await servedAndResolved(cs, '6281200000002');
    const [tag] = await harness.db
      .insert(tags)
      .values({ organizationId, name: 'Gangguan', color: 'red' })
      .returning();
    const [row] = await harness.db.select().from(conversations).where(eq(conversations.id, first));
    await harness.db
      .insert(contactTags)
      .values({ organizationId, contactId: row!.contactId, tagId: tag!.id });

    const report = await performance(owner);
    expect(report.scope).toBe('all');
    expect(report.summary).toMatchObject({
      conversations: 2,
      customerInitiated: 2,
      resolved: 2,
      handledByHuman: 2,
      resolvedByBotOnly: 0,
      firstResponse: { count: 2 },
      resolution: { count: 2 },
    });
    expect(report.summary?.firstResponse.averageSeconds).not.toBeNull();
    expect(report.trends?.daily).toHaveLength(1);
    expect(report.trends?.daily[0]).toMatchObject({ conversations: 2, resolved: 2 });
    expect(report.trends?.hourly).toHaveLength(24);
    expect(
      report.agents.map((agent) => [agent.user.name, agent.resolved, agent.messagesSent]),
    ).toEqual(
      expect.arrayContaining([
        [owner.session.user.name, 1, 1],
        ['Sinta CS', 1, 1],
      ]),
    );
    expect(report.tags?.map((entry) => [entry.tag.name, entry.conversations])).toEqual([
      ['Gangguan', 1],
    ]);
    expect(report.bots).toEqual([]);

    const own = await performance(cs);
    expect(own).toMatchObject({
      scope: 'own',
      summary: null,
      trends: null,
      bots: null,
      tags: null,
    });
    expect(own.agents.map((agent) => agent.user.name)).toEqual(['Sinta CS']);

    const tooLong = await call(
      harness.app,
      'GET',
      `${REPORT_ROUTES.performance}?from=2026-01-01&to=2026-06-01`,
      undefined,
      as(owner),
    );
    expect(tooLong.statusCode).toBe(400);
  });

  it('biaya pesan Meta: template ditagih saat diterima, UTILITY dalam jendela gratis, kuota layanan; CS ditolak', async () => {
    await servedAndResolved(owner, '6281200000003');
    const [conversation] = await harness.db.select().from(conversations);
    const now = new Date();
    const template = (category: string, status: 'delivered' | 'read' | 'sent' | 'failed') => ({
      organizationId,
      conversationId: conversation!.id,
      contactId: conversation!.contactId,
      channelId,
      direction: 'outbound' as const,
      senderKind: 'agent' as const,
      senderUserId: owner.session.user.id,
      type: 'template' as const,
      text: 'x',
      status,
      templateCategory: category,
      occurredAt: now,
    });
    await harness.db
      .insert(messages)
      .values([
        template('MARKETING', 'delivered'),
        template('MARKETING', 'read'),
        template('MARKETING', 'sent'),
        template('UTILITY', 'delivered'),
        template('AUTHENTICATION', 'failed'),
      ]);
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' })
      .format(now)
      .slice(0, 7);
    const response = await call(
      harness.app,
      'GET',
      `${REPORT_ROUTES.costs}?month=${month}`,
      undefined,
      as(owner),
    );
    expect(response.statusCode, response.body).toBe(200);
    const costs = reportCostsResponseSchema.parse(response.json()).costs;
    expect(costs.currency).toBe('IDR');
    const [channel] = costs.channels;
    expect(channel).toMatchObject({
      serviceConversations: 1,
      freeQuota: 1000,
      freeRemaining: 999,
      billableService: 0,
      templates: {
        MARKETING: { sent: 3, billable: 2, free: 0, cost: 1186 },
        // Pelanggan baru saja menulis → jendela layanan terbuka → UTILITY gratis.
        UTILITY: { billable: 0, free: 1, cost: 0 },
        AUTHENTICATION: { sent: 0, billable: 0 },
      },
      total: 1186,
    });
    expect(
      (await call(harness.app, 'GET', `${REPORT_ROUTES.costs}?month=${month}`, undefined, as(cs)))
        .statusCode,
    ).toBe(403);
  });

  it('ekspor CSV: wajib CSRF, diaudit, kebal injeksi rumus; CS hanya kinerja sendiri', async () => {
    await servedAndResolved(owner, '6281200000004');
    const url = (kind: string) =>
      `${REPORT_ROUTES.exportCsv}?kind=${kind}&from=${today()}&to=${today()}`;
    expect(
      (await call(harness.app, 'GET', url('agents'), undefined, { cookie: owner.cookie }))
        .statusCode,
    ).toBe(403);
    const csv = await call(harness.app, 'GET', url('daily'), undefined, as(owner));
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain(today());
    const [audit] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'report.exported'));
    expect(audit?.metadata).toMatchObject({ kind: 'daily', rows: 1, scope: 'all' });
    expect((await call(harness.app, 'GET', url('daily'), undefined, as(cs))).statusCode).toBe(403);
    const mine = await call(harness.app, 'GET', url('agents'), undefined, as(cs));
    expect(mine.statusCode).toBe(200);
    expect(mine.body).toContain('Sinta CS');
    expect(mine.body).not.toContain(owner.session.user.name);
  });
});

describe('laporan dibuka bersamaan (audit akhir QA S1)', () => {
  it('3 supervisor × 3 kartu serentak: semua 200, tidak ada 429', async () => {
    const supervisors: SignedIn[] = [];
    for (const index of [1, 2, 3]) {
      const email = `supervisor${String(index)}.laporan@majujaya.test`;
      await insertUser(harness.db, organizationId, {
        role: 'supervisor',
        email,
        passwordHash: await hasher.hash(PASSWORD),
      });
      supervisors.push(await login(harness.app, { email, password: PASSWORD }));
    }
    const range = `from=${today()}&to=${today()}`;
    const urls = [
      `${REPORT_ROUTES.performance}?${range}`,
      `${REPORT_ROUTES.costs}?month=${today().slice(0, 7)}`,
      `${REPORT_ROUTES.performance}?${range}`,
    ];
    const responses = await Promise.all(
      supervisors.flatMap((signed) =>
        urls.map((url) => call(harness.app, 'GET', url, undefined, as(signed))),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual(
      Array.from({ length: 9 }, () => 200),
    );
  });
});

describe('CSAT otomatis', () => {
  it('pengaturan: tautan ditolak, hanya Owner/Admin, bawaan mati', async () => {
    const initial = csatSettingsResponseSchema.parse(
      (await call(harness.app, 'GET', REPORT_ROUTES.csatSettings, undefined, as(owner))).json(),
    ).csat;
    expect(initial.enabled).toBe(false);
    expect((await enableCsat({ thanks: 'Isi survei di https://contoh.id ya' })).statusCode).toBe(
      400,
    );
    expect((await enableCsat()).statusCode).toBe(200);
    expect(
      (await call(harness.app, 'GET', REPORT_ROUTES.csatSettings, undefined, as(cs))).statusCode,
    ).toBe(403);
  });

  it('selesai oleh agen → survei daftar 1–5; jawaban tidak membuka percakapan; terima kasih; komentar; laporan', async () => {
    expect((await enableCsat()).statusCode).toBe(200);
    const id = await servedAndResolved(cs, '6281200000005');
    const before = fake.sentMessages.length;
    expect(await csat()).toMatchObject({ created: 1, sent: 1 });
    const surveyMessage = fake.sentMessages[before]?.body as {
      type: string;
      interactive: {
        type: string;
        action: { sections: { rows: { id: string; title: string }[] }[] };
      };
    };
    expect(surveyMessage.type).toBe('interactive');
    expect(surveyMessage.interactive.type).toBe('list');
    const rows = surveyMessage.interactive.action.sections[0]!.rows;
    expect(rows.map((row) => row.title)).toEqual([
      '5 — Sangat puas',
      '4 — Puas',
      '3 — Biasa saja',
      '2 — Kurang puas',
      '1 — Tidak puas',
    ]);
    const [survey] = await harness.db.select().from(csatSurveys);
    expect(survey).toMatchObject({ status: 'sent', conversationId: id });
    // Dijalankan lagi: tidak ada survei kedua untuk percakapan yang sama.
    expect(await csat()).toMatchObject({ created: 0, sent: 0 });

    // ID survei milik pelanggan LAIN / skor di luar 1–5 diabaikan (jadi pesan biasa).
    await receive(
      interactiveReplyNotification({
        reply: 'list_reply',
        id: `csat:${survey!.id}:9`,
        title: '9',
        customer: { waId: '6281200000005', userId: 'ID.6281200000005' },
      }),
    );
    let surveys = await harness.db.select().from(csatSurveys);
    expect(surveys[0]?.status).toBe('sent');
    // Bersihkan percakapan yang terbuka karena balasan tidak sah tadi.
    await harness.db
      .update(conversations)
      .set({ status: 'resolved', resolvedAt: new Date(), assigneeUserId: null })
      .where(eq(conversations.status, 'unserved'));

    await receive(
      interactiveReplyNotification({
        reply: 'list_reply',
        id: rows[1]!.id,
        title: 'Judul palsu <b>10</b>',
        customer: { waId: '6281200000005', userId: 'ID.6281200000005' },
      }),
    );
    surveys = await harness.db.select().from(csatSurveys);
    expect(surveys[0]).toMatchObject({ status: 'answered', score: 4 });
    const [conversation] = await harness.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(conversation).toMatchObject({ status: 'resolved' });

    const sentBefore = fake.sentMessages.length;
    expect(await csat()).toMatchObject({ thanked: 1 });
    expect(fake.sentMessages[sentBefore]?.body).toMatchObject({
      type: 'text',
      text: { body: 'Terima kasih! Ada saran? Tulis saja di sini.' },
    });

    await receive(
      textMessageNotification({
        body: 'Teknisinya   ramah,\nmantap!',
        customer: { waId: '6281200000005', userId: 'ID.6281200000005' },
      }),
    );
    surveys = await harness.db.select().from(csatSurveys);
    expect(surveys[0]?.comment).toBe('Teknisinya ramah, mantap!');

    const report = await performance(owner);
    expect(report.csat).toMatchObject({ sent: 1, responses: 1, average: 4, responseRate: 100 });
    expect(report.agents.find((agent) => agent.user.name === 'Sinta CS')?.csat.average).toBe(4);
    const exported = await call(
      harness.app,
      'GET',
      `${REPORT_ROUTES.exportCsv}?kind=csat&from=${today()}&to=${today()}`,
      undefined,
      as(owner),
    );
    expect(exported.body).toContain('Teknisinya ramah, mantap!');
  });

  it('tidak dikirim: CSAT mati, diselesaikan tanpa balasan agen, kontak baru disurvei', async () => {
    // Mati: tidak ada survei sama sekali.
    await servedAndResolved(owner, '6281200000006');
    expect(await csat()).toMatchObject({ created: 0 });
    expect(await harness.db.select().from(csatSurveys)).toHaveLength(0);

    expect((await enableCsat()).statusCode).toBe(200);
    // Diselesaikan tanpa balasan agen → dilewati.
    await receive(textMessageNotification({ customer: { waId: '6281200000007', userId: 'ID.7' } }));
    const [open] = (await harness.db.select().from(conversations)).filter(
      (row) => row.status !== 'resolved',
    );
    await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.resolve, { conversationId: open!.id }),
      undefined,
      as(owner),
    );
    await csat();
    const [skipped] = await harness.db
      .select()
      .from(csatSurveys)
      .where(eq(csatSurveys.conversationId, open!.id));
    expect(skipped).toMatchObject({ status: 'skipped', skipReason: 'no_human_reply' });

    // Kontak yang sama dua kali dalam 24 jam → survei kedua dilewati.
    await servedAndResolved(owner, '6281200000008');
    await csat();
    await servedAndResolved(owner, '6281200000008');
    await csat();
    const forContact = (await harness.db.select().from(csatSurveys)).filter(
      (row) => row.status !== 'skipped' || row.skipReason === 'recently_surveyed',
    );
    expect(forContact.map((row) => row.status).sort()).toEqual(['sent', 'skipped']);
  });
});
