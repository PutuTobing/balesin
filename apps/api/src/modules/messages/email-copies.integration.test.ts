/**
 * Tahap 9.0 — Cc/Bcc balasan channel Email (DECISIONS 2026-11-22, KONTRAK-API-INBOX "Cc/Bcc channel
 * Email"): alamat yang sudah ada di utas = `inbox.reply`; alamat BARU = memulai percakapan
 * (`inbox.initiate` + jatah harian per alamat, API key `messages:initiate`); maks. 10 alamat;
 * diaudit dengan alamat tersamar. Juga: DTO Kepada/Cc/alamat tujuan/Balas semua, saringan "Alamat
 * tujuan", dan `ChannelSummary.emailAddresses`. Postgres + Redis sungguhan; SMTP tidak dipanggil.
 */
import { randomUUID } from 'node:crypto';

import {
  auditLogs,
  channels,
  contacts,
  conversations,
  messages,
  newId,
  type MessageExtras,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  channelSummaryListResponseSchema,
  conversationListResponseSchema,
  createApiKeyResponseSchema,
  messageListResponseSchema,
  messageResponseSchema,
  type ApiKeyScope,
} from '@balesin/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRateLimiter } from '../../http/rate-limit';
import { createPasswordHasher } from '../auth/password-hasher';
import {
  call,
  completeSetup,
  confirmationFor,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { INITIATE_USER_RULE } from './outbound.routes';

const PASSWORD = 'sandi-uji-cc-bcc-email-01';
const CHANNEL_ADDRESS = 'cs@majujaya.test';
const ALIAS = 'billing@majujaya.test';

let harness: IntegrationHarness;
let owner: SignedIn;
let cs: SignedIn;
let organizationId: string;
let emailChannelId: string;
let telegramChannelId: string;
const hasher = createPasswordHasher();
let sequence = 0;

/** Percakapan Email terbuka + satu email masuk (Kepada/Cc seperti diberikan). */
async function emailConversation(
  inbound: { to?: string[]; cc?: string[]; recipient?: string | null } = {},
) {
  sequence += 1;
  const customer = `pelanggan${String(sequence)}@pelanggan.test`;
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'email',
      externalUserId: customer,
      channelHandle: customer,
    })
    .returning();
  const at = new Date();
  const [conversation] = await harness.db
    .insert(conversations)
    .values({
      organizationId,
      contactId: contact!.id,
      channelId: emailChannelId,
      status: 'served',
      assigneeUserId: cs.session.user.id,
      lastMessageAt: at,
      lastInboundAt: at,
    })
    .returning();
  const extras: MessageExtras = {
    email: {
      subject: 'Tagihan bulan ini',
      inReplyTo: null,
      references: [],
      authWarning: false,
      senderVerification: 'pass',
      skippedAttachments: 0,
      hasHtml: false,
      to: inbound.to ?? [CHANNEL_ADDRESS],
      cc: inbound.cc ?? [],
      replyAll: [...(inbound.to ?? []), ...(inbound.cc ?? [])].filter(
        (address) => address !== CHANNEL_ADDRESS && address !== ALIAS,
      ),
    },
  };
  await harness.db.insert(messages).values({
    organizationId,
    conversationId: conversation!.id,
    contactId: contact!.id,
    channelId: emailChannelId,
    direction: 'inbound',
    senderKind: 'customer',
    type: 'text',
    rawType: 'email',
    wamid: `${randomUUID()}@pelanggan.test`,
    text: 'Mohon dicek tagihannya.',
    extras,
    emailRecipient: inbound.recipient === undefined ? CHANNEL_ADDRESS : inbound.recipient,
    occurredAt: at,
    receivedAt: at,
  });
  return { id: conversation!.id, customer };
}

const reply = (copies: { cc?: string[]; bcc?: string[] } = {}) => ({
  type: 'text' as const,
  clientMessageId: randomUUID(),
  text: 'Baik, sudah kami cek.',
  ...copies,
});

