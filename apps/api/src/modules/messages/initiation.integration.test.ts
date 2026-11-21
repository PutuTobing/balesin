/**
 * Kirim ke percakapan yang sudah selesai = MEMULAI percakapan (audit akhir A1/A6,
 * DECISIONS 2026-11-21): template (WhatsApp) atau channel tanpa jendela 24 jam (Email/Telegram) ke
 * percakapan `resolved` butuh `inbox.initiate` (+ jatah harian `mulai-percakapan`) untuk pengguna, atau
 * scope `messages:initiate` untuk API key. Membalas percakapan `resolved` di channel berjendela selama
 * jendela terbuka tetap = balasan biasa. Postgres + Redis sungguhan; Graph API tidak dipanggil.
 */
import { randomUUID } from 'node:crypto';

import {
  auditLogs,
  broadcastCampaigns,
  channels,
  contacts,
  conversations,
  messageTemplates,
  messages,
  newId,
  type NewChannel,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  createApiKeyResponseSchema,
  type ApiKeyScope,
  type ChannelType,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
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

const WABA = '102290129340398';
const PASSWORD = 'sandi-uji-mulai-percakapan-01';

let harness: IntegrationHarness;
let owner: SignedIn;
let cs: SignedIn;
let organizationId: string;
const channelIds = new Map<ChannelType, string>();
const hasher = createPasswordHasher();

function channelValues(type: ChannelType, id: string): NewChannel {
  const base = { id, organizationId, type, name: `CS ${type}` };
  switch (type) {
    case 'whatsapp':
      return {
        ...base,
        waPhoneNumberId: '106540352242922',
        waBusinessAccountId: WABA,
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
    default:
      throw new Error(`jenis channel ${type} tidak dipakai tes ini`);
  }
}

let sequence = 0;

/** Percakapan siap pakai (kontak sesuai jenis channel). `windowOpen` hanya bermakna untuk WhatsApp. */
async function conversation(
  type: ChannelType,
  status: 'resolved' | 'served' | 'unserved',
  windowOpen = true,
): Promise<string> {
  sequence += 1;
  const channelId = channelIds.get(type)!;
  const [contact] = await harness.db
    .insert(contacts)
    .values(
      type === 'whatsapp'
        ? {
            organizationId,
            channelType: 'whatsapp',
            waBsuid: `ID.${newId().slice(-10)}`,
            phone: `+62813${String(10_000_000 + sequence)}`,
          }
        : {
            organizationId,
            channelType: type,
            externalUserId: `${type}-${String(sequence)}${type === 'email' ? '@pelanggan.test' : ''}`,
          },
    )
    .returning();
  const at = new Date();
  const [row] = await harness.db
    .insert(conversations)
    .values({
      organizationId,
      contactId: contact!.id,
      channelId,
      status,
      lastMessageAt: at,
      lastInboundAt: at,
      windowExpiresAt:
        type === 'whatsapp' ? new Date(at.getTime() + (windowOpen ? 1 : -1) * 3600_000) : null,
      ...(status === 'resolved' ? { resolvedAt: at } : {}),
    })
    .returning();
  return row!.id;
}

async function template(): Promise<string> {
  const [row] = await harness.db
    .insert(messageTemplates)
    .values({
      organizationId,
      channelId: channelIds.get('whatsapp')!,
      wabaId: WABA,
      metaTemplateId: String(Math.floor(Math.random() * 1e12)),
      name: `t_tagihan_${String(sequence)}_${String(Math.floor(Math.random() * 1e6))}`,
      language: 'id',
      category: 'UTILITY',
      status: 'APPROVED',
      content: {
        parameterFormat: 'positional',
        header: null,
        body: { text: 'Halo {{1}}, tagihan Anda sudah terbit.', examples: { '1': 'Budi' } },
        footer: null,
        buttons: [],
        authentication: null,
      } as never,
      source: 'meta',
    })
    .returning({ id: messageTemplates.id });
  return row!.id;
}

const text = () => ({ type: 'text' as const, clientMessageId: randomUUID(), text: 'Halo Kak' });
const templateBody = async () => ({
  type: 'template' as const,
  clientMessageId: randomUUID(),
  templateId: await template(),
  parameters: { body: { '1': 'Budi' } },
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

async function outboundCount(conversationId: string) {
  return (
    await harness.db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
  ).length;
}

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  channelIds.clear();
  for (const type of ['whatsapp', 'telegram', 'email'] as const) {
    const id = newId();
    channelIds.set(type, id);
    await harness.db.insert(channels).values(channelValues(type, id));
  }
  const user = await insertUser(harness.db, organizationId, {
    role: 'cs',
    email: `cs.${newId().slice(-6)}@mulai.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  cs = await login(harness.app, { email: user.email, password: PASSWORD });
});
afterAll(async () => {
  await harness?.close();
});

describe('A1 — template ke percakapan selesai (sesi pengguna)', () => {
  it('CS 403 FORBIDDEN dengan pesan jelas, tanpa pesan tersimpan; Owner 202 + jatah mulai-percakapan terpotong', async () => {
    const id = await conversation('whatsapp', 'resolved');
    const denied = await sendAs(cs, id, await templateBody());
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: 'FORBIDDEN',
      message:
        'Percakapan ini sudah selesai. Mengirim pesan baru ke percakapan yang sudah selesai butuh izin memulai percakapan.',
    });
    expect(await outboundCount(id)).toBe(0);

    const limiter = createRateLimiter(harness.redis, { prefix: harness.redisPrefix });
    const ok = await sendAs(owner, id, await templateBody());
    expect(ok.statusCode, ok.body).toBe(202);
    expect((await limiter.peek(INITIATE_USER_RULE, owner.session.user.id)).count).toBe(1);
  });

  it('balasan biasa TIDAK terkena: CS teks ke percakapan resolved dalam jendela 24 jam → 202; template ke percakapan terbuka → 202', async () => {
    const resolvedInWindow = await conversation('whatsapp', 'resolved', true);
    expect((await sendAs(cs, resolvedInWindow, text())).statusCode).toBe(202);
    const open = await conversation('whatsapp', 'served', false);
    const response = await sendAs(cs, open, await templateBody());
    expect(response.statusCode, response.body).toBe(202);
    const limiter = createRateLimiter(harness.redis, { prefix: harness.redisPrefix });
    expect((await limiter.peek(INITIATE_USER_RULE, cs.session.user.id)).count).toBe(0);
  });

  it('jatah harian mulai-percakapan habis → 429', async () => {
    const limiter = createRateLimiter(harness.redis, { prefix: harness.redisPrefix });
    for (let index = 0; index < INITIATE_USER_RULE.limit; index += 1) {
      await limiter.consume(INITIATE_USER_RULE, owner.session.user.id);
    }
    const id = await conversation('whatsapp', 'resolved');
    const response = await sendAs(owner, id, await templateBody());
    expect(response.statusCode, response.body).toBe(429);
    expect(await outboundCount(id)).toBe(0);
  });
});

describe('A6 — channel tanpa jendela (Email/Telegram)', () => {
  it.each(['telegram', 'email'] as const)(
    '%s: teks bebas ke percakapan resolved = mulai percakapan (CS 403, Owner 202); percakapan terbuka tetap boleh',
    async (type) => {
      const resolved = await conversation(type, 'resolved');
      const denied = await sendAs(cs, resolved, text());
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
      expect(await outboundCount(resolved)).toBe(0);
      expect((await sendAs(owner, resolved, text())).statusCode).toBe(202);

      const open = await conversation(type, 'unserved');
      expect((await sendAs(cs, open, text())).statusCode).toBe(202);
    },
  );
});

describe('API key — messages:send vs messages:initiate', () => {
  it('messages:send saja: template ke resolved & teks Telegram resolved → 403; balasan dalam jendela tetap 202', async () => {
    const secret = await key(['messages:send']);
    const resolved = await conversation('whatsapp', 'resolved');
    const template = await sendAsKey(secret, resolved, await templateBody());
    expect(template.statusCode, template.body).toBe(403);
    expect(template.json<{ error: { message: string } }>().error.message).toContain(
      'messages:initiate',
    );
    const telegram = await conversation('telegram', 'resolved');
    expect((await sendAsKey(secret, telegram, text())).statusCode).toBe(403);
    // Bot/MobiChat membalas percakapan selesai yang jendelanya masih terbuka: tidak berubah.
    expect((await sendAsKey(secret, resolved, text())).statusCode).toBe(202);
  });

  it('messages:send + messages:initiate: template ke resolved & teks Telegram resolved → 202', async () => {
    const secret = await key(['messages:send', 'messages:initiate']);
    const resolved = await conversation('whatsapp', 'resolved');
    expect((await sendAsKey(secret, resolved, await templateBody())).statusCode).toBe(202);
    const telegram = await conversation('telegram', 'resolved');
    expect((await sendAsKey(secret, telegram, text())).statusCode).toBe(202);
  });

  it('regresi billing: POST /public/messages/template berulang ke nomor yang sama (percakapan resolved) tetap 202', async () => {
    const secret = await key(['messages:initiate']);
    const send = async () =>
      harness.app.inject({
        method: 'POST',
        url: API_ROUTES.publicApi.templateMessage,
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        payload: JSON.stringify({
          channelId: channelIds.get('whatsapp'),
          phone: '+6281300007777',
          templateId: await template(),
          parameters: { body: { '1': 'Budi' } },
        }),
      });
    const first = await send();
    expect(first.statusCode, first.body).toBe(202);
    const second = await send();
    expect(second.statusCode, second.body).toBe(202);
    expect(second.json<{ conversationId: string }>().conversationId).toBe(
      first.json<{ conversationId: string }>().conversationId,
    );
  });
});

describe('A1 (sisa) — buka lagi percakapan selesai', () => {
  const reopen = (signed: SignedIn, conversationId: string) =>
    call(harness.app, 'POST', apiPath(API_ROUTES.inbox.reopen, { conversationId }), undefined, {
      cookie: signed.cookie,
      csrf: signed.csrf,
    });
  const statusOf = async (id: string) =>
    (
      await harness.db
        .select({ status: conversations.status })
        .from(conversations)
        .where(eq(conversations.id, id))
    )[0]?.status;

  it('CS: buka lagi di luar jendela 24 jam → 403 (diaudit), tetap selesai, template tetap ditolak', async () => {
    const id = await conversation('whatsapp', 'resolved', false);
    const denied = await reopen(cs, id);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: 'FORBIDDEN',
      message:
        'Percakapan ini sudah selesai dan pelanggan tidak mengirim pesan dalam 24 jam terakhir. Membuka lagi butuh izin memulai percakapan.',
    });
    expect(await statusOf(id)).toBe('resolved');
    const audits = await harness.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'auth.access.denied'),
          eq(auditLogs.targetId, 'inbox.reopen.stale'),
          eq(auditLogs.actorUserId, cs.session.user.id),
        ),
      );
    expect(audits).toHaveLength(1);
    expect((await sendAs(cs, id, await templateBody())).statusCode).toBe(403);
    expect(await outboundCount(id)).toBe(0);
  });

  it('Owner (inbox.initiate): buka lagi di luar jendela → 200, lalu template → 202', async () => {
    const id = await conversation('whatsapp', 'resolved', false);
    const reopened = await reopen(owner, id);
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(await statusOf(id)).not.toBe('resolved');
    expect((await sendAs(owner, id, await templateBody())).statusCode).toBe(202);
  });

  it('CS: buka lagi dalam jendela 24 jam tetap boleh (kerja normal), lalu membalas', async () => {
    const id = await conversation('whatsapp', 'resolved', true);
    const reopened = await reopen(cs, id);
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(await statusOf(id)).not.toBe('resolved');
    expect((await sendAs(cs, id, text())).statusCode).toBe(202);
  });

  it.each(['telegram', 'email'] as const)(
    '%s: CS buka lagi hanya bila pesan pelanggan terakhir < 24 jam',
    async (type) => {
      const stale = await conversation(type, 'resolved');
      await harness.db
        .update(conversations)
        .set({ lastInboundAt: new Date(Date.now() - 25 * 3600_000) })
        .where(eq(conversations.id, stale));
      expect((await reopen(cs, stale)).statusCode).toBe(403);
      expect(await statusOf(stale)).toBe('resolved');
      expect((await reopen(owner, stale)).statusCode).toBe(200);

      const recent = await conversation(type, 'resolved');
      expect((await reopen(cs, recent)).statusCode).toBe(200);
      expect((await sendAs(cs, recent, text())).statusCode).toBe(202);
    },
  );
});

const DAY = 24 * 3600_000;

async function setLastInbound(conversationId: string, daysAgo: number | null) {
  const at = daysAgo === null ? null : new Date(Date.now() - daysAgo * DAY);
  await harness.db
    .update(conversations)
    .set({
      lastInboundAt: at,
      windowExpiresAt: at ? new Date(at.getTime() + DAY) : null,
    })
    .where(eq(conversations.id, conversationId));
}

describe('P2-R2 — percakapan terbuka yang dingin (> 7 hari tanpa pesan pelanggan)', () => {
  const STALE =
    'Pelanggan tidak mengirim pesan dalam 7 hari terakhir. Mengirim template atau pesan baru ke percakapan ini butuh izin memulai percakapan.';

  it('WhatsApp: template oleh CS ditolak bila > 7 hari / belum pernah; ≤ 7 hari tetap boleh; Owner boleh', async () => {
    const cold = await conversation('whatsapp', 'served');
    await setLastInbound(cold, 8);
    const denied = await sendAs(cs, cold, await templateBody());
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: 'FORBIDDEN',
      message: STALE,
    });
    expect((await sendAs(owner, cold, await templateBody())).statusCode).toBe(202);

    const never = await conversation('whatsapp', 'served');
    await setLastInbound(never, null);
    expect((await sendAs(cs, never, await templateBody())).statusCode).toBe(403);

    const warm = await conversation('whatsapp', 'served');
    await setLastInbound(warm, 3);
    expect((await sendAs(cs, warm, await templateBody())).statusCode).toBe(202);
  });

  it.each(['email', 'telegram'] as const)(
    '%s: teks bebas oleh CS ke percakapan terbuka > 7 hari → 403; ≤ 7 hari → 202',
    async (type) => {
      const cold = await conversation(type, 'unserved');
      await setLastInbound(cold, 8);
      expect((await sendAs(cs, cold, text())).statusCode).toBe(403);
      expect(await outboundCount(cold)).toBe(0);
      const warm = await conversation(type, 'unserved');
      await setLastInbound(warm, 6);
      expect((await sendAs(cs, warm, text())).statusCode).toBe(202);
    },
  );

  it('API key messages:send saja → 403 (scope messages:initiate); dengan messages:initiate → 202', async () => {
    const cold = await conversation('whatsapp', 'served');
    await setLastInbound(cold, 30);
    const sendOnly = await key(['messages:send']);
    const denied = await sendAsKey(sendOnly, cold, await templateBody());
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json<{ error: { message: string } }>().error.message).toContain(
      'messages:initiate',
    );
    const both = await key(['messages:send', 'messages:initiate']);
    expect((await sendAsKey(both, cold, await templateBody())).statusCode).toBe(202);
  });
});

describe('P2-R1 — kirim ulang pesan gagal', () => {
  async function failedTemplate(conversationId: string, broadcastId: string | null = null) {
    const [conversationRow] = await harness.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    const at = new Date();
    const [row] = await harness.db
      .insert(messages)
      .values({
        organizationId,
        conversationId,
        contactId: conversationRow!.contactId,
        channelId: conversationRow!.channelId,
        direction: 'outbound',
        senderKind: broadcastId ? 'broadcast' : 'agent',
        senderUserId: broadcastId ? null : owner.session.user.id,
        broadcastId,
        type: 'template',
        text: 'Halo Budi, tagihan Anda sudah terbit.',
        status: 'failed',
        failureReason: 'meta_rejected',
        statusUpdatedAt: at,
        sendAttempts: 1,
        occurredAt: at,
      })
      .returning({ id: messages.id });
    return row!.id;
  }
  const retry = (signed: SignedIn, messageId: string) =>
    call(harness.app, 'POST', apiPath(API_ROUTES.inbox.retry, { messageId }), undefined, {
      cookie: signed.cookie,
      csrf: signed.csrf,
    });
  const statusOf = async (messageId: string) =>
    (
      await harness.db
        .select({ status: messages.status })
        .from(messages)
        .where(eq(messages.id, messageId))
    )[0]?.status;

  it('template gagal di percakapan selesai: CS 403 (tetap gagal), Owner 202 + jatah terpotong', async () => {
    const id = await conversation('whatsapp', 'resolved', false);
    const messageId = await failedTemplate(id);
    const denied = await retry(cs, messageId);
    expect(denied.statusCode, denied.body).toBe(403);
    expect(denied.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');
    expect(await statusOf(messageId)).toBe('failed');
    const limiter = createRateLimiter(harness.redis, { prefix: harness.redisPrefix });
    const ok = await retry(owner, messageId);
    expect(ok.statusCode, ok.body).toBe(202);
    expect(await statusOf(messageId)).toBe('pending');
    expect((await limiter.peek(INITIATE_USER_RULE, owner.session.user.id)).count).toBe(1);
  });

  it('template gagal di percakapan terbuka yang hangat: CS tetap boleh kirim ulang', async () => {
    const id = await conversation('whatsapp', 'served', false);
    await setLastInbound(id, 2);
    const messageId = await failedTemplate(id);
    expect((await retry(cs, messageId)).statusCode).toBe(202);
  });

  it('pesan broadcast tidak bisa dikirim ulang dari percakapan (Owner pun 409)', async () => {
    const id = await conversation('whatsapp', 'served');
    const [campaign] = await harness.db
      .insert(broadcastCampaigns)
      .values({
        organizationId,
        name: 'Tagihan November',
        status: 'cancelled',
        channelId: channelIds.get('whatsapp')!,
        templateId: await template(),
      })
      .returning({ id: broadcastCampaigns.id });
    const messageId = await failedTemplate(id, campaign!.id);
    const response = await retry(owner, messageId);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json<{ error: { message: string } }>().error.message).toBe(
      'Pesan broadcast tidak bisa dikirim ulang dari percakapan. Kirim ulang lewat kampanye broadcast-nya.',
    );
    expect(await statusOf(messageId)).toBe('failed');
  });
});
