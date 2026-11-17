/**
 * Broadcast (Fase 4) — Postgres + Redis sungguhan, Graph Meta TIRUAN, server Telegram & konektor REST
 * TIRUAN, worker produksi (`broadcast.ts` dipanggil langsung): impor CSV/segmen/konektor, pemetaan,
 * pratinjau, estimasi, persetujuan > ambang, jadwal, throttle, jeda/lanjut/batal, rem darurat manual &
 * otomatis, anti-dobel, restart worker, laporan + ekspor, tag otomatis saat dibalas, alarm Telegram,
 * review kontak R4, jaring pengaman kode OTP.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createInboxEventPublisher,
  createMetaGraphClient,
  createSecretBox,
  sealChannelSecret,
  Secret,
  WEBHOOK_JOBS,
  type SecurityNoticeAdminEmailPayload,
} from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import {
  alarmEvents,
  auditLogs,
  broadcastCampaigns,
  broadcastRecipients,
  channels,
  contactEvents,
  contactTags,
  contacts,
  conversations,
  messageTemplates,
  messages,
  newId,
  organizations,
  tags,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  WEBHOOK_ROUTES,
  apiPath,
  broadcastConnectorResponseSchema,
  broadcastConnectorTestResponseSchema,
  broadcastEstimateResponseSchema,
  broadcastImportResponseSchema,
  broadcastListResponseSchema,
  broadcastPreviewResponseSchema,
  broadcastRecipientListResponseSchema,
  broadcastReportResponseSchema,
  broadcastResponseSchema,
  broadcastSettingsResponseSchema,
  errorEnvelopeSchema,
  telegramAlarmSettingsResponseSchema,
  telegramTestResponseSchema,
  type BroadcastCampaign,
} from '@balesin/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  broadcastGuard,
  broadcastTick,
  deliverAlarms,
  runBroadcastSlice,
  type BroadcastJobDeps,
} from '../../../../worker/src/queues/broadcast';
import { wipeStaleSensitiveTemplates } from '../../../../worker/src/queues/maintenance';
import { processWebhookJob } from '../../../../worker/src/queues/webhooks';
import { createPasswordHasher } from '../auth/password-hasher';
import {
  FAKE_WEBHOOK_DEFAULTS,
  metaErrorBody,
  signedWebhook,
  startFakeMeta,
  statusNotification,
  textMessageNotification,
  type FakeMeta,
} from '../../testing/fake-meta';
import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  confirmationOf,
  createIntegrationHarness,
  integrationConfig,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const TOKEN = 'EAAtokenTiruanBroadcast0123456789';
const PHONE = FAKE_WEBHOOK_DEFAULTS.phoneNumberId;
const WABA = FAKE_WEBHOOK_DEFAULTS.wabaId;
const META_IP = '173.252.127.1';
const PASSWORD = 'sandi-uji-broadcast-0001';
const BOT_TOKEN = '123456789:AAFakeTokenBroadcastAlarm_abcdefghij';

let fake: FakeMeta;
let harness: IntegrationHarness;
let owner: SignedIn;
let admin: SignedIn;
let supervisor: SignedIn;
let organizationId: string;
let channelId: string;
let templateId: string;
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const logs = createLogCapture();
const hasher = createPasswordHasher();

// ── Server tiruan: Telegram + konektor billing ─────────────────────────────
interface Recorded {
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
}
let helper: Server;
let helperUrl: string;
const telegramRequests: Recorded[] = [];
const connectorRequests: Recorded[] = [];
let connectorBody: unknown = null;

const metaClient = () =>
  createMetaGraphClient({
    version: 'v26.0',
    baseUrl: fake.url,
    sleep: () => Promise.resolve(),
    maxAttempts: 1,
  });
const publisher = () =>
  createInboxEventPublisher(harness.redis, { prefix: harness.redisPrefix, logger: logs.logger });
const sleeps: number[] = [];
const ownerEmails: SecurityNoticeAdminEmailPayload[] = [];
function workerDeps(over: Partial<BroadcastJobDeps> = {}): BroadcastJobDeps {
  return {
    db: harness.db,
    logger: logs.logger,
    meta: metaClient(),
    secretBox: box,
    publisher: publisher(),
    telegramBaseUrl: helperUrl,
    notifyOwner: (payload) => {
      ownerEmails.push(payload);
      return Promise.resolve();
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...over,
  };
}

const as = (signed: SignedIn) => ({ cookie: signed.cookie, csrf: signed.csrf });

async function signIn(role: 'admin' | 'supervisor' | 'cs', email: string): Promise<SignedIn> {
  await insertUser(harness.db, organizationId, {
    role,
    email,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return login(harness.app, { email, password: PASSWORD });
}

async function receive(notification: unknown): Promise<void> {
  const { body, headers } = signedWebhook(notification, APP_SECRET);
  const response = await harness.app.inject({
    method: 'POST',
    url: apiPath(WEBHOOK_ROUTES.whatsapp, { channelId }),
    headers,
    payload: body,
    remoteAddress: META_IP,
  });
  expect(response.statusCode, response.body).toBe(200);
  for (const data of harness.webhookJobs.splice(0)) {
    await processWebhookJob(
      { name: WEBHOOK_JOBS.whatsappEvent, data, attemptsMade: 0, opts: { attempts: 8 } },
      { db: harness.db, logger: logs.logger, publisher: publisher() },
    );
  }
}

async function create(signed: SignedIn, name = 'Tagihan November'): Promise<BroadcastCampaign> {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.broadcasts.list,
    { name, channelId, templateId },
    as(signed),
  );
  expect(response.statusCode, response.body).toBe(201);
  return broadcastResponseSchema.parse(response.json()).broadcast;
}

function upload(signed: SignedIn, id: string, content: string | Buffer, filename = 'tagihan.csv') {
  const boundary = `----balesin${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`,
    ),
    Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return harness.app.inject({
    method: 'POST',
    url: apiPath(API_ROUTES.broadcasts.upload, { broadcastId: id }),
    headers: {
      cookie: signed.cookie,
      origin: TEST_APP_ORIGIN,
      'x-csrf-token': signed.csrf,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
}

const MAPPING = {
  body: {
    '1': { kind: 'column', column: 'nama' },
    '2': { kind: 'column', column: 'tagihan' },
  },
  header: null,
  buttons: {},
};

async function patch(signed: SignedIn, id: string, body: object) {
  const response = await call(
    harness.app,
    'PATCH',
    apiPath(API_ROUTES.broadcasts.broadcast, { broadcastId: id }),
    body,
    as(signed),
  );
  expect(response.statusCode, response.body).toBe(200);
  return broadcastResponseSchema.parse(response.json()).broadcast;
}

async function action(
  signed: SignedIn,
  route: string,
  id: string,
  body: object = {},
  withConfirmation = false,
) {
  return call(
    harness.app,
    'POST',
    apiPath(route, { broadcastId: id }),
    withConfirmation ? { ...body, confirmation: await confirmationOf(signed) } : body,
    as(signed),
  );
}

/** Draf siap ajukan: CSV → pemetaan. */
async function draftWith(signed: SignedIn, csv: string, name?: string) {
  const campaign = await create(signed, name);
  const imported = await upload(signed, campaign.id, csv);
  expect(imported.statusCode, imported.body).toBe(200);
  await patch(signed, campaign.id, { mapping: MAPPING });
  return { id: campaign.id, report: broadcastImportResponseSchema.parse(imported.json()).report };
}

