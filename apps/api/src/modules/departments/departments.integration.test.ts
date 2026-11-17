/**
 * Departemen Fase 5: kelola (`settings.workspace.manage`, audit), akses "hanya departemen sendiri"
 * (penyempitan cakupan percakapan & tiket per pengguna, dibaca segar), melonggarkan = konfirmasi,
 * pindah percakapan (`inbox.assign`), channel bawaan, tiket di board departemen. Matriks RBAC
 * departemen: CS/Supervisor bertanda vs tidak, Owner/Admin selalu penuh.
 */
import { auditLogs, channels, conversationEvents, users } from '@balesin/db';
import {
  API_ROUTES,
  apiPath,
  conversationActionResponseSchema,
  conversationCountsResponseSchema,
  conversationListResponseSchema,
  departmentAccessResponseSchema,
  departmentListResponseSchema,
  departmentResponseSchema,
  ticketActionResponseSchema,
  ticketBoardResponseSchema,
  ticketListResponseSchema,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  agent,
  seedConversation,
  send,
  setupWorld,
  type Agent,
  type Fase5World,
} from '../../testing/crm-fixtures';
import {
  confirmationFor,
  createIntegrationHarness,
  type IntegrationHarness,
} from '../../testing/integration';

let harness: IntegrationHarness;
let world: Fase5World;

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  world = await setupWorld(harness);
});
afterAll(async () => {
  await harness?.close();
});

