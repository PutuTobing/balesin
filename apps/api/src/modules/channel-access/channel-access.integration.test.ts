/**
 * Akses per channel (tahap 9.0, PRD-EMAIL §4.10; docs/KONTRAK-API-CHANNEL.md "Akses per channel")
 * di atas Postgres + Redis sungguhan:
 *  - kelola `GET/PUT /settings/channels/:channelId/access` (`channels.manage`, CSRF, audit, validasi);
 *  - penegakan untuk pengguna sesi: daftar, hitungan, cari, detail, pesan, semua aksi, catatan,
 *    tanda pesan, pemilih channel, laporan + ekspor CSV, WebSocket, ekspor data kontak;
 *  - irisan dengan cakupan peran (Teknisi `assigned`) & "akses hanya departemen sendiri";
 *  - penugasan (sasaran tanpa akses ditolak, daftar agen per channel) & round-robin;
 *  - Owner/Admin selalu melihat; API key tidak terpengaruh; 404 seragam.
 */
import { createLogCapture } from '@balesin/core/testing';
import {
  auditLogs,
  channelAccessSql,
  channels,
  conversationEvents,
  contacts,
  conversations,
  departmentMembers,
  messages,
  newId,
  userPrincipal,
  users,
} from '@balesin/db';
import {
  API_ROUTES,
  AUDIT_ACTIONS,
  REPORT_ROUTES,
  apiPath,
  channelAccessResponseSchema,
  contactExportSchema,
  ticketBoardResponseSchema,
  ticketResponseSchema,
  updateChannelAccessResponseSchema,
  channelSummaryListResponseSchema,
  conversationCountsResponseSchema,
  conversationListResponseSchema,
  departmentResponseSchema,
  inboxAgentListResponseSchema,
  inboxStreamEventSchema,
  reportPerformanceResponseSchema,
  type InboxStreamEvent,
} from '@balesin/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Kode worker yang sama dengan produksi (tes saja).
import { dispatchWorkspace } from '../../../../worker/src/queues/workspace';
import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import {
  agent,
  api,
  createApiKey,
  send,
  setupWorld,
  type Agent,
  type Fase5World,
} from '../../testing/crm-fixtures';
import {
  call,
  confirmationFor,
  createIntegrationHarness,
  type IntegrationHarness,
} from '../../testing/integration';

let harness: IntegrationHarness;
let world: Fase5World;
/** Channel kedua (Email) yang dibatasi di sebagian besar tes. */
let restrictedChannelId: string;
const logs = createLogCapture();

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  world = await setupWorld(harness);
  restrictedChannelId = newId();
  await harness.db.insert(channels).values({
    id: restrictedChannelId,
    organizationId: world.organizationId,
    type: 'telegram',
    name: 'Telegram Tagihan',
    tgBotId: '123456789',
    tgBotUsername: 'tagihan_bot',
    tgBotTokenEncrypted: 'x',
    tgWebhookSecretEncrypted: 'x',
  });
});
afterAll(async () => {
  await harness?.close();
});

async function department(name: string) {
  const response = await send(world, world.owner, 'POST', API_ROUTES.departments.settings, {
    name,
  });
  expect(response.statusCode, response.body).toBe(201);
  return departmentResponseSchema.parse(response.json()).department;
}

async function joinDepartment(user: Agent, departmentId: string) {
  await harness.db
    .insert(departmentMembers)
    .values({ organizationId: world.organizationId, departmentId, userId: user.userId });
}

let phoneCounter = 0;
async function seed(
  channelId: string,
  options: {
    name?: string;
    assigneeUserId?: string | null;
    departmentId?: string | null;
    status?: 'unserved' | 'served' | 'resolved';
  } = {},
) {
  phoneCounter += 1;
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId: world.organizationId,
      channelType: channelId === world.channelId ? 'whatsapp' : 'telegram',
      phone: channelId === world.channelId ? `+62812${String(20_000_000 + phoneCounter)}` : null,
      channelHandle: channelId === world.channelId ? null : `pelanggan${String(phoneCounter)}`,
      externalUserId: channelId === world.channelId ? null : String(900_000 + phoneCounter),
      name: options.name ?? `Pelanggan ${String(phoneCounter)}`,
    })
    .returning();
  const status = options.status ?? (options.assigneeUserId ? 'served' : 'unserved');
  const [conversation] = await harness.db
    .insert(conversations)
    .values({
      organizationId: world.organizationId,
      contactId: contact!.id,
      channelId,
      status,
      assigneeUserId: options.assigneeUserId ?? null,
      departmentId: options.departmentId ?? null,
      lastMessageAt: new Date(),
      lastInboundAt: new Date(),
      windowExpiresAt: new Date(Date.now() + 23 * 3600_000),
      resolvedAt: status === 'resolved' ? new Date() : null,
    })
    .returning();
  const [message] = await harness.db
    .insert(messages)
    .values({
      organizationId: world.organizationId,
      conversationId: conversation!.id,
      contactId: contact!.id,
      channelId,
      direction: 'inbound',
      senderKind: 'customer',
      type: 'text',
      text: 'Tagihan saya belum masuk',
      occurredAt: new Date(),
    })
    .returning();
  return { contact: contact!, conversation: conversation!, message: message! };
}

