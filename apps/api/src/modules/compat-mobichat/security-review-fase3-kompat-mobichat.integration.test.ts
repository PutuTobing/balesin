/**
 * Tes penjaga review keamanan Fase 3 — lapisan kompatibel MobiChat
 * (docs/security-reviews/2026-11-19-fase3-kompat-mobichat.md).
 *
 * `it` = regresi. `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN; gagal sekarang).
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createSecretBox, Secret } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import {
  apiKeys,
  channels,
  contacts,
  conversations,
  messages,
  newId,
  webhookDeliveries,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  MOBICHAT_ROUTES,
  apiPath,
  createApiKeyResponseSchema,
  outgoingWebhookSecretResponseSchema,
  type ApiKeyScope,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { processWebhooksOutTick } from '../../../../worker/src/queues/webhooks-out';
import { apiKeyPepper, generateApiKey } from '../api-keys/api-key-token';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  confirmationFor,
  createIntegrationHarness,
  integrationConfig,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { createMediaUrlSigner } from './media-signature';

const PHONE = '+6281377770001';
const ALL_SCOPES: ApiKeyScope[] = ['messages:send', 'conversations:write', 'contacts:write'];

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
let echoOrigin = '';
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const logs = createLogCapture();
const signer = () => createMediaUrlSigner(new Secret(TEST_MASTER_KEY), integrationConfig().appUrl);

/** Penerima n8n yang memantulkan body permintaan (mis. node "Respond to Webhook" default). */
const echo = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'application/json' }).end(Buffer.concat(chunks));
  });
});

async function createKey(scopes: ApiKeyScope[] = ALL_SCOPES) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    { name: 'ULAN n8n', scopes, confirmation: await confirmationFor() },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return createApiKeyResponseSchema.parse(response.json());
}

/** Key organisasi LAIN (langsung di DB, hash dengan pepper yang sama). */
async function foreignKey(scopes: ApiKeyScope[] = [...ALL_SCOPES, 'messages:read']) {
  const other = await insertOrganization(harness.db);
  const user = await insertUser(harness.db, other.id, {
    email: `owner.${newId().slice(-6)}@lain.test`,
    role: 'owner',
  });
  const generated = generateApiKey(apiKeyPepper(new Secret(TEST_MASTER_KEY)));
  const [row] = await harness.db
    .insert(apiKeys)
    .values({
      organizationId: other.id,
      name: 'key penyerang',
      lookupKey: generated.lookupKey,
      secretHash: generated.secretHash,
      scopes,
      createdByUserId: user.id,
    })
    .returning();
  return { token: generated.token, id: row!.id, organizationId: other.id, userId: user.id };
}

async function conversationWithMessage() {
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'whatsapp',
      waBsuid: `ID.${newId().slice(-10)}`,
      phone: PHONE,
      profileName: 'Pelanggan Uji',
    })
    .returning();
  const [conversation] = await harness.db
    .insert(conversations)
    .values({
      organizationId,
      contactId: contact!.id,
      channelId,
      status: 'served',
      assigneeUserId: owner.session.user.id,
      lastMessageAt: new Date(),
      lastInboundAt: new Date(),
      windowExpiresAt: new Date(Date.now() + 23 * 3600_000),
    })
    .returning();
  const [message] = await harness.db
    .insert(messages)
    .values({
      organizationId,
      conversationId: conversation!.id,
      contactId: contact!.id,
      channelId,
      direction: 'inbound',
      senderKind: 'customer',
      type: 'text',
      text: 'Data rahasia pelanggan',
      occurredAt: new Date(),
    })
    .returning();
  return { contact: contact!, conversation: conversation!, message: message! };
}