async function submitted(signed: SignedIn, csv: string, name?: string) {
  const draft = await draftWith(signed, csv, name);
  const response = await action(signed, API_ROUTES.broadcasts.submit, draft.id, {}, true);
  expect(response.statusCode, response.body).toBe(200);
  return { ...draft, broadcast: broadcastResponseSchema.parse(response.json()).broadcast };
}

async function campaignRow(id: string) {
  const [row] = await harness.db
    .select()
    .from(broadcastCampaigns)
    .where(eq(broadcastCampaigns.id, id));
  if (!row) throw new Error('kampanye hilang');
  return row;
}

async function recipientsOf(id: string) {
  return harness.db
    .select()
    .from(broadcastRecipients)
    .where(eq(broadcastRecipients.campaignId, id))
    .orderBy(broadcastRecipients.rowNumber);
}

/** Jalankan worker sampai kampanye berhenti berjalan (maks. beberapa putaran). */
async function runUntilDone(id: string, deps = workerDeps()) {
  for (let round = 0; round < 10; round += 1) {
    await broadcastTick(deps);
    const row = await campaignRow(id);
    if (row.status !== 'running' && row.status !== 'scheduled') return row;
    if (row.waitingUntil) return row;
    await runBroadcastSlice({ organizationId, campaignId: id }, deps);
  }
  return campaignRow(id);
}

const CSV = [
  'nama,nomor,tagihan',
  'Budi,0812-3456-7801,Rp150.000',
  'Sari,6281234567802,Rp200.000',
  'Budi lagi,081234567801,Rp150.000',
  'Rusak,12345,Rp0',
].join('\n');

beforeAll(async () => {
  helper = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry = {
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      if (entry.path.startsWith('/bot')) {
        telegramRequests.push(entry);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: {} }));
        return;
      }
      connectorRequests.push(entry);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(connectorBody));
    });
  });
  await new Promise<void>((resolve) => helper.listen(0, '127.0.0.1', resolve));
  helperUrl = `http://127.0.0.1:${String((helper.address() as AddressInfo).port)}`;
  fake = await startFakeMeta();
  harness = await createIntegrationHarness({
    config: { ...integrationConfig(), metaGraphBaseUrl: fake.url },
    overrides: {
      meta: { sleep: () => Promise.resolve() },
      webhookAllowLoopback: true,
      telegramBaseUrl: helperUrl,
    },
  });
});

beforeEach(async () => {
  await harness.reset();
  fake.reset();
  telegramRequests.length = 0;
  connectorRequests.length = 0;
  sleeps.length = 0;
  ownerEmails.length = 0;
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
  templateId = newId();
  await harness.db.insert(messageTemplates).values({
    id: templateId,
    organizationId,
    channelId,
    wabaId: WABA,
    metaTemplateId: '5550001',
    name: 'tagihan_bulanan',
    language: 'id',
    category: 'UTILITY',
    status: 'APPROVED',
    content: {
      parameterFormat: 'positional',
      header: null,
      body: {
        text: 'Halo {{1}}, tagihan internet kamu {{2}} jatuh tempo besok.',
        examples: { '1': 'Budi', '2': 'Rp150.000' },
      },
      footer: null,
      buttons: [],
      authentication: null,
    },
  });
  admin = await signIn('admin', 'admin.bc@majujaya.test');
  supervisor = await signIn('supervisor', 'spv.bc@majujaya.test');
});

