/**
 * Notifikasi Web Push (Fase 2 butir 10): kunci VAPID, langganan (validasi alamat/kunci, CSRF, batas,
 * hapus saat sesi dicabut), preferensi, pengaturan cuplikan, pengantre dari aksi inbox, dan worker
 * pengirim terhadap layanan push TIRUAN (isi didekripsi seperti di browser). Juga status rem darurat
 * untuk semua agen dan `senderName` pesan keluar. Postgres + Redis sungguhan.
 */
import { createSecretBox, NOTIFICATION_JOBS, Secret } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import {
  auditLogs,
  channels,
  contacts,
  conversations,
  messages,
  newId,
  organizations,
  pushSubscriptions,
  pushVapidKeys,
  userSessions,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  inboxStreamEventSchema,
  messageListResponseSchema,
  notificationPreferencesResponseSchema,
  pushNotificationPayloadSchema,
  sendingStatusResponseSchema,
  vapidPublicKeyResponseSchema,
  type InboxStreamEvent,
  type UserRole,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { processNotificationJob } from '../../../../worker/src/queues/notifications';
import { createPasswordHasher } from '../auth/password-hasher';
import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
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

const PASSWORD = 'sandi-uji-notifikasi-01';

type Agent = SignedIn & { userId: string; name: string };

let fake: FakePush;
let harness: IntegrationHarness;
let owner: Agent;
let organizationId: string;
let channelId: string;
const hasher = createPasswordHasher();
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const workerLogs = createLogCapture();
let throttled = new Set<string>();

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
    name,
  };
}

function send(
  signed: SignedIn,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
) {
  return call(harness.app, method, url, body, {
    cookie: signed.cookie,
    ...(method === 'GET' ? {} : { csrf: signed.csrf }),
  });
}

async function subscribe(signed: SignedIn): Promise<FakeDevice> {
  await send(signed, 'GET', API_ROUTES.notifications.vapidPublicKey);
  const device = fake.device();
  const response = await send(signed, 'POST', API_ROUTES.notifications.subscriptions, {
    endpoint: device.endpoint,
    keys: device.keys,
  });
  expect(response.statusCode, response.body).toBe(201);
  return device;
}

