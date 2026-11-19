/**
 * Bot eksternal di SEMUA jenis channel (DECISIONS 2026-11-19 "Bot per channel generik") — Postgres +
 * Redis sungguhan, worker produksi (pesan masuk, webhook keluar, batas waktu bot):
 *  - pengaturan bot channel Telegram/Email/Messenger/Instagram: izin, CSRF, audit (+ `channelType`),
 *    `channelType` & `receiverReady` di jawaban;
 *  - percakapan baru → `bot` hanya bila bot aktif + ada penerima native; event keluar memuat jenis
 *    channel; balasan bot lewat API publik tercatat di channel percakapan; jendela 24 jam hanya
 *    Messenger/Instagram; handoff (API v1), batas waktu, dan saklar mati melepas ke antrian;
 *  - format MobiChat = WhatsApp saja: bukan penerima untuk channel lain, tidak menerima pesannya.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createSecretBox, Secret, WEBHOOK_JOBS } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import {
  auditLogs,
  channels,
  conversationEvents,
  conversations,
  messages,
  newId,
  webhookEvents,
  type NewChannel,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  MOBICHAT_ROUTES,
  apiPath,
  channelBotSettingsResponseSchema,
  createApiKeyResponseSchema,
  securitySummaryResponseSchema,
  type ChannelBotSettings,
  type ChannelType,
} from '@balesin/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { handoffTimedOutBots } from '../../../../worker/src/queues/maintenance';
import { processWebhookJob } from '../../../../worker/src/queues/webhooks';
import { processWebhooksOutTick } from '../../../../worker/src/queues/webhooks-out';
import { createPasswordHasher } from '../auth/password-hasher';
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

type OtherChannel = Exclude<ChannelType, 'whatsapp'>;
const OTHER_TYPES: readonly OtherChannel[] = ['telegram', 'email', 'messenger', 'instagram'];
const PASSWORD = 'sandi-uji-bot-channel-lain-01';

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let receiverOrigin = '';
const received: { path: string; body: string }[] = [];
const logs = createLogCapture();
const hasher = createPasswordHasher();
const box = createSecretBox(new Secret(TEST_MASTER_KEY));

const receiver = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    received.push({ path: request.url ?? '', body: Buffer.concat(chunks).toString() });
    response.writeHead(200).end('ok');
  });
});

/** Kolom wajib per jenis channel (constraint `channels_*_live_complete`); rahasia tiruan. */
function channelValues(type: ChannelType, id: string): NewChannel {
  const base = { id, organizationId, type, name: `CS ${type}` };
  switch (type) {
    case 'whatsapp':
      return {
        ...base,
        waPhoneNumberId: '106540352242922',
        waBusinessAccountId: '102290129340398',
        waAccessTokenEncrypted: 'x',
        waAppSecretEncrypted: 'x',
        waVerifyTokenEncrypted: 'x',
        waVerifyTokenRotatedAt: new Date(),
      };
    case 'telegram':
      return {
        ...base,
        tgBotId: '123456789',
        tgBotUsername: 'majujaya_bot',
        tgBotTokenEncrypted: 'x',
        tgWebhookSecretEncrypted: 'x',
      };
    case 'email':
      return {
        ...base,
        emailAddress: 'cs@majujaya.test',
        emailFromName: 'CS Maju Jaya',
        emailImapHost: 'imap.majujaya.test',
        emailImapPort: 993,
        emailImapSecurity: 'ssl',
        emailImapUsername: 'cs',
        emailImapPasswordEncrypted: 'x',
        emailImapFolder: 'INBOX',
        emailPollIntervalMinutes: 5,
        emailMarkAsRead: false,
        emailSmtpMode: 'system',
      };
    case 'messenger':
    case 'instagram':
      return {
        ...base,
        metaPageId: '1122334455',
        ...(type === 'instagram' ? { metaIgAccountId: '9988776655' } : {}),
        metaPageTokenEncrypted: 'x',
        metaAppSecretEncrypted: 'x',
        metaVerifyTokenEncrypted: 'x',
        metaVerifyTokenRotatedAt: new Date(),
      };
  }
}

async function addChannel(type: ChannelType): Promise<string> {
  const id = newId();
  await harness.db.insert(channels).values(channelValues(type, id));
  return id;
}

