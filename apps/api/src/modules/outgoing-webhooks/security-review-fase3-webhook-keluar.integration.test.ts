/**
 * Tes penjaga review keamanan Fase 3 — webhook keluar
 * (docs/security-reviews/2026-11-19-fase3-webhook-keluar.md). Semua `it` = regresi.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createSecretBox, Secret } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import {
  auditLogs,
  channels,
  contacts,
  conversations,
  newId,
  webhookDeliveries,
  webhookEndpoints,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  outgoingWebhookSecretResponseSchema,
  webhookDeliveryResponseSchema,
  type OutgoingWebhookEvent,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { processWebhooksOutTick } from '../../../../worker/src/queues/webhooks-out';
import { createPasswordHasher } from '../auth/password-hasher';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  confirmationFor,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const PASSWORD = 'sandi-uji-review-webhook-01';
const BSUID = 'ID.REVIEWBSUID01';
const PHONE = '+6281399990001';
const PATH_TOKEN = 'token-penerima-rahasia-123';

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
let receiverOrigin = '';
const received: { path: string; body: string }[] = [];
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const logs = createLogCapture();
const hasher = createPasswordHasher();

const receiver = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    received.push({ path: request.url ?? '', body: Buffer.concat(chunks).toString() });
    response.writeHead(200).end('ok');
  });
});

const tick = () =>
  processWebhooksOutTick({
    db: harness.db,
    logger: logs.logger,
    secretBox: box,
    allowLoopback: true,
    timeoutMs: 2_000,
  });

async function createWebhook(events: OutgoingWebhookEvent[] = ['conversation.assigned']) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.outgoingWebhooks.list,
    {
      url: `${receiverOrigin}/hook/${PATH_TOKEN}?k=${PATH_TOKEN}`,
      events,
      confirmation: await confirmationFor(),
    },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return outgoingWebhookSecretResponseSchema.parse(response.json());
}

async function conversation() {
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'whatsapp',
      waBsuid: BSUID,
      phone: PHONE,
      profileName: 'Pelanggan Review',
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
    })
    .returning();
  return row!;
}

const claim = (conversationId: string) =>
  call(harness.app, 'POST', apiPath(API_ROUTES.inbox.claim, { conversationId }), undefined, {
    cookie: owner.cookie,
    csrf: owner.csrf,
  });

beforeAll(async () => {
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverOrigin = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}`;
  harness = await createIntegrationHarness({ overrides: { webhookAllowLoopback: true } });
});
beforeEach(async () => {
  await harness.reset();
  received.length = 0;
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
  receiver.close();
});

describe('review keamanan — isi & jejak', () => {
  it('payload tanpa BSUID/rahasia; log & audit tanpa rahasia, path/query token, atau nomor pelanggan', async () => {
    const { secret, webhook } = await createWebhook();
    const row = await conversation();
    expect((await claim(row.id)).statusCode).toBe(200);
    expect(await tick()).toMatchObject({ delivered: 1 });
    const [hit] = received;
    expect(hit?.body).toContain(PHONE);
    expect(hit?.body).not.toContain(BSUID);
    expect(hit?.body).not.toContain(secret);
    expect(hit?.body).not.toContain('whsec_');

    const [stored] = await harness.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, webhook.id));
    expect(JSON.stringify(stored)).not.toContain(secret.slice(6));

    const audits = JSON.stringify(
      await harness.db.select().from(auditLogs).where(eq(auditLogs.targetId, webhook.id)),
    );
    expect(audits).not.toContain(PATH_TOKEN);
    expect(audits).not.toContain(secret.slice(6));

    for (const text of [JSON.stringify(logs.lines), harness.logs.text()]) {
      expect(text).not.toContain(secret.slice(6));
      expect(text).not.toContain(PATH_TOKEN);
      expect(text).not.toContain(PHONE);
    }
  });
});

describe('review keamanan — akses & arah aman', () => {
  it('Supervisor & CS 403 untuk daftar, uji, riwayat, allowlist', async () => {
    const { webhook } = await createWebhook();
    for (const role of ['supervisor', 'cs'] as const) {
      const user = await insertUser(harness.db, organizationId, {
        role,
        email: `${role}.review@majujaya.test`,
        passwordHash: await hasher.hash(PASSWORD),
      });
      const session = await login(harness.app, { email: user.email, password: PASSWORD });
      const as = { cookie: session.cookie, csrf: session.csrf };
      expect(
        (await call(harness.app, 'GET', API_ROUTES.outgoingWebhooks.list, undefined, as))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await call(
            harness.app,
            'POST',
            apiPath(API_ROUTES.outgoingWebhooks.test, { webhookId: webhook.id }),
            undefined,
            as,
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await call(
            harness.app,
            'GET',
            apiPath(API_ROUTES.outgoingWebhooks.deliveries, { webhookId: webhook.id }),
            undefined,
            as,
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (await call(harness.app, 'GET', API_ROUTES.outgoingWebhooks.privateNetwork, undefined, as))
          .statusCode,
      ).toBe(403);
    }
  });

  it('ubah URL tanpa konfirmasi ditolak; URL ke metadata ditolak walau dikonfirmasi; nonaktif tanpa konfirmasi', async () => {
    const { webhook } = await createWebhook();
    const url = apiPath(API_ROUTES.outgoingWebhooks.webhook, { webhookId: webhook.id });
    const as = { cookie: owner.cookie, csrf: owner.csrf };
    const noConfirm = await call(harness.app, 'PATCH', url, { url: 'https://n8n.lain.id/x' }, as);
    expect(noConfirm.statusCode).toBeGreaterThanOrEqual(400);
    const metadata = await call(
      harness.app,
      'PATCH',
      url,
      { url: 'http://169.254.169.254/latest/meta-data/', confirmation: await confirmationFor() },
      as,
    );
    expect(metadata.statusCode).toBe(400);
    const [row] = await harness.db
      .select({ url: webhookEndpoints.url })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, webhook.id));
    expect(row?.url).toContain(receiverOrigin);
    expect((await call(harness.app, 'PATCH', url, { enabled: false }, as)).statusCode).toBe(200);
  });

  it('allowlist hanya CIDR privat; CIDR publik/loopback ditolak walau dikonfirmasi', async () => {
    for (const cidrs of [['8.8.8.0/24'], ['127.0.0.0/8'], ['169.254.169.254/32'], ['0.0.0.0/0']]) {
      const response = await call(
        harness.app,
        'PUT',
        API_ROUTES.outgoingWebhooks.privateNetwork,
        { cidrs, confirmation: await confirmationFor() },
        { cookie: owner.cookie, csrf: owner.csrf },
      );
      expect(response.statusCode, cidrs[0]).toBe(400);
    }
  });

  it('kirim ulang: pengiriman milik webhook lain → 404 (tidak bisa dipindah ke URL lain)', async () => {
    const first = await createWebhook();
    const second = await createWebhook();
    const test = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.outgoingWebhooks.test, { webhookId: first.webhook.id }),
      undefined,
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(test.statusCode).toBe(201);
    const delivery = webhookDeliveryResponseSchema.parse(test.json()).delivery;
    const cross = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.outgoingWebhooks.redeliver, {
        webhookId: second.webhook.id,
        deliveryId: delivery.id,
      }),
      undefined,
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(cross.statusCode).toBe(404);
  });

  it('webhook dinonaktifkan: pengiriman tertunda tidak dikirim', async () => {
    const { webhook } = await createWebhook();
    const row = await conversation();
    expect((await claim(row.id)).statusCode).toBe(200);
    // Dispatch dulu (baris pengiriman terbentuk), lalu nonaktifkan sebelum dikirim.
    await harness.db
      .update(webhookEndpoints)
      .set({ enabled: false, disabledReason: 'manual' })
      .where(eq(webhookEndpoints.id, webhook.id));
    await harness.db.insert(webhookDeliveries).values({
      organizationId,
      endpointId: webhook.id,
      eventId: newId(),
      event: 'conversation.assigned',
      payload: { id: 'x', event: 'conversation.assigned', data: {} },
      nextAttemptAt: new Date(),
    });
    await tick();
    expect(received).toHaveLength(0);
  });
});
