/**
 * Review keamanan Fase 2 butir 5 — inbox real-time
 * (docs/security-reviews/2026-11-16-fase2-inbox-realtime.md). Penjaga regresi (`it`) + temuan yang
 * dikunci `it.fails` (harus menjadi `it` setelah diperbaiki). Postgres + Redis sungguhan; percakapan
 * disisipkan langsung ke database (tanpa webhook).
 */
import { auditLogs, contacts, conversations, newId, userSessions } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  AUDIT_ACTIONS,
  INBOX_STREAM_CLOSE_CODES,
  apiPath,
  conversationCountsResponseSchema,
  conversationListResponseSchema,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

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

const PASSWORD = 'sandi-review-realtime-77';

let harness: IntegrationHarness;
let owner: SignedIn & { userId: string };
let organizationId: string;
const hasher = createPasswordHasher();
const sockets: WebSocket[] = [];

async function signIn(role: 'cs' | 'teknisi'): Promise<SignedIn & { userId: string }> {
  const user = await insertUser(harness.db, organizationId, {
    role,
    name: `Review ${role}`,
    email: `${role}.${newId().slice(-8)}@majujaya.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return {
    ...(await login(harness.app, { email: user.email, password: PASSWORD })),
    userId: user.id,
  };
}

/** Kontak + percakapan langsung di database (tanpa webhook). */
async function insertConversation(assigneeUserId: string | null, unreadCount = 3) {
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'whatsapp',
      waBsuid: `ID.review.${newId().slice(-12)}`,
    })
    .returning({ id: contacts.id });
  const channelId = await channelIdOf();
  const [conversation] = await harness.db
    .insert(conversations)
    .values({
      organizationId,
      contactId: contact!.id,
      channelId,
      status: assigneeUserId ? 'served' : 'unserved',
      assigneeUserId,
      unreadCount,
      lastMessageAt: new Date(),
    })
    .returning({ id: conversations.id });
  return conversation!.id;
}

let cachedChannelId: string | null = null;
async function channelIdOf(): Promise<string> {
  if (cachedChannelId) return cachedChannelId;
  const { channels } = await import('@balesin/db');
  const id = newId();
  await harness.db.insert(channels).values({
    id,
    organizationId,
    type: 'whatsapp',
    name: 'CS Review',
    waPhoneNumberId: '106540352240001',
    waBusinessAccountId: '102290129340398',
    waAccessTokenEncrypted: 'tiruan',
    waAppSecretEncrypted: 'tiruan',
    waVerifyTokenEncrypted: 'tiruan',
    waVerifyTokenRotatedAt: new Date(),
  });
  cachedChannelId = id;
  return id;
}

async function connect(signed: { cookie: string }) {
  let socket: WebSocket | undefined;
  const ws = await harness.app.injectWS(
    API_ROUTES.inbox.stream,
    { headers: { cookie: signed.cookie, origin: TEST_APP_ORIGIN } },
    {
      onInit: (created) => {
        socket = created;
      },
    },
  );
  sockets.push(ws);
  const closed = new Promise<number>((resolve) => {
    (socket ?? ws).on('close', (code: number) => resolve(code));
  });
  return { socket: ws, closed };
}

async function csrfAudits() {
  return harness.db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        eq(auditLogs.action, AUDIT_ACTIONS.csrfRejected),
      ),
    );
}

beforeAll(async () => {
  harness = await createIntegrationHarness({
    overrides: {
      inboxStream: { heartbeatMs: 3_600_000, revalidateMs: 3_600_000, maxConnectionsPerUser: 3 },
    },
  });
});
beforeEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await harness.reset();
  cachedChannelId = null;
  const signed = await completeSetup(harness.app);
  owner = { ...signed, userId: signed.session.user.id };
  organizationId = signed.session.organization.id;
});
afterAll(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await harness?.close();
});

describe('penjaga regresi', () => {
  it('sesi yang melewati batas idle diputus 4401 pada validasi ulang (socket tidak membuat sesi abadi)', async () => {
    const stream = await connect(owner);
    await harness.db
      .update(userSessions)
      .set({ idleExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(userSessions.userId, owner.userId));
    await harness.app.inboxStream.revalidate();
    expect(await stream.closed).toBe(INBOX_STREAM_CLOSE_CODES.sessionEnded);
  });

  it('pesan klien > 1 KiB menutup socket (1009); pesan kecil diabaikan', async () => {
    const stream = await connect(owner);
    stream.socket.send('x'.repeat(100));
    stream.socket.send('x'.repeat(2_048));
    expect(await stream.closed).toBe(1009);
  });

  it('Teknisi: saringan assignee orang lain / hitungan tidak membocorkan percakapan di luar cakupan', async () => {
    const teknisi = await signIn('teknisi');
    await insertConversation(owner.userId);
    await insertConversation(null);
    const mine = await insertConversation(teknisi.userId);

    const counts = await call(
      harness.app,
      'GET',
      `${API_ROUTES.inbox.counts}?assignee=${owner.userId}`,
      undefined,
      { cookie: teknisi.cookie },
    );
    expect(counts.statusCode, counts.body).toBe(200);
    const parsed = conversationCountsResponseSchema.parse(counts.json());
    expect(parsed.counts.all).toBe(0);
    expect(parsed.unreadOpen).toBe(0);

    const unassigned = await call(
      harness.app,
      'GET',
      `${API_ROUTES.inbox.counts}?assignee=unassigned`,
      undefined,
      { cookie: teknisi.cookie },
    );
    expect(conversationCountsResponseSchema.parse(unassigned.json()).counts.all).toBe(0);

    const list = await call(harness.app, 'GET', `${API_ROUTES.inbox.conversations}`, undefined, {
      cookie: teknisi.cookie,
    });
    expect(
      conversationListResponseSchema.parse(list.json()).conversations.map((c) => c.id),
    ).toEqual([mine]);
  });

  it('Teknisi tidak bisa menandai dibaca percakapan di luar cakupan (404, penghitung tetap)', async () => {
    const teknisi = await signIn('teknisi');
    const other = await insertConversation(owner.userId, 5);
    const response = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.read, { conversationId: other }),
      undefined,
      { cookie: teknisi.cookie, csrf: teknisi.csrf },
    );
    expect(response.statusCode).toBe(404);
    const [row] = await harness.db
      .select({ unread: conversations.unreadCount })
      .from(conversations)
      .where(eq(conversations.id, other));
    expect(row?.unread).toBe(5);
  });
});

describe('R1 — navigasi biasa ke alamat stream dicatat sebagai "CSRF ditolak" atas nama korban', () => {
  // Navigasi tingkat atas (tautan dari situs lain, bookmark) mengirim cookie `SameSite=Lax` tetapi
  // TANPA `Origin`. Penjaga Origin di `preValidation` juga berjalan untuk GET biasa (bukan upgrade),
  // jadi korban tercatat `auth.csrf.rejected` padahal tidak ada pembajakan WebSocket. Penyerang cukup
  // memasang tautan untuk mengotori audit setiap pengguna (1×/menit) dan menutupi percobaan sungguhan.
  it.fails(
    'GET tanpa upgrade dan tanpa Origin (navigasi) tidak membuat audit csrf.rejected',
    async () => {
      const response = await call(harness.app, 'GET', API_ROUTES.inbox.stream, undefined, {
        cookie: owner.cookie,
        origin: null,
        headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' },
      });
      expect([403, 404]).toContain(response.statusCode);
      expect(await csrfAudits()).toEqual([]); // saat ini 1 entri atas nama Owner
    },
  );
});
