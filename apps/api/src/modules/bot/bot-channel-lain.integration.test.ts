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
  conversations,
  messages,
  newId,
  webhookEvents,
  type NewChannel,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  channelBotSettingsResponseSchema,
  createApiKeyResponseSchema,
  type ChannelBotSettings,
  type ChannelType,
} from '@balesin/shared';
import { and, asc, eq } from 'drizzle-orm';
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
async function receive(type: OtherChannel, channelId: string, text: string) {
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
                senderVerification: 'pass',
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
  harness.db.update(conversations).set({ status: 'resolved', resolvedAt: new Date() });

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