const accessPath = (channelId: string) => apiPath(API_ROUTES.channels.access, { channelId });

/** PUT akses; Owner selalu menyertakan konfirmasi identitas (wajib bila melonggarkan, R3). */
async function setAccess(
  body: { mode: 'all' | 'restricted'; departmentIds?: string[]; userIds?: string[] },
  channelId = restrictedChannelId,
  by: Agent = world.owner,
) {
  const confirmation = by === world.owner ? { confirmation: await confirmationFor() } : {};
  return send(world, by, 'PUT', accessPath(channelId), { ...body, ...confirmation });
}

async function listIds(signed: Agent, query = ''): Promise<string[]> {
  const response = await send(world, signed, 'GET', `${API_ROUTES.inbox.conversations}${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return conversationListResponseSchema.parse(response.json()).conversations.map((item) => item.id);
}

async function counts(signed: Agent) {
  const response = await send(world, signed, 'GET', API_ROUTES.inbox.counts);
  expect(response.statusCode, response.body).toBe(200);
  return conversationCountsResponseSchema.parse(response.json()).counts;
}

const conversationPath = (route: string, conversationId: string) =>
  apiPath(route, { conversationId });

/** Isi galat tanpa `requestId` (pembanding 404 seragam). */
function errorOf(response: { json(): unknown }) {
  const { error } = response.json() as { error: { code: string; message: string } };
  return { code: error.code, message: error.message };
}

/** GET ber-efek-samping (ekspor) butuh X-CSRF-Token. */
function getWithCsrf(signed: Agent, url: string) {
  return call(harness.app, 'GET', url, undefined, { cookie: signed.cookie, csrf: signed.csrf });
}

describe('kelola akses channel', () => {
  it('Owner menyimpan & membaca aturan; audit berisi perubahan; validasi organisasi', async () => {
    const billing = await department('Tagihan');
    const cs = await agent(world, 'cs', 'Sinta CS');

    const initial = await send(world, world.owner, 'GET', accessPath(restrictedChannelId));
    expect(initial.statusCode, initial.body).toBe(200);
    expect(channelAccessResponseSchema.parse(initial.json()).access).toMatchObject({
      mode: 'all',
      departments: [],
      users: [],
      exemptRoles: ['owner', 'admin'],
    });

    const saved = await setAccess({
      mode: 'restricted',
      departmentIds: [billing.id],
      userIds: [cs.userId],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const access = channelAccessResponseSchema.parse(saved.json()).access;
    expect(access.mode).toBe('restricted');
    expect(access.departments.map((row) => row.id)).toEqual([billing.id]);
    expect(access.users).toEqual([{ id: cs.userId, name: 'Sinta CS', role: 'cs', active: true }]);

    const [audit] = await harness.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, world.organizationId),
          eq(auditLogs.action, AUDIT_ACTIONS.channelAccessUpdated),
        ),
      );
    expect(audit?.targetId).toBe(restrictedChannelId);
    expect(audit?.metadata).toMatchObject({
      previousMode: 'all',
      mode: 'restricted',
      addedDepartments: [{ id: billing.id, name: 'Tagihan' }],
      addedUsers: [{ id: cs.userId, name: 'Sinta CS' }],
      removedDepartments: [],
      removedUsers: [],
    });

    // Kembali ke "Semua tim": daftar dikosongkan.
    const reset = await setAccess({ mode: 'all' });
    expect(channelAccessResponseSchema.parse(reset.json()).access).toMatchObject({
      mode: 'all',
      departments: [],
      users: [],
    });
    const [row] = await harness.db
      .select({ restricted: channels.accessRestricted })
      .from(channels)
      .where(eq(channels.id, restrictedChannelId));
    expect(row?.restricted).toBe(false);
  });

  it('validasi: departemen/pengguna asing, daftar dengan mode "Semua tim", channel tak dikenal', async () => {
    const unknownDepartment = await setAccess({ mode: 'restricted', departmentIds: [newId()] });
    expect(unknownDepartment.statusCode).toBe(400);
    const unknownUser = await setAccess({ mode: 'restricted', userIds: [newId()] });
    expect(unknownUser.statusCode).toBe(400);
    const cs = await agent(world, 'cs', 'Sinta CS');
    await harness.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, cs.userId));
    const disabled = await setAccess({ mode: 'restricted', userIds: [cs.userId] });
    expect(disabled.statusCode).toBe(400);
    const listWithAll = await setAccess({ mode: 'all', userIds: [world.owner.userId] });
    expect(listWithAll.statusCode).toBe(400);
    const extra = await send(world, world.owner, 'PUT', accessPath(restrictedChannelId), {
      mode: 'all',
      sneaky: true,
    });
    expect(extra.statusCode).toBe(400);

    const missing = await send(world, world.owner, 'GET', accessPath(newId()));
    const malformed = await send(world, world.owner, 'GET', accessPath('bukan-uuid'));
    expect(missing.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(errorOf(malformed)).toEqual(errorOf(missing));
    // Channel terhapus = tidak ada.
    await harness.db
      .update(channels)
      .set({ deletedAt: new Date(), tgBotTokenEncrypted: null, tgWebhookSecretEncrypted: null })
      .where(eq(channels.id, restrictedChannelId));
    expect((await setAccess({ mode: 'all' })).statusCode).toBe(404);
  });

  it('RBAC: hanya pengelola channel (Owner/Admin); CS/Supervisor/Teknisi 403; PUT wajib CSRF', async () => {
    const admin = await agent(world, 'admin', 'Andi Admin');
    expect((await setAccess({ mode: 'restricted' }, restrictedChannelId, admin)).statusCode).toBe(
      200,
    );
    for (const role of ['supervisor', 'cs', 'teknisi'] as const) {
      const someone = await agent(world, role, `Pengguna ${role}`);
      expect((await send(world, someone, 'GET', accessPath(restrictedChannelId))).statusCode).toBe(
        403,
      );
      expect((await setAccess({ mode: 'all' }, restrictedChannelId, someone)).statusCode).toBe(403);
    }
    const noCsrf = await harness.app.inject({
      method: 'PUT',
      url: accessPath(restrictedChannelId),
      headers: { cookie: world.owner.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ mode: 'all' }),
    });
    expect(noCsrf.statusCode).toBe(403);
    const [row] = await harness.db
      .select({ restricted: channels.accessRestricted })
      .from(channels)
      .where(eq(channels.id, restrictedChannelId));
    expect(row?.restricted).toBe(true);
  });
});

describe('penegakan akses channel', () => {
  it('CS di departemen A tidak melihat channel terbatas untuk departemen B: daftar, hitungan, cari, detail, pesan, aksi', async () => {
    const sales = await department('Penjualan');
    const billing = await department('Tagihan');
    const csA = await agent(world, 'cs', 'Sinta CS');
    const csB = await agent(world, 'cs', 'Budi CS');
    await joinDepartment(csA, sales.id);
    await joinDepartment(csB, billing.id);
    const open = await seed(world.channelId, { name: 'Andi Terbuka' });
    const hidden = await seed(restrictedChannelId, { name: 'Rahasia Tagihan' });
    expect((await setAccess({ mode: 'restricted', departmentIds: [billing.id] })).statusCode).toBe(
      200,
    );

    // Daftar & hitungan & cari.
    expect(await listIds(csA)).toEqual([open.conversation.id]);
    expect((await counts(csA)).all).toBe(1);
    expect(await listIds(csA, '?q=Rahasia')).toEqual([]);
    expect(await listIds(csA, `?channelId=${restrictedChannelId}`)).toEqual([]);
    expect((await listIds(csB)).sort()).toEqual(
      [open.conversation.id, hidden.conversation.id].sort(),
    );
    expect((await counts(csB)).all).toBe(2);
    expect(await listIds(csB, '?q=Rahasia')).toEqual([hidden.conversation.id]);

    // Detail + pesan + aksi = 404 SERAGAM (sama dengan ID tak dikenal).
    const id = hidden.conversation.id;
    const unknown = await send(
      world,
      csA,
      'GET',
      conversationPath(API_ROUTES.inbox.conversation, newId()),
    );
    const detail = await send(
      world,
      csA,
      'GET',
      conversationPath(API_ROUTES.inbox.conversation, id),
    );
    expect(detail.statusCode).toBe(404);
    expect(errorOf(detail)).toEqual(errorOf(unknown));
    const reads: [string, string][] = [
      ['GET', API_ROUTES.inbox.messages],
      ['GET', API_ROUTES.inbox.notes],
      ['GET', API_ROUTES.inbox.events],
    ];
    for (const [, route] of reads) {
      expect((await send(world, csA, 'GET', conversationPath(route, id))).statusCode).toBe(404);
    }
    const writes: [string, unknown][] = [
      [API_ROUTES.inbox.read, undefined],
      [API_ROUTES.inbox.claim, undefined],
      [API_ROUTES.inbox.assign, { userId: csA.userId }],
      [API_ROUTES.inbox.resolve, undefined],
      [API_ROUTES.inbox.unassign, undefined],
      [API_ROUTES.inbox.bot, { active: false }],
      [API_ROUTES.inbox.notes, { body: 'Catatan rahasia' }],
      [API_ROUTES.inbox.department, { departmentId: sales.id }],
      [API_ROUTES.inbox.messages, { type: 'text', text: 'Halo', clientMessageId: newId() }],
    ];
    for (const [route, body] of writes) {
      const response = await send(world, csA, 'POST', conversationPath(route, id), body ?? {});
      expect(response.statusCode, `${route} ${response.body}`).toBe(404);
    }
    const star = await send(
      world,
      csA,
      'PUT',
      apiPath(API_ROUTES.inbox.star, { messageId: hidden.message.id }),
    );
    expect(star.statusCode).toBe(404);
    // Tidak ada yang berubah.
    const [after] = await harness.db
      .select({ status: conversations.status, assignee: conversations.assigneeUserId })
      .from(conversations)
      .where(eq(conversations.id, id));
    expect(after).toEqual({ status: 'unserved', assignee: null });

    // CS B (anggota departemen yang terdaftar) bisa bekerja normal.
    const claim = await send(world, csB, 'POST', conversationPath(API_ROUTES.inbox.claim, id));
    expect(claim.statusCode, claim.body).toBe(200);
    // Buka lagi setelah selesai juga 404 untuk CS A.
    expect(
      (await send(world, csB, 'POST', conversationPath(API_ROUTES.inbox.resolve, id))).statusCode,
    ).toBe(200);
    expect(
      (await send(world, csA, 'POST', conversationPath(API_ROUTES.inbox.reopen, id))).statusCode,
    ).toBe(404);
  });

  it('Owner & Admin selalu melihat; pengguna terdaftar langsung melihat; pemilih channel tersaring', async () => {
    const admin = await agent(world, 'admin', 'Andi Admin');
    const cs = await agent(world, 'cs', 'Sinta CS');
    const listed = await agent(world, 'cs', 'Dewi CS');
    const hidden = await seed(restrictedChannelId);
    expect((await setAccess({ mode: 'restricted', userIds: [listed.userId] })).statusCode).toBe(
      200,
    );
    for (const viewer of [world.owner, admin, listed]) {
      expect(await listIds(viewer)).toContain(hidden.conversation.id);
      const detail = await send(
        world,
        viewer,
        'GET',
        conversationPath(API_ROUTES.inbox.conversation, hidden.conversation.id),
      );
      expect(detail.statusCode).toBe(200);
    }
    expect(await listIds(cs)).not.toContain(hidden.conversation.id);

    const pickerOf = async (viewer: Agent) =>
      channelSummaryListResponseSchema
        .parse((await send(world, viewer, 'GET', API_ROUTES.channels.list)).json())
        .channels.map((channel) => channel.id);
    expect(await pickerOf(cs)).toEqual([world.channelId]);
    expect((await pickerOf(listed)).sort()).toEqual([world.channelId, restrictedChannelId].sort());
    expect((await pickerOf(world.owner)).sort()).toEqual(
      [world.channelId, restrictedChannelId].sort(),
    );
  });

  it('mode terbatas dengan daftar kosong = hanya Owner/Admin; dicabut → langsung hilang', async () => {
    const billing = await department('Tagihan');
    const cs = await agent(world, 'cs', 'Sinta CS');
    await joinDepartment(cs, billing.id);
    const hidden = await seed(restrictedChannelId);
    await setAccess({ mode: 'restricted', departmentIds: [billing.id] });
    expect(await listIds(cs)).toContain(hidden.conversation.id);
    await setAccess({ mode: 'restricted' });
    expect(await listIds(cs)).not.toContain(hidden.conversation.id);
    expect(await listIds(world.owner)).toContain(hidden.conversation.id);
    // Keluar dari departemen → akses hilang tanpa mengubah aturan channel.
    await setAccess({ mode: 'restricted', departmentIds: [billing.id] });
    await harness.db.delete(departmentMembers).where(eq(departmentMembers.userId, cs.userId));
    expect(await listIds(cs)).not.toContain(hidden.conversation.id);
  });

  it('irisan dengan "akses hanya departemen sendiri" dan cakupan Teknisi', async () => {
    const sales = await department('Penjualan');
    const billing = await department('Tagihan');
    const supervisor = await agent(world, 'supervisor', 'Rina Supervisor');
    await joinDepartment(supervisor, billing.id);
    await harness.db
      .update(users)
      .set({ departmentRestricted: true })
      .where(eq(users.id, supervisor.userId));
    await setAccess({ mode: 'restricted', departmentIds: [billing.id] });
    const allowedBoth = await seed(restrictedChannelId, { departmentId: billing.id });
    const otherDepartment = await seed(restrictedChannelId, { departmentId: sales.id });
    const openChannelOwnDept = await seed(world.channelId, { departmentId: billing.id });
    const openChannelOtherDept = await seed(world.channelId, { departmentId: sales.id });
    const visible = await listIds(supervisor);
    expect(visible).toContain(allowedBoth.conversation.id);
    expect(visible).toContain(openChannelOwnDept.conversation.id);
    // Channel boleh, departemen tidak → tetap tersembunyi (irisan, bukan gabungan).
    expect(visible).not.toContain(otherDepartment.conversation.id);
    expect(visible).not.toContain(openChannelOtherDept.conversation.id);

    // Teknisi: percakapan yang di-assign kepadanya di channel terlarang tetap tersembunyi.
    const teknisi = await agent(world, 'teknisi', 'Arya Teknisi');
    const assigned = await seed(restrictedChannelId, { assigneeUserId: teknisi.userId });
    expect(await listIds(teknisi)).not.toContain(assigned.conversation.id);
    expect(
      (
        await send(
          world,
          teknisi,
          'GET',
          conversationPath(API_ROUTES.inbox.messages, assigned.conversation.id),
        )
      ).statusCode,
    ).toBe(404);
    await setAccess({
      mode: 'restricted',
      departmentIds: [billing.id],
      userIds: [teknisi.userId],
    });
    expect(await listIds(teknisi)).toEqual([assigned.conversation.id]);
  });

  it('penugasan: sasaran tanpa akses ditolak; daftar agen per channel; buka lagi ke antrian', async () => {
    const billing = await department('Tagihan');
    const csA = await agent(world, 'cs', 'Sinta CS');
    const csB = await agent(world, 'cs', 'Budi CS');
    await joinDepartment(csB, billing.id);
    await setAccess({ mode: 'restricted', departmentIds: [billing.id] });
    const hidden = await seed(restrictedChannelId);
    const assignPath = conversationPath(API_ROUTES.inbox.assign, hidden.conversation.id);

    const refused = await send(world, world.owner, 'POST', assignPath, { userId: csA.userId });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('tidak punya akses ke channel');
    const accepted = await send(world, world.owner, 'POST', assignPath, { userId: csB.userId });
    expect(accepted.statusCode, accepted.body).toBe(200);

    const agentsFor = async (viewer: Agent, channelId: string) =>
      send(world, viewer, 'GET', `${API_ROUTES.inbox.agents}?channelId=${channelId}`);
    const forOwner = await agentsFor(world.owner, restrictedChannelId);
    expect(forOwner.statusCode, forOwner.body).toBe(200);
    const ids = inboxAgentListResponseSchema.parse(forOwner.json()).agents.map((row) => row.id);
    expect(ids).toContain(csB.userId);
    expect(ids).toContain(world.owner.userId);
    expect(ids).not.toContain(csA.userId);
    // Channel yang tidak boleh dilihat pemanggil = 404 (sama dengan channel tak dikenal).
    expect((await agentsFor(csA, restrictedChannelId)).statusCode).toBe(404);
    expect((await agentsFor(csA, newId())).statusCode).toBe(404);
    const all = inboxAgentListResponseSchema.parse(
      (await send(world, csA, 'GET', API_ROUTES.inbox.agents)).json(),
    );
    expect(all.agents.map((row) => row.id)).toContain(csA.userId);

    // Selesai → akses B dicabut → buka lagi: kembali ke antrian, bukan ke B.
    await send(
      world,
      world.owner,
      'POST',
      conversationPath(API_ROUTES.inbox.resolve, hidden.conversation.id),
    );
    await setAccess({ mode: 'restricted' });
    const reopened = await send(
      world,
      world.owner,
      'POST',
      conversationPath(API_ROUTES.inbox.reopen, hidden.conversation.id),
    );
    expect(reopened.statusCode, reopened.body).toBe(200);
    const [row] = await harness.db
      .select({ status: conversations.status, assignee: conversations.assigneeUserId })
      .from(conversations)
      .where(eq(conversations.id, hidden.conversation.id));
    expect(row).toEqual({ status: 'unserved', assignee: null });
  });

  it('round-robin melewati agen tanpa akses channel', async () => {
    const billing = await department('Tagihan');
    const csA = await agent(world, 'cs', 'Sinta CS');
    const csB = await agent(world, 'cs', 'Budi CS');
    await joinDepartment(csB, billing.id);
    const allocation = await send(world, world.owner, 'PUT', API_ROUTES.workspace.settings, {
      allocation: { mode: 'round_robin', maxOpenPerAgent: null },
    });
    expect(allocation.statusCode, allocation.body).toBe(200);
    for (const cs of [csA, csB]) {
      const available = await send(world, cs, 'PUT', API_ROUTES.inbox.availability, {
        available: true,
      });
      expect(available.statusCode, available.body).toBe(200);
    }
    // Owner tidak ikut giliran (tidak bersiaga) supaya hasilnya pasti.
    await setAccess({ mode: 'restricted', departmentIds: [billing.id] });
    const hidden = await seed(restrictedChannelId);
    await dispatchWorkspace({ db: harness.db, logger: logs.logger });
    const [row] = await harness.db
      .select({ assignee: conversations.assigneeUserId })
      .from(conversations)
      .where(eq(conversations.id, hidden.conversation.id));
    expect(row?.assignee).toBe(csB.userId);

    // Tidak ada agen berhak yang bersiaga → tetap di antrian (CS A tidak pernah mendapatkannya).
    await setAccess({ mode: 'restricted' });
    const second = await seed(restrictedChannelId);
    await dispatchWorkspace({ db: harness.db, logger: logs.logger });
    const [next] = await harness.db
      .select({ assignee: conversations.assigneeUserId })
      .from(conversations)
      .where(eq(conversations.id, second.conversation.id));
    expect(next?.assignee ?? null).toBeNull();
  });

  it('laporan & ekspor CSV tidak menghitung channel terlarang; Owner menghitung semua', async () => {
    const supervisor = await agent(world, 'supervisor', 'Rina Supervisor');
    await seed(world.channelId);
    await seed(restrictedChannelId);
    await seed(restrictedChannelId);
    await setAccess({ mode: 'restricted' });
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const query = `?from=${today}&to=${today}`;
    const reportOf = async (viewer: Agent, extra = '') => {
      const response = await send(
        world,
        viewer,
        'GET',
        `${REPORT_ROUTES.performance}${query}${extra}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      return reportPerformanceResponseSchema.parse(response.json()).report;
    };
    expect((await reportOf(world.owner)).summary?.conversations).toBe(3);
    expect((await reportOf(supervisor)).summary?.conversations).toBe(1);
    // Saringan channel terlarang = kosong, bukan bocor.
    expect(
      (await reportOf(supervisor, `&channelId=${restrictedChannelId}`)).summary?.conversations,
    ).toBe(0);

    const csvOf = async (viewer: Agent) => {
      const response = await getWithCsrf(
        viewer,
        `${REPORT_ROUTES.exportCsv}?kind=daily&from=${today}&to=${today}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      return response.body;
    };
    expect(await csvOf(world.owner)).toContain(`"${today}","3",`);
    expect(await csvOf(supervisor)).toContain(`"${today}","1",`);
  });

  it('ekspor data kontak tidak memuat percakapan/pesan channel terlarang', async () => {
    const supervisor = await agent(world, 'supervisor', 'Rina Supervisor');
    const hidden = await seed(restrictedChannelId);
    await setAccess({ mode: 'restricted' });
    const exportOf = async (viewer: Agent) => {
      const response = await getWithCsrf(
        viewer,
        apiPath(API_ROUTES.inbox.contactExport, { contactId: hidden.contact.id }),
      );
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{
        conversations: unknown[];
        messages: unknown[];
        partial?: boolean;
      }>();
    };
    const full = await exportOf(world.owner);
    expect(full.conversations).toHaveLength(1);
    expect(full.messages).toHaveLength(1);
    expect(contactExportSchema.parse(full)).toMatchObject({
      partial: false,
      partialReason: null,
      excludedConversations: 0,
    });
    const partial = await exportOf(supervisor);
    expect(partial.conversations).toHaveLength(0);
    expect(partial.messages).toHaveLength(0);
    // Review 9.0 R6: ekspor parsial ditandai di respons & audit.
    expect(contactExportSchema.parse(partial)).toMatchObject({
      partial: true,
      excludedConversations: 1,
    });
    expect(contactExportSchema.parse(partial).partialReason).toContain('Owner atau Admin');
    const audits = await harness.db
      .select({ metadata: auditLogs.metadata, actor: auditLogs.actorUserId })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, world.organizationId),
          eq(auditLogs.action, AUDIT_ACTIONS.contactExported),
        ),
      );
    expect(audits.find((row) => row.actor === supervisor.userId)?.metadata).toMatchObject({
      partial: true,
      excludedConversations: 1,
    });
  });

  it('API key (bot/n8n) tidak terpengaruh akses per channel', async () => {
    const hidden = await seed(restrictedChannelId);
    await setAccess({ mode: 'restricted' });
    const token = await createApiKey(world, ['conversations:read']);
    const response = await api(world, token, 'GET', API_ROUTES.publicApi.conversations);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain(hidden.conversation.id);
  });
});

describe('real-time akses channel', () => {
  it('event percakapan channel terlarang tidak sampai; perubahan akses → resync', async () => {
    const billing = await department('Tagihan');
    const csA = await agent(world, 'cs', 'Sinta CS');
    const csB = await agent(world, 'cs', 'Budi CS');
    await joinDepartment(csB, billing.id);
    await setAccess({ mode: 'restricted', departmentIds: [billing.id] });
    const hidden = await seed(restrictedChannelId);

    const open = async (signed: Agent) => {
      const events: InboxStreamEvent[] = [];
      const socket = await harness.app.injectWS(API_ROUTES.inbox.stream, {
        headers: { cookie: signed.cookie, origin: TEST_APP_ORIGIN },
      });
      socket.on('message', (data: Buffer) => {
        events.push(inboxStreamEventSchema.parse(JSON.parse(data.toString('utf8'))));
      });
      return { socket, events };
    };
    const waitFor = async (
      events: InboxStreamEvent[],
      match: (event: InboxStreamEvent) => boolean,
      ms = 3000,
    ) => {
      const started = Date.now();
      while (Date.now() - started < ms && !events.some(match)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return events.some(match);
    };
    const a = await open(csA);
    const b = await open(csB);
    const resolved = await send(
      world,
      world.owner,
      'POST',
      conversationPath(API_ROUTES.inbox.resolve, hidden.conversation.id),
    );
    expect(resolved.statusCode, resolved.body).toBe(200);
    const aboutHidden = (event: InboxStreamEvent) =>
      'conversationId' in event && event.conversationId === hidden.conversation.id;
    expect(await waitFor(b.events, aboutHidden)).toBe(true);
    // B sudah menerima → event sudah diproses hub; A tidak menerima apa pun tentang percakapan itu.
    expect(a.events.some(aboutHidden)).toBe(false);

    await setAccess({ mode: 'all' });
    expect(await waitFor(a.events, (event) => event.type === 'resync')).toBe(true);
    a.socket.terminate();
    b.socket.terminate();
  });
});

describe('review keamanan 9.0 — perbaikan akses per channel', () => {
  it('R2: predikat SQL gagal tertutup untuk ID yang bukan pengguna; API key eksplisit', async () => {
    const check = async (principal: Parameters<typeof channelAccessSql>[1]) => {
      const result = await harness.db.execute<{ ok: boolean }>(
        sql`select ${channelAccessSql(world.organizationId, principal, sql`${world.channelId}::uuid`)} as ok`,
      );
      return result.rows[0]?.ok;
    };
    // Channel TIDAK terbatas pun: ID yang bukan pengguna organisasi ini ditolak.
    expect(await check(userPrincipal(newId()))).toBe(false);
    expect(await check(userPrincipal(world.owner.userId))).toBe(true);
    expect(await check({ kind: 'apiKey' })).toBe(true);
  });

  it('R3: melonggarkan wajib konfirmasi identitas; mempersempit tidak', async () => {
    const cs = await agent(world, 'cs', 'Sinta CS');
    const bare = (body: Record<string, unknown>) =>
      send(world, world.owner, 'PUT', accessPath(restrictedChannelId), body);
    // all → restricted (mempersempit, walau dengan daftar): tanpa konfirmasi.
    expect((await bare({ mode: 'restricted', userIds: [cs.userId] })).statusCode).toBe(200);
    // Mencabut pengguna (mempersempit): tanpa konfirmasi.
    expect((await bare({ mode: 'restricted' })).statusCode).toBe(200);
    // Menambah pengguna ke channel terbatas: wajib konfirmasi.
    const add = await bare({ mode: 'restricted', userIds: [cs.userId] });
    expect(add.statusCode).toBe(400);
    expect(add.body).toContain('confirmation.password');
    // restricted → all: wajib konfirmasi.
    expect((await bare({ mode: 'all' })).statusCode).toBe(400);
    const wrong = await bare({ mode: 'all', confirmation: { password: 'sandi-salah-sekali-01' } });
    expect(wrong.statusCode).toBe(400);
    const [row] = await harness.db
      .select({ restricted: channels.accessRestricted })
      .from(channels)
      .where(eq(channels.id, restrictedChannelId));
    expect(row?.restricted).toBe(true);
    const ok = await bare({ mode: 'all', confirmation: await confirmationFor() });
    expect(ok.statusCode, ok.body).toBe(200);
    const [audit] = await harness.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, world.organizationId),
          eq(auditLogs.action, AUDIT_ACTIONS.channelAccessUpdated),
          sql`${auditLogs.metadata}->>'mode' = 'all'`,
        ),
      );
    expect(audit?.metadata).toMatchObject({ loosened: true, previousMode: 'restricted' });
  });

  it('R3: departemen baru yang membuka channel terbatas tercatat di audit akses departemen', async () => {
    const billing = await department('Tagihan');
    const cs = await agent(world, 'cs', 'Sinta CS');
    await setAccess({ mode: 'restricted', departmentIds: [billing.id] });
    const response = await send(
      world,
      world.owner,
      'PUT',
      apiPath(API_ROUTES.departments.access, { userId: cs.userId }),
      { departmentIds: [billing.id], restricted: false },
    );
    expect(response.statusCode, response.body).toBe(200);
    const [audit] = await harness.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, world.organizationId),
          eq(auditLogs.action, AUDIT_ACTIONS.departmentAccessUpdated),
        ),
      );
    expect(audit?.metadata).toMatchObject({
      restrictedChannelsGained: [{ id: restrictedChannelId, name: 'Telegram Tagihan' }],
    });
    const opened = await seed(restrictedChannelId);
    expect(await listIds(cs)).toContain(opened.conversation.id);
  });

  it('R4: akses dicabut → percakapan pemegang tanpa akses kembali ke antrian (+ kejadian); juga saat keluar departemen', async () => {
    const billing = await department('Tagihan');
    const csB = await agent(world, 'cs', 'Budi CS');
    const csC = await agent(world, 'cs', 'Citra CS');
    await setAccess({ mode: 'restricted', departmentIds: [billing.id], userIds: [csC.userId] });
    await joinDepartment(csB, billing.id);
    const held = await seed(restrictedChannelId, { assigneeUserId: csB.userId });
    const kept = await seed(restrictedChannelId, { assigneeUserId: csC.userId });
    const ownerHeld = await seed(restrictedChannelId, { assigneeUserId: world.owner.userId });

    const revoked = await setAccess({ mode: 'restricted', userIds: [csC.userId] });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(updateChannelAccessResponseSchema.parse(revoked.json()).releasedConversations).toBe(1);
    const stateOf = async (id: string) =>
      (
        await harness.db
          .select({ status: conversations.status, assignee: conversations.assigneeUserId })
          .from(conversations)
          .where(eq(conversations.id, id))
      )[0];
    expect(await stateOf(held.conversation.id)).toEqual({ status: 'unserved', assignee: null });
    expect(await stateOf(kept.conversation.id)).toEqual({ status: 'served', assignee: csC.userId });
    expect(await stateOf(ownerHeld.conversation.id)).toEqual({
      status: 'served',
      assignee: world.owner.userId,
    });
    const [event] = await harness.db
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, held.conversation.id));
    expect(event).toMatchObject({
      kind: 'unassigned',
      actorUserId: world.owner.userId,
      previousAssigneeUserId: csB.userId,
    });

    // Keluar dari departemen yang memberi akses → percakapannya juga dilepas.
    await setAccess({
      mode: 'restricted',
      departmentIds: [billing.id],
      userIds: [csC.userId],
    });
    const again = await seed(restrictedChannelId, { assigneeUserId: csB.userId });
    const left = await send(
      world,
      world.owner,
      'PUT',
      apiPath(API_ROUTES.departments.access, { userId: csB.userId }),
      { departmentIds: [], restricted: false },
    );
    expect(left.statusCode, left.body).toBe(200);
    expect(await stateOf(again.conversation.id)).toEqual({ status: 'unserved', assignee: null });
  });

  it('R4: Teknisi tanpa akses channel tidak membuka kontak lewat penugasan lama', async () => {
    const teknisi = await agent(world, 'teknisi', 'Arya Teknisi');
    const assigned = await seed(restrictedChannelId, { assigneeUserId: teknisi.userId });
    const contactPath = apiPath(API_ROUTES.inbox.contact, { contactId: assigned.contact.id });
    expect((await send(world, teknisi, 'GET', contactPath)).statusCode).toBe(200);
    await setAccess({ mode: 'restricted' });
    // Penugasan dilepas oleh R4, tetapi walau tidak (mis. data lama), kontak tetap tertutup.
    await harness.db
      .update(conversations)
      .set({ status: 'served', assigneeUserId: teknisi.userId })
      .where(eq(conversations.id, assigned.conversation.id));
    expect((await send(world, teknisi, 'GET', contactPath)).statusCode).toBe(404);
  });

  it('R5: tiket tidak menampilkan percakapan tertaut di channel terlarang', async () => {
    const cs = await agent(world, 'cs', 'Sinta CS');
    const hidden = await seed(restrictedChannelId);
    const boardResponse = await send(world, world.owner, 'POST', API_ROUTES.tickets.boards, {
      name: 'Keluhan',
    });
    expect(boardResponse.statusCode, boardResponse.body).toBe(201);
    const board = ticketBoardResponseSchema.parse(boardResponse.json()).board;
    const created = await send(world, world.owner, 'POST', API_ROUTES.tickets.list, {
      boardId: board.id,
      title: 'Tagihan dobel',
      conversationId: hidden.conversation.id,
    });
    expect(created.statusCode, created.body).toBe(201);
    const ticketId = created.json<{ ticket: { id: string } }>().ticket.id;
    await setAccess({ mode: 'restricted' });
    const ticketOf = async (viewer: Agent) => {
      const response = await send(
        world,
        viewer,
        'GET',
        apiPath(API_ROUTES.tickets.ticket, { ticketId }),
      );
      expect(response.statusCode, response.body).toBe(200);
      return ticketResponseSchema.parse(response.json()).ticket;
    };
    expect(await ticketOf(world.owner)).toMatchObject({
      conversation: { id: hidden.conversation.id },
      conversationUnavailable: false,
    });
    expect(await ticketOf(cs)).toMatchObject({ conversation: null, conversationUnavailable: true });
  });

  it('R5: conversation.removed (hapus kontak) hanya ke yang boleh melihat channel-nya', async () => {
    const billing = await department('Tagihan');
    const csA = await agent(world, 'cs', 'Sinta CS');
    const csB = await agent(world, 'cs', 'Budi CS');
    await joinDepartment(csB, billing.id);
    await setAccess({ mode: 'restricted', departmentIds: [billing.id] });
    const hidden = await seed(restrictedChannelId);
    const open = async (signed: Agent) => {
      const events: InboxStreamEvent[] = [];
      const socket = await harness.app.injectWS(API_ROUTES.inbox.stream, {
        headers: { cookie: signed.cookie, origin: TEST_APP_ORIGIN },
      });
      socket.on('message', (data: Buffer) => {
        events.push(inboxStreamEventSchema.parse(JSON.parse(data.toString('utf8'))));
      });
      return { socket, events };
    };
    const a = await open(csA);
    const b = await open(csB);
    const removed = await send(
      world,
      world.owner,
      'DELETE',
      apiPath(API_ROUTES.inbox.contact, { contactId: hidden.contact.id }),
      { confirmation: await confirmationFor() },
    );
    expect(removed.statusCode, removed.body).toBe(200);
    const isRemoval = (event: InboxStreamEvent) =>
      event.type === 'conversation.removed' && event.conversationId === hidden.conversation.id;
    const started = Date.now();
    while (Date.now() - started < 3000 && !b.events.some(isRemoval)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(b.events.some(isRemoval)).toBe(true);
    expect(a.events.some(isRemoval)).toBe(false);
    a.socket.terminate();
    b.socket.terminate();
  });
});
