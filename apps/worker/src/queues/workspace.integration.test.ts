/**
 * Jam kerja, pesan otomatis, alokasi round-robin (Fase 5) — `dispatchWorkspace` terhadap Postgres
 * sungguhan: adil bergiliran, kapasitas penuh → tetap di antrian, agen dikecualikan/tidak tersedia,
 * luar jam kerja & hari libur, departemen, atomik saat dua worker berjalan bersamaan, pesan otomatis
 * sekali per sesi (bukan percakapan bot/agen), rem darurat, jendela tertutup.
 */
import { createLogCapture } from '@balesin/core/testing';
import {
  agentStates,
  channels,
  closeDb,
  contacts,
  conversationAutoMessages,
  conversationEvents,
  conversations,
  createDb,
  departmentMembers,
  departments,
  messages,
  newId,
  organizations,
  users,
  workspaceSettings,
  type Database,
  type NewWorkspaceSettingsRow,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import { AUTO_MESSAGE_DEFAULT_TEXTS, type UserRole } from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { dispatchWorkspace } from './workspace';

let db: Database;
const logger = createLogCapture('silent').logger;
/** Selasa 17 Nov 2026 10:00 WIB (hari 2). */
const NOW = new Date('2026-11-17T03:00:00Z');

beforeAll(() => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-worker-workspace' });
}, 30_000);

afterAll(async () => {
  if (db) await closeDb(db);
}, 30_000);

let sequence = 0;

async function world(settings: Partial<NewWorkspaceSettingsRow> = {}) {
  const organization = await insertOrganization(db, { timezone: 'Asia/Jakarta' });
  const channelId = newId();
  sequence += 1;
  await db.insert(channels).values({
    id: channelId,
    organizationId: organization.id,
    type: 'whatsapp',
    name: 'CS',
    waPhoneNumberId: `8${String(Date.now())}${String(sequence)}`,
    waBusinessAccountId: '102290129340398',
    waAccessTokenEncrypted: 'x',
    waAppSecretEncrypted: 'x',
    waVerifyTokenEncrypted: 'x',
    waVerifyTokenRotatedAt: new Date(),
  });
  await db.insert(workspaceSettings).values({
    organizationId: organization.id,
    allocationMode: 'round_robin',
    greetingText: AUTO_MESSAGE_DEFAULT_TEXTS.greeting,
    awayText: AUTO_MESSAGE_DEFAULT_TEXTS.away,
    assignedText: AUTO_MESSAGE_DEFAULT_TEXTS.assigned,
    ...settings,
  });
  return { organizationId: organization.id, channelId };
}

type World = Awaited<ReturnType<typeof world>>;

async function agent(w: World, role: UserRole, name: string) {
  return insertUser(db, w.organizationId, {
    role,
    name,
    // Peran wajib 2FA tanpa 2FA aktif tidak ikut alokasi; isi penanda aktif untuk Supervisor.
    ...(role === 'supervisor' || role === 'admin' || role === 'owner'
      ? { totpSecretEncrypted: 'x', totpEnabledAt: new Date() }
      : {}),
  });
}

let phone = 0;
async function waiting(
  w: World,
  options: {
    departmentId?: string;
    firstDirection?: 'inbound' | 'outbound';
    createdAt?: Date;
    windowOpen?: boolean;
    name?: string;
  } = {},
) {
  phone += 1;
  const [contact] = await db
    .insert(contacts)
    .values({
      organizationId: w.organizationId,
      channelType: 'whatsapp',
      phone: `+62812${String(10_000_000 + phone * 7 + (Date.now() % 1000)).slice(-8)}`,
      name: options.name ?? null,
      profileName: 'Budi',
    })
    .returning();
  const createdAt = options.createdAt ?? new Date(NOW.getTime() - 60_000);
  const windowOpen = options.windowOpen ?? true;
  const [conversation] = await db
    .insert(conversations)
    .values({
      organizationId: w.organizationId,
      contactId: contact!.id,
      channelId: w.channelId,
      status: 'unserved',
      departmentId: options.departmentId ?? null,
      lastMessageAt: createdAt,
      lastInboundAt: windowOpen ? createdAt : new Date(NOW.getTime() - 25 * 3600_000),
      windowExpiresAt: windowOpen
        ? new Date(createdAt.getTime() + 24 * 3600_000)
        : new Date(NOW.getTime() - 3600_000),
      createdAt,
    })
    .returning();
  const direction = options.firstDirection ?? 'inbound';
  await db.insert(messages).values({
    organizationId: w.organizationId,
    conversationId: conversation!.id,
    contactId: contact!.id,
    channelId: w.channelId,
    direction,
    senderKind: direction === 'inbound' ? 'customer' : 'agent',
    type: 'text',
    wamid: `wamid.${newId()}`,
    text: 'halo',
    status: direction === 'inbound' ? null : 'sent',
    occurredAt: createdAt,
  });
  return conversation!;
}

