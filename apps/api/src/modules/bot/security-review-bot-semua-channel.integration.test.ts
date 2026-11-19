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
import { channels, conversations, newId, webhookEvents, type NewChannel } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
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

async function createKey() {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    {
      name: 'Bot review',
      scopes: ['messages:send', 'conversations:write'],
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

describe('temuan terbuka', () => {
  // B1 (Sedang): verifikasi pengirim email tidak ikut ke bot. Manusia di inbox melihat label
  // "pengirim tidak diverifikasi"/peringatan DMARC; bot yang menerima `message.received` lewat
  // webhook TIDAK mendapat sinyal itu, padahal identitas kontak email = alamat `From` (bisa
  // dipalsukan). Nama isian yang diharapkan di sini hanya usulan — sesuaikan bila kontrak memilih
  // nama lain, tetapi asersinya tetap: verifikasi `fail` harus terlihat di body.
  it.fails('B1: body native message.received email memuat hasil verifikasi pengirim', async () => {
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
