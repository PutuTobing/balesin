/**
 * Tes penjaga review keamanan "bot untuk semua jenis channel" (commit f493358)
 * — docs/security-reviews/2026-11-19-bot-semua-channel.md.
 *
 * `it` = regresi (perilaku yang sudah benar). `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN;
 * gagal sekarang). Saat temuan diperbaiki, ganti `it.fails` → `it` tanpa mengubah asersinya.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createSecretBox, Secret, WEBHOOK_JOBS } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import {
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
  MOBICHAT_ROUTES,
  createApiKeyResponseSchema,
  securitySummaryResponseSchema,
  type ChannelBotSettings,
  type ChannelType,
} from '@balesin/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
const PASSWORD = 'sandi-uji-review-bot-semua-01';

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let receiverOrigin = '';
const received: { body: string }[] = [];
const logs = createLogCapture();
const hasher = createPasswordHasher();
const box = createSecretBox(new Secret(TEST_MASTER_KEY));

const receiver = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    received.push({ body: Buffer.concat(chunks).toString() });
    response.writeHead(200).end('ok');
  });
});

/** Rahasia tiruan yang KHAS — dicari di body webhook (tidak boleh muncul). */
const FAKE_SECRET = 'RAHASIA-CHANNEL-TIDAK-BOLEH-BOCOR';

function channelValues(type: ChannelType, id: string): NewChannel {
  const base = { id, organizationId, type, name: `CS ${type}` };
  switch (type) {
    case 'whatsapp':
      return {
        ...base,
        waPhoneNumberId: '106540352242922',
        waBusinessAccountId: '102290129340398',
        waAccessTokenEncrypted: FAKE_SECRET,
        waAppSecretEncrypted: FAKE_SECRET,
        waVerifyTokenEncrypted: FAKE_SECRET,
        waVerifyTokenRotatedAt: new Date(),
      };
    case 'telegram':
      return {
        ...base,
        tgBotId: '123456789',
        tgBotUsername: 'majujaya_bot',
        tgBotTokenEncrypted: FAKE_SECRET,
        tgWebhookSecretEncrypted: FAKE_SECRET,
      };
    case 'email':
      return {
        ...base,
        emailAddress: 'cs@majujaya.test',
        emailFromName: 'CS Maju Jaya',
        emailImapHost: 'imap.majujaya.test',
        emailImapPort: 993,
        emailImapSecurity: 'ssl',
        emailImapUsername: 'cs-imap-user',
        emailImapPasswordEncrypted: FAKE_SECRET,
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
        metaPageTokenEncrypted: FAKE_SECRET,
        metaAppSecretEncrypted: FAKE_SECRET,
        metaVerifyTokenEncrypted: FAKE_SECRET,
        metaVerifyTokenRotatedAt: new Date(),
      };
  }
}

async function addChannel(type: ChannelType): Promise<string> {
  const id = newId();
  await harness.db.insert(channels).values(channelValues(type, id));
  return id;
}

/** ID platform mentah yang KHAS per channel (tidak boleh muncul di body webhook, kecuali email). */
const SENDERS: Record<OtherChannel, { externalUserId: string; handle: string | null }> = {
  telegram: { externalUserId: '5550001112223', handle: '@budi_pelanggan' },
  email: { externalUserId: 'budi@pelanggan.test', handle: 'budi@pelanggan.test' },
  messenger: { externalUserId: '7001002003004005', handle: null },
  instagram: { externalUserId: '8001002003004005', handle: null },
};

let sequence = 0;
/** Pekerjaan push yang diantrekan worker pesan masuk (stub produsen notifikasi). */
const notified: { kind: string; conversationId?: string | null }[] = [];

