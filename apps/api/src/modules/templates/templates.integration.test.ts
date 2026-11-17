/**
 * Template Meta (Fase 4) — Postgres + Redis sungguhan, Graph Meta TIRUAN, worker produksi:
 * preset → draf → ajukan (validasi lokal + galat Meta → Indonesia) → status dari webhook; sinkron
 * (manual berhalaman + berkala); ubah/hapus; kirim template di luar jendela 24 jam (variabel, payload
 * Meta, kategori tercatat); mulai percakapan ke nomor baru (`inbox.initiate`, API v1
 * `messages:initiate`).
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
  contacts,
  conversations,
  messageTemplates,
  messages,
  newId,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  WEBHOOK_ROUTES,
  apiPath,
  createApiKeyResponseSchema,
  errorEnvelopeSchema,
  messageResponseSchema,
  syncTemplatesResponseSchema,
  templateListResponseSchema,
  templatePresetListResponseSchema,
  templateResponseSchema,
  type MessageTemplate,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { syncAllTemplates } from '../../../../worker/src/queues/maintenance';
import { processSendMessageJob } from '../../../../worker/src/queues/messages';
import { processWebhookJob } from '../../../../worker/src/queues/webhooks';
import { createPasswordHasher } from '../auth/password-hasher';
import {
  FAKE_WEBHOOK_DEFAULTS,
  signedWebhook,
  startFakeMeta,
  templateStatusNotification,
  textMessageNotification,
  type FakeMeta,
} from '../../testing/fake-meta';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  confirmationFor,
  createIntegrationHarness,
  integrationConfig,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const TOKEN = 'EAAtokenTiruanTemplateMeta0123456';
const PHONE = FAKE_WEBHOOK_DEFAULTS.phoneNumberId;
const WABA = FAKE_WEBHOOK_DEFAULTS.wabaId;
const META_IP = '173.252.127.1';
const PASSWORD = 'sandi-uji-template-meta-01';

let fake: FakeMeta;
let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const logs = createLogCapture();
const hasher = createPasswordHasher();

const metaClient = () =>
  createMetaGraphClient({ version: 'v26.0', baseUrl: fake.url, sleep: () => Promise.resolve() });

function publisher() {
  return createInboxEventPublisher(harness.redis, {
    prefix: harness.redisPrefix,
    logger: logs.logger,
  });
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

async function drainSends() {
  for (const job of harness.messageJobs.splice(0)) {
    await processSendMessageJob(
      {
        name: MESSAGE_JOBS.send,
        data: { organizationId: job.organizationId, messageId: job.messageId },
        attemptsMade: 0,
        opts: { attempts: 5 },
      },
      {
        db: harness.db,
        logger: logs.logger,
        meta: metaClient(),
        secretBox: box,
        publisher: publisher(),
      },
    );
  }
}

const as = (signed: SignedIn) => ({ cookie: signed.cookie, csrf: signed.csrf });

async function fromPreset(key: string, name?: string): Promise<MessageTemplate> {
  const response = await call(
    harness.app,
    'POST',
    apiPath(API_ROUTES.templates.fromPreset, { presetId: key }),
    { channelId, ...(name ? { name } : {}) },
    as(owner),
  );
  expect(response.statusCode, response.body).toBe(201);
  return templateResponseSchema.parse(response.json()).template;
}

async function submit(id: string) {
  return call(
    harness.app,
    'POST',
    apiPath(API_ROUTES.templates.submit, { templateId: id }),
    undefined,
    as(owner),
  );
}

/** Template DISETUJUI siap kirim (preset → ajukan → webhook APPROVED). */
async function approvedTemplate(key = 'isp_tagihan_jatuh_tempo'): Promise<MessageTemplate> {
  const draft = await fromPreset(key);
  const submitted = templateResponseSchema.parse((await submit(draft.id)).json()).template;
  await receive(
    templateStatusNotification({
      wabaId: WABA,
      event: 'APPROVED',
      id: submitted.metaTemplateId!,
      name: submitted.name,
    }),
  );
  const [row] = await harness.db
    .select()
    .from(messageTemplates)
    .where(eq(messageTemplates.id, draft.id));
  expect(row?.status).toBe('APPROVED');
  return { ...submitted, status: 'APPROVED' };
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
    waAccessTokenTail: '3456',
    waAppSecretEncrypted: sealChannelSecret(box, target, 'appSecret', APP_SECRET),
    waAppSecretTail: 'cdef',
    waVerifyTokenEncrypted: sealChannelSecret(box, target, 'verifyToken', 'verify-token-01234'),
    waVerifyTokenRotatedAt: new Date(),
  });
});
afterAll(async () => {
  await harness?.close();
  await fake?.close();
});

