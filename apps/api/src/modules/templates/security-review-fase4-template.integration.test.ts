/**
 * Tes penjaga review keamanan Fase 4 — template Meta & mulai percakapan
 * (docs/security-reviews/2026-11-20-fase4-template.md).
 *
 * `it` = regresi. `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN; gagal sekarang).
 */
import { randomUUID } from 'node:crypto';

import { channels, contacts, messageTemplates, messages, newId, organizations } from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import { API_ROUTES, apiPath, createApiKeyResponseSchema, type ApiKeyScope } from '@balesin/shared';
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

const WABA = '102290129340398';
const PASSWORD = 'sandi-uji-review-template-01';
const OTP = '482913';

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
const hasher = createPasswordHasher();

const UTILITY_CONTENT = {
  parameterFormat: 'positional',
  header: null,
  body: { text: 'Halo {{1}}, tagihan Anda jatuh tempo.', examples: { '1': 'Budi' } },
  footer: null,
  buttons: [],
  authentication: null,
};
const AUTH_CONTENT = {
  parameterFormat: 'positional',
  header: null,
  body: { text: '', examples: {} },
  footer: null,
  buttons: [],
  authentication: { addSecurityRecommendation: true, codeExpirationMinutes: 10 },
};

async function template(
  overrides: Partial<typeof messageTemplates.$inferInsert> = {},
): Promise<string> {
  const [row] = await harness.db
    .insert(messageTemplates)
    .values({
      organizationId,
      channelId,
      wabaId: WABA,
      metaTemplateId: String(Math.floor(Math.random() * 1e12)),
      name: `tagihan_${newId()
        .slice(-6)
        .replace(/[^a-z0-9]/g, 'a')}`,
      language: 'id',
      category: 'UTILITY',
      status: 'APPROVED',
      content: UTILITY_CONTENT as never,
      source: 'meta',
      ...overrides,
    })
    .returning({ id: messageTemplates.id });
  return row!.id;
}

async function createKey(scopes: ApiKeyScope[], dailySendLimit?: number) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    {
      name: 'Billing',
      scopes,
      ...(dailySendLimit ? { dailySendLimit } : {}),
      confirmation: await confirmationFor(),
    },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return createApiKeyResponseSchema.parse(response.json());
}

const api = (token: string, url: string, body: unknown, headers: Record<string, string> = {}) =>
  harness.app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });

const contactByPhone = async (phone: string) =>
  harness.db.select().from(contacts).where(eq(contacts.phone, phone));

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
    waBusinessAccountId: WABA,
    waAccessTokenEncrypted: 'x',
    waAppSecretEncrypted: 'x',
    waVerifyTokenEncrypted: 'x',
    waVerifyTokenRotatedAt: new Date(),
  });
});
afterAll(async () => {
  await harness?.close();
});

