/**
 * Bot eksternal + pesan interaktif (Fase 3) — Postgres + Redis sungguhan, Graph Meta TIRUAN, worker
 * produksi (pesan masuk, kirim, webhook keluar, batas waktu bot):
 *  - saklar bot channel + jam kerja bot → percakapan baru `bot`/`unserved`;
 *  - alur bot → balas (API key) → handoff → antrian + push → agen; saklar per percakapan;
 *  - batas waktu bot (pemeriksa maintenance);
 *  - webhook "hanya saat bot" + `conversation.handoff`;
 *  - tombol/daftar dari agen (web) & bot (API v1), validasi batas Meta, payload Meta, balasan
 *    tombol pelanggan diteruskan ke bot (native & format MobiChat).
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

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
  conversationEvents,
  conversations,
  messages,
  newId,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  WEBHOOK_ROUTES,
  apiPath,
  channelBotSettingsResponseSchema,
  conversationActionResponseSchema,
  createApiKeyResponseSchema,
  messageResponseSchema,
  type ChannelBotSettings,
} from '@balesin/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { handoffTimedOutBots } from '../../../../worker/src/queues/maintenance';
import { processSendMessageJob } from '../../../../worker/src/queues/messages';
import { processWebhookJob } from '../../../../worker/src/queues/webhooks';
import { processWebhooksOutTick } from '../../../../worker/src/queues/webhooks-out';
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
  confirmationFor,
  createIntegrationHarness,
  integrationConfig,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import ulan from '../compat-mobichat/fixtures/ulan-mobichat.json';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const TOKEN = 'EAAtokenTiruanBotEksternal0123456';
const PHONE = FAKE_WEBHOOK_DEFAULTS.phoneNumberId;
const META_IP = '173.252.127.1';
const PASSWORD = 'sandi-uji-bot-eksternal-01';

let fake: FakeMeta;
let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
let receiverOrigin = '';
const received: { path: string; body: string }[] = [];
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const logs = createLogCapture();
const hasher = createPasswordHasher();

const receiver = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    received.push({ path: request.url ?? '', body: Buffer.concat(chunks).toString() });
    response.writeHead(200).end('ok');
  });
});

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const ambilDataPesan = new Function('$input', ulan.ambilDataPesan) as (input: {
  first: () => { json: unknown };
}) => { json: Record<string, unknown> }[];

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
  const meta = createMetaGraphClient({
    version: 'v26.0',
    baseUrl: fake.url,
    sleep: () => Promise.resolve(),
  });
  for (const job of harness.messageJobs.splice(0)) {
    await processSendMessageJob(
      {
        name: MESSAGE_JOBS.send,
        data: { organizationId: job.organizationId, messageId: job.messageId },
        attemptsMade: 0,
        opts: { attempts: 5 },
      },
      { db: harness.db, logger: logs.logger, meta, secretBox: box, publisher: publisher() },
    );
  }
}

const tick = () =>
  processWebhooksOutTick({
    db: harness.db,
    logger: logs.logger,
    secretBox: box,
    appUrl: integrationConfig().appUrl,
    allowLoopback: true,
    timeoutMs: 2_000,
  });

/** Penerima bot aktif (endpoint melanggan pesan masuk) — tanpa ini percakapan langsung ke tim (R1). */
async function addBotReceiver(path = '/penerima') {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.outgoingWebhooks.list,
    {
      url: `${receiverOrigin}${path}`,
      events: ['message.received'],
      confirmation: await confirmationFor(),
    },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
}

function putBot(settings: ChannelBotSettings, signed: SignedIn = owner) {
  return call(harness.app, 'PUT', apiPath(API_ROUTES.channels.bot, { channelId }), settings, {
    cookie: signed.cookie,
    csrf: signed.csrf,
  });
}

async function createKey(scopes = ['messages:send', 'conversations:write']) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    { name: 'Bot n8n', scopes, confirmation: await confirmationFor() },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return createApiKeyResponseSchema.parse(response.json());
}

function bearer(token: string, method: 'POST' | 'GET', url: string, body?: unknown) {
  return harness.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}