describe('preset → draf → ajukan → status Meta', () => {
  it('preset ISP generik; ajukan = komponen Meta sesuai; webhook mengubah status; audit tanpa isi', async () => {
    const presets = templatePresetListResponseSchema.parse(
      (await call(harness.app, 'GET', API_ROUTES.templates.presets, undefined, as(owner))).json(),
    ).presets;
    expect(presets.map((preset) => preset.key)).toContain('isp_layanan_diisolir');

    const draft = await fromPreset('isp_tagihan_jatuh_tempo');
    expect(draft).toMatchObject({
      status: 'DRAFT',
      source: 'preset',
      name: 'tagihan_jatuh_tempo',
      metaTemplateId: null,
    });
    const duplicate = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.templates.fromPreset, { presetId: 'isp_tagihan_jatuh_tempo' }),
      { channelId },
      as(owner),
    );
    expect(duplicate.statusCode).toBe(409);

    const submitted = await submit(draft.id);
    expect(submitted.statusCode, submitted.body).toBe(200);
    const template = templateResponseSchema.parse(submitted.json()).template;
    expect(template).toMatchObject({ status: 'PENDING', localChanges: false });
    expect(template.metaTemplateId).toMatch(/^\d+$/);
    const sent = fake.requests.find(
      (request) => request.method === 'POST' && request.path === `/${WABA}/message_templates`,
    );
    expect(sent?.body).toMatchObject({
      name: 'tagihan_jatuh_tempo',
      language: 'id',
      category: 'UTILITY',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Pengingat Tagihan Internet' },
        {
          type: 'BODY',
          example: { body_text: [['Budi', 'November 2026', 'Rp150.000', '20 November 2026']] },
        },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'QUICK_REPLY', text: 'Sudah bayar' },
            { type: 'QUICK_REPLY', text: 'Butuh bantuan' },
          ],
        },
      ],
    });

    await receive(
      templateStatusNotification({
        wabaId: WABA,
        event: 'REJECTED',
        reason: 'INVALID_FORMAT',
        id: template.metaTemplateId!,
        name: template.name,
      }),
    );
    const rejected = templateResponseSchema.parse(
      (
        await call(
          harness.app,
          'GET',
          apiPath(API_ROUTES.templates.template, { templateId: draft.id }),
          undefined,
          as(owner),
        )
      ).json(),
    ).template;
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectedReason: 'INVALID_FORMAT' });

    const audits = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetType, 'template'));
    expect(audits.map((row) => row.action).sort()).toEqual([
      'template.created',
      'template.submitted',
    ]);
    expect(JSON.stringify(audits)).not.toContain('Pengingat Tagihan');
  });

  it('validasi lokal sebelum Meta; galat Meta (nama sudah ada) → pesan Indonesia', async () => {
    const created = await call(
      harness.app,
      'POST',
      API_ROUTES.templates.list,
      {
        channelId,
        name: 'info_tanpa_contoh',
        category: 'UTILITY',
        content: { body: { text: 'Halo {{1}}, tagihan Anda sudah terbit.' } },
      },
      as(owner),
    );
    expect(created.statusCode, created.body).toBe(201);
    const id = templateResponseSchema.parse(created.json()).template.id;
    const invalid = await submit(id);
    expect(invalid.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(invalid.json()).error.details?.[0]?.field).toBe(
      'body.examples.1',
    );
    expect(fake.requests.filter((request) => request.method === 'POST')).toHaveLength(0);

    // Sudah ada di Meta (dibuat di luar Balesin, belum disinkron) → Meta menolak dengan subkode.
    fake.templates.set('5550001', {
      id: '5550001',
      wabaId: WABA,
      name: 'pembayaran_diterima',
      language: 'id',
      category: 'UTILITY',
      status: 'APPROVED',
      components: [],
    });
    const draft = await fromPreset('isp_pembayaran_diterima');
    const rejected = await submit(draft.id);
    expect(rejected.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(rejected.json()).error.message).toContain('sudah ada');
    expect(rejected.body).not.toContain('Invalid parameter');
  });

  it('ubah template disetujui → ajukan ulang (edit di Meta); hapus → dihapus di Meta & lokal', async () => {
    const approved = await approvedTemplate('isp_gangguan_pulih');
    const renamed = await call(
      harness.app,
      'PATCH',
      apiPath(API_ROUTES.templates.template, { templateId: approved.id }),
      { name: 'nama_lain' },
      as(owner),
    );
    expect(renamed.statusCode).toBe(409);
    const edited = await call(
      harness.app,
      'PATCH',
      apiPath(API_ROUTES.templates.template, { templateId: approved.id }),
      { content: { ...approved.content, footer: { text: 'Terima kasih.' } } },
      as(owner),
    );
    expect(templateResponseSchema.parse(edited.json()).template).toMatchObject({
      localChanges: true,
      status: 'APPROVED',
    });
    const resubmitted = await submit(approved.id);
    expect(resubmitted.statusCode, resubmitted.body).toBe(200);
    expect(
      fake.requests.some(
        (request) => request.method === 'POST' && request.path === `/${approved.metaTemplateId!}`,
      ),
    ).toBe(true);
    expect(fake.templates.get(approved.metaTemplateId!)?.components).toContainEqual({
      type: 'FOOTER',
      text: 'Terima kasih.',
    });

    const removed = await call(
      harness.app,
      'DELETE',
      apiPath(API_ROUTES.templates.template, { templateId: approved.id }),
      undefined,
      as(owner),
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect(fake.templates.has(approved.metaTemplateId!)).toBe(false);
    expect(
      await harness.db.select().from(messageTemplates).where(eq(messageTemplates.id, approved.id)),
    ).toEqual([]);
  });
});

