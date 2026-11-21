/**
 * Webhook keluar format MobiChat (Fase 3): body dibaca node "Ambil data pesan" ASLI workflow ULAN
 * (fixture verbatim), `mobichat_base_url`/`mobichat_api_key` disisipkan saat kirim dan TIDAK pernah
 * tersimpan di riwayat, key yang dicabut menghentikan pengiriman, pengelolaan (validasi key,
 * konfirmasi identitas, tampil 4 karakter terakhir). Postgres + Redis sungguhan.
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createSecretBox, Secret, WEBHOOK_JOBS, sealChannelSecret } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import { channels, conversations, newId, webhookDeliveries, webhookEndpoints } from '@balesin/db';
import {
  API_ROUTES,
  WEBHOOK_ROUTES,
  apiPath,
  createApiKeyResponseSchema,
  outgoingWebhookListResponseSchema,
  outgoingWebhookResponseSchema,
  outgoingWebhookSecretResponseSchema,
  webhookDeliveryResponseSchema,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { processWebhookJob } from '../../../../worker/src/queues/webhooks';
import { processWebhooksOutTick } from '../../../../worker/src/queues/webhooks-out';
import {
  FAKE_WEBHOOK_DEFAULTS,
  signedWebhook,
  textMessageNotification,
} from '../../testing/fake-meta';
import { createInboxEventPublisher } from '@balesin/core';
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
import ulan from './fixtures/ulan-mobichat.json';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const META_IP = '173.252.127.1';

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
let receiverOrigin = '';
const received: Received[] = [];
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const logs = createLogCapture();

const receiver = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    received.push({ headers: request.headers, body: Buffer.concat(chunks).toString() });
    response.writeHead(200).end('ok');
  });
});

/** Node "Ambil data pesan" ASLI workflow ULAN. */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const ambilDataPesan = new Function('$input', ulan.ambilDataPesan) as (input: {
  first: () => { json: unknown };
}) => { json: Record<string, unknown> }[];

function tick() {
  return processWebhooksOutTick({
    db: harness.db,
    logger: logs.logger,
    secretBox: box,
    appUrl: integrationConfig().appUrl,
    allowLoopback: true,
    timeoutMs: 2_000,
  });
}

async function receive(text: string): Promise<void> {
  const { body, headers } = signedWebhook(textMessageNotification({ body: text }), APP_SECRET);
  const response = await harness.app.inject({
    method: 'POST',
    url: apiPath(WEBHOOK_ROUTES.whatsapp, { channelId }),
    headers,
    payload: body,
    remoteAddress: META_IP,
  });
  expect(response.statusCode, response.body).toBe(200);
  for (const data of harness.webhookJobs.splice(0)) {
    await processWebhookJob(
      { name: WEBHOOK_JOBS.whatsappEvent, data, attemptsMade: 0, opts: { attempts: 8 } },
      {
        db: harness.db,
        logger: logs.logger,
        publisher: createInboxEventPublisher(harness.redis, {
          prefix: harness.redisPrefix,
          logger: logs.logger,
        }),
      },
    );
  }
}

async function createKey() {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    {
      name: 'ULAN n8n',
      scopes: ['messages:send', 'conversations:write', 'contacts:write'],
      confirmation: await confirmationFor(),
    },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return createApiKeyResponseSchema.parse(response.json());
}

