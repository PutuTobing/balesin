/**
 * Inbox real-time (Fase 2 butir 5) di atas Postgres + Redis sungguhan: WebSocket `GET /inbox/stream`
 * (sesi cookie, Origin wajib, batas koneksi, heartbeat, validasi ulang sesi/peran), penyaringan event
 * per penerima (Teknisi hanya percakapan yang di-assign), jalur ujung ke ujung webhook → worker →
 * Redis pub/sub → socket, hitungan per tab, saringan baru, tandai dibaca, dan audit penolakan
 * CSRF/Origin bersesi (review akhir Fase 1 R1).
 */
import {
  createInboxEventPublisher,
  createSecretBox,
  sealChannelSecret,
  Secret,
  WEBHOOK_JOBS,
} from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import { auditLogs, channels, conversations, newId, userSessions, users } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  AUDIT_ACTIONS,
  INBOX_STREAM_CLOSE_CODES,
  WEBHOOK_ROUTES,
  apiPath,
  conversationCountsResponseSchema,
  conversationListResponseSchema,
  conversationResponseSchema,
  inboxStreamEventSchema,
  type InboxStreamEvent,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

// Kode worker yang sama dengan produksi (tes saja).
import { processWebhookJob } from '../../../../worker/src/queues/webhooks';
import { createPasswordHasher } from '../auth/password-hasher';
import {
  FAKE_WEBHOOK_DEFAULTS,
  signedWebhook,
  textMessageNotification,
} from '../../testing/fake-meta';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { TEST_APP_ORIGIN } from '../../testing/build-test-app';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const PASSWORD = 'sandi-uji-inbox-realtime-01';
const SECRET_TEXT = 'ISI-PESAN-REALTIME-RAHASIA-4410';
const META_IP = '173.252.127.1';
const MAX_CONNECTIONS = 3;

let harness: IntegrationHarness;
let owner: SignedIn & { userId: string };
let organizationId: string;
let channelId: string;
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const hasher = createPasswordHasher();
const workerLogs = createLogCapture();
const sockets: WebSocket[] = [];

async function insertChannel(): Promise<string> {
  const id = newId();
  const target = { id, organizationId };
  await harness.db.insert(channels).values({
    id,
    organizationId,
    type: 'whatsapp',
    name: 'CS Utama',
    waPhoneNumberId: FAKE_WEBHOOK_DEFAULTS.phoneNumberId,
    waBusinessAccountId: FAKE_WEBHOOK_DEFAULTS.wabaId,
    waAccessTokenEncrypted: sealChannelSecret(box, target, 'accessToken', 'EAAtokenTiruan0123'),
    waAccessTokenTail: '0123',
    waAppSecretEncrypted: sealChannelSecret(box, target, 'appSecret', APP_SECRET),
    waAppSecretTail: 'cdef',
    waVerifyTokenEncrypted: sealChannelSecret(box, target, 'verifyToken', 'verify-token-0123456'),
    waVerifyTokenRotatedAt: new Date(),
  });
  return id;
}

/** Webhook bertanda tangan → penerima → worker (dengan penerbit Redis berawalan tes ini). */
async function receive(notification: unknown): Promise<void> {
  const { body, headers } = signedWebhook(notification, APP_SECRET);
  const response = await harness.app.inject({
    method: 'POST',
    url: apiPath(WEBHOOK_ROUTES.whatsapp, { channelId }),
    headers,
    payload: body,
    remoteAddress: META_IP,
  });
  expect(response.statusCode, response.body).toBe(200);
  const publisher = createInboxEventPublisher(harness.redis, {
    prefix: harness.redisPrefix,
    logger: workerLogs.logger,
  });
  for (const data of harness.webhookJobs.splice(0)) {
    await processWebhookJob(
      { name: WEBHOOK_JOBS.whatsappEvent, data, attemptsMade: 0, opts: { attempts: 8 } },
      { db: harness.db, logger: workerLogs.logger, publisher },
    );
  }
}

