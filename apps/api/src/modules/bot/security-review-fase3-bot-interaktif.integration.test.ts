/**
 * Tes penjaga review keamanan Fase 3 — bot eksternal + pesan interaktif
 * (docs/security-reviews/2026-11-20-fase3-bot-interaktif.md).
 *
 * `it` = regresi. `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN; gagal sekarang).
 */
import { auditLogs, channels, contacts, conversations, messages, newId } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import { API_ROUTES, apiPath, createApiKeyResponseSchema, type ApiKeyScope } from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { handoffTimedOutBots } from '../../../../worker/src/queues/maintenance';
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

const PASSWORD = 'sandi-uji-review-bot-01';

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
const hasher = createPasswordHasher();

async function signIn(role: 'cs' | 'supervisor' | 'admin' | 'teknisi') {
  const user = await insertUser(harness.db, organizationId, {
    role,
    email: `${role}.${newId().slice(-6)}@review.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return { user, session: await login(harness.app, { email: user.email, password: PASSWORD }) };
}

async function createKey(scopes: ApiKeyScope[]) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    { name: 'Bot uji', scopes, confirmation: await confirmationFor() },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return createApiKeyResponseSchema.parse(response.json());
}

async function conversation(
  status: 'bot' | 'unserved' | 'served',
  options: {
    assigneeUserId?: string | null;
    botAwaitingMinutes?: number;
    windowOpen?: boolean;
  } = {},
) {
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'whatsapp',
      waBsuid: `ID.${newId().slice(-10)}`,
      phone: `+62813${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      profileName: 'Pelanggan Uji',
    })
    .returning();
  const [row] = await harness.db
    .insert(conversations)
    .values({
      organizationId,
      contactId: contact!.id,
      channelId,
      status,
      assigneeUserId: options.assigneeUserId ?? null,
      lastMessageAt: new Date(),
      lastInboundAt: new Date(),
      windowExpiresAt: new Date(Date.now() + (options.windowOpen === false ? -1 : 1) * 3600_000),
      ...(status === 'bot' && options.botAwaitingMinutes !== undefined
        ? { botAwaitingSince: new Date(Date.now() - options.botAwaitingMinutes * 60_000) }
        : {}),
    })
    .returning();
  return row!;
}

const api = (token: string, method: 'GET' | 'POST', url: string, body?: unknown) =>
  harness.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });

const statusOf = async (id: string) =>
  (
    await harness.db
      .select({ status: conversations.status, assignee: conversations.assigneeUserId })
      .from(conversations)
      .where(eq(conversations.id, id))
  )[0];

const botUrl = (channel: string) => apiPath(API_ROUTES.channels.bot, { channelId: channel });

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  channelId = newId();
  await harness.db.insert(channels).values({
    id: channelId,
    organizationId,
    type: 'whatsapp',
    name: 'CS Utama',
    waPhoneNumberId: '106540352242922',
    waBusinessAccountId: '102290129340398',
    waAccessTokenEncrypted: 'x',
    waAppSecretEncrypted: 'x',
    waVerifyTokenEncrypted: 'x',
    waVerifyTokenRotatedAt: new Date(),
    botEnabled: true,
    // Review bot R1: bot aktif wajib punya batas waktu (constraint `channels_bot_enabled_has_timeout`).
    botTimeoutMinutes: 15,
  });
});
afterAll(async () => {
  await harness?.close();
});

describe('review keamanan — pengaturan bot channel', () => {
  it('CS & Supervisor 403; tanpa CSRF 403; perubahan Owner diaudit tanpa data pelanggan', async () => {
    const body = { enabled: true, hours: { mode: 'always' }, timeoutMinutes: 10 };
    for (const role of ['cs', 'supervisor'] as const) {
      const { session } = await signIn(role);
      const as = { cookie: session.cookie, csrf: session.csrf };
      expect((await call(harness.app, 'GET', botUrl(channelId), undefined, as)).statusCode).toBe(
        403,
      );
      expect((await call(harness.app, 'PUT', botUrl(channelId), body, as)).statusCode).toBe(403);
    }
    const noCsrf = await call(harness.app, 'PUT', botUrl(channelId), body, {
      cookie: owner.cookie,
    });
    expect(noCsrf.statusCode).toBe(403);
    const ok = await call(harness.app, 'PUT', botUrl(channelId), body, {
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const audits = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'channel.bot_updated'));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorUserId).toBe(owner.session.user.id);
  });

  it('channel organisasi lain / bukan UUID → 404', async () => {
    for (const id of [newId(), 'bukan-uuid']) {
      const response = await call(harness.app, 'GET', botUrl(id), undefined, {
        cookie: owner.cookie,
      });
      expect(response.statusCode, id).toBe(404);
    }
  });

  it('R1: mematikan bot channel menyerahkan percakapan yang sedang dipegang bot ke antrian (tidak terjebak)', async () => {
    const parked = await conversation('bot');
    const response = await call(
      harness.app,
      'PUT',
      botUrl(channelId),
      { enabled: false, hours: { mode: 'always' }, timeoutMinutes: null },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(response.statusCode).toBe(200);
    expect((await statusOf(parked.id))?.status).toBe('unserved');
  });
});

