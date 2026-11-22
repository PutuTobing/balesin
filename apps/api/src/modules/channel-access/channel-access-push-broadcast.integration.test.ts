/**
 * Akses per channel (tahap 9.0) — notifikasi Web Push (worker) dan broadcast (pemilih channel,
 * daftar, detail). Postgres + Redis sungguhan; layanan push tiruan.
 */
import { createSecretBox, NOTIFICATION_JOBS, Secret } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import {
  broadcastCampaigns,
  channels,
  contacts,
  conversations,
  departmentMembers,
  messages,
  newId,
} from '@balesin/db';
import {
  API_ROUTES,
  apiPath,
  broadcastListResponseSchema,
  departmentResponseSchema,
  errorEnvelopeSchema,
} from '@balesin/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Kode worker yang sama dengan produksi (tes saja).
import { processNotificationJob } from '../../../../worker/src/queues/notifications';
import { agent, send, setupWorld, type Agent, type Fase5World } from '../../testing/crm-fixtures';
import { startFakePush, type FakeDevice, type FakePush } from '../../testing/fake-push';
import {
  TEST_MASTER_KEY,
  createIntegrationHarness,
  type IntegrationHarness,
} from '../../testing/integration';

let fake: FakePush;
let harness: IntegrationHarness;
let world: Fase5World;
let restrictedChannelId: string;
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const workerLogs = createLogCapture();

beforeAll(async () => {
  fake = await startFakePush();
  harness = await createIntegrationHarness({
    overrides: {
      pushEndpointOrigins: [fake.origin],
      inboxStream: { heartbeatMs: 3_600_000, revalidateMs: 3_600_000 },
    },
  });
});
beforeEach(async () => {
  world = await setupWorld(harness);
  restrictedChannelId = newId();
  await harness.db.insert(channels).values({
    id: restrictedChannelId,
    organizationId: world.organizationId,
    type: 'whatsapp',
    name: 'WA Tagihan',
    waPhoneNumberId: '106540352242999',
    waBusinessAccountId: '102290129340398',
    waAccessTokenEncrypted: 'x',
    waAppSecretEncrypted: 'x',
    waVerifyTokenEncrypted: 'x',
    waVerifyTokenRotatedAt: new Date(),
  });
});
afterAll(async () => {
  await harness?.close();
  await fake?.close();
});

/** Pesan galat jawaban (pembanding 404/409 seragam). */
function messageOf(response: { json(): unknown }): string {
  return errorEnvelopeSchema.parse(response.json()).error.message;
}

async function restrictTo(departmentIds: string[]) {
  const response = await send(
    world,
    world.owner,
    'PUT',
    apiPath(API_ROUTES.channels.access, { channelId: restrictedChannelId }),
    { mode: 'restricted', departmentIds },
  );
  expect(response.statusCode, response.body).toBe(200);
}

async function department(name: string) {
  const response = await send(world, world.owner, 'POST', API_ROUTES.departments.settings, {
    name,
  });
  expect(response.statusCode, response.body).toBe(201);
  return departmentResponseSchema.parse(response.json()).department;
}

async function subscribe(signed: Agent): Promise<FakeDevice> {
  await send(world, signed, 'GET', API_ROUTES.notifications.vapidPublicKey);
  const device = fake.device();
  const response = await send(world, signed, 'POST', API_ROUTES.notifications.subscriptions, {
    endpoint: device.endpoint,
    keys: device.keys,
  });
  expect(response.statusCode, response.body).toBe(201);
  return device;
}

describe('notifikasi push', () => {
  it('pesan baru di channel terbatas hanya diantar ke pengguna yang berhak', async () => {
    const billing = await department('Tagihan');
    const csA = await agent(world, 'cs', 'Sinta CS');
    const csB = await agent(world, 'cs', 'Budi CS');
    await harness.db.insert(departmentMembers).values({
      organizationId: world.organizationId,
      departmentId: billing.id,
      userId: csB.userId,
    });
    await restrictTo([billing.id]);
    const deviceA = await subscribe(csA);
    const deviceB = await subscribe(csB);

    const [contact] = await harness.db
      .insert(contacts)
      .values({
        organizationId: world.organizationId,
        channelType: 'whatsapp',
        phone: '+6281399887766',
        profileName: 'Budi Pelanggan',
      })
      .returning();
    const [conversation] = await harness.db
      .insert(conversations)
      .values({
        organizationId: world.organizationId,
        contactId: contact!.id,
        channelId: restrictedChannelId,
        status: 'unserved',
        lastMessageAt: new Date(),
        lastInboundAt: new Date(),
        windowExpiresAt: new Date(Date.now() + 23 * 3600_000),
      })
      .returning();
    const [message] = await harness.db
      .insert(messages)
      .values({
        organizationId: world.organizationId,
        conversationId: conversation!.id,
        contactId: contact!.id,
        channelId: restrictedChannelId,
        direction: 'inbound',
        senderKind: 'customer',
        type: 'text',
        wamid: `wamid.${newId()}`,
        text: 'Tagihan saya dobel',
        occurredAt: new Date(),
      })
      .returning();

    const result = await processNotificationJob(
      {
        name: NOTIFICATION_JOBS.inbox,
        data: {
          organizationId: world.organizationId,
          kind: 'message',
          conversationId: conversation!.id,
          messageId: message!.id,
        },
      },
      {
        db: harness.db,
        logger: workerLogs.logger,
        secretBox: box,
        appUrl: 'https://balesin.test',
        extraOrigins: [fake.origin],
        throttle: () => Promise.resolve(true),
      },
    );
    expect(result).toMatchObject({ status: 'sent', delivered: 1 });
    expect(deviceA.received).toEqual([]);
    expect(deviceB.received).toHaveLength(1);
  });
});