async function department(name: string, body: Record<string, unknown> = {}) {
  const response = await send(world, world.owner, 'POST', API_ROUTES.departments.settings, {
    name,
    ...body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return departmentResponseSchema.parse(response.json()).department;
}

async function setAccess(
  target: Agent,
  departmentIds: string[],
  restricted: boolean,
  confirm = true,
) {
  return send(
    world,
    world.owner,
    'PUT',
    apiPath(API_ROUTES.departments.access, { userId: target.userId }),
    { departmentIds, restricted, ...(confirm ? { confirmation: await confirmationFor() } : {}) },
  );
}

async function visibleConversations(signed: Agent) {
  const response = await send(world, signed, 'GET', API_ROUTES.inbox.conversations);
  expect(response.statusCode, response.body).toBe(200);
  return conversationListResponseSchema
    .parse(response.json())
    .conversations.map((item) => item.id)
    .sort();
}

describe('kelola departemen', () => {
  it('Owner/Admin saja; nama unik tanpa beda huruf; channel bawaan; hapus melepas rujukan; audit', async () => {
    const cs = await agent(world, 'cs', 'Sinta CS');
    expect(
      (await send(world, cs, 'POST', API_ROUTES.departments.settings, { name: 'CS' })).statusCode,
    ).toBe(403);
    const teknisiDept = await department('Teknisi', { defaultChannelIds: [world.channelId] });
    expect(teknisiDept.defaultChannelIds).toEqual([world.channelId]);
    expect(
      (await send(world, world.owner, 'POST', API_ROUTES.departments.settings, { name: 'teknisi' }))
        .statusCode,
    ).toBe(409);
    // Daftar nama untuk semua pemegang inbox.view (termasuk CS).
    const list = await send(world, cs, 'GET', API_ROUTES.departments.list);
    expect(departmentListResponseSchema.parse(list.json()).departments.map((d) => d.name)).toEqual([
      'Teknisi',
    ]);
    const { conversation } = await seedConversation(world, { departmentId: teknisiDept.id });
    const removed = await send(
      world,
      world.owner,
      'DELETE',
      apiPath(API_ROUTES.departments.department, { departmentId: teknisiDept.id }),
    );
    expect(removed.statusCode, removed.body).toBe(200);
    const [channel] = await harness.db
      .select({ departmentId: channels.defaultDepartmentId })
      .from(channels)
      .where(eq(channels.id, world.channelId));
    expect(channel?.departmentId).toBeNull();
    const detail = await send(
      world,
      world.owner,
      'GET',
      apiPath(API_ROUTES.inbox.conversation, { conversationId: conversation.id }),
    );
    expect(
      detail.json<{ conversation: { department: unknown } }>().conversation.department,
    ).toBeNull();
    const actions = (await harness.db.select({ action: auditLogs.action }).from(auditLogs)).map(
      (row) => row.action,
    );
    expect(actions).toEqual(expect.arrayContaining(['department.created', 'department.deleted']));
  });
});

describe('akses "hanya departemen sendiri"', () => {
  it('CS bertanda hanya melihat percakapan departemennya + yang ia pegang; hitungan ikut; pencabutan langsung berlaku', async () => {
    const csDept = await department('CS');
    const techDept = await department('Teknisi');
    const cs = await agent(world, 'cs', 'Sinta CS');
    const free = await agent(world, 'cs', 'Budi CS');
    const mine = await seedConversation(world, { departmentId: csDept.id });
    const theirs = await seedConversation(world, { departmentId: techDept.id });
    const none = await seedConversation(world);
    const held = await seedConversation(world, {
      departmentId: techDept.id,
      assigneeUserId: cs.userId,
    });

    // Sebelum ditandai: semua.
    expect(await visibleConversations(cs)).toHaveLength(4);
    // Menyempitkan tidak butuh konfirmasi.
    const narrowed = await setAccess(cs, [csDept.id], true, false);
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(departmentAccessResponseSchema.parse(narrowed.json()).access).toMatchObject({
      restricted: true,
      departmentIds: [csDept.id],
    });
    expect(await visibleConversations(cs)).toEqual(
      [mine.conversation.id, held.conversation.id].sort(),
    );
    expect(await visibleConversations(free)).toHaveLength(4);
    const counts = await send(world, cs, 'GET', API_ROUTES.inbox.counts);
    expect(conversationCountsResponseSchema.parse(counts.json()).counts.all).toBe(2);
    // Satu data di luar cakupan = 404 (tidak membuka keberadaan); tidak bisa diambil/dibalas.
    const outside = apiPath(API_ROUTES.inbox.conversation, {
      conversationId: theirs.conversation.id,
    });
    expect((await send(world, cs, 'GET', outside)).statusCode).toBe(404);
    expect(
      (
        await send(
          world,
          cs,
          'POST',
          apiPath(API_ROUTES.inbox.claim, { conversationId: none.conversation.id }),
        )
      ).statusCode,
    ).toBe(404);

    // Melonggarkan (menambah departemen) wajib konfirmasi identitas.
    expect((await setAccess(cs, [csDept.id, techDept.id], true, false)).statusCode).toBe(400);
    expect((await setAccess(cs, [csDept.id, techDept.id], true)).statusCode).toBe(200);
    expect(await visibleConversations(cs)).toHaveLength(3);
    // Mencabut tanda: semua lagi (tanpa login ulang).
    expect((await setAccess(cs, [], false, false)).statusCode).toBe(400);
    expect((await setAccess(cs, [], false)).statusCode).toBe(200);
    expect(await visibleConversations(cs)).toHaveLength(4);
    const [audit] = await harness.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'department.access_updated'))
      .orderBy(auditLogs.createdAt)
      .limit(1);
    expect(audit?.metadata).toMatchObject({ restricted: true, loosened: false });
  });

  it('hanya Supervisor/CS yang bisa ditandai; Owner/Admin tetap penuh walau tandanya tertinggal', async () => {
    const dept = await department('CS');
    const admin = await agent(world, 'admin', 'Andi Admin');
    const teknisi = await agent(world, 'teknisi', 'Arya Teknisi');
    expect((await setAccess(admin, [dept.id], true)).statusCode).toBe(400);
    expect((await setAccess(teknisi, [dept.id], true)).statusCode).toBe(400);
    await seedConversation(world);
    // Tanda tertinggal (mis. CS yang kemudian naik menjadi Admin) tidak menyempitkan Admin.
    await harness.db
      .update(users)
      .set({ departmentRestricted: true })
      .where(eq(users.id, admin.userId));
    expect(await visibleConversations(admin)).toHaveLength(1);
  });

  it('pindah percakapan ke departemen: inbox.assign; tercatat di Log; pelaku bertanda kehilangan akses bila dipindah keluar', async () => {
    const csDept = await department('CS');
    const techDept = await department('Teknisi');
    const cs = await agent(world, 'cs', 'Sinta CS');
    const teknisi = await agent(world, 'teknisi', 'Arya Teknisi');
    await setAccess(cs, [csDept.id], true, false);
    const { conversation } = await seedConversation(world, { departmentId: csDept.id });
    const url = apiPath(API_ROUTES.inbox.department, { conversationId: conversation.id });
    expect(
      (await send(world, teknisi, 'POST', url, { departmentId: techDept.id })).statusCode,
    ).toBe(403);
    const moved = await send(world, cs, 'POST', url, { departmentId: techDept.id });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(conversationActionResponseSchema.parse(moved.json()).conversation).toBeNull();
    const ownerView = await send(world, world.owner, 'POST', url, { departmentId: csDept.id });
    expect(
      conversationActionResponseSchema.parse(ownerView.json()).conversation?.department,
    ).toEqual({
      id: csDept.id,
      name: 'CS',
    });
    const events = await harness.db
      .select({ kind: conversationEvents.kind, departmentId: conversationEvents.departmentId })
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, conversation.id));
    expect(events).toEqual([
      { kind: 'department_changed', departmentId: techDept.id },
      { kind: 'department_changed', departmentId: csDept.id },
    ]);
    const log = await send(
      world,
      world.owner,
      'GET',
      apiPath(API_ROUTES.inbox.events, { conversationId: conversation.id }),
    );
    expect(log.body).toContain('"department":{"id"');
    const filtered = await send(
      world,
      world.owner,
      'GET',
      `${API_ROUTES.inbox.conversations}?departmentId=${techDept.id}`,
    );
    expect(conversationListResponseSchema.parse(filtered.json()).conversations).toEqual([]);
  });

  it('tiket: CS bertanda hanya tiket board departemennya / miliknya; tidak bisa membuat tiket di board departemen lain', async () => {
    const csDept = await department('CS');
    const techDept = await department('Teknisi');
    const cs = await agent(world, 'cs', 'Sinta CS');
    await setAccess(cs, [csDept.id], true, false);
    const boardOf = async (name: string, departmentId: string) => {
      const response = await send(world, world.owner, 'POST', API_ROUTES.tickets.boards, {
        name,
        departmentId,
      });
      expect(response.statusCode, response.body).toBe(201);
      return ticketBoardResponseSchema.parse(response.json()).board;
    };
    const csBoard = await boardOf('Keluhan', csDept.id);
    const techBoard = await boardOf('Perbaikan', techDept.id);
    const create = (boardId: string, assigneeUserId: string | null = null) =>
      send(world, world.owner, 'POST', API_ROUTES.tickets.list, {
        boardId,
        title: 'Tiket',
        assigneeUserId,
      });
    await create(csBoard.id);
    await create(techBoard.id);
    await create(techBoard.id, cs.userId);
    const list = await send(world, cs, 'GET', API_ROUTES.tickets.list);
    expect(ticketListResponseSchema.parse(list.json()).tickets).toHaveLength(2);
    const foreign = await send(world, cs, 'POST', API_ROUTES.tickets.list, {
      boardId: techBoard.id,
      title: 'Di luar departemen',
    });
    expect(foreign.statusCode).toBe(403);
    const self = await send(world, cs, 'POST', API_ROUTES.tickets.list, {
      boardId: techBoard.id,
      title: 'Saya pegang sendiri',
      assigneeUserId: cs.userId,
    });
    expect(self.statusCode, self.body).toBe(201);
    expect(ticketActionResponseSchema.parse(self.json()).ticket?.assignee?.id).toBe(cs.userId);
  });
});