function sendAs(signed: SignedIn, conversationId: string, body: unknown) {
  return call(harness.app, 'POST', apiPath(API_ROUTES.inbox.messages, { conversationId }), body, {
    cookie: signed.cookie,
    csrf: signed.csrf,
  });
}

async function key(scopes: ApiKeyScope[]) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    { name: `Bot ${scopes.join('+')}`, scopes, confirmation: await confirmationFor() },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return createApiKeyResponseSchema.parse(response.json()).secret;
}

function sendAsKey(secret: string, conversationId: string, body: Record<string, unknown>) {
  const { clientMessageId: _ignored, ...payload } = body;
  return harness.app.inject({
    method: 'POST',
    url: apiPath(API_ROUTES.publicApi.messages, { conversationId }),
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

async function outboundRows(conversationId: string) {
  return harness.db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.direction, 'outbound')));
}

async function copyAudits() {
  return harness.db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, 'message.email_copies_sent'));
}

const initiationCount = async (userId: string) =>
  (
    await createRateLimiter(harness.redis, { prefix: harness.redisPrefix }).peek(
      INITIATE_USER_RULE,
      userId,
    )
  ).count;

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  emailChannelId = newId();
  telegramChannelId = newId();
  await harness.db.insert(channels).values([
    {
      id: emailChannelId,
      organizationId,
      type: 'email',
      name: 'CS Email',
      emailAddress: CHANNEL_ADDRESS,
      emailAliases: [ALIAS],
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
    },
    {
      id: telegramChannelId,
      organizationId,
      type: 'telegram',
      name: 'CS Telegram',
      tgBotId: '123456789',
      tgBotUsername: 'majujaya_bot',
      tgBotTokenEncrypted: 'x',
      tgWebhookSecretEncrypted: 'x',
    },
  ]);
  const user = await insertUser(harness.db, organizationId, {
    role: 'cs',
    email: `cs.${newId().slice(-6)}@cc.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  cs = await login(harness.app, { email: user.email, password: PASSWORD });
});
afterAll(async () => {
  await harness?.close();
});

describe('Cc/Bcc ke alamat yang SUDAH ada di utas', () => {
  it('CS boleh (inbox.reply): tersimpan di catatan pesan keluar, jatah tidak terpotong, diaudit tersamar', async () => {
    const thread = await emailConversation({
      to: [CHANNEL_ADDRESS, 'andi@pelanggan.test'],
      cc: ['Sari@Pelanggan.test'.toLowerCase()],
    });
    const response = await sendAs(
      cs,
      thread.id,
      reply({ cc: ['Andi@Pelanggan.test'], bcc: ['sari@pelanggan.test', thread.customer] }),
    );
    expect(response.statusCode, response.body).toBe(202);
    const message = messageResponseSchema.parse(response.json()).message;
    // Pelanggan (penerima utama) dibuang dari Bcc; huruf kecil.
    expect(message.email).toMatchObject({
      to: [thread.customer],
      cc: ['andi@pelanggan.test'],
      bcc: ['sari@pelanggan.test'],
      replyAll: [],
      recipient: null,
    });
    const [row] = await outboundRows(thread.id);
    expect(row!.extras.email).toMatchObject({
      cc: ['andi@pelanggan.test'],
      bcc: ['sari@pelanggan.test'],
    });
    expect(await initiationCount(cs.session.user.id)).toBe(0);

    const [audit] = await copyAudits();
    expect(audit).toMatchObject({
      actorUserId: cs.session.user.id,
      targetType: 'conversation',
      targetId: thread.id,
    });
    expect(audit!.metadata).toMatchObject({
      cc: ['a***@pelanggan.test'],
      bcc: ['s***@pelanggan.test'],
      newCount: 0,
      actor: 'user',
      messageId: row!.id,
    });
    expect(JSON.stringify(audit!.metadata)).not.toContain('andi@');
  });

  it('tanpa Cc/Bcc tidak ada catatan email baru maupun audit (perilaku lama tetap)', async () => {
    const thread = await emailConversation();
    expect((await sendAs(cs, thread.id, reply())).statusCode).toBe(202);
    const [row] = await outboundRows(thread.id);
    expect(row!.extras.email).toBeUndefined();
    expect(await copyAudits()).toHaveLength(0);
  });
});

describe('Cc/Bcc ke alamat BARU = memulai percakapan', () => {
  it('CS ditolak 403 + diaudit (inbox.initiate.email_recipient), tidak ada pesan tersimpan', async () => {
    const thread = await emailConversation({ cc: ['andi@pelanggan.test'] });
    const response = await sendAs(
      cs,
      thread.id,
      reply({ cc: ['andi@pelanggan.test', 'orang.baru@lain.test'] }),
    );
    expect(response.statusCode, response.body).toBe(403);
    const error = response.json<{ error: { code: string; message: string } }>().error;
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe(
      'Ada alamat Cc/Bcc yang belum pernah ada di utas email ini. Menambah penerima baru butuh izin memulai percakapan. Hapus alamat baru itu atau minta bantuan Supervisor.',
    );
    expect(await outboundRows(thread.id)).toHaveLength(0);
    const denied = await harness.db
      .select({ targetId: auditLogs.targetId })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'auth.access.denied'),
          eq(auditLogs.actorUserId, cs.session.user.id),
        ),
      );
    expect(denied.map((row) => row.targetId)).toEqual(['inbox.initiate.email_recipient']);
    expect(await copyAudits()).toHaveLength(0);
  });

  it('Owner boleh: 202, jatah mulai-percakapan terpotong SATU per alamat baru, audit newCount', async () => {
    const thread = await emailConversation({ cc: ['andi@pelanggan.test'] });
    const response = await sendAs(
      owner,
      thread.id,
      reply({ cc: ['andi@pelanggan.test', 'baru1@lain.test'], bcc: ['baru2@lain.test'] }),
    );
    expect(response.statusCode, response.body).toBe(202);
    expect(await initiationCount(owner.session.user.id)).toBe(2);
    const [audit] = await copyAudits();
    expect(audit!.metadata).toMatchObject({ newCount: 2 });
  });

  it('pesan keluar yang GAGAL tidak membuat alamatnya dianggap ada di utas', async () => {
    const thread = await emailConversation();
    const [conversationRow] = await harness.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, thread.id));
    const at = new Date();
    await harness.db.insert(messages).values({
      organizationId,
      conversationId: thread.id,
      contactId: conversationRow!.contactId,
      channelId: emailChannelId,
      direction: 'outbound',
      senderKind: 'agent',
      senderUserId: owner.session.user.id,
      type: 'text',
      text: 'Percobaan',
      status: 'failed',
      failureReason: 'channel_rejected',
      statusUpdatedAt: at,
      sendAttempts: 1,
      occurredAt: at,
      extras: {
        email: {
          subject: null,
          inReplyTo: null,
          references: [],
          authWarning: false,
          skippedAttachments: 0,
          hasHtml: false,
          to: [thread.customer],
          cc: ['gagal@lain.test'],
          bcc: [],
        },
      },
    });
    expect((await sendAs(cs, thread.id, reply({ cc: ['gagal@lain.test'] }))).statusCode).toBe(403);
  });

  it('kirim ulang pesan gagal ber-Cc alamat baru: CS 403 (tetap gagal), Owner 202 + jatah + audit retry', async () => {
    const thread = await emailConversation();
    const [conversationRow] = await harness.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, thread.id));
    const at = new Date();
    const [failed] = await harness.db
      .insert(messages)
      .values({
        organizationId,
        conversationId: thread.id,
        contactId: conversationRow!.contactId,
        channelId: emailChannelId,
        direction: 'outbound',
        senderKind: 'agent',
        senderUserId: owner.session.user.id,
        type: 'text',
        text: 'Terlampir rinciannya.',
        status: 'failed',
        failureReason: 'channel_rejected',
        statusUpdatedAt: at,
        sendAttempts: 1,
        occurredAt: at,
        extras: {
          email: {
            subject: null,
            inReplyTo: null,
            references: [],
            authWarning: false,
            skippedAttachments: 0,
            hasHtml: false,
            to: [thread.customer],
            cc: [],
            bcc: ['baru@lain.test'],
          },
        },
      })
      .returning({ id: messages.id });
    const retry = (signed: SignedIn) =>
      call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.inbox.retry, { messageId: failed!.id }),
        undefined,
        { cookie: signed.cookie, csrf: signed.csrf },
      );
    const denied = await retry(cs);
    expect(denied.statusCode, denied.body).toBe(403);
    const [still] = await harness.db
      .select({ status: messages.status })
      .from(messages)
      .where(eq(messages.id, failed!.id));
    expect(still!.status).toBe('failed');

    const ok = await retry(owner);
    expect(ok.statusCode, ok.body).toBe(202);
    expect(await initiationCount(owner.session.user.id)).toBe(1);
    const [audit] = await copyAudits();
    expect(audit!.metadata).toMatchObject({ retry: true, newCount: 1, bcc: ['b***@lain.test'] });
  });

  it('jatah harian habis → 429, tidak ada pesan tersimpan', async () => {
    const limiter = createRateLimiter(harness.redis, { prefix: harness.redisPrefix });
    for (let index = 0; index < INITIATE_USER_RULE.limit; index += 1) {
      await limiter.consume(INITIATE_USER_RULE, owner.session.user.id);
    }
    const thread = await emailConversation();
    const response = await sendAs(owner, thread.id, reply({ cc: ['baru@lain.test'] }));
    expect(response.statusCode, response.body).toBe(429);
    expect(await outboundRows(thread.id)).toHaveLength(0);
  });
});

describe('review 9.0 R1/R8', () => {
  it('R1: jatah tersisa 1, Cc 2 alamat baru → 429 dan TIDAK ada unit yang hilang', async () => {
    const limiter = createRateLimiter(harness.redis, { prefix: harness.redisPrefix });
    for (let index = 0; index < INITIATE_USER_RULE.limit - 1; index += 1) {
      await limiter.consume(INITIATE_USER_RULE, owner.session.user.id);
    }
    const thread = await emailConversation();
    const response = await sendAs(
      owner,
      thread.id,
      reply({ cc: ['baru1@lain.test', 'baru2@lain.test'] }),
    );
    expect(response.statusCode, response.body).toBe(429);
    expect(await outboundRows(thread.id)).toHaveLength(0);
    expect(await initiationCount(owner.session.user.id)).toBe(INITIATE_USER_RULE.limit - 1);
    // Satu alamat baru masih muat.
    expect((await sendAs(owner, thread.id, reply({ cc: ['baru1@lain.test'] }))).statusCode).toBe(
      202,
    );
  });

  it('R8: alamat/alias channel Email LAIN milik organisasi → 400', async () => {
    await harness.db.insert(channels).values({
      id: newId(),
      organizationId,
      type: 'email',
      name: 'Billing Email',
      emailAddress: 'keuangan@majujaya.test',
      emailAliases: ['tagihan@majujaya.test'],
      emailFromName: 'Keuangan',
      emailImapHost: 'imap.majujaya.test',
      emailImapPort: 993,
      emailImapSecurity: 'ssl',
      emailImapUsername: 'keuangan',
      emailImapPasswordEncrypted: 'x',
      emailImapFolder: 'INBOX',
      emailPollIntervalMinutes: 5,
      emailMarkAsRead: false,
      emailSmtpMode: 'system',
    });
    const thread = await emailConversation();
    for (const address of ['keuangan@majujaya.test', 'tagihan@majujaya.test']) {
      const response = await sendAs(owner, thread.id, reply({ bcc: [address] }));
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json<{ error: { message: string } }>().error.message).toBe(
        'Alamat itu milik channel Email lain di Balesin. Teruskan lewat percakapan di channel itu, bukan lewat Cc/Bcc.',
      );
    }
  });

  it('S1: tembusan dihitung batas harian; header email masuk tanpa verifikasi bukan daftar izin', async () => {
    const thread = await emailConversation({ cc: ['andi@pelanggan.test'] });
    await harness.db
      .update(messages)
      .set({
        extras: sql`jsonb_set(${messages.extras}, '{email,senderVerification}', '"unverified"')`,
      })
      .where(eq(messages.conversationId, thread.id));
    expect((await sendAs(cs, thread.id, reply({ cc: ['andi@pelanggan.test'] }))).statusCode).toBe(
      403,
    );
    expect(
      (await sendAs(owner, thread.id, reply({ cc: ['andi@pelanggan.test'] }))).statusCode,
    ).toBe(202);
    const limits = await call(harness.app, 'GET', API_ROUTES.sendingLimits.settings, undefined, {
      cookie: owner.cookie,
    });
    expect(limits.statusCode, limits.body).toBe(200);
    expect(limits.json<{ limits: { sentLast24Hours: number } }>().limits.sentLast24Hours).toBe(2);
  });
});

describe('validasi', () => {
  it('lebih dari 10 alamat tambahan (Cc + Bcc) → 400 berpesan Indonesia', async () => {
    const thread = await emailConversation();
    const many = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => `${prefix}${String(index)}@lain.test`);
    const response = await sendAs(
      owner,
      thread.id,
      reply({ cc: many('cc', 6), bcc: many('bcc', 5) }),
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toBe(
      'Paling banyak 10 alamat tambahan (Cc + Bcc) per balasan.',
    );
    const single = await sendAs(owner, thread.id, reply({ cc: many('cc', 11) }));
    expect(single.statusCode).toBe(400);
    expect(await outboundRows(thread.id)).toHaveLength(0);
  });

  it('format alamat salah, alamat/alias channel sendiri, dan channel selain Email → 400', async () => {
    const thread = await emailConversation();
    expect((await sendAs(owner, thread.id, reply({ cc: ['bukan-alamat'] }))).statusCode).toBe(400);
    expect(
      (await sendAs(owner, thread.id, reply({ cc: ['a@b.test\r\nBcc: x@y.test'] }))).statusCode,
    ).toBe(400);
    const own = await sendAs(owner, thread.id, reply({ bcc: [ALIAS] }));
    expect(own.statusCode).toBe(400);
    expect(own.json<{ error: { message: string } }>().error.message).toBe(
      'Alamat channel ini sendiri tidak perlu dimasukkan ke Cc/Bcc.',
    );

    const [contact] = await harness.db
      .insert(contacts)
      .values({ organizationId, channelType: 'telegram', externalUserId: '99887766' })
      .returning();
    const [telegram] = await harness.db
      .insert(conversations)
      .values({
        organizationId,
        contactId: contact!.id,
        channelId: telegramChannelId,
        status: 'served',
        lastMessageAt: new Date(),
        lastInboundAt: new Date(),
      })
      .returning();
    const other = await sendAs(owner, telegram!.id, reply({ cc: ['andi@pelanggan.test'] }));
    expect(other.statusCode).toBe(400);
    expect(other.json<{ error: { message: string } }>().error.message).toBe(
      'Cc dan Bcc hanya bisa dipakai di channel Email.',
    );
  });
});

describe('API key', () => {
  it('messages:send saja: Cc ke alamat lama 202, alamat baru 403 (scope messages:initiate)', async () => {
    const secret = await key(['messages:send']);
    const thread = await emailConversation({ cc: ['andi@pelanggan.test'] });
    expect(
      (await sendAsKey(secret, thread.id, reply({ cc: ['andi@pelanggan.test'] }))).statusCode,
    ).toBe(202);
    const denied = await sendAsKey(secret, thread.id, reply({ bcc: ['baru@lain.test'] }));
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json<{ error: { message: string } }>().error.message).toContain(
      'messages:initiate',
    );
    const audits = await copyAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ actor: 'apiKey' });
    expect(audits[0]!.actorUserId).toBeNull();
  });

  it('messages:send + messages:initiate: alamat baru 202', async () => {
    const secret = await key(['messages:send', 'messages:initiate']);
    const thread = await emailConversation();
    expect((await sendAsKey(secret, thread.id, reply({ cc: ['baru@lain.test'] }))).statusCode).toBe(
      202,
    );
  });
});

describe('DTO pesan masuk, saringan Alamat tujuan, ringkasan channel', () => {
  it('email masuk menampilkan Kepada/Cc/alamat tujuan/Balas semua; data lama kosong', async () => {
    const thread = await emailConversation({
      to: [ALIAS, 'andi@pelanggan.test'],
      cc: ['sari@pelanggan.test'],
      recipient: ALIAS,
    });
    const response = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.messages, { conversationId: thread.id }),
      undefined,
      { cookie: cs.cookie },
    );
    expect(response.statusCode, response.body).toBe(200);
    const [inbound] = messageListResponseSchema.parse(response.json()).messages;
    expect(inbound!.email).toMatchObject({
      to: [ALIAS, 'andi@pelanggan.test'],
      cc: ['sari@pelanggan.test'],
      bcc: [],
      recipient: ALIAS,
      replyAll: ['andi@pelanggan.test', 'sari@pelanggan.test'],
    });

    // Data lama (sebelum tahap 9.0): tanpa isian baru → daftar kosong, alamat tujuan null.
    await harness.db
      .update(messages)
      .set({
        emailRecipient: null,
        extras: {
          email: {
            subject: 'Lama',
            inReplyTo: null,
            references: [],
            authWarning: false,
            skippedAttachments: 0,
            hasHtml: false,
          },
        },
      })
      .where(eq(messages.conversationId, thread.id));
    const old = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.messages, { conversationId: thread.id }),
      undefined,
      { cookie: cs.cookie },
    );
    expect(messageListResponseSchema.parse(old.json()).messages[0]!.email).toMatchObject({
      to: [],
      cc: [],
      bcc: [],
      replyAll: [],
      recipient: null,
    });
  });

  it('saringan emailRecipient hanya memuat percakapan ke alias itu; alamat tidak sah → 400', async () => {
    const billing = await emailConversation({ to: [ALIAS], recipient: ALIAS });
    await emailConversation({ to: [CHANNEL_ADDRESS], recipient: CHANNEL_ADDRESS });
    const response = await call(
      harness.app,
      'GET',
      `${API_ROUTES.inbox.conversations}?emailRecipient=${encodeURIComponent('Billing@MajuJaya.test')}`,
      undefined,
      { cookie: owner.cookie },
    );
    expect(response.statusCode, response.body).toBe(200);
    const list = conversationListResponseSchema.parse(response.json()).conversations;
    expect(list.map((item) => item.id)).toEqual([billing.id]);

    const counts = await call(
      harness.app,
      'GET',
      `${API_ROUTES.inbox.counts}?emailRecipient=${encodeURIComponent(ALIAS)}`,
      undefined,
      { cookie: owner.cookie },
    );
    expect(counts.statusCode, counts.body).toBe(200);

    const bad = await call(
      harness.app,
      'GET',
      `${API_ROUTES.inbox.conversations}?emailRecipient=bukan-alamat`,
      undefined,
      { cookie: owner.cookie },
    );
    expect(bad.statusCode).toBe(400);
  });

  it('GET /channels: channel Email memuat alamat utama + alias, channel lain kosong', async () => {
    const response = await call(harness.app, 'GET', API_ROUTES.channels.list, undefined, {
      cookie: owner.cookie,
    });
    expect(response.statusCode, response.body).toBe(200);
    const list = channelSummaryListResponseSchema.parse(response.json()).channels;
    expect(list.find((item) => item.id === emailChannelId)?.emailAddresses).toEqual([
      CHANNEL_ADDRESS,
      ALIAS,
    ]);
    expect(list.find((item) => item.id === telegramChannelId)?.emailAddresses).toEqual([]);
  });
});
