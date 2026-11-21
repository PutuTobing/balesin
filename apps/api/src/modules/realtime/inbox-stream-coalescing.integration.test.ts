/**
 * Syarat broadcast Fase 4 (review real-time R2): hub WebSocket menggabungkan event per jendela pendek,
 * membaca keadaan dengan satu query `IN (…)` per batch, menggabungkan `message.status` massal ke
 * `conversation.updated`, membatasi laju event per organisasi (kelebihan → satu `resync`), dan
 * memvalidasi ulang semua sesi dengan satu query.
 */
import {
  createInboxEventPublisher,
  createSecretBox,
  sealChannelSecret,
  Secret,
  WEBHOOK_JOBS,
} from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import { channels, conversations, messages, newId } from '@balesin/db';
import {
  API_ROUTES,
  WEBHOOK_ROUTES,
  apiPath,
  inboxStreamEventSchema,
  type InboxStreamEvent,
} from '@balesin/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

import { processWebhookJob } from '../../../../worker/src/queues/webhooks';
import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import { signedWebhook, textMessageNotification } from '../../testing/fake-meta';
import {
  TEST_MASTER_KEY,
  completeSetup,
  createIntegrationHarness,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const logs = createLogCapture();
const sockets: WebSocket[] = [];

async function connect() {
  const events: InboxStreamEvent[] = [];
  const ws = await harness.app.injectWS(
    API_ROUTES.inbox.stream,
    { headers: { cookie: owner.cookie, origin: TEST_APP_ORIGIN } },
    {
      onInit: (created) => {
        created.on('message', (data: Buffer) => {
          events.push(inboxStreamEventSchema.parse(JSON.parse(data.toString('utf8'))));
        });
      },
    },
  );
  sockets.push(ws);
  await waitFor(() => events.length > 0);
  events.length = 0;
  return events;
}

async function waitFor(check: () => boolean, timeoutMs = 3_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waktu habis');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

async function receive(waId: string) {
  const { body, headers } = signedWebhook(
    textMessageNotification({ customer: { waId, userId: `ID.${waId}` } }),
    APP_SECRET,
  );
  await harness.app.inject({
    method: 'POST',
    url: apiPath(WEBHOOK_ROUTES.whatsapp, { channelId }),
    headers,
    payload: body,
    remoteAddress: '173.252.127.1',
  });
  for (const data of harness.webhookJobs.splice(0)) {
    await processWebhookJob(
      { name: WEBHOOK_JOBS.whatsappEvent, data, attemptsMade: 0, opts: { attempts: 8 } },
      { db: harness.db, logger: logs.logger },
    );
  }
}

beforeAll(async () => {
  harness = await createIntegrationHarness({
    overrides: { inboxStream: { maxEventsPerSecond: 8, statusMergeThreshold: 5 } },
  });
});
beforeEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await harness.reset();
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  channelId = newId();
  const target = { id: channelId, organizationId };
  await harness.db.insert(channels).values({
    id: channelId,
    organizationId,
    type: 'whatsapp',
    name: 'CS Utama',
    waPhoneNumberId: '106540352242922',
    waBusinessAccountId: '102290129340398',
    waAccessTokenEncrypted: sealChannelSecret(
      box,
      target,
      'accessToken',
      'EAAtokenTiruan0123456789',
    ),
    waAccessTokenTail: '6789',
    waAppSecretEncrypted: sealChannelSecret(box, target, 'appSecret', APP_SECRET),
    waAppSecretTail: 'cdef',
    waVerifyTokenEncrypted: sealChannelSecret(box, target, 'verifyToken', 'verify-token-01234'),
    waVerifyTokenRotatedAt: new Date(),
  });
});
afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  await harness?.close();
});

describe('hub WebSocket: penggabungan & batas laju (syarat broadcast)', () => {
  it('event yang sama dari Redis dalam satu jendela digabung jadi SATU kiriman', async () => {
    await receive('6281500000001');
    const [conversation] = await harness.db.select().from(conversations);
    const events = await connect();
    const publisher = createInboxEventPublisher(harness.redis, {
      prefix: harness.redisPrefix,
      logger: logs.logger,
    });
    for (let index = 0; index < 4; index += 1) {
      await publisher.publish([
        { type: 'conversation.updated', organizationId, conversationId: conversation?.id ?? '' },
      ]);
    }
    await settle();
    expect(events.filter((event) => event.type === 'conversation.updated')).toHaveLength(1);
  });

  it('status pesan massal digabung ke conversation.updated', async () => {
    await receive('6281500000002');
    const [conversation] = await harness.db.select().from(conversations);
    const rows = await harness.db
      .insert(messages)
      .values(
        Array.from({ length: 6 }, () => ({
          organizationId,
          conversationId: conversation?.id ?? '',
          contactId: conversation?.contactId ?? '',
          channelId,
          direction: 'outbound' as const,
          senderKind: 'broadcast' as const,
          type: 'text' as const,
          text: 'x',
          status: 'delivered' as const,
          occurredAt: new Date(),
        })),
      )
      .returning({ id: messages.id });
    const events = await connect();
    const delivered = await harness.app.inboxStream.deliverBatch(
      rows.map((row) => ({
        v: 1 as const,
        type: 'message.status' as const,
        organizationId,
        conversationId: conversation?.id ?? '',
        messageId: row.id,
      })),
    );
    expect(delivered).toBe(1);
    await settle(100);
    expect(events.map((event) => event.type)).toEqual(['conversation.updated']);
  });

  it('melewati batas laju organisasi → event dibuang, SATU sinyal resync (tidak berulang < 2 dtk)', async () => {
    for (let index = 0; index < 10; index += 1)
      await receive(`62815000001${String(index).padStart(2, '0')}`);
    const ids = (await harness.db.select({ id: conversations.id }).from(conversations)).map(
      (row) => row.id,
    );
    expect(ids).toHaveLength(10);
    const events = await connect();
    const batch = ids.map((conversationId) => ({
      v: 1 as const,
      type: 'conversation.updated' as const,
      organizationId,
      conversationId,
    }));
    await harness.app.inboxStream.deliverBatch(batch);
    await harness.app.inboxStream.deliverBatch(batch);
    await settle(100);
    expect(events).toEqual([{ type: 'resync' }]);
  });
});