afterAll(async () => {
  await harness?.close();
  await fake?.close();
  await new Promise<void>((resolve) => helper.close(() => resolve()));
});

describe('impor → pemetaan → pratinjau → estimasi → kirim', () => {
  it('CSV: nomor dinormalkan, ganda & salah dilaporkan; pratinjau per penerima; estimasi tarif', async () => {
    const { id, report } = await draftWith(supervisor, CSV);
    expect(report).toMatchObject({
      sourceRows: 4,
      recipients: 2,
      rejectedRows: 2,
      phoneColumn: 'nomor',
      columns: ['nama', 'nomor', 'tagihan'],
      issues: [
        { row: 4, issue: 'duplicate' },
        { row: 5, issue: 'phone_invalid' },
      ],
    });
    const preview = broadcastPreviewResponseSchema.parse(
      (
        await call(
          harness.app,
          'GET',
          apiPath(API_ROUTES.broadcasts.preview, { broadcastId: id }),
          undefined,
          as(supervisor),
        )
      ).json(),
    );
    expect(preview.samples.map((sample) => [sample.phone, sample.text])).toEqual([
      ['+6281234567801', 'Halo Budi, tagihan internet kamu Rp150.000 jatuh tempo besok.'],
      ['+6281234567802', 'Halo Sari, tagihan internet kamu Rp200.000 jatuh tempo besok.'],
    ]);
    const estimate = broadcastEstimateResponseSchema.parse(
      (
        await call(
          harness.app,
          'GET',
          apiPath(API_ROUTES.broadcasts.estimate, { broadcastId: id }),
          undefined,
          as(supervisor),
        )
      ).json(),
    ).estimate;
    expect(estimate).toMatchObject({
      currency: 'IDR',
      category: 'UTILITY',
      recipients: 2,
      billable: 2,
      free: 0,
      total: 726,
    });
    // Audit tanpa nomor.
    const audits = await harness.db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.targetId, id));
    expect(audits.map((entry) => entry.action)).toContain('broadcast.recipients_imported');
    expect(JSON.stringify(audits)).not.toContain('8123456780');
  });

  it('ajukan wajib konfirmasi identitas; di bawah ambang → terjadwal → terkirim bertahap, laporan, dibalas → tag otomatis', async () => {
    const draft = await draftWith(supervisor, CSV);
    const [tag] = await harness.db
      .insert(tags)
      .values({ organizationId, name: 'Balas Tagihan', color: 'blue' })
      .returning();
    await patch(supervisor, draft.id, { ratePerSecond: 2, autoTagId: tag?.id });
    const noConfirm = await action(supervisor, API_ROUTES.broadcasts.submit, draft.id);
    expect(noConfirm.statusCode).toBe(400);
    const response = await action(supervisor, API_ROUTES.broadcasts.submit, draft.id, {}, true);
    expect(response.statusCode, response.body).toBe(200);
    expect(broadcastResponseSchema.parse(response.json()).broadcast).toMatchObject({
      status: 'scheduled',
      approval: { required: false, threshold: 50 },
      estimate: { recipients: 2, total: 726 },
    });

    const done = await runUntilDone(draft.id);
    expect(done.status).toBe('completed');
    expect(fake.sentMessages).toHaveLength(2);
    expect(fake.sentMessages[0]?.body).toMatchObject({
      to: '6281234567801',
      type: 'template',
      template: {
        name: 'tagihan_bulanan',
        language: { code: 'id' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Budi' },
              { type: 'text', text: 'Rp150.000' },
            ],
          },
        ],
      },
    });
    // Throttle 2 pesan/detik → jeda ±500 ms di antara pesan.
    expect(sleeps.length).toBeGreaterThan(0);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(500);
    expect(Math.max(...sleeps)).toBeGreaterThan(300);

    const sent = await harness.db.select().from(messages).where(eq(messages.broadcastId, draft.id));
    expect(sent).toHaveLength(2);
    expect(sent.every((message) => message.senderKind === 'broadcast')).toBe(true);
    expect(sent.every((message) => message.templateCategory === 'UTILITY')).toBe(true);
    // Percakapan baru dibuat `resolved` (tidak membanjiri antrian CS).
    const conversationRows = await harness.db.select().from(conversations);
    expect(conversationRows.every((row) => row.status === 'resolved')).toBe(true);

    // Status dari webhook + balasan pelanggan → laporan & tag otomatis.
    const budi = sent.find((message) => message.text?.includes('Budi'));
    await receive(statusNotification({ wamid: budi?.wamid ?? '', status: 'delivered' }));
    await receive(statusNotification({ wamid: budi?.wamid ?? '', status: 'read' }));
    await receive(
      textMessageNotification({
        customer: { waId: '6281234567801', userId: 'ID.budi.broadcast' },
        body: 'Sudah saya bayar kak',
      }),
    );
    const report = broadcastReportResponseSchema.parse(
      (
        await call(
          harness.app,
          'GET',
          apiPath(API_ROUTES.broadcasts.report, { broadcastId: draft.id }),
          undefined,
          as(supervisor),
        )
      ).json(),
    ).report;
    expect(report).toMatchObject({
      status: 'completed',
      recipients: 2,
      rejectedRows: 2,
      read: 1,
      replied: 1,
      failed: 0,
      cost: { currency: 'IDR', billable: 1, total: 363 },
    });
    const budiRecipient = (await recipientsOf(draft.id))[0];
    const tagged = await harness.db
      .select()
      .from(contactTags)
      .where(eq(contactTags.contactId, budiRecipient?.contactId ?? ''));
    expect(tagged.map((row) => row.tagId)).toEqual([tag?.id]);
    const replied = broadcastRecipientListResponseSchema.parse(
      (
        await call(
          harness.app,
          'GET',
          `${apiPath(API_ROUTES.broadcasts.recipients, { broadcastId: draft.id })}?status=replied`,
          undefined,
          as(supervisor),
        )
      ).json(),
    );
    expect(replied.recipients.map((recipient) => recipient.phone)).toEqual(['+6281234567801']);

    // Alarm "selesai" dicatat (tanpa nomor).
    const alarms = await harness.db.select().from(alarmEvents);
    expect(alarms.map((alarm) => alarm.kind)).toContain('broadcast_completed');
    expect(JSON.stringify(alarms)).not.toContain('8123456780');

    // Ekspor CSV: GET ber-CSRF + audit.
    const exportUrl = apiPath(API_ROUTES.broadcasts.exportCsv, { broadcastId: draft.id });
    const noCsrf = await call(harness.app, 'GET', exportUrl, undefined, {
      cookie: supervisor.cookie,
    });
    expect(noCsrf.statusCode).toBe(403);
    const csv = await call(harness.app, 'GET', exportUrl, undefined, as(supervisor));
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain("'+6281234567801");
    const [exported] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'broadcast.exported'));
    expect(exported?.metadata).toMatchObject({ rows: 2 });

    const list = broadcastListResponseSchema.parse(
      (await call(harness.app, 'GET', API_ROUTES.broadcasts.list, undefined, as(owner))).json(),
    );
    expect(list.broadcasts.map((item) => item.id)).toEqual([draft.id]);
  });

  it('pemetaan belum lengkap / template OTP / judul media ditolak dengan pesan Indonesia', async () => {
    const campaign = await create(supervisor);
    await upload(supervisor, campaign.id, CSV);
    const missing = await action(supervisor, API_ROUTES.broadcasts.submit, campaign.id, {}, true);
    expect(missing.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(missing.json()).error.details?.[0]?.field).toBe(
      'mapping.body.1',
    );
    const otp = newId();
    await harness.db.insert(messageTemplates).values({
      id: otp,
      organizationId,
      channelId,
      wabaId: WABA,
      name: 'kode_otp',
      language: 'id',
      category: 'AUTHENTICATION',
      status: 'APPROVED',
      metaTemplateId: '5550009',
      content: {
        parameterFormat: 'positional',
        header: null,
        body: { text: 'Kode {{1}}', examples: { '1': '123' } },
        footer: null,
        buttons: [],
        authentication: { addSecurityRecommendation: true, codeExpirationMinutes: 5 },
      },
    });
    const rejected = await call(
      harness.app,
      'POST',
      API_ROUTES.broadcasts.list,
      { name: 'OTP', channelId, templateId: otp },
      as(supervisor),
    );
    expect(rejected.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(rejected.json()).error.message).toContain('OTP');
  });
});

