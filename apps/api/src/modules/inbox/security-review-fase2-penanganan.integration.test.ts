/**
 * Review keamanan Fase 2 butir 7 — penanganan percakapan
 * (docs/security-reviews/2026-11-17-fase2-penanganan-percakapan.md). Penjaga regresi: cakupan
 * Teknisi pada riwayat/buka lagi/selesai, sasaran penugasan lintas organisasi, peran yang diturunkan
 * di tengah sesi, dan jawaban tanpa data di luar cakupan. Postgres + Redis sungguhan.
 */
import {
  auditLogs,
  channels,
  contacts,
  conversationEvents,
  conversations,
  newId,
  users,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  AUDIT_ACTIONS,
  apiPath,
  conversationActionResponseSchema,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from '../auth/password-hasher';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const PASSWORD = 'sandi-review-penanganan-3';

type Agent = SignedIn & { userId: string };

let harness: IntegrationHarness;
let owner: Agent;
let organizationId: string;
let channelId: string;
const hasher = createPasswordHasher();

async function agent(role: 'cs' | 'teknisi' | 'supervisor', name: string): Promise<Agent> {
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

async function conversation(overrides: Partial<typeof conversations.$inferInsert> = {}) {
  const [contact] = await harness.db
    .insert(contacts)
    .values({ organizationId, channelType: 'whatsapp', waBsuid: `ID.${newId().slice(-10)}` })
    .returning();
  const [row] = await harness.db
    .insert(conversations)
    .values({
      organizationId,
      contactId: contact!.id,
      channelId,
      status: 'unserved',
      lastMessageAt: new Date(),
      ...overrides,
    })
    .returning();
  return row!;
}

function post(signed: SignedIn, route: string, id: string, body?: unknown) {
  return call(harness.app, 'POST', apiPath(route, { conversationId: id }), body, {
    cookie: signed.cookie,
    csrf: signed.csrf,
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
});

describe('cakupan Teknisi', () => {
  it('riwayat, buka lagi, dan selesai untuk percakapan orang lain → 404 tanpa perubahan', async () => {
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    const others = await conversation({
      status: 'resolved',
      resolvedAt: new Date(),
      assigneeUserId: owner.userId,
    });
    const open = await conversation({ status: 'served', assigneeUserId: owner.userId });

    const events = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.events, { conversationId: others.id }),
      undefined,
      { cookie: teknisi.cookie },
    );
    expect(events.statusCode).toBe(404);
    expect((await post(teknisi, API_ROUTES.inbox.reopen, others.id)).statusCode).toBe(404);
    expect((await post(teknisi, API_ROUTES.inbox.resolve, open.id)).statusCode).toBe(404);
    expect((await stateOf(others.id)).status).toBe('resolved');
    expect((await stateOf(open.id)).status).toBe('served');
    expect(await harness.db.select().from(conversationEvents)).toEqual([]);
  });

  it('Teknisi tidak bisa menugaskan (403) — termasuk menugaskan ke dirinya sendiri', async () => {
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    const row = await conversation();
    const response = await post(teknisi, API_ROUTES.inbox.assign, row.id, {
      userId: teknisi.userId,
    });
    expect(response.statusCode).toBe(403);
    expect((await stateOf(row.id)).assigneeUserId).toBeNull();
  });
});

describe('sasaran & pelaku', () => {
  it('pengguna organisasi lain tidak bisa dijadikan agen (400), percakapan tidak berubah', async () => {
    const other = await insertOrganization(harness.db);
    const stranger = await insertUser(harness.db, other.id, {
      role: 'cs',
      email: `luar.${newId().slice(-8)}@lain.test`,
      passwordHash: await hasher.hash(PASSWORD),
    });
    const row = await conversation();
    const response = await post(owner, API_ROUTES.inbox.assign, row.id, { userId: stranger.id });
    expect(response.statusCode).toBe(400);
    expect((await stateOf(row.id)).assigneeUserId).toBeNull();
  });

  it('CS yang diturunkan menjadi Teknisi tidak bisa lagi mengambil percakapan (cek ulang peran)', async () => {
    const cs = await agent('cs', 'Sinta CS');
    const row = await conversation();
    await harness.db.update(users).set({ role: 'teknisi' }).where(eq(users.id, cs.userId));
    const response = await post(cs, API_ROUTES.inbox.claim, row.id);
    expect([401, 403]).toContain(response.statusCode);
    expect((await stateOf(row.id)).assigneeUserId).toBeNull();
  });

  it('Teknisi yang mengembalikan chat-nya menerima conversation null (tanpa data yang tak lagi boleh dilihat)', async () => {
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    const row = await conversation({ status: 'served', assigneeUserId: teknisi.userId });
    const response = await post(teknisi, API_ROUTES.inbox.unassign, row.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(conversationActionResponseSchema.parse(response.json()).conversation).toBeNull();
  });
});

describe('Putaran 2 — R2: alarm aksi massal bisa dihindari dengan "tugaskan"', () => {
  // Alarm hanya menghitung `claimed`/`resolved`/`unassigned`. Mengalihkan chat yang sedang dilayani
  // agen lain ke diri sendiri (atau mengosongkan antrian ke akun rekanan) tercatat `assigned` →
  // tidak dihitung, jadi antrian bisa dikuras tanpa kejadian keamanan.
  it.fails('31 pengalihan ke diri sendiri dalam 10 menit → audit inbox.bulk_action', async () => {
    const cs = await agent('cs', 'Sinta CS');
    const holder = await agent('supervisor', 'Rina Supervisor');
    for (let index = 0; index < 31; index += 1) {
      const row = await conversation({ status: 'served', assigneeUserId: holder.userId });
      const response = await post(cs, API_ROUTES.inbox.assign, row.id, { userId: cs.userId });
      expect(response.statusCode, response.body).toBe(200);
    }
    const alarms = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.inboxBulkAction));
    expect(alarms).toHaveLength(1); // saat ini 0
  });
});