function createWebhook(body: Record<string, unknown>) {
  return call(
    harness.app,
    'POST',
    API_ROUTES.outgoingWebhooks.list,
    { url: `${receiverOrigin}/webhook/mobichat-cs`, ...body },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
}

beforeAll(async () => {
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverOrigin = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}`;
  harness = await createIntegrationHarness({ overrides: { webhookAllowLoopback: true } });
});
beforeEach(async () => {
  await harness.reset();
  received.length = 0;
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  channelId = newId();
  const target = { id: channelId, organizationId };
  await harness.db.insert(channels).values({
    id: channelId,
    organizationId,
    type: 'whatsapp',
    name: 'CS Utama',
    waPhoneNumberId: FAKE_WEBHOOK_DEFAULTS.phoneNumberId,
    waBusinessAccountId: FAKE_WEBHOOK_DEFAULTS.wabaId,
    waAccessTokenEncrypted: sealChannelSecret(
      box,
      target,
      'accessToken',
      'EAAtokenTiruan0123456789abc',
    ),
    waAccessTokenTail: '9abc',
    waAppSecretEncrypted: sealChannelSecret(box, target, 'appSecret', APP_SECRET),
    waAppSecretTail: 'cdef',
    waVerifyTokenEncrypted: sealChannelSecret(box, target, 'verifyToken', 'verify-token-01234'),
    waVerifyTokenRotatedAt: new Date(),
  });
});
afterAll(async () => {
  await harness?.close();
  await new Promise((resolve) => receiver.close(resolve));
});

describe('webhook format MobiChat', () => {
  it('body dibaca node "Ambil data pesan" asli; key disisipkan saat kirim, tidak tersimpan', async () => {
    const { secret, apiKey } = await createKey();
    const created = await createWebhook({
      events: ['message.received'],
      format: 'mobichat',
      mobichat: { apiKey: secret },
      confirmation: await confirmationFor(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const { webhook, secret: signingSecret } = outgoingWebhookSecretResponseSchema.parse(
      created.json(),
    );
    expect(webhook).toMatchObject({
      format: 'mobichat',
      mobichat: {
        baseUrl: null,
        apiKeyLast4: secret.slice(-4),
        apiKeyId: apiKey.id,
        apiKeyName: 'ULAN n8n',
        apiKeyStatus: 'active',
      },
    });
    expect(created.body).not.toContain(secret);

    await receive('Siap kak');
    await tick();
    expect(received).toHaveLength(1);
    const delivery = received[0]!;
    const body = JSON.parse(delivery.body) as Record<string, unknown>;
    const [conversation] = await harness.db.select().from(conversations);

    const [result] = ambilDataPesan({ first: () => ({ json: { body } }) });
    expect(result?.json).toMatchObject({
      lanjut: true,
      conversation_id: conversation!.number,
      text: 'Siap kak',
      contact_name: FAKE_WEBHOOK_DEFAULTS.customerName,
    });
    expect(typeof result?.json.message_id).toBe('number');
    expect(body).toMatchObject({
      mobichat_base_url: new URL(integrationConfig().appUrl).origin,
      mobichat_api_key: secret,
      conversation_session_log_id: conversation!.number,
      contact: {
        phone_number: FAKE_WEBHOOK_DEFAULTS.customerWaId,
        contact_details: [{ type: 'whatsapp', value: FAKE_WEBHOOK_DEFAULTS.customerWaId }],
        tags: [],
      },
    });
    // Ditandatangani seperti webhook biasa.
    const signature = String(delivery.headers['x-balesin-signature']);
    const t = /t=(\d+)/.exec(signature)?.[1] ?? '';
    const expected = createHmac('sha256', signingSecret)
      .update(`${t}.${delivery.body}`)
      .digest('hex');
    expect(signature).toContain(`v1=${expected}`);

    // Riwayat pengiriman TIDAK menyimpan API key maupun alamat balik.
    const stored = await harness.db.select().from(webhookDeliveries);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(stored[0]?.payload).not.toHaveProperty('mobichat_api_key');
    const [endpoint] = await harness.db.select().from(webhookEndpoints);
    expect(endpoint?.mobichatApiKeyEncrypted).not.toContain(secret.slice(10));
    expect(harness.logs.lines.join(' ')).not.toContain(secret.slice(-20));
    expect(logs.lines.join(' ')).not.toContain(secret.slice(-20));

    // Kirim ulang membawa key lagi (disisipkan ulang saat kirim).
    const redeliver = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.outgoingWebhooks.redeliver, {
        webhookId: webhook.id,
        deliveryId: stored[0]!.id,
      }),
      {},
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(redeliver.statusCode, redeliver.body).toBe(201);
    await tick();
    expect(JSON.parse(received[1]!.body)).toMatchObject({ mobichat_api_key: secret });

    // Tes dari Pengaturan: bentuk MobiChat tanpa conversation_id → workflow tidak memproses.
    const test = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.outgoingWebhooks.test, { webhookId: webhook.id }),
      {},
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    webhookDeliveryResponseSchema.parse(test.json());
    await tick();
    const testBody = JSON.parse(received[2]!.body) as Record<string, unknown>;
    expect(ambilDataPesan({ first: () => ({ json: { body: testBody } }) })[0]?.json.lanjut).toBe(
      false,
    );

    // Key dicabut → pengiriman berikutnya gagal tanpa dikirim (admin mengganti key).
    await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.apiKeys.revoke, { apiKeyId: apiKey.id }),
      {},
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    await receive('Halo lagi');
    await tick();
    expect(received).toHaveLength(3);
    const failed = await harness.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.errorCode, 'mobichat_key_inactive'));
    expect(failed).toHaveLength(1);
    const list = outgoingWebhookListResponseSchema.parse(
      (
        await call(harness.app, 'GET', API_ROUTES.outgoingWebhooks.list, undefined, {
          cookie: owner.cookie,
        })
      ).json(),
    );
    expect(list.webhooks[0]?.mobichat?.apiKeyStatus).toBe('revoked');
  });

  it('pengelolaan: validasi key & event, alamat balik, konfirmasi identitas saat ganti', async () => {
    const { secret } = await createKey();
    const second = await createKey();
    for (const [label, body] of [
      ['tanpa key', { events: ['message.received'], format: 'mobichat' }],
      [
        'event lain',
        { events: ['conversation.assigned'], format: 'mobichat', mobichat: { apiKey: secret } },
      ],
      [
        'key salah',
        {
          events: ['message.received'],
          format: 'mobichat',
          mobichat: { apiKey: `${secret.slice(0, -3)}xyz` },
        },
      ],
      [
        'bukan key',
        { events: ['message.received'], format: 'mobichat', mobichat: { apiKey: 'rahasia' } },
      ],
      ['native + mobichat', { events: ['message.received'], mobichat: { apiKey: secret } }],
      [
        'alamat ber-query',
        {
          events: ['message.received'],
          format: 'mobichat',
          mobichat: { apiKey: secret, baseUrl: 'https://balesin.contoh.id/?x=1' },
        },
      ],
    ] as const) {
      const response = await createWebhook({ ...body, confirmation: await confirmationFor() });
      expect(response.statusCode, `${label}: ${response.body}`).toBe(400);
      expect(response.body).not.toContain(secret);
    }
    const created = await createWebhook({
      events: ['message.received'],
      format: 'mobichat',
      mobichat: { apiKey: secret, baseUrl: 'http://10.0.0.8:3000/' },
      confirmation: await confirmationFor(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const { webhook } = outgoingWebhookSecretResponseSchema.parse(created.json());
    expect(webhook.mobichat?.baseUrl).toBe('http://10.0.0.8:3000');

    const patch = (body: Record<string, unknown>) =>
      call(
        harness.app,
        'PATCH',
        apiPath(API_ROUTES.outgoingWebhooks.webhook, { webhookId: webhook.id }),
        body,
        { cookie: owner.cookie, csrf: owner.csrf },
      );
    // Ganti key / alamat tanpa konfirmasi → ditolak; event lain → ditolak.
    expect((await patch({ mobichat: { apiKey: second.secret } })).statusCode).not.toBe(200);
    expect(
      (await patch({ mobichat: { baseUrl: 'https://penyerang.example' } })).statusCode,
    ).not.toBe(200);
    expect((await patch({ events: ['message.sent'] })).statusCode).toBe(400);
    // Aktif/nonaktif tetap tanpa konfirmasi.
    expect((await patch({ enabled: false })).statusCode).toBe(200);
    const changed = await patch({
      mobichat: { apiKey: second.secret, baseUrl: null },
      confirmation: await confirmationFor(),
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(outgoingWebhookResponseSchema.parse(changed.json()).webhook.mobichat).toMatchObject({
      apiKeyId: second.apiKey.id,
      apiKeyLast4: second.secret.slice(-4),
      baseUrl: null,
    });
    // Webhook native menolak pengaturan MobiChat.
    const native = await createWebhook({
      events: ['message.received'],
      confirmation: await confirmationFor(),
    });
    const nativeId = outgoingWebhookSecretResponseSchema.parse(native.json()).webhook.id;
    const nativePatch = await call(
      harness.app,
      'PATCH',
      apiPath(API_ROUTES.outgoingWebhooks.webhook, { webhookId: nativeId }),
      { mobichat: { apiKey: secret }, confirmation: await confirmationFor() },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(nativePatch.statusCode).toBe(400);
  });
});