describe('persetujuan di atas ambang', () => {
  it('pembuat tidak boleh menyetujui sendiri; Admin lain menyetujui; tolak → draf; ambang naik hanya Owner', async () => {
    // Admin MENURUNKAN ambang (memperketat) boleh; menaikkan (melonggarkan) hanya Owner.
    const settings = broadcastSettingsResponseSchema.parse(
      (await call(harness.app, 'GET', API_ROUTES.broadcasts.settings, undefined, as(admin))).json(),
    ).settings;
    const { updatedAt: _u, updatedBy: _b, ...values } = settings;
    const tighten = await call(
      harness.app,
      'PUT',
      API_ROUTES.broadcasts.settings,
      { ...values, approvalThreshold: 1, confirmation: await confirmationOf(admin) },
      as(admin),
    );
    expect(tighten.statusCode, tighten.body).toBe(200);
    const loosen = await call(
      harness.app,
      'PUT',
      API_ROUTES.broadcasts.settings,
      { ...values, approvalThreshold: 500, confirmation: await confirmationOf(admin) },
      as(admin),
    );
    expect(loosen.statusCode).toBe(403);

    const first = await submitted(owner, CSV, 'Butuh persetujuan');
    expect(first.broadcast).toMatchObject({
      status: 'pending_approval',
      approval: { required: true, threshold: 1 },
    });
    const pendingAlarm = await harness.db
      .select()
      .from(alarmEvents)
      .where(eq(alarmEvents.kind, 'broadcast_pending_approval'));
    expect(pendingAlarm).toHaveLength(1);
    // Worker tidak mengirim yang belum disetujui.
    await broadcastTick(workerDeps());
    expect((await campaignRow(first.id)).status).toBe('pending_approval');

    const own = await action(owner, API_ROUTES.broadcasts.approve, first.id, {}, true);
    expect(own.statusCode).toBe(403);
    const bySupervisor = await action(
      supervisor,
      API_ROUTES.broadcasts.approve,
      first.id,
      {},
      true,
    );
    expect(bySupervisor.statusCode).toBe(403);
    const noConfirm = await action(admin, API_ROUTES.broadcasts.approve, first.id);
    expect(noConfirm.statusCode).toBe(400);
    const approved = await action(admin, API_ROUTES.broadcasts.approve, first.id, {}, true);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(broadcastResponseSchema.parse(approved.json()).broadcast).toMatchObject({
      status: 'scheduled',
      approval: { decidedBy: { id: admin.session.user.id } },
    });
    expect((await runUntilDone(first.id)).status).toBe('completed');

    const second = await submitted(supervisor, CSV, 'Ditolak');
    const rejected = await action(admin, API_ROUTES.broadcasts.reject, second.id, {
      reason: 'Jadwal bentrok dengan pemeliharaan jaringan',
    });
    expect(rejected.statusCode).toBe(200);
    expect(broadcastResponseSchema.parse(rejected.json()).broadcast).toMatchObject({
      status: 'draft',
      approval: { rejectionReason: 'Jadwal bentrok dengan pemeliharaan jaringan' },
    });
  });
});