describe('sinkron', () => {
  it('manual berhalaman + berkala: dibuat/diperbarui/dihapus; bernama & judul media dikenali', async () => {
    for (let index = 0; index < 120; index += 1) {
      const id = String(8_000_000 + index);
      fake.templates.set(id, {
        id,
        wabaId: WABA,
        name: `promo_${String(index)}`,
        language: 'id',
        category: 'MARKETING',
        status: 'APPROVED',
        components: [{ type: 'BODY', text: 'Promo spesial bulan ini.' }],
      });
    }
    fake.templates.set('9000001', {
      id: '9000001',
      wabaId: WABA,
      name: 'sapa_pelanggan',
      language: 'en_US',
      category: 'UTILITY',
      status: 'APPROVED',
      parameter_format: 'NAMED',
      quality_score: { score: 'GREEN' },
      components: [
        { type: 'HEADER', format: 'IMAGE' },
        {
          type: 'BODY',
          text: 'Hi {{name}}, your bill is ready.',
          example: { body_text_named_params: [{ param_name: 'name', example: 'Budi' }] },
        },
      ],
    });
    const response = await call(harness.app, 'POST', API_ROUTES.templates.sync, {}, as(owner));
    expect(response.statusCode, response.body).toBe(200);
    expect(syncTemplatesResponseSchema.parse(response.json()).channels).toEqual([
      { channelId, ok: true, error: null, created: 121, updated: 0, removed: 0 },
    ]);
    const listed = templateListResponseSchema.parse(
      (
        await call(harness.app, 'GET', `${API_ROUTES.templates.list}?q=sapa`, undefined, as(owner))
      ).json(),
    ).templates;
    expect(listed).toEqual([
      expect.objectContaining({
        name: 'sapa_pelanggan',
        status: 'APPROVED',
        source: 'meta',
        qualityScore: 'GREEN',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- pencocok vitest
        content: expect.objectContaining({
          parameterFormat: 'named',
          header: { format: 'IMAGE' },
          body: { text: 'Hi {{name}}, your bill is ready.', examples: { name: 'Budi' } },
        }),
      }),
    ]);
    // Berkala (worker): yang hilang dari Meta → DELETED; status berubah ikut.
    fake.templates.delete('8000000');
    fake.templates.get('8000001')!.status = 'PAUSED';
    expect(
      await syncAllTemplates(
        { db: harness.db, logger: logs.logger, meta: metaClient(), secretBox: box },
        new Date(),
      ),
    ).toEqual({
      channels: 1,
      failed: 0,
    });
    const rows = await harness.db
      .select()
      .from(messageTemplates)
      .where(eq(messageTemplates.organizationId, organizationId));
    expect(rows.find((row) => row.name === 'promo_0')?.status).toBe('DELETED');
    expect(rows.find((row) => row.name === 'promo_1')?.status).toBe('PAUSED');
  });
});