/** Pengirim tiruan per jenis channel (ID Telegram, alamat email, PSID/IGSID). */
const SENDERS: Record<OtherChannel, { externalUserId: string; handle: string | null }> = {
  telegram: { externalUserId: '987654321', handle: '@budi_pelanggan' },
  email: { externalUserId: 'budi@pelanggan.test', handle: 'budi@pelanggan.test' },
  messenger: { externalUserId: '7001002003004005', handle: null },
  instagram: { externalUserId: '8001002003004005', handle: null },
};

let sequence = 0;

/** Pesan masuk netral (bentuk yang disimpan penerima/pengambil kotak masuk) → worker produksi. */
async function receive(
  type: OtherChannel,
  channelId: string,
  text: string,
  senderVerification: 'pass' | 'fail' | 'unverified' = 'pass',
) {
  sequence += 1;
  const externalId = `${type}-masuk-${String(sequence)}`;
  const [event] = await harness.db
    .insert(webhookEvents)
    .values({
      organizationId,
      channelId,
      source: type,
      kind: 'message',
      field: type,
      dedupKey: `m:${externalId}`,
      externalId,
      payload: {
        kind: 'message',
        externalId,
        sentAt: new Date().toISOString(),
        sender: { ...SENDERS[type], displayName: 'Budi Pelanggan' },
        type: 'text',
        rawType: 'text',
        text,
        media: null,
        location: null,
        replyToExternalId: null,
        reply: null,
        email:
          type === 'email'
            ? {
                subject: 'Internet mati',
                inReplyTo: null,
                references: [],
                authWarning: false,
                senderVerification,
                skippedAttachments: 0,
                html: null,
                attachments: [],
              }
            : null,
      },
    })
    .returning({ id: webhookEvents.id });
  const result = await processWebhookJob(
    {
      name: WEBHOOK_JOBS.whatsappEvent,
      data: { organizationId, eventId: event!.id },
      attemptsMade: 0,
      opts: { attempts: 8 },
    },
    { db: harness.db, logger: logs.logger },
  );
  expect(result.status, JSON.stringify(result)).toBe('processed');
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

function botUrl(channelId: string) {
  return apiPath(API_ROUTES.channels.bot, { channelId });
}

async function getBot(channelId: string) {
  const response = await call(harness.app, 'GET', botUrl(channelId), undefined, {
    cookie: owner.cookie,
  });
  expect(response.statusCode, response.body).toBe(200);
  return channelBotSettingsResponseSchema.parse(response.json()).settings;
}

function putBot(channelId: string, settings: ChannelBotSettings, signed: SignedIn = owner) {
  return call(harness.app, 'PUT', botUrl(channelId), settings, {
    cookie: signed.cookie,
    csrf: signed.csrf,
  });
}

async function createKey() {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    {
      name: 'Bot n8n',
      scopes: ['messages:send', 'conversations:write'],
      confirmation: await confirmationFor(),
    },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return createApiKeyResponseSchema.parse(response.json());
}

async function addWebhook(body: Record<string, unknown>) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.outgoingWebhooks.list,
    { url: `${receiverOrigin}/bot`, confirmation: await confirmationFor(), ...body },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
}

function bearer(token: string, url: string, body?: unknown) {
  return harness.app.inject({
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}

async function latestConversation(channelId: string) {
  const rows = await harness.db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.organizationId, organizationId), eq(conversations.channelId, channelId)),
    )
    .orderBy(asc(conversations.createdAt));
  const last = rows.at(-1);
  if (!last) throw new Error('belum ada percakapan');
  return last;
}

const resolveAll = () =>
  harness.db
    .update(conversations)
    .set({ status: 'resolved', resolvedAt: new Date(), botAwaitingSince: null });

const bodies = () =>
  received.map(
    (item) =>
      JSON.parse(item.body) as {
        event: string;
        data: {
          conversation?: { channel_id: string; channel_type: string; channel: unknown };
          contact?: { channel_type: string; channel_handle: string | null };
        };
      },
  );