describe('jadwal, jeda, lanjut, batal', () => {
  it('jadwal di zona server; jeda SEKETIKA di tengah pengiriman; lanjut; batal', async () => {
    const draft = await draftWith(supervisor, CSV);
    const at = new Date(Date.now() + 60 * 60 * 1000);
    await patch(supervisor, draft.id, { scheduledAt: at.toISOString() });
    await action(supervisor, API_ROUTES.broadcasts.submit, draft.id, {}, true);
    await broadcastTick(workerDeps());
    expect((await campaignRow(draft.id)).status).toBe('scheduled');
    await broadcastTick(workerDeps({ now: () => new Date(at.getTime() + 1_000) }));
    expect((await campaignRow(draft.id)).status).toBe('running');

    // Jeda ditarik saat worker menunggu jeda throttle setelah pesan pertama.
    let pausedOnce = false;
    const deps = workerDeps({
      sleep: async () => {
        if (pausedOnce) return;
        pausedOnce = true;
        const paused = await action(supervisor, API_ROUTES.broadcasts.pause, draft.id);
        expect(paused.statusCode).toBe(200);
      },
    });
    const slice = await runBroadcastSlice({ organizationId, campaignId: draft.id }, deps);
    expect(slice).toMatchObject({ status: 'stopped', sent: 1 });
    expect(fake.sentMessages).toHaveLength(1);
    expect(await campaignRow(draft.id)).toMatchObject({ status: 'paused', pausedReason: 'manual' });
    expect(
      (await runBroadcastSlice({ organizationId, campaignId: draft.id }, workerDeps())).status,
    ).toBe('skipped');

    const resumed = await action(supervisor, API_ROUTES.broadcasts.resume, draft.id, {}, true);
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect((await runUntilDone(draft.id)).status).toBe('completed');
    expect(fake.sentMessages).toHaveLength(2);

    const other = await submitted(supervisor, CSV, 'Batal');
    const cancelled = await action(supervisor, API_ROUTES.broadcasts.cancel, other.id);
    expect(cancelled.statusCode).toBe(200);
    expect((await recipientsOf(other.id)).every((row) => row.status === 'cancelled')).toBe(true);
    await runUntilDone(other.id);
    expect(fake.sentMessages).toHaveLength(2);
  });
});

