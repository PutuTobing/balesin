/**
 * Webhook keluar (Fase 3): kelola (Owner/Admin, konfirmasi, rahasia sekali), validasi alamat (SSRF),
 * outbox → pengiriman bertanda tangan ke penerima TIRUAN lokal, coba ulang, nonaktif otomatis,
 * rotasi rahasia (tumpang tindih), kirim ulang, allowlist IP privat, retensi, hapus kontak.
 * Postgres + Redis sungguhan; pengirim = pemroses worker yang sama dengan produksi.
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createSecretBox, Secret, type SecurityNoticeAdminEmailPayload } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import {
  auditLogs,
  channels,
  contacts,
  conversations,
  newId,
  outgoingEvents,
  webhookDeliveries,
  webhookEndpoints,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  outgoingWebhookSecretResponseSchema,
  webhookDeliveryListResponseSchema,
  webhookDeliveryResponseSchema,
  type OutgoingWebhookEvent,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { processWebhooksOutTick } from '../../../../worker/src/queues/webhooks-out';
import { createPasswordHasher } from '../auth/password-hasher';
import { deleteContactData } from '../contacts/contacts.repo';
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

const PASSWORD = 'sandi-uji-webhook-keluar-01';

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
let receiverOrigin = '';
const received: Received[] = [];
let respondWith = 200;
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const logs = createLogCapture();
const hasher = createPasswordHasher();
const ownerEmails: SecurityNoticeAdminEmailPayload[] = [];

const receiver = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    received.push({
      path: request.url ?? '',
      headers: request.headers,
      body: Buffer.concat(chunks).toString(),
    });
    response.writeHead(respondWith).end('diterima');
  });
});

function tick(now?: Date) {
  return processWebhooksOutTick({
    db: harness.db,
    logger: logs.logger,
    secretBox: box,
    allowLoopback: true,
    timeoutMs: 2_000,
    notifyOwner: (payload) => {
      ownerEmails.push(payload);
      return Promise.resolve();
    },
    ...(now ? { now: () => now } : {}),
  });
}

async function createWebhook(events: OutgoingWebhookEvent[] = ['conversation.assigned']) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.outgoingWebhooks.list,
    { url: `${receiverOrigin}/n8n/hook`, events, confirmation: await confirmationFor() },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return outgoingWebhookSecretResponseSchema.parse(response.json());
}

function verify(header: string | string[] | undefined, secret: string, body: string): boolean {
  const value = String(header);
  const timestamp = /t=(\d+)/.exec(value)?.[1];
  const expected = createHmac('sha256', secret)
    .update(`${timestamp ?? ''}.${body}`)
    .digest('hex');
  return value.split(',').includes(`v1=${expected}`);
}

async function conversation() {
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'whatsapp',
      waBsuid: `ID.${newId().slice(-10)}`,
      phone: '+6281311112222',
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
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverOrigin = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}`;
  harness = await createIntegrationHarness({ overrides: { webhookAllowLoopback: true } });
});
beforeEach(async () => {
  await harness.reset();
  received.length = 0;
  ownerEmails.length = 0;
  respondWith = 200;
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

describe('mengelola webhook keluar', () => {
  it('Owner/Admin + konfirmasi; alamat terlarang ditolak; rahasia sekali & terenkripsi; audit tanpa path', async () => {
    const cs = await insertUser(harness.db, organizationId, {
      role: 'cs',
      email: 'cs.webhook@majujaya.test',
      passwordHash: await hasher.hash(PASSWORD),
    });
    const csSession = await login(harness.app, { email: cs.email, password: PASSWORD });
    const body = {
      url: 'https://n8n.contoh.id/webhook/rahasia-path',
      events: ['message.received'],
    };
    expect(
      (
        await call(harness.app, 'POST', API_ROUTES.outgoingWebhooks.list, body, {
          cookie: csSession.cookie,
          csrf: csSession.csrf,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(harness.app, 'POST', API_ROUTES.outgoingWebhooks.list, body, {
          cookie: owner.cookie,
          csrf: owner.csrf,
        })
      ).statusCode,
    ).toBe(400);
    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'http://n8n.contoh.id:22/hook',
      'https://user:pw@n8n.contoh.id/hook',
      'http://10.0.0.5:5678/webhook',
      'http://[fd00:ec2::254]/',
    ]) {
      const response = await call(
        harness.app,
        'POST',
        API_ROUTES.outgoingWebhooks.list,
        { ...body, url, confirmation: await confirmationFor() },
        { cookie: owner.cookie, csrf: owner.csrf },
      );
      expect(response.statusCode, url).toBe(400);
    }
    const created = await call(
      harness.app,
      'POST',
      API_ROUTES.outgoingWebhooks.list,
      { ...body, confirmation: await confirmationFor() },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(created.statusCode, created.body).toBe(201);
    const { secret, webhook } = outgoingWebhookSecretResponseSchema.parse(created.json());
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const [stored] = await harness.db.select().from(webhookEndpoints);
    expect(stored?.secretEncrypted).toMatch(/^v1\./);
    expect(JSON.stringify(stored)).not.toContain(secret);
    const audit = await harness.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.targetId, webhook.id));
    expect(audit).toMatchObject([{ metadata: { host: 'n8n.contoh.id' } }]);
    expect(JSON.stringify(audit)).not.toContain('rahasia-path');

    // URL berubah = wajib konfirmasi; nonaktifkan tidak.
    const url = apiPath(API_ROUTES.outgoingWebhooks.webhook, { webhookId: webhook.id });
    expect(
      (
        await call(
          harness.app,
          'PATCH',
          url,
          { url: 'https://lain.contoh.id/x' },
          {
            cookie: owner.cookie,
            csrf: owner.csrf,
          },
        )
      ).statusCode,
    ).toBe(400);
    const off = await call(
      harness.app,
      'PATCH',
      url,
      { enabled: false },
      {
        cookie: owner.cookie,
        csrf: owner.csrf,
      },
    );
    expect(off.json()).toMatchObject({ webhook: { enabled: false, disabledReason: 'manual' } });
  });

  it('allowlist IP privat: hanya CIDR privat, + konfirmasi; setelahnya http ke IP itu diterima', async () => {
    const put = (cidrs: string[], withConfirmation = true) =>
      confirmationFor().then((confirmation) =>
        call(
          harness.app,
          'PUT',
          API_ROUTES.outgoingWebhooks.privateNetwork,
          { cidrs, ...(withConfirmation ? { confirmation } : {}) },
          { cookie: owner.cookie, csrf: owner.csrf },
        ),
      );
    expect((await put(['10.0.0.0/24'], false)).statusCode).toBe(400);
    for (const bad of [['8.8.8.0/24'], ['127.0.0.0/8'], ['169.254.0.0/16'], ['10.0.0.0/7']]) {
      expect((await put(bad)).statusCode, bad[0]).toBe(400);
    }
    expect((await put(['10.0.0.0/24'])).json()).toEqual({ settings: { cidrs: ['10.0.0.0/24'] } });
    const created = await call(
      harness.app,
      'POST',
      API_ROUTES.outgoingWebhooks.list,
      {
        url: 'http://10.0.0.5:5678/webhook/ulan',
        events: ['message.received'],
        confirmation: await confirmationFor(),
      },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(created.statusCode, created.body).toBe(201);
  });
});

describe('pengiriman', () => {
  it('outbox → body {id,event,created_at,data} bertanda tangan; header; percakapan + kontak', async () => {
    const { secret } = await createWebhook(['conversation.assigned', 'conversation.resolved']);
    const row = await conversation();
    const claim = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.claim, { conversationId: row.id }),
      undefined,
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(claim.statusCode).toBe(200);
    expect(await harness.db.select().from(outgoingEvents)).toHaveLength(1);
    expect(await tick()).toMatchObject({ dispatched: 1, delivered: 1 });
    expect(await harness.db.select().from(outgoingEvents)).toEqual([]);
    const [hit] = received;
    expect(hit?.path).toBe('/n8n/hook');
    expect(hit?.headers['x-balesin-event']).toBe('conversation.assigned');
    expect(hit?.headers['x-balesin-delivery']).toEqual(expect.any(String));
    expect(verify(hit?.headers['x-balesin-signature'], secret, hit?.body ?? '')).toBe(true);
    const body = JSON.parse(hit?.body ?? '{}') as {
      event: string;
      data: { conversation: { id: string; assignee: { id: string } }; contact: { phone: string } };
    };
    expect(body).toMatchObject({
      event: 'conversation.assigned',
      data: {
        conversation: { id: row.id, assignee: { id: owner.session.user.id } },
        contact: { phone: '+6281311112222' },
      },
    });
    // Event yang tidak dilanggani tidak masuk outbox.
    await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.unassign, { conversationId: row.id }),
      undefined,
      {
        cookie: owner.cookie,
        csrf: owner.csrf,
      },
    );
    expect(await harness.db.select().from(outgoingEvents)).toEqual([]);
    expect(JSON.stringify(logs.lines)).not.toContain('+6281311112222');
  });

  it('5xx dicoba ulang bertahap; 4xx langsung gagal; 20 gagal beruntun → nonaktif + audit + email Owner', async () => {
    const { webhook } = await createWebhook();
    const deliveriesUrl = apiPath(API_ROUTES.outgoingWebhooks.deliveries, {
      webhookId: webhook.id,
    });
    const testUrl = apiPath(API_ROUTES.outgoingWebhooks.test, { webhookId: webhook.id });
    respondWith = 500;
    const sent = await call(harness.app, 'POST', testUrl, undefined, {
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(webhookDeliveryResponseSchema.parse(sent.json()).delivery.status).toBe('pending');
    expect(await tick()).toMatchObject({ retried: 1 });
    const list = webhookDeliveryListResponseSchema.parse(
      (await call(harness.app, 'GET', deliveriesUrl, undefined, { cookie: owner.cookie })).json(),
    );
    expect(list.deliveries[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      httpStatus: 500,
      error: 'http_500',
    });
    // Belum jatuh tempo → tidak dikirim lagi.
    expect(await tick()).toMatchObject({ retried: 0, delivered: 0 });

    respondWith = 400;
    await harness.db
      .update(webhookEndpoints)
      .set({ consecutiveFailures: 19 })
      .where(eq(webhookEndpoints.id, webhook.id));
    await call(harness.app, 'POST', testUrl, undefined, { cookie: owner.cookie, csrf: owner.csrf });
    expect(await tick()).toMatchObject({ failed: 1 });
    const [endpoint] = await harness.db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.id, webhook.id));
    expect(endpoint).toMatchObject({ enabled: false, disabledReason: 'auto_failures' });
    const audit = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'webhook.auto_disabled'));
    expect(audit).toHaveLength(1);
    expect(ownerEmails).toMatchObject([{ event: 'webhook_disabled' }]);
  });

  it('rotasi: rahasia lama tetap ikut ditandatangani; kirim ulang memakai body yang sama', async () => {
    const created = await createWebhook();
    const rotate = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.outgoingWebhooks.rotateSecret, { webhookId: created.webhook.id }),
      { confirmation: await confirmationFor() },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(rotate.statusCode, rotate.body).toBe(200);
    const rotated = outgoingWebhookSecretResponseSchema.parse(rotate.json());
    expect(rotated.secret).not.toBe(created.secret);
    expect(rotated.webhook.previousSecretExpiresAt).not.toBeNull();
    const test = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.outgoingWebhooks.test, { webhookId: created.webhook.id }),
      undefined,
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    const first = webhookDeliveryResponseSchema.parse(test.json()).delivery;
    await tick();
    const [hit] = received;
    expect(verify(hit?.headers['x-balesin-signature'], rotated.secret, hit?.body ?? '')).toBe(true);
    expect(verify(hit?.headers['x-balesin-signature'], created.secret, hit?.body ?? '')).toBe(true);

    const again = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.outgoingWebhooks.redeliver, {
        webhookId: created.webhook.id,
        deliveryId: first.id,
      }),
      undefined,
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(again.statusCode, again.body).toBe(201);
    await tick();
    expect(received).toHaveLength(2);
    expect(received[1]?.body).toBe(received[0]?.body);
    expect(received[1]?.headers['x-balesin-delivery']).not.toBe(
      received[0]?.headers['x-balesin-delivery'],
    );
  });

  it('retensi: isi dikosongkan setelah 7 hari (tidak bisa dikirim ulang); hapus kontak mengosongkan isi', async () => {
    const created = await createWebhook(['conversation.assigned']);
    const row = await conversation();
    await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.claim, { conversationId: row.id }),
      undefined,
      {
        cookie: owner.cookie,
        csrf: owner.csrf,
      },
    );
    await tick();
    await harness.db.transaction((tx) => deleteContactData(tx, organizationId, row.contactId));
    const [afterDelete] = await harness.db.select().from(webhookDeliveries);
    expect(afterDelete?.payload).toBeNull();

    const test = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.outgoingWebhooks.test, { webhookId: created.webhook.id }),
      undefined,
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    const delivery = webhookDeliveryResponseSchema.parse(test.json()).delivery;
    await tick();
    await harness.db
      .update(webhookDeliveries)
      .set({ createdAt: new Date(Date.now() - 8 * 24 * 3600_000) })
      .where(eq(webhookDeliveries.id, delivery.id));
    await tick();
    const redeliver = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.outgoingWebhooks.redeliver, {
        webhookId: created.webhook.id,
        deliveryId: delivery.id,
      }),
      undefined,
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(redeliver.statusCode).toBe(409);
  });
});
