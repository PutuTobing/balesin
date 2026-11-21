/**
 * Review keamanan Fase 2 butir 10 — langganan & penerima push
 * (docs/security-reviews/2026-11-18-fase2-notifikasi-push.md). Penjaga regresi: alamat langganan yang
 * didaftarkan ulang pengguna lain pindah SEPENUHNYA ke pendaftar baru (kunci + sesi), Teknisi tidak
 * menerima push chat orang lain, isi push tanpa nomor/isi pesan secara bawaan.
 * Postgres + Redis sungguhan, server push tiruan lokal.
 */
import { createSecretBox, NOTIFICATION_JOBS, Secret } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import { channels, contacts, conversations, messages, newId, pushSubscriptions } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import { API_ROUTES, type UserRole } from '@balesin/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { processNotificationJob } from '../../../../worker/src/queues/notifications';
import { createPasswordHasher } from '../auth/password-hasher';
import { startFakePush, type FakeDevice, type FakePush } from '../../testing/fake-push';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const PASSWORD = 'sandi-review-push-55';
const SECRET_TEXT = 'ISI-PESAN-RAHASIA-PUSH-8812';
const PHONE = '+6281399990001';

type Agent = SignedIn & { userId: string };

let fake: FakePush;
let harness: IntegrationHarness;
let owner: Agent;
let organizationId: string;
let channelId: string;
const hasher = createPasswordHasher();
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const workerLogs = createLogCapture();

async function agent(role: Exclude<UserRole, 'owner'>, name: string): Promise<Agent> {
  const user = await insertUser(harness.db, organizationId, {
    role,
    name,
    email: `${role}.${newId().slice(-8)}@majujaya.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return {
    ...(await login(harness.app, { email: user.email, password: PASSWORD })),
    userId: user.id,
  };
}

function post(signed: SignedIn, url: string, body?: unknown) {
  return call(harness.app, 'POST', url, body, { cookie: signed.cookie, csrf: signed.csrf });
}

async function register(signed: SignedIn, endpoint: string, keys: FakeDevice['keys']) {
  await call(harness.app, 'GET', API_ROUTES.notifications.vapidPublicKey, undefined, {
    cookie: signed.cookie,
  });
  const response = await post(signed, API_ROUTES.notifications.subscriptions, { endpoint, keys });
  expect(response.statusCode, response.body).toBe(201);
}

async function conversation(overrides: Partial<typeof conversations.$inferInsert> = {}) {
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'whatsapp',
      waBsuid: `ID.${newId().slice(-10)}`,
      phone: overrides.assigneeUserId ? '+6281399990002' : PHONE,
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
      ...overrides,
    })
    .returning();
  return row!;
}

async function inbound(row: { id: string; contactId: string }) {
  const [message] = await harness.db
    .insert(messages)
    .values({
      organizationId,
      conversationId: row.id,
      contactId: row.contactId,
      channelId,
      direction: 'inbound',
      senderKind: 'customer',
      type: 'text',
      wamid: `wamid.${newId()}`,
      text: SECRET_TEXT,
      occurredAt: new Date(),
    })
    .returning();
  return message!;
}

function run(data: Record<string, unknown>) {
  return processNotificationJob(
    { name: NOTIFICATION_JOBS.inbox, data: { organizationId, ...data } },
    {
      db: harness.db,
      logger: workerLogs.logger,
      secretBox: box,
      appUrl: 'https://balesin.test',
      extraOrigins: [fake.origin],
      throttle: () => Promise.resolve(true),
    },
  );
}

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
  await harness.reset();
  const signed = await completeSetup(harness.app);
  organizationId = signed.session.organization.id;
  owner = { ...signed, userId: signed.session.user.id };
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
  await fake?.close();
});

describe('langganan', () => {
  it('alamat yang didaftarkan ulang pengguna lain pindah sepenuhnya (pengguna, sesi, kunci)', async () => {
    const cs = await agent('cs', 'Sinta CS');
    const device = fake.device();
    await register(cs, device.endpoint, device.keys);
    // Pengguna lain di browser yang sama (alamat sama) — kunci browser baru.
    const fresh = fake.device();
    await register(owner, device.endpoint, fresh.keys);

    const rows = await harness.db.select().from(pushSubscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: owner.userId });
    // CS tidak lagi bisa melepas langganan yang kini milik Owner.
    const removed = await call(
      harness.app,
      'DELETE',
      API_ROUTES.notifications.subscriptions,
      { endpoint: device.endpoint },
      { cookie: cs.cookie, csrf: cs.csrf },
    );
    expect(removed.json()).toEqual({ deleted: false });

    // Push untuk CS tidak dikirim ke alamat itu lagi.
    const test = await post(cs, API_ROUTES.notifications.test);
    expect(test.json()).toMatchObject({ devices: 0 });
  });
});

describe('penerima & isi', () => {
  it('Teknisi tidak menerima push chat antrian maupun chat agen lain; isi tanpa nomor/isi pesan', async () => {
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    const teknisiDevice = fake.device();
    await register(teknisi, teknisiDevice.endpoint, teknisiDevice.keys);
    const ownerDevice = fake.device();
    await register(owner, ownerDevice.endpoint, ownerDevice.keys);

    const queued = await conversation();
    await run({
      kind: 'message',
      conversationId: queued.id,
      messageId: (await inbound(queued)).id,
    });
    const others = await conversation({ status: 'served', assigneeUserId: owner.userId });
    await run({
      kind: 'message',
      conversationId: others.id,
      messageId: (await inbound(others)).id,
    });

    expect(teknisiDevice.received).toEqual([]);
    expect(ownerDevice.received.length).toBeGreaterThan(0);
    const delivered = JSON.stringify(ownerDevice.received);
    expect(delivered).not.toContain(SECRET_TEXT);
    expect(delivered).not.toContain(PHONE);
    expect(delivered).not.toContain('6281399990001');
    for (const payload of ownerDevice.received) {
      expect(String(payload.url)).toMatch(/^\/inbox(\?chat=[0-9a-f-]{36})?$/);
    }
    expect(workerLogs.text()).not.toContain(SECRET_TEXT);
    expect(workerLogs.text()).not.toContain(ownerDevice.endpoint);
  });
});