describe('rem darurat & rem otomatis', () => {
  it('rem darurat organisasi menjeda kampanye + alarm; Supervisor tak bisa melanjutkan; Owner setelah rem dilepas', async () => {
    const { id } = await submitted(supervisor, CSV);
    const pulled = await call(
      harness.app,
      'POST',
      API_ROUTES.sendingLimits.pause,
      { reason: 'Uji rem' },
      as(admin),
    );
    expect(pulled.statusCode).toBe(200);
    await broadcastTick(workerDeps());
    expect(await campaignRow(id)).toMatchObject({
      status: 'paused',
      pausedReason: 'emergency_brake',
    });
    expect(
      (await harness.db.select().from(alarmEvents)).filter(
        (alarm) => alarm.kind === 'emergency_brake',
      ),
    ).toHaveLength(1);
    await broadcastTick(workerDeps());
    expect(
      (await harness.db.select().from(alarmEvents)).filter(
        (alarm) => alarm.kind === 'emergency_brake',
      ),
    ).toHaveLength(1);

    expect((await action(supervisor, API_ROUTES.broadcasts.resume, id, {}, true)).statusCode).toBe(
      403,
    );
    expect((await action(owner, API_ROUTES.broadcasts.resume, id, {}, true)).statusCode).toBe(409);
    const released = await call(
      harness.app,
      'POST',
      API_ROUTES.sendingLimits.resume,
      { confirmation: await confirmationOf(owner) },
      as(owner),
    );
    expect(released.statusCode).toBe(200);
    expect((await action(owner, API_ROUTES.broadcasts.resume, id, {}, true)).statusCode).toBe(200);
    expect((await runUntilDone(id)).status).toBe('completed');
  });

  it('kode Meta tingkat akun (131048) → kampanye dijeda seketika + alarm', async () => {
    const { id } = await submitted(supervisor, CSV);
    fake.failNext(`/${PHONE}/messages`, {
      status: 400,
      body: metaErrorBody(131048, 'Spam rate limit hit'),
    });
    const row = await runUntilDone(id);
    expect(row).toMatchObject({ status: 'paused', pausedReason: 'meta_blocked' });
    expect(fake.sentMessages).toHaveLength(0);
    const [alarm] = await harness.db
      .select()
      .from(alarmEvents)
      .where(eq(alarmEvents.kind, 'broadcast_auto_paused'));
    expect(alarm?.details).toMatchObject({ reason: 'meta_blocked', metaCode: 131048 });
  });

  it('lonjakan gagal → rem otomatis kampanye setelah sampel minimal', async () => {
    const settings = broadcastSettingsResponseSchema.parse(
      (await call(harness.app, 'GET', API_ROUTES.broadcasts.settings, undefined, as(owner))).json(),
    ).settings;
    const { updatedAt: _u, updatedBy: _b, ...values } = settings;
    const put = await call(
      harness.app,
      'PUT',
      API_ROUTES.broadcasts.settings,
      {
        ...values,
        autoBrake: { ...values.autoBrake, failureSpikeMinSample: 5, failureSpikePercent: 50 },
        confirmation: await confirmationOf(owner),
      },
      as(owner),
    );
    expect(put.statusCode, put.body).toBe(200);
    const rows = Array.from(
      { length: 14 },
      (_, index) => `Pelanggan ${String(index)},0812345670${String(index).padStart(2, '0')},Rp1`,
    );
    const { id } = await submitted(owner, ['nama,nomor,tagihan', ...rows].join('\n'));
    fake.failNext(
      `/${PHONE}/messages`,
      ...Array.from({ length: 10 }, () => ({
        status: 400,
        body: metaErrorBody(131009, 'Parameter value is not valid'),
      })),
    );
    const row = await runUntilDone(id);
    expect(row).toMatchObject({ status: 'paused', pausedReason: 'failure_spike' });
    const pending = (await recipientsOf(id)).filter((entry) => entry.status === 'pending');
    expect(pending.length).toBe(4);
  });

  it('lonjakan pesan keluar NON-broadcast → rem darurat otomatis organisasi + audit + alarm + email Owner', async () => {
    await receive(textMessageNotification());
    const [conversation] = await harness.db.select().from(conversations);
    const now = new Date();
    await harness.db.insert(messages).values(
      Array.from({ length: 130 }, () => ({
        organizationId,
        conversationId: conversation?.id ?? '',
        contactId: conversation?.contactId ?? '',
        channelId,
        direction: 'outbound' as const,
        senderKind: 'agent' as const,
        senderUserId: owner.session.user.id,
        type: 'text' as const,
        text: 'x',
        status: 'sent' as const,
        occurredAt: now,
      })),
    );
    const result = await broadcastGuard(workerDeps());
    expect(result.braked).toBe(1);
    const [org] = await harness.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    expect(org?.sendingPausedAt).not.toBeNull();
    expect(org?.sendingPauseReason).toContain('Rem otomatis');
    const [audit] = await harness.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'sending.paused'), sql`${auditLogs.actorUserId} is null`));
    expect(audit?.metadata).toMatchObject({ automatic: true, perMinute: 130 });
    expect(ownerEmails.map((email) => email.event)).toEqual(['sending_auto_paused']);
    const auto = await harness.db
      .select()
      .from(alarmEvents)
      .where(eq(alarmEvents.kind, 'auto_brake'));
    expect(auto).toHaveLength(1);
    // Tick tidak menambah alarm "rem darurat" kedua untuk penarikan yang sama.
    await broadcastTick(workerDeps());
    expect(
      (await harness.db.select().from(alarmEvents)).filter((a) => a.kind === 'emergency_brake'),
    ).toHaveLength(0);
  });
});

describe('anti-dobel & restart worker', () => {
  it('nomor yang sudah menerima template sama dalam 24 jam dilewati di kampanye lain', async () => {
    const first = await submitted(supervisor, CSV, 'Pertama');
    expect((await runUntilDone(first.id)).status).toBe('completed');
    const second = await submitted(
      supervisor,
      ['nama,nomor,tagihan', 'Budi,081234567801,Rp1', 'Dedi,081234567803,Rp2'].join('\n'),
      'Kedua',
    );
    expect((await runUntilDone(second.id)).status).toBe('completed');
    const rows = await recipientsOf(second.id);
    expect(rows.map((row) => [row.phone, row.status, row.skipReason])).toEqual([
      ['+6281234567801', 'skipped', 'recently_sent'],
      ['+6281234567803', 'queued', null],
    ]);
    expect(fake.sentMessages).toHaveLength(3);
  });

  it('batas laju Meta → menunggu; potongan berikutnya mengirim PESAN YANG SAMA (tanpa dobel); sewa mencegah pemroses ganda', async () => {
    const { id } = await submitted(supervisor, CSV);
    await broadcastTick(workerDeps());
    fake.failNext(`/${PHONE}/messages`, {
      status: 429,
      body: metaErrorBody(130429, 'Rate limit hit'),
    });
    const first = await runBroadcastSlice({ organizationId, campaignId: id }, workerDeps());
    expect(first).toMatchObject({ status: 'stopped', sent: 0 });
    const waiting = await campaignRow(id);
    expect(waiting.waitingReason).toBe('meta_rate_limit');
    const [queued] = (await recipientsOf(id)).filter((row) => row.status === 'queued');
    expect(queued?.messageId).toBeTruthy();

    const later = new Date((waiting.waitingUntil?.getTime() ?? Date.now()) + 1_000);
    const deps = workerDeps({ now: () => later });
    // Sewa aktif milik pemroses lain → dilewati.
    await harness.db
      .update(broadcastCampaigns)
      .set({ runnerLeaseUntil: new Date(later.getTime() + 30_000) })
      .where(eq(broadcastCampaigns.id, id));
    expect((await runBroadcastSlice({ organizationId, campaignId: id }, deps)).status).toBe(
      'skipped',
    );
    await harness.db
      .update(broadcastCampaigns)
      .set({ runnerLeaseUntil: null })
      .where(eq(broadcastCampaigns.id, id));
    const second = await runBroadcastSlice({ organizationId, campaignId: id }, deps);
    expect(second.status).toBe('completed');
    expect(fake.sentMessages).toHaveLength(2);
    const sentRows = await harness.db.select().from(messages).where(eq(messages.broadcastId, id));
    expect(sentRows).toHaveLength(2);
    expect(sentRows.some((row) => row.id === queued?.messageId && row.wamid !== null)).toBe(true);
  });
});