const n8n = (key: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) =>
  harness.app.inject({
    method,
    url,
    headers: {
      'x-api-key': key,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });

beforeAll(async () => {
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  echoOrigin = `http://127.0.0.1:${String((echo.address() as AddressInfo).port)}`;
  harness = await createIntegrationHarness({ overrides: { webhookAllowLoopback: true } });
});
beforeEach(async () => {
  await harness.reset();
  logs.lines.length = 0;
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
  await new Promise((resolve) => echo.close(resolve));
});

describe('review keamanan — ID numerik lintas organisasi', () => {
  it('key organisasi lain tidak bisa membaca/mengubah percakapan, kontak, atau tag lewat nomor', async () => {
    const { conversation } = await conversationWithMessage();
    const attacker = await foreignKey();
    const cid = conversation.number;

    const history = await n8n(
      attacker.token,
      'GET',
      `${MOBICHAT_ROUTES.messages}?conversation_id=${String(cid)}`,
    );
    expect(history.statusCode).toBe(404);
    expect(history.body).not.toContain('Data rahasia pelanggan');
    expect(
      (
        await n8n(
          attacker.token,
          'GET',
          `${MOBICHAT_ROUTES.conversationStatus}?conversationId=${String(cid)}`,
        )
      ).statusCode,
    ).toBe(404);
    for (const [url, body] of [
      [MOBICHAT_ROUTES.conversationStatus, { conversation_id: cid, status: 'resolved' }],
      [MOBICHAT_ROUTES.unassignAgent, { conversation_id: cid, agent_id: owner.session.user.id }],
      [MOBICHAT_ROUTES.agents, { conversation_id: cid, agent_id: attacker.userId }],
      [MOBICHAT_ROUTES.notes, { conversationId: cid, notes: 'Hubungi 0800-penipu' }],
      [
        MOBICHAT_ROUTES.messages,
        { conversation_id: cid, messages: [{ message_type: 'text', text: 'Spam' }] },
      ],
      [
        MOBICHAT_ROUTES.botReply,
        { conversation_id: cid, message_text: 'Spam', message_type: 'text' },
      ],
    ] as const) {
      const response = await n8n(attacker.token, 'POST', url, body);
      expect(response.statusCode, url).toBe(404);
    }
    expect(
      (
        await n8n(attacker.token, 'PUT', MOBICHAT_ROUTES.contacts, {
          conversation_id: cid,
          name: 'X',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await n8n(attacker.token, 'PUT', MOBICHAT_ROUTES.tagsWhatsapp, {
          whatsapp_number: PHONE.slice(1),
          tags: ['DIBAJAK'],
        })
      ).statusCode,
    ).toBe(404);

    const [after] = await harness.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(after).toMatchObject({ status: 'served', assigneeUserId: owner.session.user.id });
    const sent = await harness.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    expect(sent).toHaveLength(1);
  });

  it('assign oleh key: agen organisasi lain / bukan UUID → 400, percakapan tidak berubah', async () => {
    const { conversation } = await conversationWithMessage();
    const { secret } = await createKey();
    const other = await foreignKey();
    for (const agentId of [other.userId, '42', 'bot']) {
      const response = await n8n(secret, 'POST', MOBICHAT_ROUTES.agents, {
        conversation_id: conversation.number,
        agent_id: agentId,
      });
      expect(response.statusCode, agentId).toBe(400);
    }
    const [after] = await harness.db
      .select({ assignee: conversations.assigneeUserId })
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(after?.assignee).toBe(owner.session.user.id);
  });

  it('unassign dengan agent_id yang BUKAN pemegang tidak melepas agen', async () => {
    const { conversation } = await conversationWithMessage();
    const { secret } = await createKey();
    const response = await n8n(secret, 'POST', MOBICHAT_ROUTES.unassignAgent, {
      conversation_id: conversation.number,
      agent_id: newId(),
    });
    expect(response.statusCode).toBeLessThan(300);
    const [after] = await harness.db
      .select({ assignee: conversations.assigneeUserId, status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(after).toEqual({ assignee: owner.session.user.id, status: 'served' });
  });
});

describe('review keamanan — URL media bertanda tangan', () => {
  it('tanda tangan sah untuk key organisasi LAIN tidak membuka media organisasi ini', async () => {
    const { message } = await conversationWithMessage();
    const attacker = await foreignKey();
    const url = new URL(signer().url(message.number, attacker.id, new Date())!);
    const response = await harness.app.inject({
      method: 'GET',
      url: `${url.pathname}${url.search}`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('semua bentuk tidak sah → 404 dengan body yang sama; query tidak tertulis di log', async () => {
    const { message } = await conversationWithMessage();
    const { apiKey } = await createKey([...ALL_SCOPES, 'messages:read']);
    const good = new URL(signer().url(message.number, apiKey.id, new Date())!);
    const exp = good.searchParams.get('exp')!;
    const sig = good.searchParams.get('sig')!;
    const base = `/api/public/media/${String(message.number)}`;
    const far = String(Number(exp) + 7 * 24 * 3600);
    const variants = [
      `${base}?exp=${exp}&kid=${apiKey.id}&sig=${sig}x`,
      `${base}?exp=${exp}&kid=${apiKey.id}&sig=${sig.slice(0, -2)}`,
      `${base}?exp=${far}&kid=${apiKey.id}&sig=${sig}`,
      `${base}?exp=${exp}0&kid=${apiKey.id}&sig=${sig}`,
      `${base}?exp=1e10&kid=${apiKey.id}&sig=${sig}`,
      `${base}?exp=${exp}&kid=bukan-uuid&sig=${sig}`,
      `${base}?exp=${exp}&kid=${newId()}&sig=${sig}`,
      `/api/public/media/0${String(message.number)}?exp=${exp}&kid=${apiKey.id}&sig=${sig}`,
      `/api/public/media/${String(message.number + 1000)}?exp=${exp}&kid=${apiKey.id}&sig=${sig}`,
      `${base}?exp=${exp}&kid=${apiKey.id}`,
      base,
    ];
    const bodies = new Set<string>();
    for (const url of variants) {
      const response = await harness.app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
      bodies.add(response.body);
    }
    expect(bodies.size).toBe(1);
    expect(harness.logs.text()).not.toContain(sig);
  });
});

describe('review keamanan — webhook format MobiChat', () => {
  it.fails(
    'R1: key yang disisipkan tidak tersimpan di potongan jawaban walau penerima memantulkan body',
    async () => {
      const { secret } = await createKey();
      const created = await call(
        harness.app,
        'POST',
        API_ROUTES.outgoingWebhooks.list,
        {
          url: `${echoOrigin}/webhook/mobichat-cs`,
          events: ['message.received'],
          format: 'mobichat',
          mobichat: { apiKey: secret },
          confirmation: await confirmationFor(),
        },
        { cookie: owner.cookie, csrf: owner.csrf },
      );
      expect(created.statusCode, created.body).toBe(201);
      const { webhook } = outgoingWebhookSecretResponseSchema.parse(created.json());
      const test = await call(
        harness.app,
        'POST',
        apiPath(API_ROUTES.outgoingWebhooks.test, { webhookId: webhook.id }),
        undefined,
        { cookie: owner.cookie, csrf: owner.csrf },
      );
      expect(test.statusCode).toBe(201);
      await processWebhooksOutTick({
        db: harness.db,
        logger: logs.logger,
        secretBox: box,
        appUrl: integrationConfig().appUrl,
        allowLoopback: true,
        timeoutMs: 2_000,
      });
      const rows = await harness.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.endpointId, webhook.id));
      expect(rows[0]?.status).toBe('succeeded');
      const listed = await call(
        harness.app,
        'GET',
        apiPath(API_ROUTES.outgoingWebhooks.deliveries, { webhookId: webhook.id }),
        undefined,
        { cookie: owner.cookie },
      );
      const keyTail = secret.slice(-20);
      expect(JSON.stringify(rows)).not.toContain(keyTail);
      expect(listed.body).not.toContain(keyTail);
    },
  );
});
