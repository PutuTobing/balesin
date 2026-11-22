/**
 * Channel selain WhatsApp (Fase 6, docs/KONTRAK-API-CHANNEL-LAIN.md) — Postgres + Redis sungguhan,
 * Bot API Telegram TIRUAN, server IMAP TIRUAN (TLS, sertifikat tes), Mailpit (SMTP), Graph TIRUAN.
 *
 * Alur per channel: pengaturan (buat dengan konfirmasi identitas, rahasia terenkripsi & tersamar,
 * tes koneksi, webhook) → pesan masuk (webhook/IMAP) → worker → kontak & percakapan → tampil di
 * `GET /conversations` → balas → worker kirim → status. Ditambah penyalahgunaan: peran tanpa izin,
 * IDOR lintas organisasi, secret webhook salah, rahasia tidak pernah keluar di respons/log.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  CHANNEL_JOBS,
  MESSAGE_JOBS,
  WEBHOOK_JOBS,
  createInboxEventPublisher,
  createMediaStore,
  createMetaGraphClient,
  createSecretBox,
  createTelegramBotClient,
  Secret,
  type WebhookEventJobPayload,
} from '@balesin/core';
import {
  TEST_IMAP_CERT,
  TEST_MAIL,
  createLogCapture,
  startFakeImap,
  testEmail,
  waitForCapturedMail,
  type FakeImapServer,
} from '@balesin/core/testing';
import {
  channels,
  contacts,
  conversations,
  emailMailboxStates,
  messages,
  webhookEvents,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  WEBHOOK_ROUTES,
  apiPath,
  connectionChannelListResponseSchema,
  connectionChannelResponseSchema,
  connectionTestResultSchema,
  channelSummaryListResponseSchema,
  conversationListResponseSchema,
  createConnectionChannelResponseSchema,
  emailHtmlResponseSchema,
  errorEnvelopeSchema,
  messageListResponseSchema,
  type UserRole,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { processChannelJob } from '../../../../worker/src/queues/channel-mailboxes';
import { processSendMessageJob } from '../../../../worker/src/queues/messages';
import { processWebhookJob } from '../../../../worker/src/queues/webhooks';
import { startFakeTelegram, type FakeTelegram } from '../../testing/fake-telegram';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  withConfirmation,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { defaultTestConfig } from '../../testing/build-test-app';
import { createPasswordHasher } from '../auth/password-hasher';

const BOT_TOKEN = '123456789:AAFakeTokenUntukTesSaja_abcdefghijklmn';
const BOT_TOKEN_2 = '123456789:AAGantiTokenBotYangSamaSaja_zyxwvutsrqp';
const OTHER_BOT = '555555555:AAFakeBotLainSamaSekali_abcdefghijklmn';
const PAGE_ID = '1122334455';
const PAGE_TOKEN = 'EAAPageAccessTokenRahasiaUntukTes0123456789';
const APP_SECRET = '0123456789abcdef0123456789abcdef';
const API_URL = 'https://balesin.contoh.co.id/api';
const PASSWORD = 'sandi-anggota-channel-06';

let harness: IntegrationHarness;
let telegram: FakeTelegram;
let imap: FakeImapServer;
let graph: Server;
let graphUrl: string;
const graphCalls: { method: string; path: string; body: string }[] = [];
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const workerLogs = createLogCapture('trace');
const hasher = createPasswordHasher();
const bodies: string[] = [];
const mediaDir = defaultTestConfig().mediaDir;
const lookup = () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]);

const options = () => ({
  config: { apiUrl: API_URL, metaGraphBaseUrl: graphUrl },
  overrides: {
    telegramBaseUrl: telegram.url,
    mailLookup: lookup,
    meta: { sleep: () => Promise.resolve() },
    imap: {
      allowedPorts: [imap.port],
      testCa: TEST_IMAP_CERT,
      timeouts: { connectionMs: 3_000, greetingMs: 3_000, socketMs: 5_000, totalMs: 15_000 },
    },
  },
});

beforeAll(async () => {
  telegram = await startFakeTelegram();
  imap = await startFakeImap();
  graph = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      graphCalls.push({
        method: request.method ?? '',
        path,
        body: Buffer.concat(chunks).toString('latin1'),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      if (request.method === 'GET' && path.endsWith(`/${PAGE_ID}`)) {
        response.end(JSON.stringify({ id: PAGE_ID, name: 'Maju Jaya' }));
      } else if (request.method === 'POST' && path.endsWith(`/${PAGE_ID}/messages`)) {
        response.end(
          JSON.stringify({
            recipient_id: '9988776655',
            message_id: `m.out.${String(graphCalls.length)}`,
          }),
        );
      } else {
        response.writeHead(404);
        response.end(JSON.stringify({ error: { code: 100, message: 'x' } }));
      }
    });
  });
  await new Promise<void>((resolve) => graph.listen(0, '127.0.0.1', resolve));
  graphUrl = `http://127.0.0.1:${String((graph.address() as AddressInfo).port)}`;
  harness = await createIntegrationHarness(options());
});
beforeEach(async () => {
  await harness.reset();
  telegram.reset();
  telegram.bots.set(BOT_TOKEN, { id: 123456789, username: 'majujaya_bot' });
  telegram.bots.set(BOT_TOKEN_2, { id: 123456789, username: 'majujaya_bot' });
  telegram.bots.set(OTHER_BOT, { id: 555555555, username: 'lain_bot' });
  graphCalls.length = 0;
  workerLogs.lines.length = 0;
});
afterAll(async () => {
  // Tidak ada rahasia di respons mana pun sepanjang berkas tes.
  for (const body of bodies) {
    for (const secret of [BOT_TOKEN, BOT_TOKEN_2, PAGE_TOKEN, APP_SECRET, 'rahasia-imap']) {
      expect(body).not.toContain(secret);
    }
  }
  await harness?.close();
  await telegram?.close();
  await imap?.close();
  await new Promise<void>((resolve) => graph.close(() => resolve()));
});

const routes = API_ROUTES.channelConnections;
const path = (template: string, channelId: string) => apiPath(template, { channelId });

async function send(
  signed: SignedIn,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
) {
  const response = await call(harness.app, method, url, body, {
    cookie: signed.cookie,
    csrf: signed.csrf,
  });
  bodies.push(response.body);
  return response;
}

async function member(owner: SignedIn, role: UserRole): Promise<SignedIn> {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@majujaya.test`;
  await insertUser(harness.db, owner.session.organization.id, {
    role,
    email,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return login(harness.app, { email, password: PASSWORD });
}

function publisher() {
  return createInboxEventPublisher(harness.redis, {
    prefix: harness.redisPrefix,
    logger: workerLogs.logger,
  });
}

async function drainWebhooks(jobs: WebhookEventJobPayload[] = harness.webhookJobs.splice(0)) {
  for (const data of jobs) {
    const result = await processWebhookJob(
      { name: WEBHOOK_JOBS.whatsappEvent, data, attemptsMade: 0, opts: { attempts: 8 } },
      { db: harness.db, logger: workerLogs.logger, publisher: publisher() },
    );
    expect(result.status === 'processed' || result.reason === 'already_done').toBe(true);
  }
}

async function drainSends() {
  const results = [];
  for (const job of harness.messageJobs.splice(0)) {
    results.push(
      await processSendMessageJob(
        {
          name: MESSAGE_JOBS.send,
          data: { organizationId: job.organizationId, messageId: job.messageId },
          attemptsMade: 0,
          opts: { attempts: 5 },
        },
        {
          db: harness.db,
          logger: workerLogs.logger,
          meta: createMetaGraphClient({
            version: 'v26.0',
            baseUrl: graphUrl,
            sleep: () => Promise.resolve(),
          }),
          secretBox: box,
          publisher: publisher(),
          channels: {
            telegram: createTelegramBotClient({ baseUrl: telegram.url }),
            store: createMediaStore(mediaDir),
            smtp: {
              allowedPorts: [1025, 465, 587],
              plaintextLogin: 'allow',
              fallback: null,
              lookup,
            },
          },
        },
      ),
    );
  }
  return results;
}

async function conversationsOf(signed: SignedIn) {
  const response = await send(signed, 'GET', API_ROUTES.inbox.conversations);
  expect(response.statusCode, response.body).toBe(200);
  return conversationListResponseSchema.parse(response.json()).conversations;
}

async function sendReply(signed: SignedIn, conversationId: string, body: Record<string, unknown>) {
  return send(signed, 'POST', apiPath(API_ROUTES.inbox.messages, { conversationId }), {
    clientMessageId: crypto.randomUUID(),
    ...body,
  });
}

// ── Telegram ────────────────────────────────────────────────────────────────

async function createTelegram(owner: SignedIn, token = BOT_TOKEN) {
  const response = await send(
    owner,
    'POST',
    routes.list,
    await withConfirmation(owner, { type: 'telegram', name: 'Telegram CS', botToken: token }),
  );
  expect(response.statusCode, response.body).toBe(201);
  return createConnectionChannelResponseSchema.parse(response.json());
}

function telegramUpdate(channelId: string, update: unknown, secret: string | null) {
  return harness.app.inject({
    method: 'POST',
    url: apiPath(WEBHOOK_ROUTES.telegram, { channelId }),
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret }),
    },
    payload: JSON.stringify(update),
    remoteAddress: '149.154.167.200',
  });
}

describe('Telegram', () => {
  it('buat (getMe + setWebhook dengan secret), tes, rahasia terenkripsi & tersamar', async () => {
    const owner = await completeSetup(harness.app);
    const created = await createTelegram(owner);
    expect(created.channel).toMatchObject({
      type: 'telegram',
      enabled: true,
      status: 'connected',
      botUsername: 'majujaya_bot',
      botId: '123456789',
      botTokenHint: '••••klmn',
      webhook: { url: expect.stringContaining('/api/webhooks/telegram/') as string, warning: null },
    });
    expect(
      created.channel.type === 'telegram' && created.channel.webhook.registeredAt,
    ).toBeTruthy();
    const registered = telegram.webhooks.get(BOT_TOKEN);
    expect(registered?.url).toBe(`${API_URL}/webhooks/telegram/${created.channel.id}`);
    expect(registered?.secretToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [row] = await harness.db
      .select()
      .from(channels)
      .where(eq(channels.id, created.channel.id));
    expect(row?.tgBotTokenEncrypted).not.toContain(BOT_TOKEN);
    expect(row?.tgWebhookSecretEncrypted).not.toContain(registered?.secretToken ?? '-');

    const tested = await send(owner, 'POST', path(routes.test, created.channel.id));
    expect(connectionTestResultSchema.parse(tested.json())).toMatchObject({
      ok: true,
      checks: [
        { name: 'bot', ok: true },
        { name: 'webhook', ok: true },
      ],
    });

    // Webhook diarahkan ke tempat lain → tes melapor; "Pasang webhook" memperbaikinya dengan secret baru.
    telegram.webhooks.set(BOT_TOKEN, { url: 'https://lain.test/x', secretToken: 'x' });
    const mismatch = connectionTestResultSchema.parse(
      (await send(owner, 'POST', path(routes.test, created.channel.id))).json(),
    );
    expect(mismatch.code).toBe('telegram_webhook_url_mismatch');
    const rotated = await send(owner, 'POST', path(routes.webhook, created.channel.id));
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(telegram.webhooks.get(BOT_TOKEN)?.secretToken).not.toBe(registered?.secretToken);
  });

  it('validasi: tanpa konfirmasi, token ditolak Telegram, bot yang sama dua kali, token bot lain saat ganti', async () => {
    const owner = await completeSetup(harness.app);
    const noConfirm = await send(owner, 'POST', routes.list, {
      type: 'telegram',
      name: 'Tes',
      botToken: BOT_TOKEN,
    });
    expect(noConfirm.statusCode).toBe(400);
    const rejected = await send(
      owner,
      'POST',
      routes.list,
      await withConfirmation(owner, {
        type: 'telegram',
        name: 'Tes',
        botToken: '999999999:AATokenTidakDikenalTelegram_abcdefghij',
      }),
    );
    expect(rejected.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(rejected.json()).error.details?.[0]?.field).toBe('botToken');

    const created = await createTelegram(owner);
    const duplicate = await send(
      owner,
      'POST',
      routes.list,
      await withConfirmation(owner, { type: 'telegram', name: 'Lagi', botToken: BOT_TOKEN_2 }),
    );
    expect(duplicate.statusCode).toBe(409);

    const otherBot = await send(
      owner,
      'PATCH',
      path(routes.channel, created.channel.id),
      await withConfirmation(owner, { type: 'telegram', botToken: OTHER_BOT }),
    );
    expect(otherBot.statusCode).toBe(400);
    const renamed = await send(owner, 'PATCH', path(routes.channel, created.channel.id), {
      type: 'telegram',
      name: 'Bot CS',
    });
    expect(renamed.statusCode).toBe(200);
    const sameBot = await send(
      owner,
      'PATCH',
      path(routes.channel, created.channel.id),
      await withConfirmation(owner, { type: 'telegram', botToken: BOT_TOKEN_2 }),
    );
    expect(connectionChannelResponseSchema.parse(sameBot.json()).channel).toMatchObject({
      status: 'untested',
    });
    expect(telegram.webhooks.get(BOT_TOKEN_2)?.url).toContain(created.channel.id);
  });

  it('webhook: secret salah/tidak ada → 403; pesan masuk → percakapan tampil; balas → terkirim; tombol', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createTelegram(owner);
    const secret = telegram.webhooks.get(BOT_TOKEN)?.secretToken ?? '';
    const update = {
      update_id: 501,
      message: {
        message_id: 7,
        date: Math.floor(Date.now() / 1000),
        from: { id: 777001, is_bot: false, first_name: 'Budi', username: 'budi_s' },
        chat: { id: 777001, type: 'private' },
        text: 'Halo, internet mati',
      },
    };
    expect((await telegramUpdate(channel.id, update, null)).statusCode).toBe(403);
    expect((await telegramUpdate(channel.id, update, 'salah')).statusCode).toBe(403);
    expect(await harness.db.select().from(webhookEvents)).toHaveLength(0);

    const ok = await telegramUpdate(channel.id, update, secret);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ status: 'received' });
    // Kiriman ulang Telegram tidak menggandakan.
    await telegramUpdate(channel.id, update, secret);
    await drainWebhooks();

    const list = await conversationsOf(owner);
    expect(list).toHaveLength(1);
    const conversation = list[0];
    expect(conversation).toMatchObject({
      channel: { type: 'telegram' },
      contact: {
        displayName: 'Budi',
        nameSource: 'channel',
        channelHandle: '@budi_s',
        phone: null,
      },
      windowApplies: false,
      windowOpen: true,
      windowExpiresAt: null,
      unreadCount: 1,
    });
    if (!conversation) throw new Error('tidak ada percakapan');

    // Template & reaksi tidak berlaku di Telegram.
    expect(
      (
        await sendReply(owner, conversation.id, {
          type: 'reaction',
          targetMessageId: crypto.randomUUID(),
          emoji: '👍',
        })
      ).statusCode,
    ).toBe(400);
    const reply = await sendReply(owner, conversation.id, {
      type: 'text',
      text: 'Baik kak, kami cek.',
    });
    expect(reply.statusCode, reply.body).toBe(202);
    const [result] = await drainSends();
    expect(result).toMatchObject({
      status: 'sent',
      wamid: expect.stringMatching(/^777001:\d+$/) as string,
    });
    const sent = telegram.calls.find((entry) => entry.method === 'sendMessage');
    expect(sent?.body).toMatchObject({ chat_id: '777001', text: 'Baik kak, kami cek.' });
    const messagesResponse = await send(
      owner,
      'GET',
      apiPath(API_ROUTES.inbox.messages, { conversationId: conversation.id }),
    );
    const listed = messageListResponseSchema.parse(messagesResponse.json()).messages;
    expect(listed.find((message) => message.direction === 'outbound')?.status).toBe('sent');

    // Tombol inline: dijawab di badan respons webhook (tanpa token).
    const callback = await telegramUpdate(
      channel.id,
      {
        update_id: 502,
        callback_query: {
          id: 'cb-9',
          from: { id: 777001, is_bot: false, first_name: 'Budi' },
          data: 'ya',
          message: { message_id: 8, chat: { id: 777001, type: 'private' } },
        },
      },
      secret,
    );
    expect(callback.json()).toEqual({ method: 'answerCallbackQuery', callback_query_id: 'cb-9' });
    await drainWebhooks();
    const after = await conversationsOf(owner);
    expect(after[0]?.lastMessage).toMatchObject({ type: 'interactive', text: 'ya' });

    // Pelanggan memblokir bot → gagal dengan alasan jelas.
    telegram.failNext = {
      status: 403,
      body: { ok: false, description: 'Forbidden: bot was blocked by the user' },
    };
    await sendReply(owner, conversation.id, { type: 'text', text: 'Halo?' });
    const [blocked] = await drainSends();
    expect(blocked).toMatchObject({ status: 'failed', reason: 'recipient_blocked' });
  });

  it('nonaktif → update dibuang (tetap 200); hapus → webhook dilepas & rahasia dimusnahkan', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createTelegram(owner);
    const secret = telegram.webhooks.get(BOT_TOKEN)?.secretToken ?? '';
    expect((await send(owner, 'POST', path(routes.disable, channel.id))).statusCode).toBe(200);
    const update = {
      update_id: 900,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        from: { id: 1, is_bot: false, first_name: 'A' },
        chat: { id: 1, type: 'private' },
        text: 'x',
      },
    };
    expect((await telegramUpdate(channel.id, update, secret)).statusCode).toBe(200);
    expect(await harness.db.select().from(webhookEvents)).toHaveLength(0);

    const removed = await send(
      owner,
      'DELETE',
      path(routes.channel, channel.id),
      await withConfirmation(owner, {}).then((b) => b.confirmation),
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect(telegram.webhooks.has(BOT_TOKEN)).toBe(false);
    const [row] = await harness.db.select().from(channels).where(eq(channels.id, channel.id));
    expect(row).toMatchObject({ tgBotTokenEncrypted: null, tgWebhookSecretEncrypted: null });
    expect((await telegramUpdate(channel.id, update, secret)).statusCode).toBe(404);
  });
});

// ── Email ───────────────────────────────────────────────────────────────────

async function createEmail(owner: SignedIn, overrides: Record<string, unknown> = {}) {
  const response = await send(
    owner,
    'POST',
    routes.list,
    await withConfirmation(owner, {
      type: 'email',
      name: 'Email CS',
      emailAddress: 'cs@contoh.test',
      fromName: 'CS Maju Jaya',
      imap: {
        host: 'localhost',
        port: imap.port,
        security: 'ssl',
        username: 'cs@contoh.test',
        password: 'rahasia-imap',
      },
      pollIntervalMinutes: 1,
      smtp: {
        mode: 'custom',
        host: TEST_MAIL.host,
        port: TEST_MAIL.smtpPort,
        security: 'none',
        username: TEST_MAIL.username,
        password: TEST_MAIL.password,
      },
      ...overrides,
    }),
  );
  expect(response.statusCode, response.body).toBe(201);
  return createConnectionChannelResponseSchema.parse(response.json());
}

function mailboxDeps(jobs: WebhookEventJobPayload[]) {
  return {
    db: harness.db,
    logger: workerLogs.logger,
    secretBox: box,
    store: createMediaStore(mediaDir),
    imapPolicy: { allowedPorts: [imap.port], lookup, testCa: TEST_IMAP_CERT },
    enqueueEvents: (events: readonly WebhookEventJobPayload[]) => {
      jobs.push(...events);
      return Promise.resolve();
    },
    enqueuePoll: () => Promise.resolve(),
  };
}

describe('Email', () => {
  it('IMAP → percakapan (HTML tersanitasi, lampiran) → balas lewat SMTP dengan header utas', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createEmail(owner);
    expect(channel).toMatchObject({
      type: 'email',
      imap: { passwordHint: '••••imap' },
      smtp: { mode: 'custom' },
      mailbox: { lastPolledAt: null, skippedMessages: 0 },
    });
    const tested = connectionTestResultSchema.parse(
      (await send(owner, 'POST', path(routes.test, channel.id))).json(),
    );
    expect(tested).toMatchObject({
      ok: true,
      checks: [
        { name: 'incoming', ok: true },
        { name: 'outgoing', ok: true },
      ],
    });

    const jobs: WebhookEventJobPayload[] = [];
    const deps = mailboxDeps(jobs);
    // Putaran pertama hanya mencatat posisi kotak masuk.
    await processChannelJob(
      {
        name: CHANNEL_JOBS.emailPoll,
        data: { organizationId: owner.session.organization.id, channelId: channel.id },
      },
      deps,
    );
    const customer = `pelanggan-${Math.random().toString(36).slice(2, 8)}@pelanggan.test`;
    imap.add(
      [
        `From: "Ani" <${customer}>`,
        'To: cs@contoh.test',
        'Subject: Tagihan Oktober',
        'Message-ID: <tagihan-1@pelanggan.test>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="B"',
        '',
        '--B',
        'Content-Type: multipart/alternative; boundary="A"',
        '',
        '--A',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Tagihan saya dobel.',
        '--A',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Tagihan saya <b>dobel</b>.</p><script>alert(1)</script>',
        '--A--',
        '--B',
        'Content-Type: application/pdf; name="bukti.pdf"',
        'Content-Disposition: attachment; filename="bukti.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
        '--B--',
        '',
      ].join('\r\n'),
    );
    imap.add(testEmail({ from: customer, headers: { 'Auto-Submitted': 'auto-replied' } }));
    await processChannelJob(
      {
        name: CHANNEL_JOBS.emailPoll,
        data: { organizationId: owner.session.organization.id, channelId: channel.id },
      },
      deps,
    );
    await drainWebhooks(jobs);
    const [state] = await harness.db.select().from(emailMailboxStates);
    expect(state).toMatchObject({ lastPollOk: true, skippedMessages: 1 });

    const [conversation] = await conversationsOf(owner);
    expect(conversation).toMatchObject({
      channel: { type: 'email' },
      contact: { displayName: 'Ani', channelHandle: customer },
      windowApplies: false,
      windowOpen: true,
    });
    if (!conversation) throw new Error('tidak ada percakapan');
    const listed = messageListResponseSchema.parse(
      (
        await send(
          owner,
          'GET',
          apiPath(API_ROUTES.inbox.messages, { conversationId: conversation.id }),
        )
      ).json(),
    ).messages;
    const text = listed.find((message) => message.type === 'text');
    expect(text).toMatchObject({
      text: 'Tagihan saya dobel.',
      email: { subject: 'Tagihan Oktober', hasHtml: true, senderVerification: 'unverified' },
    });
    expect(listed.find((message) => message.type === 'document')).toMatchObject({
      media: { filename: 'bukti.pdf' },
      mediaAvailable: true,
    });
    const html = await send(
      owner,
      'GET',
      apiPath(API_ROUTES.inbox.emailHtml, { messageId: text?.id ?? '' }),
    );
    expect(emailHtmlResponseSchema.parse(html.json()).html).toBe(
      '<p>Tagihan saya <b>dobel</b>.</p>',
    );

    const reply = await sendReply(owner, conversation.id, {
      type: 'text',
      text: 'Kami bantu cek ya.',
    });
    expect(reply.statusCode, reply.body).toBe(202);
    const [result] = await drainSends();
    expect(result).toMatchObject({ status: 'sent' });
    const mail = await waitForCapturedMail(customer);
    expect(mail).toMatchObject({
      subject: 'Re: Tagihan Oktober',
      from: { address: 'cs@contoh.test', name: 'CS Maju Jaya' },
    });
    expect(mail.text).toContain('Kami bantu cek ya.');
    const headers = (await (
      await fetch(`http://${TEST_MAIL.host}:8025/api/v1/message/${mail.id}/headers`)
    ).json()) as Record<string, string[]>;
    expect(headers['In-Reply-To']?.[0]).toBe('<tagihan-1@pelanggan.test>');
  });

  it('tahap 9.0: alias → Kepada/Cc/alamat tujuan tersimpan; balas Cc + Bcc (Bcc tidak ada di header MIME)', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createEmail(owner, {
      aliases: ['Billing@Contoh.test', 'cs@contoh.test'],
    });
    // Alamat utama dibuang dari daftar alias; huruf kecil.
    expect(channel).toMatchObject({ aliases: ['billing@contoh.test'] });
    const summaries = await send(owner, 'GET', API_ROUTES.channels.list);
    expect(
      channelSummaryListResponseSchema
        .parse(summaries.json())
        .channels.find((item) => item.id === channel.id)?.emailAddresses,
    ).toEqual(['cs@contoh.test', 'billing@contoh.test']);

    const jobs: WebhookEventJobPayload[] = [];
    const deps = mailboxDeps(jobs);
    const poll = () =>
      processChannelJob(
        {
          name: CHANNEL_JOBS.emailPoll,
          data: { organizationId: owner.session.organization.id, channelId: channel.id },
        },
        deps,
      );
    await poll();
    const tag = Math.random().toString(36).slice(2, 8);
    const customer = `pelanggan-${tag}@pelanggan.test`;
    const colleague = `rekan-${tag}@pelanggan.test`;
    const boss = `atasan-${tag}@pelanggan.test`;
    const hidden = `rahasia-${tag}@lain.test`;
    imap.add(
      testEmail({
        from: `"Ani" <${customer}>`,
        to: `"Tagihan" <billing@contoh.test>, ${colleague}`,
        messageId: `alias-${tag}@pelanggan.test`,
        subject: 'Tagihan ganda',
        headers: {
          'Delivered-To': 'billing@contoh.test',
          Cc: `${boss}, CS <cs@contoh.test>`,
        },
      }),
    );
    await poll();
    await drainWebhooks(jobs);

    const [conversation] = await conversationsOf(owner);
    if (!conversation) throw new Error('tidak ada percakapan');
    const [inbound] = messageListResponseSchema.parse(
      (
        await send(
          owner,
          'GET',
          apiPath(API_ROUTES.inbox.messages, { conversationId: conversation.id }),
        )
      ).json(),
    ).messages;
    expect(inbound?.email).toMatchObject({
      to: ['billing@contoh.test', colleague],
      cc: [boss, 'cs@contoh.test'],
      recipient: 'billing@contoh.test',
      replyAll: [colleague, boss],
    });
    const filtered = await send(
      owner,
      'GET',
      `${API_ROUTES.inbox.conversations}?emailRecipient=billing%40contoh.test`,
    );
    expect(
      conversationListResponseSchema.parse(filtered.json()).conversations.map((item) => item.id),
    ).toEqual([conversation.id]);

    // Owner: Cc alamat lama (Balas semua) + Bcc alamat baru.
    const reply = await sendReply(owner, conversation.id, {
      type: 'text',
      text: 'Sudah kami koreksi.',
      cc: [colleague, boss],
      bcc: [hidden],
    });
    expect(reply.statusCode, reply.body).toBe(202);
    const [result] = await drainSends();
    expect(result).toMatchObject({ status: 'sent' });
    const mail = await waitForCapturedMail(customer);
    const headers = (await (
      await fetch(`http://${TEST_MAIL.host}:8025/api/v1/message/${mail.id}/headers`)
    ).json()) as Record<string, string[]>;
    expect(headers.Cc?.[0]).toContain(colleague);
    expect(headers.Cc?.[0]).toContain(boss);
    // Mailpit MENAMBAHKAN header `Bcc` sendiri untuk penerima amplop yang tidak ada di To/Cc, jadi
    // "Bcc tidak di header MIME" dibuktikan di tingkat kabel SMTP (`packages/core/src/mail/mail.test.ts`).
    // Di sini: Bcc sampai lewat amplop SMTP saja.
    const detail = (await (
      await fetch(`http://${TEST_MAIL.host}:8025/api/v1/message/${mail.id}`)
    ).json()) as { Bcc?: { Address?: string }[] };
    expect((detail.Bcc ?? []).map((entry) => entry.Address)).toEqual([hidden]);

    const sent = messageListResponseSchema
      .parse(
        (
          await send(
            owner,
            'GET',
            apiPath(API_ROUTES.inbox.messages, { conversationId: conversation.id }),
          )
        ).json(),
      )
      .messages.find((message) => message.direction === 'outbound');
    expect(sent?.email).toMatchObject({
      subject: 'Re: Tagihan ganda',
      to: [customer],
      cc: [colleague, boss],
      bcc: [hidden],
    });
    expect(sent?.email?.senderVerification).toBeUndefined();

    // Review 9.0 R7: menambah alias wajib konfirmasi identitas; alamat kontak pelanggan ditolak.
    const channelPath = path(routes.channel, channel.id);
    const unconfirmed = await send(owner, 'PATCH', channelPath, {
      type: 'email',
      aliases: ['billing@contoh.test', 'info@contoh.test'],
    });
    expect(unconfirmed.statusCode, unconfirmed.body).toBe(400);
    expect(unconfirmed.body).toContain('confirmation.password');
    const customerAlias = await send(
      owner,
      'PATCH',
      channelPath,
      await withConfirmation(owner, { type: 'email', aliases: ['billing@contoh.test', customer] }),
    );
    expect(customerAlias.statusCode, customerAlias.body).toBe(400);
    expect(customerAlias.body).toContain('sudah tercatat sebagai kontak pelanggan');
    // Menghapus alias tidak butuh konfirmasi.
    const removed = await send(owner, 'PATCH', channelPath, { type: 'email', aliases: [] });
    expect(removed.statusCode, removed.body).toBe(200);
    const added = await send(
      owner,
      'PATCH',
      channelPath,
      await withConfirmation(owner, { type: 'email', aliases: ['info@contoh.test'] }),
    );
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json<{ channel: { aliases: string[] } }>().channel.aliases).toEqual([
      'info@contoh.test',
    ]);
  });

  it('password IMAP salah → kode jelas; SMTP "system" tanpa email pengirim → smtp_not_configured', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createEmail(owner, {
      emailAddress: 'cs2@contoh.test',
      imap: {
        host: 'localhost',
        port: imap.port,
        security: 'ssl',
        username: 'cs@contoh.test',
        password: 'salah',
      },
      smtp: { mode: 'system' },
    });
    const tested = connectionTestResultSchema.parse(
      (await send(owner, 'POST', path(routes.test, channel.id))).json(),
    );
    expect(tested.checks.map((check) => check.code)).toEqual([
      'imap_auth_failed',
      'smtp_not_configured',
    ]);
    expect(tested.ok).toBe(false);
  });
});

// ── Messenger ───────────────────────────────────────────────────────────────

describe('Messenger (nonaktif bawaan, butuh App Review)', () => {
  it('dibuat nonaktif; aktifkan hanya setelah tes; jabat tangan + tanda tangan; kirim lewat Graph', async () => {
    const owner = await completeSetup(harness.app);
    const response = await send(
      owner,
      'POST',
      routes.list,
      await withConfirmation(owner, {
        type: 'messenger',
        name: 'Messenger',
        pageId: PAGE_ID,
        pageAccessToken: PAGE_TOKEN,
        appSecret: APP_SECRET,
      }),
    );
    expect(response.statusCode, response.body).toBe(201);
    const created = createConnectionChannelResponseSchema.parse(response.json());
    expect(created.channel).toMatchObject({
      type: 'messenger',
      enabled: false,
      requiresAppReview: true,
    });
    const channelId = created.channel.id;
    expect((await send(owner, 'POST', path(routes.enable, channelId))).statusCode).toBe(409);
    expect(
      connectionTestResultSchema.parse(
        (await send(owner, 'POST', path(routes.test, channelId))).json(),
      ).ok,
    ).toBe(true);
    expect((await send(owner, 'POST', path(routes.enable, channelId))).statusCode).toBe(200);

    const verifyToken = created.webhook?.verifyToken ?? '';
    const handshake = await harness.app.inject({
      method: 'GET',
      url: `${apiPath(WEBHOOK_ROUTES.messenger, { channelId })}?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=tantangan123`,
    });
    expect(handshake.body).toBe('tantangan123');

    const payload = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          time: Date.now(),
          messaging: [
            {
              sender: { id: '9988776655' },
              recipient: { id: PAGE_ID },
              timestamp: Date.now(),
              message: { mid: 'm.in.1', text: 'Halo dari Messenger' },
            },
          ],
        },
      ],
    });
    const post = (signature: string) =>
      harness.app.inject({
        method: 'POST',
        url: apiPath(WEBHOOK_ROUTES.messenger, { channelId }),
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
        payload,
      });
    expect((await post('sha256=00')).statusCode).toBe(403);
    const signed = `sha256=${createHmac('sha256', APP_SECRET).update(payload).digest('hex')}`;
    expect((await post(signed)).statusCode).toBe(200);
    await drainWebhooks();
    const [conversation] = await conversationsOf(owner);
    expect(conversation).toMatchObject({
      channel: { type: 'messenger' },
      windowApplies: true,
      windowOpen: true,
    });
    if (!conversation) throw new Error('tidak ada percakapan');
    expect(
      (await sendReply(owner, conversation.id, { type: 'text', text: 'Halo juga' })).statusCode,
    ).toBe(202);
    const [result] = await drainSends();
    expect(result).toMatchObject({
      status: 'sent',
      wamid: expect.stringMatching(/^m\.out\./) as string,
    });
    expect(graphCalls.at(-1)).toMatchObject({ method: 'POST', path: `/v26.0/${PAGE_ID}/messages` });
    expect(graphCalls.at(-1)?.body).toContain('"messaging_type":"RESPONSE"');

    // Status: `delivery` (mid) → terantar; `read` (watermark) → dibaca.
    const sentWamid = result && 'wamid' in result ? result.wamid : '';
    const statusPayload = (event: Record<string, unknown>) =>
      JSON.stringify({
        object: 'page',
        entry: [
          {
            id: PAGE_ID,
            messaging: [{ sender: { id: '9988776655' }, recipient: { id: PAGE_ID }, ...event }],
          },
        ],
      });
    for (const event of [
      { delivery: { mids: [sentWamid], watermark: Date.now() } },
      { read: { watermark: Date.now() + 1000 } },
    ]) {
      const body = statusPayload(event);
      const response = await harness.app.inject({
        method: 'POST',
        url: apiPath(WEBHOOK_ROUTES.messenger, { channelId }),
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`,
        },
        payload: body,
      });
      expect(response.statusCode, response.body).toBe(200);
      await drainWebhooks();
      const [outbound] = await harness.db
        .select({ status: messages.status })
        .from(messages)
        .where(eq(messages.wamid, sentWamid));
      expect(outbound?.status).toBe('delivery' in event ? 'delivered' : 'read');
    }
  });
});

// ── Akses ───────────────────────────────────────────────────────────────────

describe('akses', () => {
  it('CS & Teknisi ditolak; organisasi lain = 404; daftar memuat info jenis channel', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createTelegram(owner);
    for (const role of ['cs', 'teknisi'] as const) {
      const signed = await member(owner, role);
      expect((await send(signed, 'GET', routes.list)).statusCode).toBe(403);
      expect((await send(signed, 'POST', path(routes.test, channel.id))).statusCode).toBe(403);
    }
    const list = connectionChannelListResponseSchema.parse(
      (await send(owner, 'GET', routes.list)).json(),
    );
    expect(list.types.map((type) => [type.type, type.capabilities.broadcast])).toEqual([
      ['whatsapp', true],
      ['telegram', false],
      ['email', false],
      ['messenger', false],
      ['instagram', false],
    ]);
    // WhatsApp tetap di rutenya sendiri: channel Telegram bukan channel WhatsApp.
    expect(
      (await send(owner, 'GET', apiPath(API_ROUTES.channels.channel, { channelId: channel.id })))
        .statusCode,
    ).toBe(404);

    const other = await insertOrganization(harness.db, { name: 'Org Lain' });
    const [foreign] = await harness.db
      .insert(channels)
      .values({
        organizationId: other.id,
        type: 'telegram',
        name: 'Asing',
        tgBotId: '444444444',
        tgBotTokenEncrypted: 'x',
        tgWebhookSecretEncrypted: 'y',
      })
      .returning();
    expect((await send(owner, 'GET', path(routes.channel, foreign?.id ?? ''))).statusCode).toBe(
      404,
    );
    expect((await send(owner, 'POST', path(routes.disable, foreign?.id ?? ''))).statusCode).toBe(
      404,
    );
    const contactRows = await harness.db
      .select()
      .from(contacts)
      .where(and(eq(contacts.organizationId, other.id)));
    expect(contactRows).toHaveLength(0);
    expect(
      await harness.db.select().from(messages).where(eq(messages.organizationId, other.id)),
    ).toHaveLength(0);
    expect(
      await harness.db
        .select()
        .from(conversations)
        .where(eq(conversations.organizationId, other.id)),
    ).toHaveLength(0);
  });
});