describe('segmen & konektor REST', () => {
  it('segmen tag kontak → penerima (kolom nama/nomor/atribut)', async () => {
    const [tag] = await harness.db
      .insert(tags)
      .values({ organizationId, name: 'MITRA-A', color: 'green' })
      .returning();
    const [a, b] = await harness.db
      .insert(contacts)
      .values([
        {
          organizationId,
          channelType: 'whatsapp',
          phone: '+6281234567811',
          name: '101A@G2',
          attributes: [{ key: 'area', value: 'G2' }],
        },
        { organizationId, channelType: 'whatsapp', phone: '+6281234567812', name: '102B@G3' },
      ])
      .returning();
    await harness.db
      .insert(contactTags)
      .values([{ organizationId, contactId: a?.id ?? '', tagId: tag?.id ?? '' }]);
    void b;
    const campaign = await create(supervisor);
    const response = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.broadcasts.segment, { broadcastId: campaign.id }),
      { tagIds: [tag?.id] },
      as(supervisor),
    );
    expect(response.statusCode, response.body).toBe(200);
    const parsed = broadcastImportResponseSchema.parse(response.json());
    expect(parsed.report).toMatchObject({ recipients: 1, columns: ['nomor', 'nama', 'area'] });
    expect(parsed.broadcast.source?.label).toContain('MITRA-A');
  });

  it('konektor: header terenkripsi (tidak dikirim balik), SSRF ditolak, tes & impor data billing', async () => {
    const ssrf = await call(
      harness.app,
      'POST',
      API_ROUTES.broadcasts.connectors,
      {
        name: 'Metadata',
        url: 'http://169.254.169.254/latest',
        auth: null,
        phoneField: 'hp',
      },
      as(admin),
    );
    expect(ssrf.statusCode).toBe(400);
    const noConfirm = await call(
      harness.app,
      'POST',
      API_ROUTES.broadcasts.connectors,
      {
        name: 'Billing',
        url: `${helperUrl}/tagihan`,
        auth: { headerName: 'X-API-Key', headerValue: 'rahasia-billing-0001' },
        phoneField: 'hp',
        itemsPath: 'data',
      },
      as(admin),
    );
    expect(noConfirm.statusCode).toBe(400);
    const created = await call(
      harness.app,
      'POST',
      API_ROUTES.broadcasts.connectors,
      {
        name: 'Billing',
        url: `${helperUrl}/tagihan`,
        auth: { headerName: 'X-API-Key', headerValue: 'rahasia-billing-0001' },
        phoneField: 'hp',
        itemsPath: 'data',
        confirmation: await confirmationOf(admin),
      },
      as(admin),
    );
    expect(created.statusCode, created.body).toBe(201);
    expect(created.body).not.toContain('rahasia-billing');
    const connector = broadcastConnectorResponseSchema.parse(created.json()).connector;
    expect(connector.authHeaderTail).toBe('0001');

    connectorBody = {
      data: [
        { hp: '081234567821', nama: 'Rina', tagihan: 'Rp99.000' },
        { hp: 'salah', nama: 'X', tagihan: 'Rp1' },
      ],
    };
    const tested = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.broadcasts.connectorTest, { connectorId: connector.id }),
      undefined,
      as(admin),
    );
    expect(broadcastConnectorTestResponseSchema.parse(tested.json())).toMatchObject({
      ok: true,
      items: 2,
      columns: ['hp', 'nama', 'tagihan'],
    });
    expect(connectorRequests.at(-1)?.headers['x-api-key']).toBe('rahasia-billing-0001');

    const campaign = await create(supervisor);
    const options = await call(
      harness.app,
      'GET',
      API_ROUTES.broadcasts.connectorOptions,
      undefined,
      as(supervisor),
    );
    expect(options.json()).toEqual({ connectors: [{ id: connector.id, name: 'Billing' }] });
    const imported = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.broadcasts.connector, { broadcastId: campaign.id }),
      { connectorId: connector.id },
      as(supervisor),
    );
    expect(imported.statusCode, imported.body).toBe(200);
    expect(broadcastImportResponseSchema.parse(imported.json()).report).toMatchObject({
      recipients: 1,
      rejectedRows: 1,
      phoneColumn: 'hp',
    });
    // Supervisor tidak boleh melihat/ubah konektor (integrations.manage).
    expect(
      (await call(harness.app, 'GET', API_ROUTES.broadcasts.connectors, undefined, as(supervisor)))
        .statusCode,
    ).toBe(403);
  });
});