async function receive(
  type: OtherChannel,
  channelId: string,
  text: string,
  emailVerification: 'pass' | 'fail' | 'unverified' = 'pass',
) {
  sequence += 1;
  const externalId = `${type}-masuk-review-${String(sequence)}`;
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
                authWarning: emailVerification === 'fail',
                senderVerification: emailVerification,
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
    {
      db: harness.db,
      logger: logs.logger,
      notifications: {
        enqueue: (jobs) => {
          notified.push(
            ...jobs.map((job) => ({ kind: job.kind, conversationId: job.conversationId })),
          );
          return Promise.resolve();
        },
      },
    },
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

const botUrl = (channelId: string) => apiPath(API_ROUTES.channels.bot, { channelId });
const ON: ChannelBotSettings = { enabled: true, hours: { mode: 'always' }, timeoutMinutes: 10 };

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

async function createKey(scopes: readonly string[] = ['messages:send', 'conversations:write']) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    {
      name: 'Bot review',
      scopes,
      confirmation: await confirmationFor(),
    },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return createApiKeyResponseSchema.parse(response.json());
}

const bearer = (token: string, url: string, body?: unknown) =>
  harness.app.inject({
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });

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
  notified.length = 0;
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
});
afterAll(async () => {
  await harness?.close();
  await new Promise((resolve) => receiver.close(resolve));
});

describe('minimisasi data payload webhook native (fokus 1)', () => {
  it.each(['telegram', 'messenger', 'instagram', 'email'] as const)(
    '%s: tanpa ID platform mentah, tanpa rahasia/kolom channel; channel = {id,type,name} saja',
    async (type) => {
      const channelId = await addChannel(type);
      await addWebhook({
        events: ['message.received', 'contact.created', 'conversation.created'],
      });
      await receive(type, channelId, 'Halo');
      await tick();
      expect(received.length).toBeGreaterThan(0);
      for (const { body } of received) {
        // ID Telegram / PSID / IGSID mentah tidak pernah ikut (email: alamat = isian `email` kontak).
        if (type !== 'email') expect(body).not.toContain(SENDERS[type].externalUserId);
        expect(body).not.toContain(FAKE_SECRET);
        for (const leak of [
          'external_user_id',
          'externalUserId',
          'wa_bsuid',
          'tgBotId',
          '123456789',
          'majujaya_bot',
          '1122334455',
          '9988776655',
          'imap.majujaya.test',
          'cs-imap-user',
          'mobichat_api_key',
        ]) {
          expect(body, leak).not.toContain(leak);
        }
        const parsed = JSON.parse(body) as {
          data: {
            conversation?: { channel: Record<string, unknown> };
            contact?: Record<string, unknown>;
          };
        };
        if (parsed.data.conversation) {
          expect(Object.keys(parsed.data.conversation.channel).sort()).toEqual([
            'id',
            'name',
            'type',
          ]);
        }
        if (parsed.data.contact) {
          expect(Object.keys(parsed.data.contact).sort()).toEqual(
            [
              'attributes',
              'channel_handle',
              'channel_type',
              'email',
              'id',
              'name',
              'number',
              'phone',
              'profile_name',
              'tags',
              'wa_username',
            ].sort(),
          );
          expect(parsed.data.contact.channel_handle).toBe(SENDERS[type].handle);
        }
      }
    },
  );
});