const assigneeOf = async (conversationId: string) => {
  const [row] = await db
    .select({ assignee: conversations.assigneeUserId, status: conversations.status })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  return row;
};

function run(now: Date = NOW, notified: unknown[] = []) {
  return dispatchWorkspace({
    db,
    logger,
    now: () => now,
    notifications: {
      enqueue: (jobs) => {
        notified.push(...jobs);
        return Promise.resolve();
      },
    },
  });
}

describe('alokasi round-robin', () => {
  it('bergiliran adil (paling lama tanpa tugas dulu); kejadian assigned oleh sistem; push ke agen', async () => {
    const w = await world();
    const sinta = await agent(w, 'cs', 'Sinta');
    const rina = await agent(w, 'supervisor', 'Rina');
    await agent(w, 'owner', 'Pemilik'); // bawaan dikecualikan
    await agent(w, 'teknisi', 'Arya'); // bukan peran alokasi
    const queue = [];
    for (let index = 0; index < 4; index += 1) {
      queue.push(await waiting(w, { createdAt: new Date(NOW.getTime() - (10 - index) * 60_000) }));
    }
    const notified: unknown[] = [];
    await run(NOW, notified);
    const owners = await Promise.all(queue.map((item) => assigneeOf(item.id)));
    expect(owners.every((row) => row?.status === 'served')).toBe(true);
    const counts = new Map<string, number>();
    for (const row of owners) counts.set(row!.assignee!, (counts.get(row!.assignee!) ?? 0) + 1);
    expect(counts).toEqual(
      new Map([
        [sinta.id, 2],
        [rina.id, 2],
      ]),
    );
    // Bergiliran: dua percakapan pertama ke dua agen berbeda.
    expect(owners[0]!.assignee).not.toBe(owners[1]!.assignee);
    const events = await db
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.organizationId, w.organizationId));
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.kind === 'assigned' && event.actorUserId === null)).toBe(
      true,
    );
    expect(notified).toHaveLength(4);
    expect(notified[0]).toMatchObject({ organizationId: w.organizationId, kind: 'assigned' });
  });

  it('kapasitas penuh → tetap di antrian; agen dikecualikan/tidak tersedia dilewati', async () => {
    const w = await world({ maxOpenPerAgent: 1 });
    const sinta = await agent(w, 'cs', 'Sinta');
    const off = await agent(w, 'cs', 'Sedang istirahat');
    const excluded = await agent(w, 'cs', 'Dikecualikan');
    await db.insert(agentStates).values([
      { userId: off.id, organizationId: w.organizationId, available: false },
      { userId: excluded.id, organizationId: w.organizationId, excluded: true },
    ]);
    const first = await waiting(w, { createdAt: new Date(NOW.getTime() - 5 * 60_000) });
    const second = await waiting(w);
    await run();
    expect((await assigneeOf(first.id))?.assignee).toBe(sinta.id);
    expect(await assigneeOf(second.id)).toEqual({ assignee: null, status: 'unserved' });
  });

  it('di luar jam kerja / hari libur tidak menugaskan', async () => {
    const outside = await world({
      teamHours: { mode: 'schedule', windows: [{ day: 2, start: '13:00', end: '17:00' }] },
    });
    await agent(outside, 'cs', 'Sinta');
    const a = await waiting(outside);
    const holiday = await world({ holidays: [{ date: '2026-11-17', name: 'Libur tes' }] });
    await agent(holiday, 'cs', 'Sinta');
    const b = await waiting(holiday);
    await run();
    expect((await assigneeOf(a.id))?.status).toBe('unserved');
    expect((await assigneeOf(b.id))?.status).toBe('unserved');
    // Jam 14:00 WIB → dalam jam kerja.
    await run(new Date('2026-11-17T07:00:00Z'));
    expect((await assigneeOf(a.id))?.status).toBe('served');
  });

  it('departemen: hanya anggota; departemen tanpa anggota tetap di antrian; bertanda tidak dapat percakapan tanpa departemen', async () => {
    const w = await world();
    const [teknik] = await db
      .insert(departments)
      .values({ organizationId: w.organizationId, name: 'Teknik' })
      .returning();
    const [kosong] = await db
      .insert(departments)
      .values({ organizationId: w.organizationId, name: 'Kosong' })
      .returning();
    const member = await agent(w, 'cs', 'Anggota');
    const restricted = await agent(w, 'cs', 'Bertanda');
    await db.insert(departmentMembers).values([
      { organizationId: w.organizationId, departmentId: teknik!.id, userId: member.id },
      { organizationId: w.organizationId, departmentId: teknik!.id, userId: restricted.id },
    ]);
    await db.update(users).set({ departmentRestricted: true }).where(eq(users.id, restricted.id));
    // Anggota sudah lebih dulu mendapat tugas → giliran berikutnya ke yang bertanda, tetapi hanya
    // untuk percakapan departemennya.
    const general = await waiting(w, { createdAt: new Date(NOW.getTime() - 9 * 60_000) });
    const tech = await waiting(w, { departmentId: teknik!.id });
    const empty = await waiting(w, { departmentId: kosong!.id });
    await run();
    expect((await assigneeOf(general.id))?.assignee).toBe(member.id);
    expect((await assigneeOf(tech.id))?.assignee).toBe(restricted.id);
    expect((await assigneeOf(empty.id))?.status).toBe('unserved');
  });

  it('atomik: dua dispatch bersamaan tidak menugaskan dobel dan tidak melewati kapasitas', async () => {
    const w = await world({ maxOpenPerAgent: 1 });
    const sinta = await agent(w, 'cs', 'Sinta');
    const items = [await waiting(w), await waiting(w), await waiting(w)];
    await Promise.all([run(), run(), run()]);
    const rows = await Promise.all(items.map((item) => assigneeOf(item.id)));
    expect(rows.filter((row) => row?.assignee === sinta.id)).toHaveLength(1);
    const events = await db
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.organizationId, w.organizationId));
    expect(events).toHaveLength(1);
  });
});