async function signIn(
  role: 'cs' | 'teknisi',
  name: string,
): Promise<SignedIn & { userId: string }> {
  const user = await insertUser(harness.db, organizationId, {
    role,
    name,
    email: `${role}.${newId().slice(-8)}@majujaya.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  const signed = await login(harness.app, { email: user.email, password: PASSWORD });
  return { ...signed, userId: user.id };
}

interface Stream {
  socket: WebSocket;
  events: InboxStreamEvent[];
  closed: Promise<number>;
}

async function connect(signed: { cookie: string } | null, origin: string | null = TEST_APP_ORIGIN) {
  const headers: Record<string, string> = {};
  if (signed) headers.cookie = signed.cookie;
  if (origin !== null) headers.origin = origin;
  const events: InboxStreamEvent[] = [];
  let socket: WebSocket | undefined;
  const ws = await harness.app.injectWS(
    API_ROUTES.inbox.stream,
    { headers },
    {
      onInit: (created) => {
        socket = created;
        created.on('message', (data: Buffer) => {
          events.push(inboxStreamEventSchema.parse(JSON.parse(data.toString('utf8'))));
        });
      },
    },
  );
  sockets.push(ws);
  const closed = new Promise<number>((resolve) => {
    (socket ?? ws).on('close', (code: number) => resolve(code));
  });
  return { socket: ws, events, closed } satisfies Stream;
}

async function eventually(check: () => void, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function conversationOf(phone: string) {
  const [row] = await harness.db
    .select({ id: conversations.id, contactId: conversations.contactId })
    .from(conversations)
    .where(eq(conversations.organizationId, organizationId));
  if (!row) throw new Error(`percakapan ${phone} belum ada`);
  return row;
}

beforeAll(async () => {
  harness = await createIntegrationHarness({
    overrides: {
      // Heartbeat & validasi ulang dipanggil manual di tes (deterministik).
      inboxStream: {
        heartbeatMs: 3_600_000,
        revalidateMs: 3_600_000,
        maxConnectionsPerUser: MAX_CONNECTIONS,
      },
    },
  });
});
beforeEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await harness.reset();
  const signed = await completeSetup(harness.app);
  owner = { ...signed, userId: signed.session.user.id };
  organizationId = signed.session.organization.id;
  channelId = await insertChannel();
});
afterAll(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await harness?.close();
});

describe('WebSocket: penolakan sebelum upgrade', () => {
  it('tanpa sesi → 401; sesi sah tapi Origin asing / tanpa Origin → 403 + audit', async () => {
    await expect(connect(null)).rejects.toThrow('Unexpected server response: 401');
    await expect(connect(owner, 'https://penyerang.test')).rejects.toThrow(
      'Unexpected server response: 403',
    );
    await expect(connect(owner, null)).rejects.toThrow('Unexpected server response: 403');

    const audits = await harness.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, organizationId),
          eq(auditLogs.action, AUDIT_ACTIONS.csrfRejected),
        ),
      );
    // Dibatasi 1×/menit per pengguna.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: owner.userId });
    expect(audits[0]?.metadata).toMatchObject({
      reason: 'origin',
      originHost: 'penyerang.test',
      route: API_ROUTES.inbox.stream,
    });
    expect(harness.app.inboxStream.connections()).toBe(0);
  });

  it('sesi dicabut sebelum terhubung → 401', async () => {
    await harness.db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(eq(userSessions.userId, owner.userId));
    await expect(connect(owner)).rejects.toThrow('Unexpected server response: 401');
  });

  it(`batas ${String(MAX_CONNECTIONS)} koneksi per pengguna → 429`, async () => {
    for (let index = 0; index < MAX_CONNECTIONS; index += 1) await connect(owner);
    await expect(connect(owner)).rejects.toThrow('Unexpected server response: 429');
    expect(harness.app.inboxStream.connections(owner.userId)).toBe(MAX_CONNECTIONS);
  });

  it('permintaan HTTP biasa ke alamat stream (tanpa upgrade) → 404', async () => {
    const response = await call(harness.app, 'GET', API_ROUTES.inbox.stream, undefined, {
      cookie: owner.cookie,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('WebSocket: event dan penyaringan per penerima', () => {
  it('terhubung → hello; webhook diproses worker → message.created + conversation.updated tanpa isi pesan', async () => {
    const stream = await connect(owner);
    await eventually(() => expect(stream.events[0]).toMatchObject({ type: 'hello' }));

    await receive(textMessageNotification({ body: SECRET_TEXT }));
    const conversation = await conversationOf('pelanggan');
    await eventually(() => {
      const types = stream.events.map((event) => event.type);
      expect(types).toContain('message.created');
      expect(types).toContain('conversation.updated');
    });
    const updated = stream.events.find((event) => event.type === 'conversation.updated');
    expect(updated).toMatchObject({
      conversationId: conversation.id,
      status: 'unserved',
      assigneeUserId: null,
      unreadCount: 1,
    });
    const created = stream.events.find((event) => event.type === 'message.created');
    expect(created).toMatchObject({ conversationId: conversation.id, direction: 'inbound' });

    const raw = JSON.stringify(stream.events);
    expect(raw).not.toContain(SECRET_TEXT);
    expect(raw).not.toContain(FAKE_WEBHOOK_DEFAULTS.customerWaId);
    expect(raw).not.toContain(FAKE_WEBHOOK_DEFAULTS.customerName);
    expect(raw).not.toContain(FAKE_WEBHOOK_DEFAULTS.customerUserId);
  });

  it('Teknisi hanya menerima event percakapan yang di-assign kepadanya; CS menerima semua', async () => {
    await receive(
      textMessageNotification({ customer: { waId: '6281500000001', userId: 'ID.r1' } }),
    );
    await receive(
      textMessageNotification({ customer: { waId: '6281500000002', userId: 'ID.r2' } }),
    );
    const rows = await harness.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.organizationId, organizationId))
      .orderBy(conversations.number);
    const [mine, other] = rows;
    const teknisi = await signIn('teknisi', 'Arya Teknisi');
    const cs = await signIn('cs', 'Sinta CS');
    await harness.db
      .update(conversations)
      .set({ status: 'served', assigneeUserId: teknisi.userId })
      .where(eq(conversations.id, mine!.id));

    const teknisiStream = await connect(teknisi);
    const csStream = await connect(cs);
    for (const conversationId of [mine!.id, other!.id]) {
      await harness.app.inboxStream.deliver({
        v: 1,
        type: 'conversation.updated',
        organizationId,
        conversationId,
      });
    }
    await receive(
      textMessageNotification({ customer: { waId: '6281500000002', userId: 'ID.r2' } }),
    );
    await settle();

    const idsOf = (stream: Stream) =>
      new Set(
        stream.events.flatMap((event) => ('conversationId' in event ? [event.conversationId] : [])),
      );
    expect([...idsOf(teknisiStream)]).toEqual([mine!.id]);
    expect(idsOf(csStream)).toEqual(new Set([mine!.id, other!.id]));
  });

  it('event organisasi lain / pesan bus rusak tidak sampai ke siapa pun', async () => {
    const stream = await connect(owner);
    await eventually(() => expect(stream.events).toHaveLength(1));
    expect(
      await harness.app.inboxStream.deliver({
        v: 1,
        type: 'conversation.updated',
        organizationId: newId(),
        conversationId: newId(),
      }),
    ).toBe(0);
    await harness.redis.publish(`${harness.redisPrefix}:inbox-events`, '{"bukan":"event"}');
    await harness.redis.publish(`${harness.redisPrefix}:inbox-events`, 'bukan json');
    await settle();
    expect(stream.events).toHaveLength(1);
  });
});

describe('WebSocket: sesi, peran, heartbeat', () => {
  it('sesi dicabut / akun dinonaktifkan → diputus 4401 pada validasi ulang', async () => {
    const cs = await signIn('cs', 'Sinta CS');
    const ownerStream = await connect(owner);
    const csStream = await connect(cs);
    await harness.db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(eq(userSessions.userId, owner.userId));
    await harness.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, cs.userId));
    await harness.app.inboxStream.revalidate();
    expect(await ownerStream.closed).toBe(INBOX_STREAM_CLOSE_CODES.sessionEnded);
    expect(await csStream.closed).toBe(INBOX_STREAM_CLOSE_CODES.sessionEnded);
    expect(harness.app.inboxStream.connections()).toBe(0);
  });

  it('peran berubah → cakupan baru langsung berlaku (Teknisi → CS menerima semua)', async () => {
    await receive(textMessageNotification());
    const conversation = await conversationOf('pelanggan');
    const teknisi = await signIn('teknisi', 'Arya Teknisi');
    const stream = await connect(teknisi);
    const deliver = () =>
      harness.app.inboxStream.deliver({
        v: 1,
        type: 'conversation.updated',
        organizationId,
        conversationId: conversation.id,
      });
    expect(await deliver()).toBe(0);
    await harness.db.update(users).set({ role: 'cs' }).where(eq(users.id, teknisi.userId));
    await harness.app.inboxStream.revalidate();
    expect(await deliver()).toBe(1);
    await eventually(() =>
      expect(stream.events.map((event) => event.type)).toContain('conversation.updated'),
    );
  });

  it('peran dinaikkan menjadi wajib 2FA tanpa 2FA → sesi tidak cocok lagi → 4401', async () => {
    const cs = await signIn('cs', 'Sinta CS');
    const stream = await connect(cs);
    await harness.db.update(users).set({ role: 'supervisor' }).where(eq(users.id, cs.userId));
    await harness.app.inboxStream.revalidate();
    expect(await stream.closed).toBe(INBOX_STREAM_CLOSE_CODES.sessionEnded);
  });

  it('tidak menjawab ping sampai heartbeat berikutnya → 4408', async () => {
    const stream = await connect(owner);
    // Dua putaran beruntun tanpa kesempatan pong terproses di antaranya.
    harness.app.inboxStream.heartbeat();
    harness.app.inboxStream.heartbeat();
    expect(await stream.closed).toBe(INBOX_STREAM_CLOSE_CODES.heartbeatTimeout);
  });

  it('socket terbuka tidak memperpanjang batas idle sesi', async () => {
    const before = await harness.db
      .select({ idle: userSessions.idleExpiresAt })
      .from(userSessions)
      .where(eq(userSessions.userId, owner.userId));
    await connect(owner);
    await harness.db
      .update(userSessions)
      .set({ lastSeenAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(userSessions.userId, owner.userId));
    await harness.app.inboxStream.revalidate();
    const after = await harness.db
      .select({ idle: userSessions.idleExpiresAt })
      .from(userSessions)
      .where(eq(userSessions.userId, owner.userId));
    expect(after.map((row) => row.idle.getTime())).toEqual(before.map((row) => row.idle.getTime()));
  });
});

describe('hitungan per tab, saringan, tandai dibaca', () => {
  async function seed() {
    for (const index of [1, 2, 3, 4]) {
      await receive(
        textMessageNotification({
          customer: { waId: `628160000000${String(index)}`, userId: `ID.t${String(index)}` },
        }),
      );
    }
    const rows = await harness.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.organizationId, organizationId))
      .orderBy(conversations.number);
    const now = Date.now();
    const teknisi = await signIn('teknisi', 'Arya Teknisi');
    // 1: dilayani Teknisi, jendela terbuka; 2: bot, hampir habis; 3: selesai, kedaluwarsa;
    // 4: belum dilayani, tanpa jendela (mis. dari broadcast), sudah dibaca.
    await harness.db
      .update(conversations)
      .set({ status: 'served', assigneeUserId: teknisi.userId })
      .where(eq(conversations.id, rows[0]!.id));
    await harness.db
      .update(conversations)
      .set({
        status: 'bot',
        lastInboundAt: new Date(now - 23 * 60 * 60 * 1000),
        windowExpiresAt: new Date(now + 60 * 60 * 1000),
      })
      .where(eq(conversations.id, rows[1]!.id));
    await harness.db
      .update(conversations)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        lastInboundAt: new Date(now - 30 * 60 * 60 * 1000),
        windowExpiresAt: new Date(now - 6 * 60 * 60 * 1000),
      })
      .where(eq(conversations.id, rows[2]!.id));
    await harness.db
      .update(conversations)
      .set({ lastInboundAt: null, windowExpiresAt: null, unreadCount: 0 })
      .where(eq(conversations.id, rows[3]!.id));
    return { ids: rows.map((row) => row.id), teknisi };
  }

  const countsOf = async (signed: SignedIn, query = '') => {
    const response = await call(
      harness.app,
      'GET',
      `${API_ROUTES.inbox.counts}${query}`,
      undefined,
      { cookie: signed.cookie },
    );
    expect(response.statusCode, response.body).toBe(200);
    return conversationCountsResponseSchema.parse(response.json());
  };
  const listIds = async (signed: SignedIn, query: string) => {
    const response = await call(
      harness.app,
      'GET',
      `${API_ROUTES.inbox.conversations}${query}`,
      undefined,
      { cookie: signed.cookie },
    );
    expect(response.statusCode, response.body).toBe(200);
    return conversationListResponseSchema.parse(response.json()).conversations.map((row) => row.id);
  };

  it('hitungan per tab sesuai cakupan; Teknisi hanya yang di-assign', async () => {
    const { teknisi } = await seed();
    expect(await countsOf(owner)).toEqual({
      counts: { all: 4, bot: 1, unserved: 1, served: 1, resolved: 1 },
      unreadOpen: 2,
    });
    expect(await countsOf(teknisi)).toEqual({
      counts: { all: 1, bot: 0, unserved: 0, served: 1, resolved: 0 },
      unreadOpen: 1,
    });
    expect((await countsOf(owner, '?window=expiring')).counts).toMatchObject({ all: 1, bot: 1 });
    expect((await countsOf(owner, '?q=zz')).counts.all).toBe(0);
  });

  it('saringan agen, jendela 24 jam, belum dibaca', async () => {
    const { ids, teknisi } = await seed();
    expect(await listIds(owner, `?assignee=${teknisi.userId}`)).toEqual([ids[0]]);
    expect(await listIds(teknisi, '?assignee=me')).toEqual([ids[0]]);
    expect((await listIds(owner, '?assignee=unassigned')).sort()).toEqual(
      [ids[1], ids[2], ids[3]].sort(),
    );
    expect(await listIds(owner, '?window=open')).toEqual([ids[0]]);
    expect(await listIds(owner, '?window=expiring')).toEqual([ids[1]]);
    expect(await listIds(owner, '?window=expired')).toEqual([ids[2]]);
    expect(await listIds(owner, '?window=none')).toEqual([ids[3]]);
    expect(await listIds(owner, '?unread=false')).toEqual([ids[3]]);
    expect((await listIds(owner, '?unread=true')).sort()).toEqual([ids[0], ids[1], ids[2]].sort());
    const bad = await call(
      harness.app,
      'GET',
      `${API_ROUTES.inbox.conversations}?window=x`,
      undefined,
      {
        cookie: owner.cookie,
      },
    );
    expect(bad.statusCode).toBe(400);
  });

  it('tandai dibaca: CSRF wajib (ditolak + diaudit), Teknisi di luar cakupan 404, event terkirim', async () => {
    const { ids, teknisi } = await seed();
    const url = apiPath(API_ROUTES.inbox.read, { conversationId: ids[1]! });

    const noToken = await call(harness.app, 'POST', url, undefined, { cookie: owner.cookie });
    expect(noToken.statusCode).toBe(403);
    const [audit] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.csrfRejected));
    expect(audit?.metadata).toMatchObject({ reason: 'token', method: 'POST' });

    expect(
      (
        await call(harness.app, 'POST', url, undefined, {
          cookie: teknisi.cookie,
          csrf: teknisi.csrf,
        })
      ).statusCode,
    ).toBe(404);

    const stream = await connect(owner);
    const read = await call(harness.app, 'POST', url, undefined, {
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(conversationResponseSchema.parse(read.json()).conversation.unreadCount).toBe(0);
    await eventually(() =>
      expect(stream.events).toContainEqual(
        expect.objectContaining({
          type: 'conversation.updated',
          conversationId: ids[1],
          unreadCount: 0,
        }),
      ),
    );
    // Idempoten.
    const again = await call(harness.app, 'POST', url, undefined, {
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(again.statusCode).toBe(200);
  });

  it('POST bersesi dari Origin asing ditolak dan diaudit (tanpa memperpanjang sesi)', async () => {
    const { ids } = await seed();
    const url = apiPath(API_ROUTES.inbox.read, { conversationId: ids[0]! });
    const response = await call(harness.app, 'POST', url, undefined, {
      cookie: owner.cookie,
      csrf: owner.csrf,
      origin: 'https://penyerang.test',
    });
    expect(response.statusCode).toBe(403);
    const [audit] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.csrfRejected));
    expect(audit?.metadata).toMatchObject({ reason: 'origin', originHost: 'penyerang.test' });
  });
});