describe('kirim template', () => {
  it('di luar jendela 24 jam: variabel wajib, payload Meta, kategori tercatat; belum disetujui/WABA lain → 409', async () => {
    const approved = await approvedTemplate();
    await receive(textMessageNotification({ body: 'Halo' }));
    const [conversation] = await harness.db.select().from(conversations);
    await harness.db
      .update(conversations)
      .set({
        lastInboundAt: new Date(Date.now() - 30 * 3600_000),
        windowExpiresAt: new Date(Date.now() - 6 * 3600_000),
      })
      .where(eq(conversations.id, conversation!.id));
    const send = (body: Record<string, unknown>) =>
      call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.inbox.messages, { conversationId: conversation!.id }),
        { clientMessageId: randomUUID(), ...body },
        as(owner),
      );
    // Teks biasa tetap ditolak di luar jendela.
    expect((await send({ type: 'text', text: 'Halo' })).statusCode).toBe(409);
    const missing = await send({
      type: 'template',
      templateId: approved.id,
      parameters: { body: { '1': 'Budi' } },
    });
    expect(missing.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(missing.json()).error.details?.[0]?.field).toBe(
      'parameters.body.2',
    );
    const newline = await send({
      type: 'template',
      templateId: approved.id,
      parameters: { body: { '1': 'Budi\nX', '2': 'Nov', '3': 'Rp1', '4': 'besok' } },
    });
    expect(newline.statusCode).toBe(400);

    const ok = await send({
      type: 'template',
      templateId: approved.id,
      parameters: {
        body: { '1': 'Budi', '2': 'November 2026', '3': 'Rp150.000', '4': '20 November 2026' },
      },
    });
    expect(ok.statusCode, ok.body).toBe(202);
    const { message } = messageResponseSchema.parse(ok.json());
    expect(message).toMatchObject({
      type: 'template',
      text: 'Halo Budi, tagihan internet periode November 2026 sebesar Rp150.000 jatuh tempo pada 20 November 2026. Mohon lakukan pembayaran sebelum jatuh tempo agar layanan tetap aktif. Abaikan pesan ini bila sudah membayar.',
      template: {
        templateId: approved.id,
        name: 'tagihan_jatuh_tempo',
        language: 'id',
        category: 'UTILITY',
      },
    });
    await drainSends();
    expect(fake.sentMessages.at(-1)?.body).toMatchObject({
      type: 'template',
      template: {
        name: 'tagihan_jatuh_tempo',
        language: { code: 'id' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Budi' },
              { type: 'text', text: 'November 2026' },
              { type: 'text', text: 'Rp150.000' },
              { type: 'text', text: '20 November 2026' },
            ],
          },
        ],
      },
    });
    const [stored] = await harness.db.select().from(messages).where(eq(messages.id, message.id));
    expect(stored).toMatchObject({ templateId: approved.id, templateCategory: 'UTILITY' });
    expect(stored?.wamid).not.toBeNull();

    // Draf (belum disetujui) → 409.
    const draft = await fromPreset('isp_pelanggan_baru');
    expect(
      (
        await send({
          type: 'template',
          templateId: draft.id,
          parameters: { body: { '1': 'a', '2': 'b' } },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('mulai percakapan ke nomor baru: inbox.initiate (CS 403), percakapan dipegang pemula, idempoten', async () => {
    const approved = await approvedTemplate('isp_pelanggan_baru');
    const body = {
      channelId,
      phone: '0812-3456-7000',
      clientMessageId: randomUUID(),
      templateId: approved.id,
      parameters: { body: { '1': 'Sari', '2': '100777' } },
    };
    const cs = await insertUser(harness.db, organizationId, {
      role: 'cs',
      email: 'cs.template@majujaya.test',
      passwordHash: await hasher.hash(PASSWORD),
    });
    const csSession = await login(harness.app, { email: cs.email, password: PASSWORD });
    expect(
      (await call(harness.app, 'POST', API_ROUTES.inbox.start, body, as(csSession))).statusCode,
    ).toBe(403);

    const started = await call(harness.app, 'POST', API_ROUTES.inbox.start, body, as(owner));
    expect(started.statusCode, started.body).toBe(202);
    const { conversationId } = started.json<{ conversationId: string }>();
    const again = await call(harness.app, 'POST', API_ROUTES.inbox.start, body, as(owner));
    expect(again.statusCode).toBe(200);
    expect(again.json<{ conversationId: string }>().conversationId).toBe(conversationId);
    const [contact] = await harness.db
      .select()
      .from(contacts)
      .where(eq(contacts.phone, '+6281234567000'));
    expect(contact).toBeDefined();
    const [conversation] = await harness.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conversation).toMatchObject({
      status: 'served',
      assigneeUserId: owner.session.user.id,
      contactId: contact!.id,
    });
    await drainSends();
    expect(fake.sentMessages.at(-1)?.body).toMatchObject({ to: '6281234567000', type: 'template' });
    expect(
      (
        await call(
          harness.app,
          'POST',
          API_ROUTES.inbox.start,
          { ...body, clientMessageId: randomUUID(), phone: '12' },
          as(owner),
        )
      ).statusCode,
    ).toBe(400);
  });

  it('API v1 messages:initiate: kirim berdasarkan nama; percakapan sistem (selesai) tanpa antrian; scope wajib', async () => {
    await approvedTemplate('isp_layanan_aktif_kembali');
    const createKey = async (scopes: string[]) => {
      const response = await call(
        harness.app,
        'POST',
        API_ROUTES.apiKeys.list,
        { name: 'Billing', scopes, confirmation: await confirmationFor() },
        as(owner),
      );
      return createApiKeyResponseSchema.parse(response.json()).secret;
    };
    const send = (token: string, idempotencyKey?: string) =>
      harness.app.inject({
        method: 'POST',
        url: API_ROUTES.publicApi.templateMessage,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        payload: JSON.stringify({
          channelId,
          phone: '6281299990000',
          name: 'layanan_aktif_kembali',
          parameters: { body: { '1': 'Budi', '2': '100123' } },
        }),
      });
    expect((await send(await createKey(['messages:send']))).statusCode).toBe(403);
    const token = await createKey(['messages:initiate']);
    const first = await send(token, 'aktif-100123-202611');
    expect(first.statusCode, first.body).toBe(202);
    const second = await send(token, 'aktif-100123-202611');
    expect(second.statusCode).toBe(200);
    const { conversationId } = first.json<{ conversationId: string }>();
    const [conversation] = await harness.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(conversation?.status).toBe('resolved');
    expect(
      await harness.db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.type, 'template'))),
    ).toHaveLength(1);
  });
});