describe('pesan otomatis', () => {
  const autoRows = async (conversationId: string) =>
    db
      .select({
        kind: conversationAutoMessages.kind,
        messageId: conversationAutoMessages.messageId,
        skipReason: conversationAutoMessages.skipReason,
      })
      .from(conversationAutoMessages)
      .where(eq(conversationAutoMessages.conversationId, conversationId));
  const systemTexts = async (conversationId: string) =>
    (
      await db
        .select({ text: messages.text })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.senderKind, 'system')))
    ).map((row) => row.text);

  it('sapaan sekali per sesi; percakapan dimulai agen & pernah bot tidak; "ditangani agen" memakai {agen}', async () => {
    const w = await world({
      allocationMode: 'round_robin',
      greetingEnabled: true,
      greetingText: 'Halo {nama}, selamat datang!',
      assignedEnabled: true,
      assignedText: 'Halo {nama}, {agen} akan membantumu.',
    });
    await agent(w, 'cs', 'Sinta');
    const customer = await waiting(w, { name: '101PUTU@G2' });
    const agentStarted = await waiting(w, { firstDirection: 'outbound' });
    const botHandled = await waiting(w);
    await db.insert(conversationEvents).values({
      organizationId: w.organizationId,
      conversationId: botHandled.id,
      kind: 'handoff',
    });
    await run();
    await run();
    expect(await systemTexts(customer.id)).toEqual(
      expect.arrayContaining([
        'Halo 101PUTU@G2, selamat datang!',
        'Halo 101PUTU@G2, Sinta akan membantumu.',
      ]),
    );
    expect(await systemTexts(customer.id)).toHaveLength(2);
    expect(await systemTexts(agentStarted.id)).toEqual([]);
    // Pernah ditangani bot: tanpa sapaan, tetapi "ditangani agen" tetap (diambil round-robin).
    expect(await systemTexts(botHandled.id)).toEqual(['Halo Budi, Sinta akan membantumu.']);
  });

  it('di luar jam kerja → pesan di luar jam kerja; rem darurat & jendela tertutup dilewati (tercatat)', async () => {
    const w = await world({
      allocationMode: 'manual',
      teamHours: { mode: 'schedule', windows: [{ day: 2, start: '13:00', end: '17:00' }] },
      greetingEnabled: true,
      awayEnabled: true,
      awayText: 'Maaf {nama}, kami sedang tutup.',
    });
    const away = await waiting(w);
    const closed = await waiting(w, { windowOpen: false });
    await run();
    expect(await systemTexts(away.id)).toEqual(['Maaf Budi, kami sedang tutup.']);
    expect(await autoRows(away.id)).toEqual([
      { kind: 'away', messageId: expect.any(String) as string, skipReason: null },
    ]);
    // Jendela tertutup tidak lolos penyaring kandidat sama sekali.
    expect(await autoRows(closed.id)).toEqual([]);

    const paused = await world({ allocationMode: 'manual', greetingEnabled: true });
    await db
      .update(organizations)
      .set({ sendingPausedAt: new Date() })
      .where(eq(organizations.id, paused.organizationId));
    const blocked = await waiting(paused);
    await run();
    expect(await autoRows(blocked.id)).toEqual([
      { kind: 'greeting', messageId: null, skipReason: 'sending_paused' },
    ]);
    expect(await systemTexts(blocked.id)).toEqual([]);
  });
});
