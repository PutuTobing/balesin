/**
 * API key + API publik v1 + dokumentasi (Fase 3): buat/cabut (Owner/Admin, konfirmasi identitas,
 * rahasia sekali, hash saja), Bearer (tanpa sesi), scope bertingkat, dicabut/kedaluwarsa, IP,
 * batas kegagalan, kirim pesan (jendela, idempotensi, batas harian per key), kontak & tag, audit,
 * OpenAPI `/api/docs`. Postgres + Redis sungguhan.
 */
import {
  apiKeys,
  auditLogs,
  channels,
  contactEvents,
  contacts,
  conversations,
  messages,
  newId,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_DOCS_ROUTES,
  API_ROUTES,
  apiPath,
  apiKeyListResponseSchema,
  contactResponseSchema,
  conversationListResponseSchema,
  createApiKeyResponseSchema,
  errorEnvelopeSchema,
  messageResponseSchema,
  securitySummaryResponseSchema,
  type ApiKeyScope,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

const PASSWORD = 'sandi-uji-api-publik-01';

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
const hasher = createPasswordHasher();

/** Token dibangun saat runtime (tidak ada pola kunci utuh di sumber → tidak memicu pemindai rahasia). */
const fakeToken = (id = 'a'.repeat(16), secret = 'b'.repeat(43)) =>
  ['blsn', 'live', id, secret].join('_');

async function createKey(
  overrides: {
    scopes?: ApiKeyScope[];
    allowedIps?: string[];
    dailySendLimit?: number;
    name?: string;
  } = {},
) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    {
      name: overrides.name ?? 'n8n produksi',
      scopes: overrides.scopes ?? ['messages:send', 'contacts:write'],
      ...(overrides.allowedIps ? { allowedIps: overrides.allowedIps } : {}),
      ...(overrides.dailySendLimit ? { dailySendLimit: overrides.dailySendLimit } : {}),
      confirmation: await confirmationFor(),
    },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return createApiKeyResponseSchema.parse(response.json());
}

