/**
 * Tes penjaga audit akhir sebelum rilis 1.0 — bagian keamanan
 * (docs/audits/2026-11-25-audit-akhir/security.md).
 *
 * `it` = regresi. `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN; gagal sekarang). Saat temuan
 * diperbaiki, ganti `it.fails` → `it` tanpa melemahkan asersinya.
 *
 * Postgres + Redis lokal (harness integrasi); Graph API tidak pernah dipanggil (pesan hanya diantrekan).
 */
import { randomUUID } from 'node:crypto';

import { channels, conversations, messageTemplates, messages, newId } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import { API_ROUTES, apiPath, createApiKeyResponseSchema } from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from './modules/auth/password-hasher';
import {
  call,
  completeSetup,
  confirmationFor,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from './testing/integration';

const WABA = '102290129340398';
const PASSWORD = 'sandi-uji-audit-akhir-01';

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
const hasher = createPasswordHasher();

const MARKETING_CONTENT = {
  parameterFormat: 'positional',
  header: null,
  body: { text: 'Halo {{1}}, ada promo untuk Anda.', examples: { '1': 'Budi' } },
  footer: null,
  buttons: [],
  authentication: null,
};

async function approvedTemplate(category: 'UTILITY' | 'MARKETING'): Promise<string> {
  const [row] = await harness.db
    .insert(messageTemplates)
    .values({
      organizationId,
      channelId,
      wabaId: WABA,
      metaTemplateId: String(Math.floor(Math.random() * 1e12)),
      name: `t_${category.toLowerCase()}_${newId()
        .slice(-6)
        .replace(/[^a-z0-9]/g, 'a')}`,
      language: 'id',
      category,
      status: 'APPROVED',
      content: MARKETING_CONTENT as never,
      source: 'meta',
    })
    .returning({ id: messageTemplates.id });
  return row!.id;
}

/** Notifikasi billing lewat API v1 (`messages:initiate`) → percakapan `resolved` untuk nomor itu. */
async function billingNotification(phone: string): Promise<string> {
  const created = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    { name: 'Billing', scopes: ['messages:initiate'], confirmation: await confirmationFor() },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(created.statusCode, created.body).toBe(201);
  const key = createApiKeyResponseSchema.parse(created.json());
  const response = await harness.app.inject({
    method: 'POST',
    url: API_ROUTES.publicApi.templateMessage,
    headers: { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json' },
    payload: JSON.stringify({
      channelId,
      phone,
      templateId: await approvedTemplate('UTILITY'),
      parameters: { body: { '1': 'Budi' } },
    }),
  });
  expect(response.statusCode, response.body).toBe(202);
  return response.json<{ conversationId: string }>().conversationId;
}

async function signIn(role: 'cs'): Promise<SignedIn> {
  const user = await insertUser(harness.db, organizationId, {
    role,
    email: `${role}.${newId().slice(-6)}@audit-akhir.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return login(harness.app, { email: user.email, password: PASSWORD });
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

describe('audit akhir — A1: template dari CS ke percakapan yang sudah selesai (broadcast terselubung)', () => {
  it('prasyarat: notifikasi billing API v1 meninggalkan percakapan `resolved` yang terlihat CS', async () => {
    const conversationId = await billingNotification('+6281300009001');
    const [row] = await harness.db
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(row?.status).toBe('resolved');
    const cs = await signIn('cs');
    const view = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.messages, { conversationId }),
      undefined,
      { cookie: cs.cookie },
    );
    expect(view.statusCode).toBe(200);
  });

  it('A1: CS (tanpa inbox.initiate) tidak bisa mengirim template MARKETING ke percakapan resolved (= nomor tanpa percakapan terbuka)', async () => {
    const conversationId = await billingNotification('+6281300009002');
    const cs = await signIn('cs');
    const templateId = await approvedTemplate('MARKETING');
    const response = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.messages, { conversationId }),
      {
        type: 'template',
        clientMessageId: randomUUID(),
        templateId,
        parameters: { body: { '1': 'Budi. Klaim hadiah di https://contoh-phishing.test' } },
      },
      { cookie: cs.cookie, csrf: cs.csrf },
    );
    // 403 (butuh `inbox.initiate`, seperti POST /conversations/start) — A1 diperbaiki.
    expect(response.statusCode, response.body).toBe(403);
    const sent = await harness.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.templateCategory, 'MARKETING'),
        ),
      );
    expect(sent).toHaveLength(0);
  });

  it('regresi: Owner (memegang inbox.initiate) tetap boleh mengirim template ke percakapan resolved', async () => {
    const conversationId = await billingNotification('+6281300009003');
    const response = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.messages, { conversationId }),
      {
        type: 'template',
        clientMessageId: randomUUID(),
        templateId: await approvedTemplate('UTILITY'),
        parameters: { body: { '1': 'Budi' } },
      },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(response.statusCode, response.body).toBe(202);
  });
});