async function onlyConversation() {
  const rows = await harness.db
    .select()
    .from(conversations)
    .where(eq(conversations.organizationId, organizationId))
    .orderBy(asc(conversations.createdAt));
  const last = rows.at(-1);
  if (!last) throw new Error('belum ada percakapan');
  return last;
}

async function eventsOf(conversationId: string) {
  return harness.db
    .select()
    .from(conversationEvents)
    .where(eq(conversationEvents.conversationId, conversationId))
    .orderBy(asc(conversationEvents.createdAt));
}

function setBot(signed: SignedIn, conversationId: string, active: boolean) {
  return call(
    harness.app,
    'POST',
    apiPath(API_ROUTES.inbox.bot, { conversationId }),
    { active },
    { cookie: signed.cookie, csrf: signed.csrf },
  );
}

/** Hari lokal Asia/Jakarta sekarang (0 = Minggu). */
function jakartaDay(date = new Date()): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    weekday: 'short',
  }).format(date);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

beforeAll(async () => {
  fake = await startFakeMeta();
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverOrigin = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}`;
  harness = await createIntegrationHarness({
    config: { ...integrationConfig(), metaGraphBaseUrl: fake.url },
    overrides: { webhookAllowLoopback: true },
  });
});
beforeEach(async () => {
  await harness.reset();
  fake.reset();
  received.length = 0;
  fake.tokens.set(TOKEN, { appSecret: APP_SECRET });
  fake.phoneNumbers.set(PHONE, { id: PHONE, wabaId: FAKE_WEBHOOK_DEFAULTS.wabaId });
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
    waBusinessAccountId: FAKE_WEBHOOK_DEFAULTS.wabaId,
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
  await new Promise((resolve) => receiver.close(resolve));
});

describe('Pengaturan → Channel → Bot', () => {
  it('bawaan mati; ubah = audit; validasi jam & batas waktu; menentukan status percakapan baru', async () => {
    const initial = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.channels.bot, { channelId }),
      undefined,
      {
        cookie: owner.cookie,
      },
    );
    expect(channelBotSettingsResponseSchema.parse(initial.json()).settings).toMatchObject({
      enabled: false,
      hours: { mode: 'always' },
      timeoutMinutes: null,
      timezone: 'Asia/Jakarta',
      activeNow: false,
    });
    for (const bad of [
      { enabled: true, hours: { mode: 'schedule', windows: [] }, timeoutMinutes: null },
      {
        enabled: true,
        hours: { mode: 'schedule', windows: [{ day: 1, start: '17:00', end: '08:00' }] },
        timeoutMinutes: null,
      },
      { enabled: true, hours: { mode: 'always' }, timeoutMinutes: 0 },
      { enabled: true, hours: { mode: 'always' }, timeoutMinutes: 1441 },
    ]) {
      expect((await putBot(bad as ChannelBotSettings)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    // CS tidak boleh (integrations.manage).
    const cs = await insertUser(harness.db, organizationId, {
      role: 'cs',
      email: 'cs.bot@majujaya.test',
      passwordHash: await hasher.hash(PASSWORD),
    });
    const csSession = await login(harness.app, { email: cs.email, password: PASSWORD });
    expect(
      (await putBot({ enabled: true, hours: { mode: 'always' }, timeoutMinutes: 5 }, csSession))
        .statusCode,
    ).toBe(403);

    // Jam kerja bot di luar sekarang → percakapan baru ke tim.
    const tomorrow = (jakartaDay() + 1) % 7;
    const outside = await putBot({
      enabled: true,
      hours: { mode: 'schedule', windows: [{ day: tomorrow, start: '00:00', end: '24:00' }] },
      timeoutMinutes: null,
    });
    expect(outside.statusCode, outside.body).toBe(200);
    expect(channelBotSettingsResponseSchema.parse(outside.json()).settings.activeNow).toBe(false);
    await receive(textMessageNotification({ body: 'Halo malam' }));
    expect((await onlyConversation()).status).toBe('unserved');
    await harness.db.update(conversations).set({ status: 'resolved', resolvedAt: new Date() });

    // Bot 24 jam TANPA penerima aktif → tetap ke tim (review R1: tidak diparkir di bot mati).
    await putBot({ enabled: true, hours: { mode: 'always' }, timeoutMinutes: 10 });
    await receive(textMessageNotification({ body: 'Halo tanpa bot' }));
    expect((await onlyConversation()).status).toBe('unserved');
    await harness.db.update(conversations).set({ status: 'resolved', resolvedAt: new Date() });

    // Ada penerima aktif → percakapan baru ke bot + penanda menunggu bot.
    await addBotReceiver();
    const always = await putBot({ enabled: true, hours: { mode: 'always' }, timeoutMinutes: 10 });
    expect(channelBotSettingsResponseSchema.parse(always.json()).settings).toMatchObject({
      enabled: true,
      activeNow: true,
      timeoutMinutes: 10,
    });
    await receive(textMessageNotification({ body: 'Halo bot' }));
    const conversation = await onlyConversation();
    expect(conversation.status).toBe('bot');
    expect(conversation.botAwaitingSince).not.toBeNull();
    // Pesan di percakapan bot tidak memicu push ke manusia.
    expect(harness.notificationJobs).toHaveLength(0);

    const audits = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'channel.bot_updated'));
    expect(audits).toHaveLength(3);
    expect(audits[2]?.metadata).toMatchObject({
      enabled: true,
      hoursMode: 'always',
      timeoutMinutes: 10,
    });
  });
});

describe('alur bot → handoff → agen', () => {
  it('bot membalas (API key), handoff → antrian + push + webhook; saklar per percakapan; agen mengambil alih', async () => {
    await putBot({ enabled: true, hours: { mode: 'always' }, timeoutMinutes: 5 });
    const hook = await call(
      harness.app,
      'POST',
      API_ROUTES.outgoingWebhooks.list,
      {
        url: `${receiverOrigin}/bot`,
        events: ['message.received', 'conversation.handoff'],
        botOnly: true,
        confirmation: await confirmationFor(),
      },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(hook.statusCode, hook.body).toBe(201);
    const { secret } = await createKey();

    await receive(textMessageNotification({ body: 'Internet mati' }));
    let conversation = await onlyConversation();
    expect(conversation.status).toBe('bot');
    await tick();
    expect(received.map((item) => (JSON.parse(item.body) as { event: string }).event)).toEqual([
      'message.received',
    ]);

    // Bot membalas → penanda menunggu bot hilang (batas waktu tidak berlaku).
    const reply = await bearer(
      secret,
      'POST',
      apiPath(API_ROUTES.publicApi.messages, { conversationId: conversation.id }),
      {
        type: 'text',
        text: 'Halo Kak, kami cek ya',
      },
    );
    expect(reply.statusCode, reply.body).toBe(202);
    expect((await onlyConversation()).botAwaitingSince).toBeNull();
    expect(await handoffTimedOutBots(harness.db, { now: new Date(Date.now() + 60 * 60_000) })).toBe(
      0,
    );

    // Bot menyerahkan ke tim (API v1).
    const handoff = await bearer(
      secret,
      'POST',
      apiPath(API_ROUTES.publicApi.handoff, { conversationId: conversation.id }),
    );
    expect(handoff.statusCode, handoff.body).toBe(200);
    expect(handoff.json<{ changed: boolean; conversation: { status: string } }>()).toMatchObject({
      changed: true,
      conversation: { status: 'unserved' },
    });
    expect(harness.notificationJobs).toEqual([
      expect.objectContaining({ kind: 'queued', conversationId: conversation.id }),
    ]);
    // Diulang: tidak berubah.
    const again = await bearer(
      secret,
      'POST',
      apiPath(API_ROUTES.publicApi.handoff, { conversationId: conversation.id }),
    );
    expect(again.json<{ changed: boolean }>().changed).toBe(false);

    // Setelah handoff: pesan pelanggan TIDAK dikirim ke endpoint "hanya saat bot"; handoff dikirim.
    await receive(textMessageNotification({ body: 'Halo? masih mati' }));
    await tick();
    expect(received.map((item) => (JSON.parse(item.body) as { event: string }).event)).toEqual([
      'message.received',
      'conversation.handoff',
    ]);

    // Agen mengembalikan ke bot, lalu mematikannya lagi (saklar per percakapan).
    const cs = await insertUser(harness.db, organizationId, {
      role: 'cs',
      email: 'cs.bot2@majujaya.test',
      name: 'Sari CS',
      passwordHash: await hasher.hash(PASSWORD),
    });
    const csSession = await login(harness.app, { email: cs.email, password: PASSWORD });
    const resumed = await setBot(csSession, conversation.id, true);
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(conversationActionResponseSchema.parse(resumed.json()).conversation?.status).toBe('bot');
    const stopped = await setBot(csSession, conversation.id, false);
    expect(conversationActionResponseSchema.parse(stopped.json()).conversation?.status).toBe(
      'unserved',
    );
    expect((await setBot(csSession, conversation.id, false)).statusCode).toBe(200);

    // Kembali ke bot, lalu agen mengambil alih langsung (Ambil) → served + handoff ke bot.
    await setBot(csSession, conversation.id, true);
    const claim = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.claim, { conversationId: conversation.id }),
      undefined,
      { cookie: csSession.cookie, csrf: csSession.csrf },
    );
    expect(claim.statusCode, claim.body).toBe(200);
    conversation = await onlyConversation();
    expect(conversation).toMatchObject({
      status: 'served',
      assigneeUserId: cs.id,
      botAwaitingSince: null,
    });
    // Bot tidak bisa merebut / menyelesaikan chat agen.
    expect(
      (
        await bearer(
          secret,
          'POST',
          apiPath(API_ROUTES.publicApi.handoff, { conversationId: conversation.id }),
        )
      ).json<{
        changed: boolean;
      }>().changed,
    ).toBe(false);

    const kinds = (await eventsOf(conversation.id)).map((event) => [
      event.kind,
      event.apiKeyId ? 'key' : event.actorUserId ? 'user' : 'sistem',
    ]);
    expect(kinds).toEqual([
      ['handoff', 'key'],
      ['bot_resumed', 'user'],
      ['handoff', 'user'],
      ['bot_resumed', 'user'],
      ['claimed', 'user'],
    ]);
    await tick();
    const handoffs = received.filter(
      (item) => (JSON.parse(item.body) as { event: string }).event === 'conversation.handoff',
    );
    expect(handoffs).toHaveLength(3);

    // Bot channel dimatikan → tidak bisa dikembalikan ke bot.
    await putBot({ enabled: false, hours: { mode: 'always' }, timeoutMinutes: null });
    const off = await setBot(owner, conversation.id, true);
    expect(off.statusCode).toBe(409);
  });

  it('batas waktu bot: pesan pelanggan tak dibalas N menit → antrian (sistem) + push', async () => {
    await addBotReceiver();
    await putBot({ enabled: true, hours: { mode: 'always' }, timeoutMinutes: 5 });
    await receive(textMessageNotification({ body: 'Halo' }));
    const conversation = await onlyConversation();
    const since = conversation.botAwaitingSince!;
    // Pesan berikutnya tidak menggeser waktu tunggu pertama.
    await receive(textMessageNotification({ body: 'Halo??' }));
    expect((await onlyConversation()).botAwaitingSince?.getTime()).toBe(since.getTime());

    expect(
      await handoffTimedOutBots(harness.db, { now: new Date(since.getTime() + 4 * 60_000) }),
    ).toBe(0);
    const notified: unknown[] = [];
    const moved = await handoffTimedOutBots(harness.db, {
      now: new Date(since.getTime() + 5 * 60_000 + 1_000),
      notifications: {
        enqueue: (jobs) => {
          notified.push(...jobs);
          return Promise.resolve();
        },
      },
    });
    expect(moved).toBe(1);
    expect(await onlyConversation()).toMatchObject({ status: 'unserved', botAwaitingSince: null });
    expect(await eventsOf(conversation.id)).toEqual([
      expect.objectContaining({ kind: 'handoff', actorUserId: null, apiKeyId: null }),
    ]);
    expect(notified).toEqual([
      expect.objectContaining({ kind: 'queued', conversationId: conversation.id }),
    ]);
    // Bot aktif tanpa batas waktu tidak mungkin (review R1): `null` → bawaan 15 menit.
    const defaulted = await putBot({
      enabled: true,
      hours: { mode: 'always' },
      timeoutMinutes: null,
    });
    expect(channelBotSettingsResponseSchema.parse(defaulted.json()).settings.timeoutMinutes).toBe(
      15,
    );
    // Bot dimatikan → percakapan yang dipegang bot diserahkan ke antrian (handoff oleh pengguna).
    await harness.db.update(conversations).set({ status: 'resolved', resolvedAt: new Date() });
    await receive(textMessageNotification({ body: 'Halo lagi' }));
    const parked = await onlyConversation();
    expect(parked.status).toBe('bot');
    harness.notificationJobs.length = 0;
    await putBot({ enabled: false, hours: { mode: 'always' }, timeoutMinutes: null });
    expect(await onlyConversation()).toMatchObject({ status: 'unserved', botAwaitingSince: null });
    expect(await eventsOf(parked.id)).toEqual([
      expect.objectContaining({ kind: 'handoff', actorUserId: owner.session.user.id }),
    ]);
    expect(harness.notificationJobs).toEqual([
      expect.objectContaining({ kind: 'queued', conversationId: parked.id }),
    ]);
  });
});

describe('pesan interaktif', () => {
  it('agen kirim tombol (web) & bot kirim daftar (API v1): batas Meta, payload Meta, tampil di riwayat', async () => {
    await receive(textMessageNotification({ body: 'Mau tanya paket' }));
    const conversation = await onlyConversation();
    const send = (interactive: unknown) =>
      call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.inbox.messages, { conversationId: conversation.id }),
        { type: 'interactive', clientMessageId: randomUUID(), interactive },
        { cookie: owner.cookie, csrf: owner.csrf },
      );
    for (const bad of [
      { kind: 'button', body: 'Pilih', buttons: [] },
      {
        kind: 'button',
        body: 'Pilih',
        buttons: ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id })),
      },
      { kind: 'button', body: 'Pilih', buttons: [{ id: 'a', title: 'x'.repeat(21) }] },
      {
        kind: 'button',
        body: 'Pilih',
        buttons: [
          { id: 'a', title: 'Ya' },
          { id: 'a', title: 'Tidak' },
        ],
      },
      { kind: 'button', body: 'x'.repeat(1025), buttons: [{ id: 'a', title: 'Ya' }] },
      {
        kind: 'list',
        body: 'Pilih',
        buttonText: 'Pilih',
        sections: [
          {
            rows: Array.from({ length: 11 }, (_, i) => ({
              id: `r${String(i)}`,
              title: `P${String(i)}`,
            })),
          },
        ],
      },
      {
        kind: 'list',
        body: 'Pilih',
        buttonText: 'Pilih',
        sections: [{ rows: [{ id: 'a', title: 'A' }] }, { rows: [{ id: 'b', title: 'B' }] }],
      },
      {
        kind: 'list',
        body: 'Pilih',
        buttonText: 'Pilih',
        sections: [{ rows: [{ id: 'a', title: 'A', description: 'x'.repeat(73) }] }],
      },
    ]) {
      expect((await send(bad)).statusCode, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    const sent = await send({
      kind: 'button',
      header: 'Konfirmasi',
      body: 'Sudah bayar tagihan bulan ini?',
      footer: 'Sky Tech',
      buttons: [
        { id: 'SUDAH', title: 'Sudah' },
        { id: 'BELUM', title: 'Belum' },
      ],
    });
    expect(sent.statusCode, sent.body).toBe(202);
    const { message } = messageResponseSchema.parse(sent.json());
    expect(message).toMatchObject({
      type: 'interactive',
      text: 'Sudah bayar tagihan bulan ini?',
      interactiveMessage: {
        kind: 'button',
        buttons: [
          { id: 'SUDAH', title: 'Sudah' },
          { id: 'BELUM', title: 'Belum' },
        ],
      },
    });

    const { secret } = await createKey(['messages:send']);
    const list = await bearer(
      secret,
      'POST',
      apiPath(API_ROUTES.publicApi.messages, { conversationId: conversation.id }),
      {
        type: 'interactive',
        interactive: {
          kind: 'list',
          body: 'Pilih paket internet',
          buttonText: 'Lihat paket',
          sections: [
            { title: 'Rumah', rows: [{ id: 'p10', title: '10 Mbps', description: 'Rp150.000' }] },
            { title: 'Bisnis', rows: [{ id: 'b50', title: '50 Mbps' }] },
          ],
        },
      },
    );
    expect(list.statusCode, list.body).toBe(202);
    await drainSends();
    const bodies = fake.sentMessages.map((item) => item.body);
    expect(bodies[0]).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: 'Konfirmasi' },
        body: { text: 'Sudah bayar tagihan bulan ini?' },
        footer: { text: 'Sky Tech' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'SUDAH', title: 'Sudah' } },
            { type: 'reply', reply: { id: 'BELUM', title: 'Belum' } },
          ],
        },
      },
    });
    expect(bodies[1]).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'list',
        action: {
          button: 'Lihat paket',
          sections: [
            { title: 'Rumah', rows: [{ id: 'p10', title: '10 Mbps', description: 'Rp150.000' }] },
            { title: 'Bisnis', rows: [{ id: 'b50', title: '50 Mbps' }] },
          ],
        },
      },
    });
    const statuses = await harness.db
      .select({ wamid: messages.wamid })
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.type, 'interactive')));
    // Diterima Meta (wamid tersimpan; status `sent` menyusul lewat webhook status).
    expect(statuses).toHaveLength(2);
    expect(statuses.every((row) => row.wamid !== null)).toBe(true);

    // Di luar jendela 24 jam → 409 (pesan sesi, bukan template).
    await harness.db
      .update(conversations)
      .set({
        lastInboundAt: new Date(Date.now() - 30 * 3600_000),
        windowExpiresAt: new Date(Date.now() - 6 * 3600_000),
      })
      .where(eq(conversations.id, conversation.id));
    expect(
      (await send({ kind: 'button', body: 'Halo', buttons: [{ id: 'a', title: 'A' }] })).statusCode,
    ).toBe(409);
  });

  it('balasan tombol/daftar pelanggan diteruskan ke bot (native: id+judul; MobiChat: dibaca node ULAN)', async () => {
    const { secret } = await createKey(['messages:send', 'conversations:write', 'contacts:write']);
    for (const body of [
      { url: `${receiverOrigin}/native`, events: ['message.received'] },
      {
        url: `${receiverOrigin}/mobichat`,
        events: ['message.received'],
        format: 'mobichat',
        mobichat: { apiKey: secret },
      },
    ]) {
      const response = await call(
        harness.app,
        'POST',
        API_ROUTES.outgoingWebhooks.list,
        { ...body, confirmation: await confirmationFor() },
        { cookie: owner.cookie, csrf: owner.csrf },
      );
      expect(response.statusCode, response.body).toBe(201);
    }
    await receive(
      interactiveReplyNotification({
        reply: 'list_reply',
        id: 'p10',
        title: '10 Mbps',
        description: 'Rp150.000',
      }),
    );
    await tick();
    const native = JSON.parse(received.find((item) => item.path === '/native')!.body) as {
      data: { message: { interactive: unknown } };
    };
    expect(native.data.message.interactive).toEqual({
      type: 'list_reply',
      id: 'p10',
      title: '10 Mbps',
      description: 'Rp150.000',
    });
    const mobichat = JSON.parse(received.find((item) => item.path === '/mobichat')!.body) as Record<
      string,
      unknown
    >;
    expect(mobichat).toMatchObject({
      message_text: '10 Mbps',
      reply_id: 'p10',
      interactive_reply: { type: 'list_reply', id: 'p10', title: '10 Mbps' },
    });
    const [read] = ambilDataPesan({ first: () => ({ json: { body: mobichat } }) });
    expect(read?.json).toMatchObject({ lanjut: true, text: '10 Mbps' });
  });
});