function api(
  token: string | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
  extra: { headers?: Record<string, string>; remoteAddress?: string } = {},
) {
  return harness.app.inject({
    method,
    url,
    ...(extra.remoteAddress ? { remoteAddress: extra.remoteAddress } : {}),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extra.headers,
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}

async function openConversation() {
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'whatsapp',
      waBsuid: `ID.${newId().slice(-10)}`,
      phone: `+62813${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      profileName: 'Budi Pelanggan',
    })
    .returning();
  const [row] = await harness.db
    .insert(conversations)
    .values({
      organizationId,
      contactId: contact!.id,
      channelId,
      status: 'unserved',
      lastMessageAt: new Date(),
      lastInboundAt: new Date(),
      windowExpiresAt: new Date(Date.now() + 23 * 3600_000),
    })
    .returning();
  return row!;
}

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
  });
});
afterAll(async () => {
  await harness?.close();
});

describe('mengelola API key', () => {
  it('Owner/Admin + konfirmasi; rahasia sekali; hanya hash tersimpan; audit + kejadian keamanan', async () => {
    const cs = await insertUser(harness.db, organizationId, {
      role: 'cs',
      email: 'cs.apikey@majujaya.test',
      passwordHash: await hasher.hash(PASSWORD),
    });
    const csSession = await login(harness.app, { email: cs.email, password: PASSWORD });
    const body = { name: 'n8n', scopes: ['contacts:read'] };
    expect(
      (
        await call(harness.app, 'POST', API_ROUTES.apiKeys.list, body, {
          cookie: csSession.cookie,
          csrf: csSession.csrf,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(harness.app, 'POST', API_ROUTES.apiKeys.list, body, {
          cookie: owner.cookie,
          csrf: owner.csrf,
        })
      ).statusCode,
    ).toBe(400);
    for (const bad of [
      { ...body, scopes: [] },
      { ...body, scopes: ['admin:all'] },
      { ...body, allowedIps: ['999.1.1.1'] },
      { ...body, allowedIps: ['10.0.0.0/40'] },
      { ...body, expiresAt: new Date(Date.now() - 1000).toISOString() },
    ]) {
      const response = await call(
        harness.app,
        'POST',
        API_ROUTES.apiKeys.list,
        { ...bad, confirmation: await confirmationFor() },
        { cookie: owner.cookie, csrf: owner.csrf },
      );
      expect(response.statusCode, JSON.stringify(bad)).toBe(400);
    }

    const created = await createKey();
    expect(created.secret).toMatch(/^blsn_live_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(created.apiKey).toMatchObject({ status: 'active', dailySendLimit: 500 });
    expect(created.secret.startsWith(created.apiKey.displayPrefix.replace('…', ''))).toBe(true);
    const listed = await call(harness.app, 'GET', API_ROUTES.apiKeys.list, undefined, {
      cookie: owner.cookie,
    });
    expect(listed.body).not.toContain(created.secret.split('_').at(-1));
    expect(apiKeyListResponseSchema.parse(listed.json()).apiKeys).toHaveLength(1);
    const [stored] = await harness.db.select().from(apiKeys);
    expect(stored?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.secret.split('_').at(-1));
    const audit = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'api_key.created'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(created.secret.split('_').at(-1));
    expect(JSON.stringify(harness.logs.lines)).not.toContain(created.secret.split('_').at(-1));
    const summary = securitySummaryResponseSchema.parse(
      (
        await call(harness.app, 'GET', API_ROUTES.audit.securitySummary, undefined, {
          cookie: owner.cookie,
        })
      ).json(),
    );
    expect(summary.counts.api_key_changed).toBe(1);
  });

  it('dicabut / kedaluwarsa → 401; IP di luar daftar → 403; key salah dibatasi per IP', async () => {
    const created = await createKey({ scopes: ['contacts:read'], allowedIps: ['203.0.113.0/24'] });
    const url = `${API_ROUTES.publicApi.contacts}?q=budi`;
    expect(
      (await api(created.secret, 'GET', url, undefined, { remoteAddress: '203.0.113.7' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await api(created.secret, 'GET', url, undefined, { remoteAddress: '198.51.100.1' }))
        .statusCode,
    ).toBe(403);

    const open = await createKey({ scopes: ['contacts:read'] });
    expect((await api(open.secret, 'GET', url)).statusCode).toBe(200);
    expect((await api(null, 'GET', url)).statusCode).toBe(401);
    // Cookie sesi web tidak berlaku di API publik.
    const withCookie = await harness.app.inject({
      method: 'GET',
      url,
      headers: { cookie: owner.cookie },
    });
    expect(withCookie.statusCode).toBe(401);

    await harness.db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, open.apiKey.id));
    expect((await api(open.secret, 'GET', url)).statusCode).toBe(401);

    const another = await createKey({ scopes: ['contacts:read'] });
    const revoke = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.apiKeys.revoke, { apiKeyId: another.apiKey.id }),
      undefined,
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect((await api(another.secret, 'GET', url)).statusCode).toBe(401);
    const revokedAudit = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'api_key.revoked'));
    expect(revokedAudit).toHaveLength(1);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await api(fakeToken(), 'GET', url, undefined, { remoteAddress: '192.0.2.50' });
    }
    const blocked = await api(fakeToken(), 'GET', url, undefined, { remoteAddress: '192.0.2.50' });
    expect(blocked.statusCode).toBe(429);
  });
});

describe('API publik v1', () => {
  it('scope bertingkat: contacts:read tidak bisa kirim; messages:send juga bisa membaca pesan', async () => {
    const conversation = await openConversation();
    const reader = await createKey({ scopes: ['contacts:read'] });
    const sender = await createKey({ scopes: ['messages:send'] });
    const messagesUrl = apiPath(API_ROUTES.publicApi.messages, { conversationId: conversation.id });
    const denied = await api(reader.secret, 'POST', messagesUrl, { type: 'text', text: 'Halo' });
    expect(denied.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(denied.json()).error.message).toContain('messages:send');
    expect((await api(sender.secret, 'GET', messagesUrl)).statusCode).toBe(200);
    expect((await api(sender.secret, 'GET', API_ROUTES.publicApi.conversations)).statusCode).toBe(
      200,
    );
    expect(
      (await api(sender.secret, 'GET', `${API_ROUTES.publicApi.contacts}?q=ab`)).statusCode,
    ).toBe(403);
  });

  it('kirim teks: pelaku = key, idempoten per Idempotency-Key, batas harian per key', async () => {
    const conversation = await openConversation();
    const key = await createKey({ scopes: ['messages:send'], dailySendLimit: 1 });
    const url = apiPath(API_ROUTES.publicApi.messages, { conversationId: conversation.id });
    const headers = { 'idempotency-key': 'order-123' };
    const first = await api(
      key.secret,
      'POST',
      url,
      { type: 'text', text: 'Tagihan sudah lunas.' },
      { headers },
    );
    expect(first.statusCode, first.body).toBe(202);
    const sent = messageResponseSchema.parse(first.json()).message;
    expect(sent).toMatchObject({ senderKind: 'bot', senderUserId: null, status: 'pending' });
    const again = await api(
      key.secret,
      'POST',
      url,
      { type: 'text', text: 'Tagihan sudah lunas.' },
      { headers },
    );
    expect(again.statusCode).toBe(200);
    expect(messageResponseSchema.parse(again.json()).message.id).toBe(sent.id);
    const [row] = await harness.db.select().from(messages).where(eq(messages.id, sent.id));
    expect(row).toMatchObject({ apiKeyId: key.apiKey.id, senderUserId: null });
    expect(harness.messageJobs).toHaveLength(1);

    const limited = await api(key.secret, 'POST', url, { type: 'text', text: 'Pesan kedua' });
    expect(limited.statusCode).toBe(429);
    const reached = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'sending.limit_reached'));
    expect(reached).toMatchObject([
      { targetType: 'api_key', targetId: key.apiKey.id, actorUserId: null },
    ]);
    // Review R2: Owner diberi tahu juga (subjek = pembuat key).
    expect(harness.adminNotices).toContainEqual(
      expect.objectContaining({
        event: 'sending_limit_reached',
        subjectUserId: owner.session.user.id,
      }),
    );

    const status = await api(
      key.secret,
      'GET',
      apiPath(API_ROUTES.publicApi.message, { messageId: sent.id }),
    );
    expect(messageResponseSchema.parse(status.json()).message.status).toBe('pending');

    await harness.db
      .update(conversations)
      .set({ windowExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(conversations.id, conversation.id));
    const other = await createKey({ scopes: ['messages:send'] });
    const closed = await api(other.secret, 'POST', url, { type: 'text', text: 'Di luar jendela' });
    expect(closed.statusCode).toBe(409);
  });

  it('kontak: buat (nomor kembar = kontak yang sama), cari, ubah, tag berdasarkan nama', async () => {
    const key = await createKey({ scopes: ['contacts:write'] });
    const created = await api(key.secret, 'POST', API_ROUTES.publicApi.contacts, {
      phone: '+6281299990000',
      name: '1500040SUWANTO@KWSN',
    });
    expect(created.statusCode, created.body).toBe(201);
    const contact = contactResponseSchema.parse(created.json()).contact;
    const duplicate = await api(key.secret, 'POST', API_ROUTES.publicApi.contacts, {
      phone: '+6281299990000',
    });
    expect(duplicate.statusCode).toBe(200);
    expect(contactResponseSchema.parse(duplicate.json()).contact.id).toBe(contact.id);

    const search = await api(
      key.secret,
      'GET',
      `${API_ROUTES.publicApi.contacts}?phone=%2B6281299990000`,
    );
    expect(search.json<{ contacts: { id: string }[] }>().contacts.map((item) => item.id)).toEqual([
      contact.id,
    ]);
    const url = apiPath(API_ROUTES.publicApi.contact, { contactId: contact.id });
    const patched = await api(key.secret, 'PATCH', url, { email: 'suwanto@contoh.id' });
    expect(contactResponseSchema.parse(patched.json()).contact.email).toBe('suwanto@contoh.id');

    const tagsUrl = apiPath(API_ROUTES.publicApi.contactTags, { contactId: contact.id });
    const tagged = await api(key.secret, 'POST', tagsUrl, { tags: ['MITRA-SURYA', 'mitra-surya'] });
    expect(contactResponseSchema.parse(tagged.json()).contact.tags?.map((tag) => tag.name)).toEqual(
      ['MITRA-SURYA'],
    );
    const untagged = await api(key.secret, 'DELETE', tagsUrl, { tags: ['mitra-surya'] });
    // Review R2: riwayat kontak menyebut key pelakunya.
    const history = await harness.db
      .select({ apiKeyId: contactEvents.apiKeyId, actorUserId: contactEvents.actorUserId })
      .from(contactEvents)
      .where(eq(contactEvents.contactId, contact.id));
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((row) => row.apiKeyId === key.apiKey.id && row.actorUserId === null)).toBe(
      true,
    );
    expect(contactResponseSchema.parse(untagged.json()).contact.tags).toEqual([]);
  });

  it('daftar percakapan memakai bentuk yang sama dengan API web', async () => {
    await openConversation();
    const key = await createKey({ scopes: ['conversations:read'] });
    const response = await api(key.secret, 'GET', API_ROUTES.publicApi.conversations);
    expect(conversationListResponseSchema.parse(response.json()).conversations).toHaveLength(1);
  });
});

describe('dokumentasi /api/docs', () => {
  it('halaman + OpenAPI 3.1 tanpa sesi; CSP ketat; bisa dimatikan Owner', async () => {
    const page = await harness.app.inject({ method: 'GET', url: API_DOCS_ROUTES.page });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.body).not.toContain('<script>');
    const openapi = await harness.app.inject({ method: 'GET', url: API_DOCS_ROUTES.openapi });
    const doc = openapi.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain(
      '/api/v1/public/conversations/{conversationId}/messages',
    );
    expect(openapi.body).not.toMatch(/blsn_live_[0-9a-f]{16}_/);

    const disabled = await call(
      harness.app,
      'PUT',
      API_ROUTES.apiKeys.settings,
      { docsEnabled: false },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(disabled.json()).toEqual({ settings: { docsEnabled: false } });
    expect(
      (await harness.app.inject({ method: 'GET', url: API_DOCS_ROUTES.page })).statusCode,
    ).toBe(404);
  });
});
