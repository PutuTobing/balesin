/**
 * Penanganan percakapan (Fase 2 butir 7): ambil (balapan), tugaskan/alihkan, kembalikan, selesai,
 * buka lagi — RBAC per peran, cakupan Teknisi berubah saat dialihkan (+ event WS), riwayat, waktu
 * laporan, daftar agen. Postgres + Redis sungguhan.
 */
import { randomUUID } from 'node:crypto';

import {
  auditLogs,
  channels,
  contacts,
  conversationEvents,
  conversations,
  newId,
  users,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  conversationActionResponseSchema,
  conversationEventListResponseSchema,
  errorEnvelopeSchema,
  inboxAgentListResponseSchema,
  inboxStreamEventSchema,
  securitySummaryResponseSchema,
  type InboxStreamEvent,
  type UserRole,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from '../auth/password-hasher';
import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const PASSWORD = 'sandi-uji-penanganan-01';

type Agent = SignedIn & { userId: string; name: string };

let harness: IntegrationHarness;
let owner: Agent;
let organizationId: string;
let channelId: string;
const hasher = createPasswordHasher();

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

async function conversation(overrides: Partial<typeof conversations.$inferInsert> = {}) {
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'whatsapp',
      waBsuid: `ID.${newId().slice(-10)}`,
      phone: `+62813${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    })
    .returning();
  const now = Date.now();
  const [row] = await harness.db
    .insert(conversations)
    .values({
      organizationId,
      contactId: contact!.id,
      channelId,
      status: 'unserved',
      lastMessageAt: new Date(now),
      lastInboundAt: new Date(now - 60_000),
      windowExpiresAt: new Date(now + 23 * 60 * 60 * 1000),
      ...overrides,
    })
    .returning();
  return row!;
}

function act(signed: SignedIn, route: string, id: string, body?: unknown, csrf = true) {
  return call(harness.app, 'POST', apiPath(route, { conversationId: id }), body, {
    cookie: signed.cookie,
    ...(csrf ? { csrf: signed.csrf } : {}),
  });
}

const stateOf = async (id: string) =>
  (await harness.db.select().from(conversations).where(eq(conversations.id, id)))[0]!;

beforeAll(async () => {
  harness = await createIntegrationHarness({
    overrides: { inboxStream: { heartbeatMs: 3_600_000, revalidateMs: 3_600_000 } },
  });
});
beforeEach(async () => {
  await harness.reset();
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
});

describe('ambil dari antrian', () => {
  it('dua agen mengambil bersamaan → satu menang, yang lain 409 menyebut pemegangnya', async () => {
    const row = await conversation();
    const ani = await agent('cs', 'Ani CS');
    const budi = await agent('cs', 'Budi CS');
    const [first, second] = await Promise.all([
      act(ani, API_ROUTES.inbox.claim, row.id),
      act(budi, API_ROUTES.inbox.claim, row.id),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = first.statusCode === 409 ? first : second;
    const winner = first.statusCode === 200 ? ani : budi;
    expect(errorEnvelopeSchema.parse(loser.json()).error.message).toContain(winner.name);

    const state = await stateOf(row.id);
    expect(state).toMatchObject({ status: 'served', assigneeUserId: winner.userId });
    expect(state.firstAssignedAt).toBeInstanceOf(Date);
    const events = await harness.db
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, row.id));
    expect(events).toMatchObject([{ kind: 'claimed', actorUserId: winner.userId }]);
  });

  it('Teknisi tidak boleh mengambil (403); CSRF wajib; percakapan selesai tidak bisa diambil', async () => {
    const row = await conversation();
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    expect((await act(teknisi, API_ROUTES.inbox.claim, row.id)).statusCode).toBe(403);
    expect((await act(owner, API_ROUTES.inbox.claim, row.id, undefined, false)).statusCode).toBe(
      403,
    );
    const resolved = await conversation({ status: 'resolved', resolvedAt: new Date() });
    expect((await act(owner, API_ROUTES.inbox.claim, resolved.id)).statusCode).toBe(409);
  });
});

describe('tugaskan, alihkan, kembalikan', () => {
  it('Teknisi kehilangan akses saat dialihkan: event conversation.removed ke Teknisi lama, updated ke yang baru', async () => {
    const row = await conversation();
    const cs = await agent('cs', 'Sinta CS');
    const arya = await agent('teknisi', 'Arya Teknisi');
    const bayu = await agent('teknisi', 'Bayu Teknisi');

    const assigned = await act(cs, API_ROUTES.inbox.assign, row.id, { userId: arya.userId });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(conversationActionResponseSchema.parse(assigned.json()).conversation?.assignee).toEqual({
      id: arya.userId,
      name: 'Arya Teknisi',
    });
    const detail = (signed: SignedIn) =>
      call(
        harness.app,
        'GET',
        apiPath(API_ROUTES.inbox.conversation, { conversationId: row.id }),
        undefined,
        {
          cookie: signed.cookie,
        },
      );
    expect((await detail(arya)).statusCode).toBe(200);

    const streams = new Map<string, InboxStreamEvent[]>();
    for (const signed of [arya, bayu]) {
      const events: InboxStreamEvent[] = [];
      const socket = await harness.app.injectWS(API_ROUTES.inbox.stream, {
        headers: { cookie: signed.cookie, origin: TEST_APP_ORIGIN },
      });
      socket.on('message', (data: Buffer) => {
        events.push(inboxStreamEventSchema.parse(JSON.parse(data.toString('utf8'))));
      });
      streams.set(signed.userId, events);
    }

    expect(
      (await act(cs, API_ROUTES.inbox.assign, row.id, { userId: bayu.userId })).statusCode,
    ).toBe(200);
    expect((await detail(arya)).statusCode).toBe(404);
    expect((await detail(bayu)).statusCode).toBe(200);

    const started = Date.now();
    while (Date.now() - started < 3000) {
      const aryaEvents = streams.get(arya.userId) ?? [];
      const bayuEvents = streams.get(bayu.userId) ?? [];
      if (
        aryaEvents.some((event) => event.type === 'conversation.removed') &&
        bayuEvents.some((event) => event.type === 'conversation.updated')
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(streams.get(arya.userId)).toContainEqual({
      type: 'conversation.removed',
      conversationId: row.id,
    });
    expect(streams.get(arya.userId)?.some((event) => event.type === 'conversation.updated')).toBe(
      false,
    );
    expect(streams.get(bayu.userId)).toContainEqual(
      expect.objectContaining({
        type: 'conversation.updated',
        conversationId: row.id,
        assigneeUserId: bayu.userId,
      }),
    );

    const log = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.events, { conversationId: row.id }),
      undefined,
      {
        cookie: owner.cookie,
      },
    );
    expect(conversationEventListResponseSchema.parse(log.json()).events).toMatchObject([
      {
        kind: 'assigned',
        actor: { name: 'Sinta CS' },
        assignee: { name: 'Arya Teknisi' },
        previousAssignee: null,
      },
      {
        kind: 'assigned',
        actor: { name: 'Sinta CS' },
        assignee: { name: 'Bayu Teknisi' },
        previousAssignee: { name: 'Arya Teknisi' },
      },
    ]);
  });

  it('sasaran harus aktif, organisasi sama, dan berizin membalas', async () => {
    const row = await conversation();
    const disabled = await agent('cs', 'Nonaktif');
    await harness.db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, disabled.userId));
    for (const userId of [disabled.userId, newId()]) {
      const response = await act(owner, API_ROUTES.inbox.assign, row.id, { userId });
      expect(response.statusCode).toBe(400);
    }
    expect((await stateOf(row.id)).assigneeUserId).toBeNull();
  });

  it('Teknisi hanya mengembalikan chat miliknya (jawaban tanpa percakapan karena aksesnya hilang)', async () => {
    const row = await conversation();
    const arya = await agent('teknisi', 'Arya Teknisi');
    const other = await conversation();
    await act(owner, API_ROUTES.inbox.assign, row.id, { userId: arya.userId });
    await act(owner, API_ROUTES.inbox.claim, other.id);

    expect((await act(arya, API_ROUTES.inbox.unassign, other.id)).statusCode).toBe(404);
    const released = await act(arya, API_ROUTES.inbox.unassign, row.id);
    expect(released.statusCode, released.body).toBe(200);
    expect(conversationActionResponseSchema.parse(released.json())).toEqual({ conversation: null });
    expect(await stateOf(row.id)).toMatchObject({ status: 'unserved', assigneeUserId: null });
  });
});

describe('selesai & buka lagi', () => {
  it('selesai → resolvedAt; idempoten; buka lagi kembali ke pemegang; sesi lebih lama tidak bisa dibuka', async () => {
    const row = await conversation();
    await act(owner, API_ROUTES.inbox.claim, row.id);
    expect((await act(owner, API_ROUTES.inbox.resolve, row.id)).statusCode).toBe(200);
    expect((await stateOf(row.id)).resolvedAt).toBeInstanceOf(Date);
    expect((await act(owner, API_ROUTES.inbox.resolve, row.id)).statusCode).toBe(200);

    const reopened = await act(owner, API_ROUTES.inbox.reopen, row.id);
    expect(conversationActionResponseSchema.parse(reopened.json()).conversation).toMatchObject({
      status: 'served',
      resolvedAt: null,
      assignee: { id: owner.userId },
    });

    await act(owner, API_ROUTES.inbox.resolve, row.id);
    // Pesan baru dari pelanggan membuka sesi baru → sesi lama tidak boleh dibuka lagi.
    await harness.db.insert(conversations).values({
      organizationId,
      contactId: row.contactId,
      channelId,
      status: 'unserved',
      lastMessageAt: new Date(),
    });
    const conflict = await act(owner, API_ROUTES.inbox.reopen, row.id);
    expect(conflict.statusCode).toBe(409);
    const kinds = (
      await harness.db
        .select()
        .from(conversationEvents)
        .where(eq(conversationEvents.conversationId, row.id))
    ).map((event) => event.kind);
    expect(kinds).toEqual(['claimed', 'resolved', 'reopened', 'resolved']);
  });

  it('Teknisi menyelesaikan percakapan miliknya; selain itu 404', async () => {
    const mine = await conversation();
    const notMine = await conversation();
    const arya = await agent('teknisi', 'Arya Teknisi');
    await act(owner, API_ROUTES.inbox.assign, mine.id, { userId: arya.userId });
    expect((await act(arya, API_ROUTES.inbox.resolve, notMine.id)).statusCode).toBe(404);
    expect((await act(arya, API_ROUTES.inbox.resolve, mine.id)).statusCode).toBe(200);
  });
});

describe('laporan & agen', () => {
  it('waktu respons pertama terisi dari pesan keluar pertama agen', async () => {
    const row = await conversation();
    await act(owner, API_ROUTES.inbox.claim, row.id);
    const sent = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.messages, { conversationId: row.id }),
      { type: 'text', clientMessageId: randomUUID(), text: 'Halo kak' },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(sent.statusCode, sent.body).toBe(202);
    const first = (await stateOf(row.id)).firstResponseAt;
    expect(first).toBeInstanceOf(Date);
    await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.messages, { conversationId: row.id }),
      { type: 'text', clientMessageId: randomUUID(), text: 'Ada lagi?' },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect((await stateOf(row.id)).firstResponseAt?.getTime()).toBe(first?.getTime());
  });

  it('daftar agen (inbox.assign; Teknisi 403): tanpa email, status aktif, beban percakapan', async () => {
    const cs = await agent('cs', 'Sinta CS');
    const gone = await agent('teknisi', 'Lama Teknisi');
    await harness.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, gone.userId));
    const row = await conversation();
    const claimed = await act(cs, API_ROUTES.inbox.claim, row.id);
    expect(claimed.statusCode, claimed.body).toBe(200);
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    const denied = await call(harness.app, 'GET', API_ROUTES.inbox.agents, undefined, {
      cookie: teknisi.cookie,
    });
    expect(denied.statusCode).toBe(403);
    const response = await call(harness.app, 'GET', API_ROUTES.inbox.agents, undefined, {
      cookie: cs.cookie,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('@majujaya.test');
    const { agents } = inboxAgentListResponseSchema.parse(response.json());
    expect(agents.find((item) => item.id === cs.userId)).toMatchObject({
      active: true,
      openConversations: 1,
      role: 'cs',
    });
    expect(agents.find((item) => item.id === gone.userId)).toMatchObject({ active: false });
  });
});

describe('alarm aksi massal (review butir 7 R1)', () => {
  it('> 30 ambil/kembalikan dalam 10 menit → audit + kejadian keamanan warning, sekali per jam', async () => {
    const cs = await agent('cs', 'Sinta CS');
    const row = await conversation();
    for (let round = 0; round < 18; round += 1) {
      expect((await act(cs, API_ROUTES.inbox.claim, row.id)).statusCode).toBe(200);
      expect((await act(cs, API_ROUTES.inbox.unassign, row.id)).statusCode).toBe(200);
    }
    const alarms = await harness.db
      .select({ metadata: auditLogs.metadata, actor: auditLogs.actorUserId })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'inbox.bulk_action'));
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ actor: cs.userId, metadata: { actorRole: 'cs' } });
    const summary = await call(harness.app, 'GET', API_ROUTES.audit.securitySummary, undefined, {
      cookie: owner.cookie,
    });
    const parsed = securitySummaryResponseSchema.parse(summary.json());
    expect(parsed.counts.inbox_bulk_action).toBe(1);
    expect(parsed.events).toContainEqual(
      expect.objectContaining({ kind: 'inbox_bulk_action', severity: 'warning' }),
    );
  });
});