beforeAll(async () => {
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverOrigin = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}`;
  harness = await createIntegrationHarness({
    config: integrationConfig(),
    overrides: { webhookAllowLoopback: true },
  });
});
beforeEach(async () => {
  await harness.reset();
  received.length = 0;
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
});
afterAll(async () => {
  await harness?.close();
  await new Promise((resolve) => receiver.close(resolve));
});

describe.each(OTHER_TYPES)('bot di channel %s', (type) => {
  it('pengaturan: izin, CSRF, audit; penerima native → bot; event memuat jenis channel; balas, handoff', async () => {
    const channelId = await addChannel(type);
    const on: ChannelBotSettings = { enabled: true, hours: { mode: 'always' }, timeoutMinutes: 10 };

    expect(await getBot(channelId)).toMatchObject({
      enabled: false,
      channelType: type,
      activeNow: false,
      receiverReady: false,
    });

    // Izin `integrations.manage`: CS & Supervisor ditolak (GET dan PUT); tanpa CSRF ditolak.
    for (const role of ['cs', 'supervisor'] as const) {
      const user = await insertUser(harness.db, organizationId, {
        role,
        email: `${role}.${type}@majujaya.test`,
        passwordHash: await hasher.hash(PASSWORD),
      });
      const session = await login(harness.app, { email: user.email, password: PASSWORD });
      const as = { cookie: session.cookie, csrf: session.csrf };
      expect((await call(harness.app, 'GET', botUrl(channelId), undefined, as)).statusCode).toBe(
        403,
      );
      expect((await putBot(channelId, on, session)).statusCode).toBe(403);
    }
    const noCsrf = await call(harness.app, 'PUT', botUrl(channelId), on, {
      cookie: owner.cookie,
    });
    expect(noCsrf.statusCode).toBe(403);
    expect((await getBot(channelId)).enabled).toBe(false);

    // Bot aktif TANPA penerima → percakapan baru tetap ke tim (review R1, semua channel).
    const enabled = await putBot(channelId, on);
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(channelBotSettingsResponseSchema.parse(enabled.json()).settings).toMatchObject({
      enabled: true,
      channelType: type,
      activeNow: true,
      receiverReady: false,
      timeoutMinutes: 10,
    });
    const audits = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'channel.bot_updated'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: owner.session.user.id,
      targetId: channelId,
      metadata: expect.objectContaining({
        channelType: type,
        enabled: true,
        previousEnabled: false,
      }) as unknown,
    });
    await receive(type, channelId, 'Halo tanpa bot');
    expect((await latestConversation(channelId)).status).toBe('unserved');
    await resolveAll();

    // Penerima native "hanya saat bot" → percakapan baru ke bot.
    await addWebhook({ events: ['message.received', 'conversation.handoff'], botOnly: true });
    expect((await getBot(channelId)).receiverReady).toBe(true);
    await receive(type, channelId, 'Internet mati');
    let conversation = await latestConversation(channelId);
    expect(conversation.status).toBe('bot');
    expect(conversation.botAwaitingSince).not.toBeNull();
    expect(harness.notificationJobs).toHaveLength(0);

    // Event ke bot memuat jenis channel (percakapan + kontak).
    await tick();
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]).toMatchObject({
      event: 'message.received',
      data: {
        conversation: {
          channel_id: channelId,
          channel_type: type,
          channel: { id: channelId, type, name: `CS ${type}` },
        },
        contact: {
          channel_type: type,
          channel_handle: SENDERS[type].handle,
        },
      },
    });

    // Balasan bot (API publik) tercatat di channel percakapan, pelaku `bot`; penanda tunggu hilang.
    const { secret } = await createKey();
    const sendUrl = apiPath(API_ROUTES.publicApi.messages, { conversationId: conversation.id });
    const reply = await bearer(secret, sendUrl, { type: 'text', text: 'Halo Kak, kami cek ya' });
    expect(reply.statusCode, reply.body).toBe(202);
    const [sent] = await harness.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.direction, 'outbound')));
    expect(sent).toMatchObject({ channelId, senderKind: 'bot', text: 'Halo Kak, kami cek ya' });
    expect((await latestConversation(channelId)).botAwaitingSince).toBeNull();

    // Jendela 24 jam hanya channel Meta (Messenger/Instagram); Telegram & Email tanpa jendela.
    await harness.db
      .update(conversations)
      .set({ windowExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(conversations.id, conversation.id));
    const late = await bearer(secret, sendUrl, { type: 'text', text: 'Masih kami cek' });
    if (type === 'messenger' || type === 'instagram') {
      expect(late.statusCode, late.body).toBe(409);
      expect(late.json<{ error: { code: string } }>().error.code).toBe('WINDOW_CLOSED');
    } else {
      expect(late.statusCode, late.body).toBe(202);
    }

    // Bot menyerahkan ke tim → antrian + push; `conversation.handoff` memuat jenis channel.
    const handoff = await bearer(
      secret,
      apiPath(API_ROUTES.publicApi.handoff, { conversationId: conversation.id }),
    );
    expect(handoff.statusCode, handoff.body).toBe(200);
    conversation = await latestConversation(channelId);
    expect(conversation.status).toBe('unserved');
    expect(harness.notificationJobs).toEqual([
      expect.objectContaining({ kind: 'queued', conversationId: conversation.id }),
    ]);
    await tick();
    expect(bodies().map((body) => body.event)).toEqual([
      'message.received',
      'conversation.handoff',
    ]);
    expect(bodies()[1]?.data.conversation?.channel_type).toBe(type);
  });

  it('batas waktu bot & mematikan saklar melepas percakapan ke antrian', async () => {
    const channelId = await addChannel(type);
    await addWebhook({ events: ['message.received'] });
    await putBot(channelId, { enabled: true, hours: { mode: 'always' }, timeoutMinutes: 5 });

    await receive(type, channelId, 'Halo');
    const waiting = await latestConversation(channelId);
    expect(waiting.status).toBe('bot');
    const since = waiting.botAwaitingSince!;
    expect(
      await handoffTimedOutBots(harness.db, { now: new Date(since.getTime() + 4 * 60_000) }),
    ).toBe(0);
    expect(
      await handoffTimedOutBots(harness.db, {
        now: new Date(since.getTime() + 5 * 60_000 + 1_000),
      }),
    ).toBe(1);
    expect(await latestConversation(channelId)).toMatchObject({
      status: 'unserved',
      botAwaitingSince: null,
    });

    await resolveAll();
    await receive(type, channelId, 'Halo lagi');
    const parked = await latestConversation(channelId);
    expect(parked.status).toBe('bot');
    const off = await putBot(channelId, {
      enabled: false,
      hours: { mode: 'always' },
      timeoutMinutes: null,
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(await latestConversation(channelId)).toMatchObject({
      id: parked.id,
      status: 'unserved',
    });
  });
});

describe('format MobiChat = WhatsApp saja', () => {
  it('endpoint MobiChat bukan penerima bot channel lain dan tidak menerima pesannya; WhatsApp tetap', async () => {
    const whatsapp = await addChannel('whatsapp');
    const telegram = await addChannel('telegram');
    const { secret } = await createKey();
    await addWebhook({
      events: ['message.received'],
      format: 'mobichat',
      mobichat: { apiKey: secret },
    });
    const on: ChannelBotSettings = { enabled: true, hours: { mode: 'always' }, timeoutMinutes: 10 };
    expect((await putBot(whatsapp, on)).statusCode).toBe(200);
    expect((await putBot(telegram, on)).statusCode).toBe(200);

    // Kontrak lama WhatsApp tidak berubah: endpoint MobiChat ber-key aktif = penerima.
    expect((await getBot(whatsapp)).receiverReady).toBe(true);
    expect((await getBot(telegram)).receiverReady).toBe(false);

    // Telegram dengan hanya endpoint MobiChat → langsung ke tim, tidak ada body MobiChat terkirim.
    await receive('telegram', telegram, 'Halo dari Telegram');
    const conversation = await latestConversation(telegram);
    expect(conversation.status).toBe('unserved');
    // Walau dipaksa ke bot, body MobiChat untuk channel non-WhatsApp tidak dibangun.
    await harness.db
      .update(conversations)
      .set({ status: 'bot', botAwaitingSince: new Date() })
      .where(eq(conversations.id, conversation.id));
    await receive('telegram', telegram, 'Halo lagi');
    await tick();
    expect(received).toHaveLength(0);

    // Endpoint native ditambahkan → Telegram punya penerima.
    await addWebhook({ events: ['message.received'] });
    expect((await getBot(telegram)).receiverReady).toBe(true);
  });
});

describe('perbaikan review bot semua channel', () => {
  it('B1: email gagal verifikasi tidak dipegang bot; bot menerima hasil verifikasi', async () => {
    const channelId = await addChannel('email');
    await addWebhook({ events: ['message.received', 'conversation.handoff'] });
    await putBot(channelId, { enabled: true, hours: { mode: 'always' }, timeoutMinutes: 10 });

    // Percakapan baru dari email `fail` → langsung antrian manusia.
    await receive('email', channelId, 'Tolong isolir nomor saya', 'fail');
    expect((await latestConversation(channelId)).status).toBe('unserved');
    await resolveAll();

    // `pass` → bot.
    await receive('email', channelId, 'Halo', 'pass');
    const held = await latestConversation(channelId);
    expect(held.status).toBe('bot');
    // Pesan `fail` berikutnya di percakapan bot → diserahkan ke tim (pelaku sistem) + webhook.
    await receive('email', channelId, 'Ganti paket saya', 'fail');
    expect(await latestConversation(channelId)).toMatchObject({
      id: held.id,
      status: 'unserved',
      botAwaitingSince: null,
    });
    const events = await harness.db
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, held.id));
    expect(events).toEqual([
      expect.objectContaining({ kind: 'handoff', actorUserId: null, apiKeyId: null }),
    ]);

    await tick();
    const delivered = received.map(
      (item) =>
        JSON.parse(item.body) as {
          event: string;
          data: { message?: { email: { sender_verification: string | null } | null } };
        },
    );
    expect(
      delivered
        .filter((body) => body.event === 'message.received')
        .map((body) => body.data.message?.email?.sender_verification)
        // Urutan kiriman paralel tidak dijamin.
        .sort(),
    ).toEqual(['fail', 'fail', 'pass']);
    expect(delivered.filter((body) => body.event === 'conversation.handoff')).toHaveLength(1);
  });

  it('B1: pesan non-email → `message.email` null', async () => {
    const channelId = await addChannel('telegram');
    await addWebhook({ events: ['message.received'] });
    await receive('telegram', channelId, 'Halo');
    await tick();
    const body = JSON.parse(received[0]!.body) as { data: { message: { email: unknown } } };
    expect(body.data.message.email).toBeNull();
  });

  it('B2: lapisan MobiChat menjawab 404 untuk percakapan non-WhatsApp', async () => {
    const channelId = await addChannel('telegram');
    await receive('telegram', channelId, 'Halo');
    const conversation = await latestConversation(channelId);
    const { secret } = await createKey();
    const asKey = (method: 'GET' | 'POST', url: string, body?: unknown) =>
      harness.app.inject({
        method,
        url,
        headers: {
          'x-api-key': secret,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      });
    const number = conversation.number;
    const cases: ['GET' | 'POST', string, unknown][] = [
      ['GET', `${MOBICHAT_ROUTES.messages}?conversation_id=${String(number)}&limit=5`, undefined],
      [
        'POST',
        MOBICHAT_ROUTES.messages,
        { conversation_id: number, messages: [{ message_text: 'x' }] },
      ],
      ['POST', MOBICHAT_ROUTES.botReply, { conversation_id: number, message_text: 'x' }],
      ['POST', MOBICHAT_ROUTES.unassignAgent, { conversation_id: number }],
    ];
    for (const [method, url, body] of cases) {
      const response = await asKey(method, url, body);
      expect(response.statusCode, `${method} ${url} ${response.body}`).toBe(404);
    }
    const sent = await harness.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.direction, 'outbound')));
    expect(sent).toHaveLength(0);
  });

  it('B3: kembalikan ke bot butuh penerima aktif; penanda batas waktu diisi', async () => {
    const channelId = await addChannel('telegram');
    await putBot(channelId, { enabled: true, hours: { mode: 'always' }, timeoutMinutes: 5 });
    await receive('telegram', channelId, 'Halo');
    const conversation = await latestConversation(channelId);
    expect(conversation.status).toBe('unserved');
    const resume = () =>
      call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.inbox.bot, { conversationId: conversation.id }),
        { active: true },
        { cookie: owner.cookie, csrf: owner.csrf },
      );

    // Hanya endpoint MobiChat (tidak berlaku untuk Telegram) → 409, status tetap.
    const { secret } = await createKey();
    await addWebhook({
      events: ['message.received'],
      format: 'mobichat',
      mobichat: { apiKey: secret },
    });
    const refused = await resume();
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Belum ada penerima bot aktif') as unknown,
    });
    expect((await latestConversation(channelId)).status).toBe('unserved');

    // Penerima native → boleh; pesan pelanggan belum dibalas → batas waktu berjalan.
    await addWebhook({ events: ['message.received'] });
    const before = Date.now();
    const ok = await resume();
    expect(ok.statusCode, ok.body).toBe(200);
    const resumed = await latestConversation(channelId);
    expect(resumed.status).toBe('bot');
    expect(resumed.botAwaitingSince?.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(
      await handoffTimedOutBots(harness.db, {
        now: new Date(resumed.botAwaitingSince!.getTime() + 5 * 60_000 + 1_000),
      }),
    ).toBe(1);
    expect((await latestConversation(channelId)).status).toBe('unserved');

    // Pesan terakhir dari tim (sudah dibalas) → kembali ke bot tanpa penanda.
    const reply = await bearer(
      secret,
      apiPath(API_ROUTES.publicApi.messages, { conversationId: conversation.id }),
      { type: 'text', text: 'Sudah kami bantu ya' },
    );
    expect(reply.statusCode, reply.body).toBe(202);
    expect((await resume()).statusCode).toBe(200);
    expect(await latestConversation(channelId)).toMatchObject({
      status: 'bot',
      botAwaitingSince: null,
    });
  });
});

describe('putaran 2 review bot semua channel', () => {
  it('P2-1: Email "bot hanya pengirim terverifikasi" — unverified ke tim; bawaan mati; channel lain 400', async () => {
    const email = await addChannel('email');
    const telegram = await addChannel('telegram');
    await addWebhook({ events: ['message.received'] });
    const on: ChannelBotSettings = { enabled: true, hours: { mode: 'always' }, timeoutMinutes: 10 };

    // Bawaan mati: email `unverified` tetap dilayani bot.
    expect((await getBot(email)).requireVerifiedSender).toBe(false);
    await putBot(email, on);
    await receive('email', email, 'Halo', 'unverified');
    expect((await latestConversation(email)).status).toBe('bot');
    await resolveAll();

    // Channel selain Email: `true` ditolak 400 (tidak tersimpan); `false` boleh.
    const rejected = await call(
      harness.app,
      'PUT',
      botUrl(telegram),
      { ...on, requireVerifiedSender: true },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(rejected.statusCode, rejected.body).toBe(400);
    expect((await getBot(telegram)).requireVerifiedSender).toBe(false);
    const allowed = await call(
      harness.app,
      'PUT',
      botUrl(telegram),
      { ...on, requireVerifiedSender: false },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(allowed.statusCode, allowed.body).toBe(200);

    // Nyalakan di Email → diaudit; tidak diisi = tetap.
    const enabled = await call(
      harness.app,
      'PUT',
      botUrl(email),
      { ...on, requireVerifiedSender: true },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(channelBotSettingsResponseSchema.parse(enabled.json()).settings).toMatchObject({
      channelType: 'email',
      requireVerifiedSender: true,
    });
    const [audit] = await harness.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'channel.bot_updated'), eq(auditLogs.targetId, email)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(audit?.metadata).toMatchObject({
      channelType: 'email',
      requireVerifiedSender: true,
      previousRequireVerifiedSender: false,
    });
    expect((await putBot(email, on)).statusCode).toBe(200);
    expect((await getBot(email)).requireVerifiedSender).toBe(true);

    // `unverified` → antrian; `pass` → bot; `unverified` berikutnya di percakapan bot → diserahkan.
    await receive('email', email, 'Isolir nomor saya', 'unverified');
    expect((await latestConversation(email)).status).toBe('unserved');
    await resolveAll();
    await receive('email', email, 'Halo', 'pass');
    const held = await latestConversation(email);
    expect(held.status).toBe('bot');
    await receive('email', email, 'Ganti paket', 'unverified');
    expect(await latestConversation(email)).toMatchObject({ id: held.id, status: 'unserved' });
  });

  it('P2-3: conversation.bot_resumed (native) memuat percakapan + pesan pelanggan yang belum dibalas', async () => {
    const channelId = await addChannel('telegram');
    await putBot(channelId, { enabled: true, hours: { mode: 'always' }, timeoutMinutes: 10 });
    const { secret } = await createKey();
    // Format MobiChat tidak bisa melanggan event ini.
    const mobichat = await call(
      harness.app,
      'POST',
      API_ROUTES.outgoingWebhooks.list,
      {
        url: `${receiverOrigin}/mobichat`,
        events: ['conversation.bot_resumed'],
        format: 'mobichat',
        mobichat: { apiKey: secret },
        confirmation: await confirmationFor(),
      },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(mobichat.statusCode, mobichat.body).toBe(400);

    // Percakapan di antrian (penerima baru dibuat setelah pesan masuk).
    await receive('telegram', channelId, 'Internet mati');
    const conversation = await latestConversation(channelId);
    expect(conversation.status).toBe('unserved');
    // "Hanya saat bot": pesan masuk saat antrian tidak dikirim; penerima ini juga syarat B3.
    await addWebhook({ events: ['message.received', 'conversation.bot_resumed'], botOnly: true });
    const [pending] = await harness.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    const resume = (active: boolean) =>
      call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.inbox.bot, { conversationId: conversation.id }),
        { active },
        { cookie: owner.cookie, csrf: owner.csrf },
      );
    expect((await resume(true)).statusCode).toBe(200);
    await tick();
    type Body = {
      event: string;
      data: {
        conversation: { id: string; status: string; channel_type: string };
        message: { id: string; direction: string; text: string } | null;
        actor: { id: string } | null;
      };
    };
    const resumedBodies = () =>
      received
        .map((item) => JSON.parse(item.body) as Body)
        .filter((body) => body.event === 'conversation.bot_resumed');
    const first = resumedBodies()[0];
    expect(first).toMatchObject({
      event: 'conversation.bot_resumed',
      data: {
        conversation: { id: conversation.id, status: 'bot', channel_type: 'telegram' },
        message: { id: pending!.id, direction: 'inbound', text: 'Internet mati' },
        actor: { id: owner.session.user.id },
      },
    });

    // Tim sudah membalas → dikembalikan lagi tanpa pesan tertunda (`message: null`).
    expect((await resume(false)).statusCode).toBe(200);
    const reply = await bearer(
      secret,
      apiPath(API_ROUTES.publicApi.messages, { conversationId: conversation.id }),
      { type: 'text', text: 'Sudah normal ya' },
    );
    expect(reply.statusCode, reply.body).toBe(202);
    expect((await resume(true)).statusCode).toBe(200);
    await tick();
    expect(resumedBodies()).toHaveLength(2);
    expect(resumedBodies()[1]?.data.message).toBeNull();
  });
});

describe('putaran 3 review bot semua channel', () => {
  it('P3-2: endpoint "hanya saat bot" tidak menerima bot_resumed bila agen sudah mengambil alih', async () => {
    const channelId = await addChannel('telegram');
    await putBot(channelId, { enabled: true, hours: { mode: 'always' }, timeoutMinutes: 10 });
    await receive('telegram', channelId, 'Halo');
    const conversation = await latestConversation(channelId);
    await addWebhook({ events: ['message.received', 'conversation.bot_resumed'], botOnly: true });
    const resumed = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.bot, { conversationId: conversation.id }),
      { active: true },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(resumed.statusCode, resumed.body).toBe(200);
    // Diambil agen SEBELUM dispatch → event dinilai ulang dan dilewati.
    const claimed = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.claim, { conversationId: conversation.id }),
      undefined,
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(claimed.statusCode, claimed.body).toBe(200);
    await tick();
    expect(received).toHaveLength(0);
  });

  it('P3-I1: Admin mematikan "hanya pengirim terverifikasi" → kejadian keamanan warning; Owner tidak', async () => {
    const email = await addChannel('email');
    const on: ChannelBotSettings = { enabled: true, hours: { mode: 'always' }, timeoutMinutes: 10 };
    const put = (signed: SignedIn, requireVerifiedSender: boolean) =>
      call(
        harness.app,
        'PUT',
        botUrl(email),
        { ...on, requireVerifiedSender },
        { cookie: signed.cookie, csrf: signed.csrf },
      );
    const summary = async () => {
      const response = await call(harness.app, 'GET', API_ROUTES.audit.securitySummary, undefined, {
        cookie: owner.cookie,
      });
      expect(response.statusCode, response.body).toBe(200);
      return securitySummaryResponseSchema
        .parse(response.json())
        .events.filter((event) => event.kind === 'bot_verified_sender_disabled');
    };
    expect((await put(owner, true)).statusCode).toBe(200);
    // Owner mematikan sendiri → tidak jadi banner.
    expect((await put(owner, false)).statusCode).toBe(200);
    expect(await summary()).toHaveLength(0);

    expect((await put(owner, true)).statusCode).toBe(200);
    const user = await insertUser(harness.db, organizationId, {
      role: 'admin',
      email: 'admin.verifikasi@majujaya.test',
      passwordHash: await hasher.hash(PASSWORD),
    });
    const admin = await login(harness.app, { email: user.email, password: PASSWORD });
    expect((await put(admin, false)).statusCode).toBe(200);
    const events = await summary();
    expect(events).toHaveLength(1);
    expect(events[0]?.severity).toBe('warning');
  });
});