describe('review keamanan — siapa boleh mengirim template ke nomor baru', () => {
  it('key messages:send (tanpa messages:initiate) → 403, tidak ada kontak/pesan dibuat', async () => {
    const key = await createKey(['messages:send', 'contacts:write']);
    const templateId = await template();
    const phone = '+6281300000001';
    const response = await api(key.secret, API_ROUTES.publicApi.templateMessage, {
      channelId,
      phone,
      templateId,
      parameters: { body: { '1': 'Budi' } },
    });
    expect(response.statusCode).toBe(403);
    expect(await contactByPhone(phone)).toHaveLength(0);
    expect(await harness.db.select().from(messages)).toHaveLength(0);
  });

  it('CS & Teknisi tidak bisa memulai percakapan (403), tanpa kontak baru', async () => {
    const templateId = await template();
    for (const role of ['cs', 'teknisi'] as const) {
      const user = await insertUser(harness.db, organizationId, {
        role,
        email: `${role}.${newId().slice(-6)}@review.test`,
        passwordHash: await hasher.hash(PASSWORD),
      });
      const session = await login(harness.app, { email: user.email, password: PASSWORD });
      const phone = `+62813000000${role === 'cs' ? '11' : '12'}`;
      const response = await call(
        harness.app,
        'POST',
        API_ROUTES.inbox.start,
        { channelId, phone, clientMessageId: randomUUID(), templateId },
        { cookie: session.cookie, csrf: session.csrf },
      );
      expect(response.statusCode, role).toBe(403);
      expect(await contactByPhone(phone)).toHaveLength(0);
    }
  });

  it('template organisasi lain → 404; status selain APPROVED → 409; WABA lain → 409', async () => {
    const key = await createKey(['messages:initiate']);
    const url = API_ROUTES.publicApi.templateMessage;
    const body = (templateId: string, phone: string) => ({
      channelId,
      phone,
      templateId,
      parameters: { body: { '1': 'Budi' } },
    });

    const other = await insertOrganization(harness.db);
    const otherChannel = newId();
    await harness.db.insert(channels).values({
      id: otherChannel,
      organizationId: other.id,
      type: 'whatsapp',
      name: 'Lain',
      waPhoneNumberId: '999000111222333',
      waBusinessAccountId: WABA,
      waAccessTokenEncrypted: 'x',
      waAppSecretEncrypted: 'x',
      waVerifyTokenEncrypted: 'x',
      waVerifyTokenRotatedAt: new Date(),
    });
    const [foreign] = await harness.db
      .insert(messageTemplates)
      .values({
        organizationId: other.id,
        channelId: otherChannel,
        wabaId: WABA,
        metaTemplateId: '777',
        name: 'milik_lain',
        language: 'id',
        category: 'UTILITY',
        status: 'APPROVED',
        content: UTILITY_CONTENT as never,
        source: 'meta',
      })
      .returning({ id: messageTemplates.id });
    expect((await api(key.secret, url, body(foreign!.id, '+6281300000021'))).statusCode).toBe(404);

    for (const status of ['DRAFT', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'DELETED']) {
      const id = await template(status === 'DRAFT' ? { status, metaTemplateId: null } : { status });
      const response = await api(key.secret, url, body(id, '+6281300000022'));
      expect(response.statusCode, status).toBe(409);
    }
    const otherWaba = await template({ wabaId: '555555555555555' });
    expect((await api(key.secret, url, body(otherWaba, '+6281300000023'))).statusCode).toBe(409);
    expect(await harness.db.select().from(messages)).toHaveLength(0);
  });

  it('nilai variabel dengan baris baru/tab/> 4 spasi/kosong → 400, tidak ada pesan', async () => {
    const key = await createKey(['messages:initiate']);
    const templateId = await template();
    for (const value of ['Budi\nKlik tautan', 'Budi\tX', 'Budi     X', '   ']) {
      const response = await api(key.secret, API_ROUTES.publicApi.templateMessage, {
        channelId,
        phone: '+6281300000031',
        templateId,
        parameters: { body: { '1': value } },
      });
      expect(response.statusCode, JSON.stringify(value)).toBe(400);
    }
    expect(await harness.db.select().from(messages)).toHaveLength(0);
  });
});

describe('review keamanan — temuan', () => {
  it('S1: kode OTP tidak tersimpan sebagai teks yang bisa dibaca agen (teks pesan / API inbox)', async () => {
    const key = await createKey(['messages:initiate']);
    const templateId = await template({
      category: 'AUTHENTICATION',
      content: AUTH_CONTENT as never,
    });
    const response = await api(key.secret, API_ROUTES.publicApi.templateMessage, {
      channelId,
      phone: '+6281300000041',
      templateId,
      parameters: { body: { '1': OTP } },
    });
    expect(response.statusCode, response.body).toBe(202);
    const { conversationId } = response.json<{ conversationId: string }>();
    const [row] = await harness.db.select().from(messages).limit(1);
    expect(row?.text ?? '').not.toContain(OTP);
    const agentView = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.messages, { conversationId }),
      undefined,
      { cookie: owner.cookie },
    );
    expect(agentView.statusCode).toBe(200);
    expect(agentView.body).not.toContain(OTP);
  });

  it('R1: key yang tertahan (batas harian habis / rem darurat) tidak membuat kontak/percakapan sampah', async () => {
    const key = await createKey(['messages:initiate'], 1);
    const templateId = await template();
    const send = (phone: string) =>
      api(key.secret, API_ROUTES.publicApi.templateMessage, {
        channelId,
        phone,
        templateId,
        parameters: { body: { '1': 'Budi' } },
      });
    expect((await send('+6281300000051')).statusCode).toBe(202);
    expect((await send('+6281300000052')).statusCode).toBe(429);
    await harness.db
      .update(organizations)
      .set({ sendingPausedAt: new Date() })
      .where(eq(organizations.id, organizationId));
    expect((await send('+6281300000053')).statusCode).toBeGreaterThanOrEqual(423);
    expect(await contactByPhone('+6281300000052')).toHaveLength(0);
    expect(await contactByPhone('+6281300000053')).toHaveLength(0);
  });
});