describe('broadcast', () => {
  it('Supervisor tanpa akses: channel tidak bisa dipilih, broadcast channel itu tidak terlihat (404 seragam)', async () => {
    const supervisor = await agent(world, 'supervisor', 'Rina Supervisor');
    const [campaign] = await harness.db
      .insert(broadcastCampaigns)
      .values({
        organizationId: world.organizationId,
        name: 'Promo Tagihan',
        channelId: restrictedChannelId,
        templateId: newId(),
        createdByUserId: world.owner.userId,
      })
      .returning();
    await restrictTo([]);

    const listOf = async (viewer: Agent) => {
      const response = await send(world, viewer, 'GET', API_ROUTES.broadcasts.list);
      expect(response.statusCode, response.body).toBe(200);
      return broadcastListResponseSchema.parse(response.json()).broadcasts.map((row) => row.id);
    };
    expect(await listOf(world.owner)).toEqual([campaign!.id]);
    expect(await listOf(supervisor)).toEqual([]);

    const path = apiPath(API_ROUTES.broadcasts.broadcast, { broadcastId: campaign!.id });
    const unknown = await send(
      world,
      supervisor,
      'GET',
      apiPath(API_ROUTES.broadcasts.broadcast, { broadcastId: newId() }),
    );
    const hidden = await send(world, supervisor, 'GET', path);
    expect(hidden.statusCode).toBe(404);
    expect(messageOf(hidden)).toBe(messageOf(unknown));
    for (const [method, route] of [
      ['GET', API_ROUTES.broadcasts.report],
      ['DELETE', API_ROUTES.broadcasts.broadcast],
      ['PATCH', API_ROUTES.broadcasts.broadcast],
    ] as const) {
      const response = await send(
        world,
        supervisor,
        method,
        apiPath(route, { broadcastId: campaign!.id }),
        method === 'GET' ? undefined : { name: 'Diubah diam-diam' },
      );
      expect(response.statusCode, `${method} ${route}`).toBe(404);
    }
    expect((await send(world, world.owner, 'GET', path)).statusCode).toBe(200);

    const created = await send(world, supervisor, 'POST', API_ROUTES.broadcasts.list, {
      name: 'Coba channel terlarang',
      channelId: restrictedChannelId,
      templateId: newId(),
    });
    expect(created.statusCode).toBe(404);
    expect(created.body).toContain('Nomor WhatsApp pengirim tidak ditemukan.');
  });
});

describe('mulai percakapan dengan template', () => {
  it('channel terlarang dijawab sama dengan channel yang tidak ada', async () => {
    const supervisor = await agent(world, 'supervisor', 'Rina Supervisor');
    await restrictTo([]);
    const start = (channelId: string) =>
      send(world, supervisor, 'POST', API_ROUTES.inbox.start, {
        channelId,
        phone: '081399887766',
        clientMessageId: newId(),
        templateId: newId(),
      });
    const hidden = await start(restrictedChannelId);
    const unknown = await start(newId());
    expect(hidden.statusCode).toBe(unknown.statusCode);
    expect(messageOf(hidden)).toBe(messageOf(unknown));
    // Owner melewati pemeriksaan channel (lalu ditolak karena template tidak ada — bukan karena akses).
    const owner = await send(world, world.owner, 'POST', API_ROUTES.inbox.start, {
      channelId: restrictedChannelId,
      phone: '081399887766',
      clientMessageId: newId(),
      templateId: newId(),
    });
    expect(messageOf(owner)).not.toBe(messageOf(unknown));
  });
});
