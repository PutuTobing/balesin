/**
 * Tes penjaga review keamanan Fase 3 — API publik v1 + API key
 * (docs/security-reviews/2026-11-18-fase3-api-publik.md).
 *
 * `it` = perilaku aman yang harus tetap benar (regresi). `it.fails` = temuan terbuka: tes menyatakan
 * perilaku yang DIHARAPKAN dan saat ini gagal; setelah diperbaiki ubah menjadi `it`.
 */
import { Secret } from '@balesin/core';
import { apiKeys, channels, contacts, conversations, messages, newId } from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import {
  API_DOCS_ROUTES,
  API_ROUTES,
  apiPath,
  createApiKeyResponseSchema,
  messageResponseSchema,
  type ApiKeyScope,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { apiKeyPepper, generateApiKey } from '../api-keys/api-key-token';
import {
  call,
  completeSetup,
  confirmationFor,
  createIntegrationHarness,
  TEST_MASTER_KEY,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;

const fakeToken = (id = 'c'.repeat(16), secret = 'd'.repeat(43)) =>
  ['blsn', 'live', id, secret].join('_');

async function createKey(scopes: ApiKeyScope[], extra: { allowedIps?: string[] } = {}) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    { name: 'integrasi uji', scopes, ...extra, confirmation: await confirmationFor() },
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
      profileName: 'Pelanggan Uji',
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
  return { conversation: row!, contact: contact! };
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

describe('review keamanan Fase 3 — autentikasi API key', () => {
  it('sesi web (cookie + CSRF) tanpa Bearer di rute tulis publik → 401; sesi tidak pernah dipakai', async () => {
    const { conversation } = await openConversation();
    const url = apiPath(API_ROUTES.publicApi.messages, { conversationId: conversation.id });
    const viaSession = await call(
      harness.app,
      'POST',
      url,
      { type: 'text', text: 'Spam lewat sesi CS' },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(viaSession.statusCode).toBe(401);
    expect(await harness.db.select().from(messages)).toHaveLength(0);
  });

  it('Bearer sah + Origin asing pada permintaan tulis → 403 (tidak bisa dipicu dari situs lain)', async () => {
    const { conversation } = await openConversation();
    const key = await createKey(['messages:send']);
    const url = apiPath(API_ROUTES.publicApi.messages, { conversationId: conversation.id });
    const response = await api(
      key.secret,
      'POST',
      url,
      { type: 'text', text: 'Halo' },
      { headers: { origin: 'https://penyerang.contoh' } },
    );
    expect(response.statusCode).toBe(403);
    expect(await harness.db.select().from(messages)).toHaveLength(0);
  });

  it('rahasia salah dengan id key yang SAH → 401 (bukan diterima berdasarkan id saja)', async () => {
    const key = await createKey(['contacts:read']);
    const lookupKey = key.secret.split('_')[2]!;
    const forged = fakeToken(lookupKey, 'e'.repeat(43));
    const response = await api(forged, 'GET', `${API_ROUTES.publicApi.contacts}?q=ab`);
    expect(response.statusCode).toBe(401);
  });

  it('header Authorization kosong/tanpa Bearer tidak menghabiskan kuota kegagalan IP', async () => {
    const key = await createKey(['contacts:read']);
    const url = `${API_ROUTES.publicApi.contacts}?q=ab`;
    for (let attempt = 0; attempt < 35; attempt += 1) {
      await api(null, 'GET', url, undefined, { remoteAddress: '192.0.2.77' });
    }
    expect(
      (await api(key.secret, 'GET', url, undefined, { remoteAddress: '192.0.2.77' })).statusCode,
    ).toBe(200);
  });

  it.fails(
    'R1: key SAH dari IP yang terkunci karena 30 key salah tetap diterima (penyerang di NAT bersama tidak bisa memblokir integrasi sah)',
    async () => {
      const key = await createKey(['contacts:read']);
      const url = `${API_ROUTES.publicApi.contacts}?q=ab`;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await api(fakeToken(), 'GET', url, undefined, { remoteAddress: '192.0.2.88' });
      }
      const legit = await api(key.secret, 'GET', url, undefined, { remoteAddress: '192.0.2.88' });
      expect(legit.statusCode).toBe(200);
    },
  );

  it('log tidak memuat rahasia key maupun header Authorization (sukses, salah, dan buat key)', async () => {
    const key = await createKey(['contacts:read']);
    const secretPart = key.secret.split('_').at(-1)!;
    await api(key.secret, 'GET', `${API_ROUTES.publicApi.contacts}?q=ab`);
    await api(fakeToken(), 'GET', `${API_ROUTES.publicApi.contacts}?q=ab`);
    await api(`${key.secret}x`, 'GET', `${API_ROUTES.publicApi.contacts}?q=ab`);
    const text = harness.logs.text();
    expect(text).not.toContain(secretPart);
    expect(text).not.toContain('d'.repeat(43));
    expect(text).not.toMatch(/Bearer\s+blsn/i);
  });
});

describe('review keamanan Fase 3 — scope & cakupan', () => {
  it('scope ditegakkan per rute (baca ≠ tulis, kontak ≠ percakapan)', async () => {
    const { conversation, contact } = await openConversation();
    const convReader = await createKey(['conversations:read']);
    const contactReader = await createKey(['contacts:read']);
    const sender = await createKey(['messages:send']);
    const messagesUrl = apiPath(API_ROUTES.publicApi.messages, { conversationId: conversation.id });
    const contactUrl = apiPath(API_ROUTES.publicApi.contact, { contactId: contact.id });
    const tagsUrl = apiPath(API_ROUTES.publicApi.contactTags, { contactId: contact.id });

    expect((await api(convReader.secret, 'GET', messagesUrl)).statusCode).toBe(403);
    expect(
      (await api(convReader.secret, 'POST', messagesUrl, { type: 'text', text: 'x' })).statusCode,
    ).toBe(403);
    expect(
      (await api(contactReader.secret, 'PATCH', contactUrl, { name: 'Diubah' })).statusCode,
    ).toBe(403);
    expect((await api(contactReader.secret, 'POST', tagsUrl, { tags: ['VIP'] })).statusCode).toBe(
      403,
    );
    expect(
      (await api(contactReader.secret, 'GET', API_ROUTES.publicApi.conversations)).statusCode,
    ).toBe(403);
    expect(
      (await api(sender.secret, 'POST', API_ROUTES.publicApi.contacts, { phone: '+6281200000001' }))
        .statusCode,
    ).toBe(403);
    expect((await api(sender.secret, 'GET', contactUrl)).statusCode).toBe(403);
    expect(await harness.db.select().from(messages)).toHaveLength(0);
  });

  it('key organisasi lain tidak bisa membaca/mengirim ke percakapan organisasi ini', async () => {
    const { conversation, contact } = await openConversation();
    const other = await insertOrganization(harness.db);
    const otherUser = await insertUser(harness.db, other.id, {
      email: 'owner@lain.contoh',
      role: 'owner',
    });
    const generated = generateApiKey(apiKeyPepper(new Secret(TEST_MASTER_KEY)));
    await harness.db.insert(apiKeys).values({
      organizationId: other.id,
      name: 'key organisasi lain',
      lookupKey: generated.lookupKey,
      secretHash: generated.secretHash,
      scopes: ['messages:send', 'contacts:write'],
      createdByUserId: otherUser.id,
    });
    const token = generated.token;
    const conversationUrl = apiPath(API_ROUTES.publicApi.conversation, {
      conversationId: conversation.id,
    });
    const messagesUrl = apiPath(API_ROUTES.publicApi.messages, { conversationId: conversation.id });
    const contactUrl = apiPath(API_ROUTES.publicApi.contact, { contactId: contact.id });

    // Key itu sah (organisasinya sendiri kosong) — penolakan di bawah karena cakupan, bukan autentikasi.
    const ownList = await api(token, 'GET', API_ROUTES.publicApi.conversations);
    expect(ownList.statusCode).toBe(200);
    expect(ownList.json<{ conversations: unknown[] }>().conversations).toHaveLength(0);

    expect((await api(token, 'GET', conversationUrl)).statusCode).toBe(404);
    expect((await api(token, 'GET', messagesUrl)).statusCode).toBe(404);
    expect(
      (await api(token, 'POST', messagesUrl, { type: 'text', text: 'Penipuan' })).statusCode,
    ).toBe(404);
    expect((await api(token, 'GET', contactUrl)).statusCode).toBe(404);
    expect((await api(token, 'PATCH', contactUrl, { name: 'Dibajak' })).statusCode).toBe(404);
    const search = await api(token, 'GET', `${API_ROUTES.publicApi.contacts}?q=Pelanggan`);
    expect(search.json<{ contacts: unknown[] }>().contacts).toHaveLength(0);
    expect(await harness.db.select().from(messages)).toHaveLength(0);
  });

  it('Idempotency-Key per key: key lain dengan nilai sama TIDAK mendapat pesan milik key pertama', async () => {
    const { conversation } = await openConversation();
    const first = await createKey(['messages:send']);
    const second = await createKey(['messages:send']);
    const url = apiPath(API_ROUTES.publicApi.messages, { conversationId: conversation.id });
    const headers = { 'idempotency-key': 'sama-123' };
    const a = await api(
      first.secret,
      'POST',
      url,
      { type: 'text', text: 'Dari key A' },
      { headers },
    );
    const b = await api(
      second.secret,
      'POST',
      url,
      { type: 'text', text: 'Dari key B' },
      { headers },
    );
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    const messageA = messageResponseSchema.parse(a.json()).message;
    const messageB = messageResponseSchema.parse(b.json()).message;
    expect(messageB.id).not.toBe(messageA.id);
  });

  it('key dicabut: pesan yang sudah antre tetap tercatat milik key; permintaan berikutnya 401', async () => {
    const { conversation } = await openConversation();
    const key = await createKey(['messages:send']);
    const url = apiPath(API_ROUTES.publicApi.messages, { conversationId: conversation.id });
    expect((await api(key.secret, 'POST', url, { type: 'text', text: 'Satu' })).statusCode).toBe(
      202,
    );
    const revoke = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.apiKeys.revoke, { apiKeyId: key.apiKey.id }),
      undefined,
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(revoke.statusCode).toBe(200);
    expect((await api(key.secret, 'POST', url, { type: 'text', text: 'Dua' })).statusCode).toBe(
      401,
    );
    const rows = await harness.db
      .select()
      .from(messages)
      .where(eq(messages.apiKeyId, key.apiKey.id));
    expect(rows).toHaveLength(1);
  });
});

describe('review keamanan Fase 3 — dokumentasi publik', () => {
  it('/api/docs dan openapi.json tidak memuat data organisasi maupun rahasia', async () => {
    await createKey(['contacts:read']);
    const organizationName = owner.session.organization.name;
    for (const url of [API_DOCS_ROUTES.page, API_DOCS_ROUTES.openapi]) {
      const response = await harness.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(organizationName);
      expect(response.body).not.toMatch(/blsn_live_[0-9a-f]{16}_[A-Za-z0-9_-]{43}/);
      expect(response.body).not.toContain(owner.session.user.email);
    }
  });
});