async function conversation(overrides: Partial<typeof conversations.$inferInsert> = {}) {
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'whatsapp',
      waBsuid: `ID.${newId().slice(-10)}`,
      phone: `+62813${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
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

async function inbound(
  row: { id: string; contactId: string },
  text = 'Internet saya mati sejak pagi',
) {
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
      text,
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
      throttle: (key) => {
        if (throttled.has(key)) return Promise.resolve(false);
        throttled.add(key);
        return Promise.resolve(true);
      },
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
  throttled = new Set();
  workerLogs.lines.length = 0;
  const signed = await completeSetup(harness.app);
  organizationId = signed.session.organization.id;
  owner = { ...signed, userId: signed.session.user.id, name: signed.session.user.name };
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

describe('kunci VAPID & langganan', () => {
  it('kunci dibuat sekali, privatnya terenkripsi; alamat & kunci langganan divalidasi; CSRF wajib', async () => {
    const first = vapidPublicKeyResponseSchema.parse(
      (await send(owner, 'GET', API_ROUTES.notifications.vapidPublicKey)).json(),
    ).publicKey;
    const again = vapidPublicKeyResponseSchema.parse(
      (await send(owner, 'GET', API_ROUTES.notifications.vapidPublicKey)).json(),
    ).publicKey;
    expect(again).toBe(first);
    expect(Buffer.from(first, 'base64url')).toHaveLength(65);
    const [stored] = await harness.db.select().from(pushVapidKeys);
    expect(stored?.privateKeyEncrypted).toMatch(/^v1\./);

    const device = fake.device();
    for (const body of [
      { endpoint: 'https://evil.example/push', keys: device.keys },
      { endpoint: 'http://169.254.169.254/latest/meta-data', keys: device.keys },
      { endpoint: device.endpoint, keys: { ...device.keys, p256dh: 'A'.repeat(87) } },
      { endpoint: device.endpoint, keys: { ...device.keys, auth: 'pendek' } },
    ]) {
      const response = await send(owner, 'POST', API_ROUTES.notifications.subscriptions, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    const noCsrf = await call(
      harness.app,
      'POST',
      API_ROUTES.notifications.subscriptions,
      { endpoint: device.endpoint, keys: device.keys },
      { cookie: owner.cookie },
    );
    expect(noCsrf.statusCode).toBe(403);
    expect(
      (
        await send(owner, 'POST', API_ROUTES.notifications.subscriptions, {
          endpoint: device.endpoint,
          keys: device.keys,
        })
      ).statusCode,
    ).toBe(201);
    const [row] = await harness.db.select().from(pushSubscriptions);
    expect(row?.keysEncrypted).toMatch(/^v1\./);
    expect(row?.keysEncrypted).not.toContain(device.keys.auth);
  });

  it('maks. 10 perangkat per pengguna; logout menghapus langganan sesi itu; lepas hanya milik sendiri', async () => {
    for (let index = 0; index < 11; index += 1) await subscribe(owner);
    expect(await harness.db.select().from(pushSubscriptions)).toHaveLength(10);

    const cs = await agent('cs', 'Sinta CS');
    const device = await subscribe(cs);
    const other = await send(owner, 'DELETE', API_ROUTES.notifications.subscriptions, {
      endpoint: device.endpoint,
    });
    expect(other.json()).toEqual({ deleted: false });
    expect((await send(cs, 'POST', API_ROUTES.auth.logout)).statusCode).toBeLessThan(300);
    const left = await harness.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, cs.userId));
    expect(left).toEqual([]);
  });

  it('preferensi: bawaan menyala; jam tenang tervalidasi; pengaturan cuplikan hanya Owner + diaudit', async () => {
    const cs = await agent('cs', 'Sinta CS');
    const prefs = notificationPreferencesResponseSchema.parse(
      (await send(cs, 'GET', API_ROUTES.notifications.preferences)).json(),
    );
    expect(prefs).toMatchObject({
      preferences: { queue: true, assignedMessage: true, assignedToMe: true, quietHours: null },
      timezone: 'Asia/Jakarta',
      devices: 0,
    });
    const bad = await send(cs, 'PUT', API_ROUTES.notifications.preferences, {
      ...prefs.preferences,
      quietHours: { start: '25:00', end: '06:00' },
    });
    expect(bad.statusCode).toBe(400);
    const saved = await send(cs, 'PUT', API_ROUTES.notifications.preferences, {
      ...prefs.preferences,
      queue: false,
      quietHours: { start: '22:00', end: '06:00' },
    });
    expect(notificationPreferencesResponseSchema.parse(saved.json()).preferences).toMatchObject({
      queue: false,
      quietHours: { start: '22:00', end: '06:00' },
    });

    expect(
      (
        await send(cs, 'PUT', API_ROUTES.notifications.settings, {
          preview: true,
          contactName: true,
        })
      ).statusCode,
    ).toBe(403);
    const updated = await send(owner, 'PUT', API_ROUTES.notifications.settings, {
      preview: true,
      contactName: false,
    });
    expect(updated.json()).toEqual({ settings: { preview: true, contactName: false } });
    const audit = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'settings.notifications.updated'));
    expect(audit).toHaveLength(1);
  });

  it('tes: diantrekan hanya bila ada perangkat; worker mengirim ke perangkat sendiri', async () => {
    expect((await send(owner, 'POST', API_ROUTES.notifications.test)).json()).toEqual({
      devices: 0,
    });
    const device = await subscribe(owner);
    expect((await send(owner, 'POST', API_ROUTES.notifications.test)).json()).toEqual({
      devices: 1,
    });
    const [job] = harness.notificationJobs;
    expect(job).toEqual({ organizationId, kind: 'test', userId: owner.userId });
    expect(await run({ kind: 'test', userId: owner.userId })).toMatchObject({ delivered: 1 });
    expect(pushNotificationPayloadSchema.parse(device.received[0])).toMatchObject({
      title: 'Notifikasi aktif',
      url: '/inbox',
    });
  });
});

describe('pengirim (worker) — penerima, isi, jeda', () => {
  it('pesan masuk di chat yang dipegang → hanya pemegangnya; tanpa isi pesan secara bawaan; URL relatif', async () => {
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    const cs = await agent('cs', 'Sinta CS');
    const mine = await subscribe(teknisi);
    const csDevice = await subscribe(cs);
    const row = await conversation({ status: 'served', assigneeUserId: teknisi.userId });
    const message = await inbound(row);

    expect(
      await run({ kind: 'message', conversationId: row.id, messageId: message.id }),
    ).toMatchObject({ status: 'sent', recipients: 1, delivered: 1 });
    expect(csDevice.received).toEqual([]);
    const pushed = pushNotificationPayloadSchema.parse(mine.received[0]);
    expect(pushed).toEqual({
      v: 1,
      // Bawaan tanpa nama kontak (review push R1).
      title: 'Pesan baru di inbox',
      body: 'Buka untuk membaca pesan.',
      url: `/inbox?chat=${row.id}`,
      tag: `chat-${row.id}`,
      conversationId: row.id,
    });
    expect(mine.headers[0]).toMatchObject({ 'content-encoding': 'aes128gcm', urgency: 'high' });
    expect(JSON.stringify(workerLogs.lines)).not.toContain('Internet saya mati');
    expect(JSON.stringify(workerLogs.lines)).not.toContain('Budi Pelanggan');

    // Jeda gabung 30 dtk per pengguna per percakapan.
    const next = await inbound(row, 'Halo?');
    expect(
      await run({ kind: 'message', conversationId: row.id, messageId: next.id }),
    ).toMatchObject({ status: 'skipped', reason: 'muted' });
  });

  it('antrian (unserved) → yang bisa mengambil, bukan Teknisi; cuplikan bila diizinkan Owner; preferensi & 410', async () => {
    await harness.db
      .update(organizations)
      .set({ notificationPreview: true, notificationContactName: true })
      .where(eq(organizations.id, organizationId));
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    const cs = await agent('cs', 'Sinta CS');
    const supervisor = await agent('supervisor', 'Rina Supervisor');
    const teknisiDevice = await subscribe(teknisi);
    const csDevice = await subscribe(cs);
    const supervisorDevice = await subscribe(supervisor);
    await send(supervisor, 'PUT', API_ROUTES.notifications.preferences, {
      queue: false,
      assignedMessage: true,
      assignedToMe: true,
      quietHours: null,
    });
    const ownerDevice = await subscribe(owner);
    ownerDevice.respondWith = 410;

    const row = await conversation();
    const message = await inbound(row, 'Tagihan bulan ini berapa ya kak?');
    expect(
      await run({ kind: 'message', conversationId: row.id, messageId: message.id }),
    ).toMatchObject({ status: 'sent', delivered: 1, removed: 1 });
    expect(teknisiDevice.received).toEqual([]);
    expect(supervisorDevice.received).toEqual([]);
    expect(pushNotificationPayloadSchema.parse(csDevice.received[0])).toMatchObject({
      // Nama profil WhatsApp (tidak tepercaya) diberi penanda `~`.
      title: 'Pesan baru dari ~Budi Pelanggan',
      body: 'Tagihan bulan ini berapa ya kak?',
    });
    const ownerLeft = await harness.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, owner.userId));
    expect(ownerLeft).toEqual([]);
  });

  it('langganan dari sesi yang sudah dicabut/kedaluwarsa tidak dikirimi dan dihapus', async () => {
    const cs = await agent('cs', 'Sinta CS');
    const device = await subscribe(cs);
    const [subscription] = await harness.db.select().from(pushSubscriptions);
    // Sesi kedaluwarsa (bukan dicabut lewat logout).
    await harness.db
      .update(userSessions)
      .set({ idleExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(userSessions.id, subscription!.sessionId));
    const row = await conversation();
    const message = await inbound(row);
    expect(
      await run({ kind: 'message', conversationId: row.id, messageId: message.id }),
    ).toMatchObject({ delivered: 0, removed: 1 });
    expect(device.received).toEqual([]);
  });

  it('aksi inbox mengantre notifikasi: ditugaskan ke orang lain & kembali ke antrian; ambil sendiri tidak', async () => {
    const cs = await agent('cs', 'Sinta CS');
    const device = await subscribe(cs);
    const row = await conversation();
    const act = (route: string, body?: unknown) =>
      send(owner, 'POST', apiPath(route, { conversationId: row.id }), body);
    await act(API_ROUTES.inbox.claim);
    expect(harness.notificationJobs).toEqual([]);
    await act(API_ROUTES.inbox.assign, { userId: cs.userId });
    expect(harness.notificationJobs).toEqual([
      { organizationId, kind: 'assigned', conversationId: row.id, actorUserId: owner.userId },
    ]);
    expect(
      await run({ kind: 'assigned', conversationId: row.id, actorUserId: owner.userId }),
    ).toMatchObject({ delivered: 1 });
    expect(pushNotificationPayloadSchema.parse(device.received[0])).toMatchObject({
      title: 'Chat ditugaskan ke kamu',
      body: 'Buka untuk melihat percakapan.',
    });
    await send(cs, 'POST', apiPath(API_ROUTES.inbox.unassign, { conversationId: row.id }));
    expect(harness.notificationJobs.at(-1)).toMatchObject({
      kind: 'queued',
      actorUserId: cs.userId,
    });
  });
});

describe('status rem darurat untuk semua agen & nama pengirim', () => {
  it('GET /inbox/sending-status untuk inbox.view; tarik rem → event sending.changed', async () => {
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    const status = () =>
      send(teknisi, 'GET', API_ROUTES.inbox.sendingStatus).then((response) =>
        sendingStatusResponseSchema.parse(response.json()),
      );
    expect(await status()).toEqual({ paused: false });
    const events: InboxStreamEvent[] = [];
    const socket = await harness.app.injectWS(API_ROUTES.inbox.stream, {
      headers: { cookie: teknisi.cookie, origin: TEST_APP_ORIGIN },
    });
    socket.on('message', (data: Buffer) => {
      events.push(inboxStreamEventSchema.parse(JSON.parse(data.toString('utf8'))));
    });
    expect(
      (await send(owner, 'POST', API_ROUTES.sendingLimits.pause, { reason: 'Uji' })).statusCode,
    ).toBe(200);
    expect(await status()).toEqual({ paused: true });
    const started = Date.now();
    while (
      Date.now() - started < 3000 &&
      !events.some((event) => event.type === 'sending.changed')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(events).toContainEqual({ type: 'sending.changed', paused: true });
    socket.terminate();
  });

  it('pesan keluar membawa senderName (nama tampilan, tanpa email) untuk Teknisi pemegangnya', async () => {
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    const row = await conversation({ status: 'served', assigneeUserId: teknisi.userId });
    await harness.db.insert(messages).values({
      organizationId,
      conversationId: row.id,
      contactId: row.contactId,
      channelId,
      direction: 'outbound',
      senderKind: 'agent',
      senderUserId: owner.userId,
      type: 'text',
      text: 'Baik kak',
      status: 'pending',
      occurredAt: new Date(),
    });
    const list = messageListResponseSchema.parse(
      (
        await send(teknisi, 'GET', apiPath(API_ROUTES.inbox.messages, { conversationId: row.id }))
      ).json(),
    );
    expect(list.messages[0]).toMatchObject({ senderUserId: owner.userId, senderName: owner.name });
    expect(JSON.stringify(list)).not.toContain('@majujaya.test');
  });
});