describe('format MobiChat & key (fokus 2–3)', () => {
  it('endpoint MobiChat tidak menerima apa pun dari channel non-WhatsApp, termasuk API key tersisip', async () => {
    const telegram = await addChannel('telegram');
    const { secret } = await createKey();
    await addWebhook({
      events: ['message.received'],
      format: 'mobichat',
      mobichat: { apiKey: secret },
    });
    await call(harness.app, 'PUT', botUrl(telegram), ON, {
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    await receive('telegram', telegram, 'Halo');
    // Dipaksa ke bot pun body MobiChat (yang membawa key) tidak dibangun.
    await harness.db
      .update(conversations)
      .set({ status: 'bot', botAwaitingSince: new Date() })
      .where(eq(conversations.channelId, telegram));
    await receive('telegram', telegram, 'Halo lagi');
    await tick();
    expect(received).toHaveLength(0);
  });

  it('key tidak mengubah status percakapan Telegram yang dipegang agen (handoff no-op, selesai 409)', async () => {
    const telegram = await addChannel('telegram');
    await receive('telegram', telegram, 'Halo');
    const conversation = await latestConversation(telegram);
    await harness.db
      .update(conversations)
      .set({ status: 'served', assigneeUserId: owner.session.user.id })
      .where(eq(conversations.id, conversation.id));
    const { secret } = await createKey();
    const handoff = await bearer(
      secret,
      apiPath(API_ROUTES.publicApi.handoff, { conversationId: conversation.id }),
    );
    expect(handoff.statusCode, handoff.body).toBe(200);
    expect(handoff.json<{ changed: boolean }>().changed).toBe(false);
    expect(await latestConversation(telegram)).toMatchObject({
      status: 'served',
      assigneeUserId: owner.session.user.id,
    });
  });
});

describe('kejadian keamanan bot_enabled (fokus 4)', () => {
  it.each(['telegram', 'email', 'messenger', 'instagram'] as const)(
    'Admin menyalakan bot channel %s → bot_enabled (warning) di ringkasan keamanan',
    async (type) => {
      const channelId = await addChannel(type);
      const admin = await insertUser(harness.db, organizationId, {
        role: 'admin',
        email: `admin.${type}@review.test`,
        passwordHash: await hasher.hash(PASSWORD),
      });
      const session = await login(harness.app, { email: admin.email, password: PASSWORD });
      const put = await call(harness.app, 'PUT', botUrl(channelId), ON, {
        cookie: session.cookie,
        csrf: session.csrf,
      });
      expect(put.statusCode, put.body).toBe(200);
      const summary = await call(harness.app, 'GET', API_ROUTES.audit.securitySummary, undefined, {
        cookie: owner.cookie,
      });
      expect(summary.statusCode, summary.body).toBe(200);
      const events = securitySummaryResponseSchema
        .parse(summary.json())
        .events.filter((event) => event.kind === 'bot_enabled');
      expect(events).toHaveLength(1);
      expect(events[0]?.severity).toBe('warning');
    },
  );
});

describe('temuan yang sudah diperbaiki', () => {
  // B1 (Sedang, DIPERBAIKI: `data.message.email.sender_verification`): verifikasi pengirim email
  // dulu tidak ikut ke bot. Manusia di inbox melihat label
  // "pengirim tidak diverifikasi"/peringatan DMARC; bot yang menerima `message.received` lewat
  // webhook TIDAK mendapat sinyal itu, padahal identitas kontak email = alamat `From` (bisa
  // dipalsukan). Nama isian yang diharapkan di sini hanya usulan — sesuaikan bila kontrak memilih
  // nama lain, tetapi asersinya tetap: verifikasi `fail` harus terlihat di body.
  it('B1: body native message.received email memuat hasil verifikasi pengirim', async () => {
    const channelId = await addChannel('email');
    await addWebhook({ events: ['message.received'] });
    await receive('email', channelId, 'Tolong ganti paket saya', 'fail');
    await tick();
    expect(received).toHaveLength(1);
    const body = JSON.parse(received[0]!.body) as {
      data: { message: { email?: { sender_verification?: string } } };
    };
    expect(body.data.message.email?.sender_verification).toBe('fail');
  });
});

describe('putaran 2 — penjaga perbaikan B1–B3', () => {
  it('B1: email fail di percakapan bot → antrian; bot "hanya saat bot" tidak menerimanya; agen tetap dapat push antrian', async () => {
    const channelId = await addChannel('email');
    await addWebhook({ events: ['message.received'], botOnly: true });
    await call(harness.app, 'PUT', botUrl(channelId), ON, {
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    await receive('email', channelId, 'Halo', 'pass');
    const held = await latestConversation(channelId);
    expect(held.status).toBe('bot');
    // Kirim sekarang (endpoint "hanya saat bot" dinilai SAAT DISPATCH).
    await tick();
    notified.length = 0;

    await receive('email', channelId, 'Isolir layanan saya sekarang', 'fail');
    expect(await latestConversation(channelId)).toMatchObject({ id: held.id, status: 'unserved' });
    // Push "pesan baru" tetap diantrekan; worker notifikasi membaca status SAAT ITU (`unserved` →
    // penerima antrian, `notifications.ts` cabang `queue`).
    expect(notified).toEqual([{ kind: 'message', conversationId: held.id }]);

    await tick();
    const texts = received.map(
      (item) =>
        (JSON.parse(item.body) as { data: { message: { text: string } } }).data.message.text,
    );
    // Endpoint bot ("hanya saat bot") menerima pesan `pass`, TIDAK menerima pesan palsu.
    expect(texts).toEqual(['Halo']);
  });

  it('B1: email unverified tetap ke bot tetapi berlabel `unverified` (bukan `pass`)', async () => {
    const channelId = await addChannel('email');
    await addWebhook({ events: ['message.received'] });
    await call(harness.app, 'PUT', botUrl(channelId), ON, {
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    await receive('email', channelId, 'Halo', 'unverified');
    expect((await latestConversation(channelId)).status).toBe('bot');
    await tick();
    const body = JSON.parse(received[0]!.body) as {
      data: { message: { email: { sender_verification: string } } };
    };
    expect(body.data.message.email.sender_verification).toBe('unverified');
  });

  it('B2: semua rute MobiChat → 404 IDENTIK dengan nomor yang tidak ada (tanpa oracle jenis channel)', async () => {
    const channelId = await addChannel('telegram');
    await receive('telegram', channelId, 'Halo');
    const conversation = await latestConversation(channelId);
    const { secret } = await createKey([
      'conversations:read',
      'conversations:write',
      'messages:read',
      'messages:send',
      'contacts:write',
    ]);
    const missing = conversation.number + 100_000;
    const asKey = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) =>
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
    const cases = (n: number): ['GET' | 'POST' | 'PUT', string, unknown][] => [
      ['GET', `${MOBICHAT_ROUTES.messages}?conversation_id=${String(n)}&limit=5`, undefined],
      ['POST', MOBICHAT_ROUTES.messages, { conversation_id: n, messages: [{ message_text: 'x' }] }],
      ['GET', `${MOBICHAT_ROUTES.conversationStatus}?conversation_id=${String(n)}`, undefined],
      ['POST', MOBICHAT_ROUTES.conversationStatus, { conversation_id: n, status: 'resolved' }],
      ['POST', MOBICHAT_ROUTES.unassignAgent, { conversation_id: n }],
      ['POST', MOBICHAT_ROUTES.agents, { conversation_id: n, agent_id: owner.session.user.id }],
      ['POST', MOBICHAT_ROUTES.notes, { conversation_id: n, notes: 'catatan' }],
      ['PUT', MOBICHAT_ROUTES.contacts, { conversation_id: n, name: 'Nama Baru' }],
      ['POST', MOBICHAT_ROUTES.botReply, { conversation_id: n, message_text: 'x' }],
    ];
    const real = cases(conversation.number);
    const ghost = cases(missing);
    for (const [index, [method, url, body]] of real.entries()) {
      const actual = await asKey(method, url, body);
      const [gMethod, gUrl, gBody] = ghost[index]!;
      const expected = await asKey(gMethod, gUrl, gBody);
      expect(expected.statusCode, `${gMethod} ${gUrl} ${expected.body}`).toBe(404);
      expect(actual.statusCode, `${method} ${url} ${actual.body}`).toBe(404);
      expect(actual.body, `${method} ${url}`).toBe(expected.body);
    }
    // Tidak ada efek samping di percakapan Telegram.
    const outbound = await harness.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.direction, 'outbound')));
    expect(outbound).toHaveLength(0);
    expect(await latestConversation(channelId)).toMatchObject({
      status: conversation.status,
      contactId: conversation.contactId,
    });
  });

  it('B3: cakupan diperiksa SEBELUM penerima — Teknisi di luar cakupan dapat 404, bukan 409', async () => {
    const channelId = await addChannel('telegram');
    await call(harness.app, 'PUT', botUrl(channelId), ON, {
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    await receive('telegram', channelId, 'Halo');
    const conversation = await latestConversation(channelId);
    expect(conversation.status).toBe('unserved');
    const teknisi = await insertUser(harness.db, organizationId, {
      role: 'teknisi',
      email: 'teknisi.bot@review.test',
      passwordHash: await hasher.hash(PASSWORD),
    });
    const session = await login(harness.app, { email: teknisi.email, password: PASSWORD });
    const url = apiPath(API_ROUTES.inbox.bot, { conversationId: conversation.id });
    const asTeknisi = await call(
      harness.app,
      'POST',
      url,
      { active: true },
      {
        cookie: session.cookie,
        csrf: session.csrf,
      },
    );
    expect(asTeknisi.statusCode, asTeknisi.body).toBe(404);
    // Pemegang izin tanpa penerima → 409; status tetap.
    const asOwner = await call(
      harness.app,
      'POST',
      url,
      { active: true },
      {
        cookie: owner.cookie,
        csrf: owner.csrf,
      },
    );
    expect(asOwner.statusCode, asOwner.body).toBe(409);
    expect((await latestConversation(channelId)).status).toBe('unserved');
  });
});

describe('putaran 3 — requireVerifiedSender & conversation.bot_resumed (d9766b3)', () => {
  type ResumedBody = {
    event: string;
    data: {
      conversation: Record<string, unknown> & { id: string; status: string };
      contact: Record<string, unknown>;
      actor: Record<string, unknown> | null;
      message:
        | (Record<string, unknown> & {
            text: string | null;
            email: { sender_verification: string | null } | null;
          })
        | null;
    };
  };
  const resumedBodies = () =>
    received
      .map((item) => JSON.parse(item.body) as ResumedBody)
      .filter((body) => body.event === 'conversation.bot_resumed');
  const resume = (conversationId: string, active = true) =>
    call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.bot, { conversationId }),
      { active },
      { cookie: owner.cookie, csrf: owner.csrf },
    );

  it('opsi baru: CS & Supervisor 403, tanpa CSRF 403, nilai tidak berubah', async () => {
    const channelId = await addChannel('email');
    const body = { ...ON, requireVerifiedSender: true };
    for (const role of ['cs', 'supervisor'] as const) {
      const user = await insertUser(harness.db, organizationId, {
        role,
        email: `${role}.p3@review.test`,
        passwordHash: await hasher.hash(PASSWORD),
      });
      const session = await login(harness.app, { email: user.email, password: PASSWORD });
      const denied = await call(harness.app, 'PUT', botUrl(channelId), body, {
        cookie: session.cookie,
        csrf: session.csrf,
      });
      expect(denied.statusCode, denied.body).toBe(403);
    }
    const noCsrf = await call(harness.app, 'PUT', botUrl(channelId), body, {
      cookie: owner.cookie,
    });
    expect(noCsrf.statusCode, noCsrf.body).toBe(403);
    const [row] = await harness.db
      .select({ value: channels.botRequireVerifiedSender })
      .from(channels)
      .where(eq(channels.id, channelId));
    expect(row?.value).toBe(false);
  });

  it('CHECK DB: bot_require_verified_sender = true ditolak di channel selain email', async () => {
    const channelId = await addChannel('telegram');
    await expect(
      harness.db
        .update(channels)
        .set({ botRequireVerifiedSender: true })
        .where(eq(channels.id, channelId)),
    ).rejects.toThrow();
  });

  it('worker membaca pengaturan per channel: channel email lain (opsi mati) tetap ke bot', async () => {
    const strict = await addChannel('email');
    const loose = newId();
    await harness.db
      .insert(channels)
      .values({ ...channelValues('email', loose), emailAddress: 'cs2@majujaya.test' });
    await addWebhook({ events: ['message.received'] });
    for (const id of [strict, loose]) {
      const response = await call(harness.app, 'PUT', botUrl(id), ON, {
        cookie: owner.cookie,
        csrf: owner.csrf,
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    const on = await call(
      harness.app,
      'PUT',
      botUrl(strict),
      { ...ON, requireVerifiedSender: true },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(on.statusCode, on.body).toBe(200);
    await receive('email', strict, 'Halo', 'unverified');
    await receive('email', loose, 'Halo', 'unverified');
    expect((await latestConversation(strict)).status).toBe('unserved');
    expect((await latestConversation(loose)).status).toBe('bot');
  });

  it('bot_resumed: minimisasi data — kunci tetap, tanpa ID platform/rahasia/header email mentah', async () => {
    const channelId = await addChannel('email');
    await addWebhook({ events: ['message.received', 'conversation.bot_resumed'] });
    await call(harness.app, 'PUT', botUrl(channelId), ON, {
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    await receive('email', channelId, 'Internet mati', 'unverified');
    const conversation = await latestConversation(channelId);
    expect(conversation.status).toBe('bot');
    // Ke antrian (agen mematikan bot), lalu dikembalikan.
    expect((await resume(conversation.id, false)).statusCode).toBe(200);
    expect((await resume(conversation.id)).statusCode).toBe(200);
    await tick();
    const [body] = resumedBodies();
    expect(body).toBeDefined();
    const raw = JSON.stringify(body);
    for (const forbidden of [
      FAKE_SECRET,
      'imap.majujaya.test',
      'cs-imap-user',
      'mobichat_api_key',
      'inReplyTo',
      'references',
      'hasHtml',
      'metaMediaId',
      'meta_media_id',
      'external_user_id',
      'wa_bsuid',
      owner.session.user.email,
    ]) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
    expect(Object.keys(body!.data).sort()).toEqual(['actor', 'contact', 'conversation', 'message']);
    expect(Object.keys(body!.data.actor ?? {}).sort()).toEqual(['id', 'name']);
    expect(body!.data.message?.text).toBe('Internet mati');
    expect(body!.data.message?.email?.sender_verification).toBe('unverified');
  });

  it('bot_resumed: endpoint MobiChat juga tidak bisa melanggan lewat UBAH (PATCH events)', async () => {
    const { secret } = await createKey();
    const created = await call(
      harness.app,
      'POST',
      API_ROUTES.outgoingWebhooks.list,
      {
        url: `${receiverOrigin}/mobichat`,
        events: ['message.received'],
        format: 'mobichat',
        mobichat: { apiKey: secret },
        confirmation: await confirmationFor(),
      },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<{ webhook: { id: string } }>().webhook.id;
    const patched = await call(
      harness.app,
      'PATCH',
      apiPath(API_ROUTES.outgoingWebhooks.webhook, { webhookId: id }),
      { events: ['message.received', 'conversation.bot_resumed'] },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(patched.statusCode, patched.body).toBe(400);
  });

  // P3-1 (Sedang): "Kembalikan ke bot" meneruskan email PALSU (`fail`) yang belum dibalas ke bot
  // lewat `conversation.bot_resumed`. Ini melewati jaminan worker B1 ("email `fail` tidak pernah
  // dilayani bot"), yang sengaja tidak bergantung pada kepatuhan bot ke kontrak. Diharapkan: ditolak
  // 409, ATAU `data.message` tidak memuat pesan itu (`null`).
  it('P3-1: email `fail` yang belum dibalas tidak diteruskan ke bot saat dikembalikan', async () => {
    const channelId = await addChannel('email');
    await addWebhook({
      events: ['message.received', 'conversation.bot_resumed'],
      botOnly: true,
    });
    await call(harness.app, 'PUT', botUrl(channelId), ON, {
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    await receive('email', channelId, 'Isolir layanan saya sekarang', 'fail');
    const conversation = await latestConversation(channelId);
    expect(conversation.status).toBe('unserved');
    await resume(conversation.id);
    await tick();
    const texts = resumedBodies().map((body) => body.data.message?.text ?? null);
    expect(texts).not.toContain('Isolir layanan saya sekarang');
  });

  // P3-1 (Sedang), varian P2-1: channel Email dengan `requireVerifiedSender` — `unverified` yang
  // belum dibalas juga diteruskan ke bot lewat `conversation.bot_resumed`.
  it('P3-1: requireVerifiedSender — email `unverified` yang belum dibalas tidak diteruskan ke bot', async () => {
    const channelId = await addChannel('email');
    await addWebhook({
      events: ['message.received', 'conversation.bot_resumed'],
      botOnly: true,
    });
    const on = await call(
      harness.app,
      'PUT',
      botUrl(channelId),
      { ...ON, requireVerifiedSender: true },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(on.statusCode, on.body).toBe(200);
    await receive('email', channelId, 'Ganti paket saya', 'unverified');
    const conversation = await latestConversation(channelId);
    expect(conversation.status).toBe('unserved');
    await resume(conversation.id);
    await tick();
    const texts = resumedBodies().map((body) => body.data.message?.text ?? null);
    expect(texts).not.toContain('Ganti paket saya');
  });
});