describe('review keamanan — handoff & saklar per percakapan', () => {
  it('Teknisi tidak bisa mengembalikan ke bot percakapan milik agen LAIN (403/404), status tidak berubah', async () => {
    const { session } = await signIn('teknisi');
    const held = await conversation('served', { assigneeUserId: owner.session.user.id });
    const response = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.bot, { conversationId: held.id }),
      { active: true },
      { cookie: session.cookie, csrf: session.csrf },
    );
    expect([403, 404]).toContain(response.statusCode);
    expect(await statusOf(held.id)).toEqual({ status: 'served', assignee: owner.session.user.id });
  });

  it('saklar per percakapan tanpa CSRF → 403', async () => {
    const parked = await conversation('bot');
    const response = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.bot, { conversationId: parked.id }),
      { active: false },
      { cookie: owner.cookie },
    );
    expect(response.statusCode).toBe(403);
    expect((await statusOf(parked.id))?.status).toBe('bot');
  });

  it('key conversations:write tidak bisa mengacak pekerjaan agen (handoff/selesai hanya dari bot)', async () => {
    const key = await createKey(['conversations:write']);
    const held = await conversation('served', { assigneeUserId: owner.session.user.id });
    const handoff = await api(
      key.secret,
      'POST',
      apiPath(API_ROUTES.publicApi.handoff, { conversationId: held.id }),
    );
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json<{ changed: boolean }>().changed).toBe(false);
    expect(await statusOf(held.id)).toEqual({ status: 'served', assignee: owner.session.user.id });
  });

  it('key tanpa conversations:write tidak bisa handoff (403)', async () => {
    const key = await createKey(['messages:send']);
    const parked = await conversation('bot');
    const response = await api(
      key.secret,
      'POST',
      apiPath(API_ROUTES.publicApi.handoff, { conversationId: parked.id }),
    );
    expect(response.statusCode).toBe(403);
    expect((await statusOf(parked.id))?.status).toBe('bot');
  });

  it('batas waktu bot: hanya percakapan bot yang lewat batas; agen & antrian tidak tersentuh', async () => {
    await harness.db
      .update(channels)
      .set({ botTimeoutMinutes: 5 })
      .where(eq(channels.id, channelId));
    const late = await conversation('bot', { botAwaitingMinutes: 10 });
    const fresh = await conversation('bot', { botAwaitingMinutes: 1 });
    const held = await conversation('served', { assigneeUserId: owner.session.user.id });
    expect(await handoffTimedOutBots(harness.db)).toBe(1);
    expect((await statusOf(late.id))?.status).toBe('unserved');
    expect((await statusOf(fresh.id))?.status).toBe('bot');
    expect((await statusOf(held.id))?.status).toBe('served');
  });
});

describe('review keamanan — pesan interaktif', () => {
  const button = (overrides: Record<string, unknown> = {}) => ({
    type: 'interactive',
    interactive: {
      kind: 'button',
      body: 'Pilih paket',
      buttons: [
        { id: 'a', title: 'Paket A' },
        { id: 'b', title: 'Paket B' },
      ],
      ...overrides,
    },
  });

  it('batas Meta ditegakkan di API; tidak ada pesan tersimpan bila tidak sah', async () => {
    const key = await createKey(['messages:send']);
    const open = await conversation('bot');
    const url = apiPath(API_ROUTES.publicApi.messages, { conversationId: open.id });
    for (const [label, body] of [
      [
        '4 tombol',
        button({
          buttons: ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id.toUpperCase() })),
        }),
      ],
      [
        'ID kembar',
        button({
          buttons: [
            { id: 'x', title: 'A' },
            { id: 'x', title: 'B' },
          ],
        }),
      ],
      ['judul > 20', button({ buttons: [{ id: 'x', title: 'J'.repeat(21) }] })],
      ['ID karakter kontrol', button({ buttons: [{ id: 'a\nb', title: 'A' }] })],
      ['body NUL', button({ body: 'a\u0000b' })],
      ['body > 1024', button({ body: 'b'.repeat(1025) })],
      [
        'daftar > 10 baris',
        {
          type: 'interactive',
          interactive: {
            kind: 'list',
            body: 'Pilih',
            buttonText: 'Menu',
            sections: [
              {
                rows: Array.from({ length: 11 }, (_, index) => ({
                  id: `r${String(index)}`,
                  title: `Baris ${String(index)}`,
                })),
              },
            ],
          },
        },
      ],
    ] as const) {
      const response = await api(key.secret, 'POST', url, body);
      expect(response.statusCode, label).toBe(400);
    }
    expect(
      await harness.db.select().from(messages).where(eq(messages.conversationId, open.id)),
    ).toHaveLength(0);
  });

  it('di luar jendela 24 jam → 409, tidak tersimpan', async () => {
    const key = await createKey(['messages:send']);
    const closed = await conversation('bot', { windowOpen: false });
    const response = await api(
      key.secret,
      'POST',
      apiPath(API_ROUTES.publicApi.messages, { conversationId: closed.id }),
      button(),
    );
    expect(response.statusCode).toBe(409);
    expect(
      await harness.db.select().from(messages).where(eq(messages.conversationId, closed.id)),
    ).toHaveLength(0);
  });
});