describe('alarm Telegram', () => {
  it('token terenkripsi (hanya ekor), tes kirim, alarm outbox dikirim; tanpa Telegram = dilewati', async () => {
    await harness.db.insert(alarmEvents).values({
      organizationId,
      kind: 'broadcast_completed',
      details: { campaign: 'Tanpa Telegram', recipients: 1, sent: 1 },
    });
    expect(await deliverAlarms(workerDeps())).toMatchObject({ skipped: 1, sent: 0 });

    const put = await call(
      harness.app,
      'PUT',
      API_ROUTES.alarms.telegram,
      {
        botToken: BOT_TOKEN,
        chatId: '-1001234567890',
        enabled: true,
        confirmation: await confirmationOf(admin),
      },
      as(admin),
    );
    expect(put.statusCode, put.body).toBe(200);
    expect(put.body).not.toContain('AAFakeToken');
    expect(telegramAlarmSettingsResponseSchema.parse(put.json()).telegram).toMatchObject({
      configured: true,
      tokenTail: 'ghij',
      chatId: '-1001234567890',
    });
    const test = await call(
      harness.app,
      'POST',
      API_ROUTES.alarms.telegramTest,
      undefined,
      as(admin),
    );
    expect(telegramTestResponseSchema.parse(test.json())).toMatchObject({ ok: true, code: 'ok' });
    expect(telegramRequests.at(-1)?.path).toBe(`/bot${BOT_TOKEN}/sendMessage`);

    await harness.db.insert(alarmEvents).values({
      organizationId,
      kind: 'broadcast_auto_paused',
      details: { campaign: 'Tagihan Desember', reason: 'failure_spike', failed: 12 },
    });
    expect(await deliverAlarms(workerDeps())).toMatchObject({ sent: 1 });
    const body = JSON.parse(telegramRequests.at(-1)?.body ?? '{}') as {
      text: string;
      chat_id: string;
    };
    expect(body.chat_id).toBe('-1001234567890');
    expect(body.text).toContain('Broadcast dijeda otomatis');
    expect(body.text).toContain('Tagihan Desember');
    // Token tidak pernah masuk log.
    expect(JSON.stringify(logs.lines)).not.toContain('AAFakeToken');
    expect(JSON.stringify(harness.logs.lines)).not.toContain('AAFakeToken');

    const removed = await call(
      harness.app,
      'DELETE',
      API_ROUTES.alarms.telegram,
      { confirmation: await confirmationOf(admin) },
      as(admin),
    );
    expect(telegramAlarmSettingsResponseSchema.parse(removed.json()).telegram.configured).toBe(
      false,
    );
  });
});

describe('review kontak R4 & jaring pengaman OTP', () => {
  it('kontak hanya-nomor lama tanpa pesan masuk → kontak baru "mungkin duplikat"; kontak baru → BSUID dilekatkan', async () => {
    const [old] = await harness.db
      .insert(contacts)
      .values({
        organizationId,
        channelType: 'whatsapp',
        phone: '+6281234567890',
        name: 'Pelanggan lama',
        createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      })
      .returning();
    await receive(textMessageNotification());
    const all = await harness.db.select().from(contacts);
    const fresh = all.find((row) => row.id !== old?.id);
    expect(fresh).toMatchObject({
      phone: '+6281234567890',
      waBsuid: FAKE_WEBHOOK_DEFAULTS.customerUserId,
      possibleDuplicateOfContactId: old?.id,
    });
    expect(all.find((row) => row.id === old?.id)).toMatchObject({
      phone: null,
      name: 'Pelanggan lama',
    });
    expect((await harness.db.select().from(contactEvents)).map((event) => event.kind)).toContain(
      'possible_duplicate',
    );

    const [recent] = await harness.db
      .insert(contacts)
      .values({ organizationId, channelType: 'whatsapp', phone: '+6281234567891' })
      .returning();
    await receive(
      textMessageNotification({ customer: { waId: '6281234567891', userId: 'ID.baru.0001' } }),
    );
    const [attached] = await harness.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, recent?.id ?? ''));
    expect(attached?.waBsuid).toBe('ID.baru.0001');
    expect((await harness.db.select().from(contactEvents)).map((event) => event.kind)).toContain(
      'whatsapp_identity_attached',
    );
  });

  it('nilai template sensitif (OTP) yang tertinggal > 1 jam dikosongkan job pemeliharaan', async () => {
    await receive(textMessageNotification());
    const [conversation] = await harness.db.select().from(conversations);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const [row] = await harness.db
      .insert(messages)
      .values({
        organizationId,
        conversationId: conversation?.id ?? '',
        contactId: conversation?.contactId ?? '',
        channelId,
        direction: 'outbound',
        senderKind: 'agent',
        type: 'template',
        text: 'Kode verifikasi',
        status: 'pending',
        occurredAt: old,
        createdAt: old,
        extras: {
          template: {
            templateId: newId(),
            name: 'kode_otp',
            language: 'id',
            category: 'AUTHENTICATION',
            named: false,
            headerFormat: null,
            headerVariable: null,
            headerText: null,
            headerMediaFileId: null,
            bodyVariables: ['1'],
            values: { '1': '482913' },
            buttons: [{ index: 0, type: 'URL', value: '482913' }],
            sensitive: true,
          },
        },
      })
      .returning();
    expect(await wipeStaleSensitiveTemplates(harness.db)).toBe(1);
    const [wiped] = await harness.db
      .select()
      .from(messages)
      .where(eq(messages.id, row?.id ?? ''));
    expect(JSON.stringify(wiped?.extras)).not.toContain('482913');
    expect(wiped?.extras.template?.buttons[0]?.value).toBe('');
    expect(await wipeStaleSensitiveTemplates(harness.db)).toBe(0);
  });
});
