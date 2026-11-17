/**
 * Tiket Fase 5: board/kolom/atribut (`tickets.configure`), tiket (buat/ubah/pindah/komentar/riwayat),
 * cakupan Teknisi (`own` + akses percakapan "terkait tiketnya"), API tiket untuk bot (`tickets:*`),
 * dan outbox webhook `ticket.created`/`ticket.updated`. Postgres + Redis sungguhan.
 */
import { auditLogs, outgoingEvents, ticketEvents, webhookEndpoints } from '@balesin/db';
import {
  API_ROUTES,
  apiPath,
  conversationListResponseSchema,
  ticketActionResponseSchema,
  ticketBoardResponseSchema,
  ticketKanbanResponseSchema,
  ticketListResponseSchema,
  ticketResponseSchema,
  type TicketBoard,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  agent,
  api,
  createApiKey,
  seedConversation,
  send,
  setupWorld,
  type Agent,
  type Fase5World,
} from '../../testing/crm-fixtures';
import { createIntegrationHarness, type IntegrationHarness } from '../../testing/integration';

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

async function createBoard(signed: Agent, body: Record<string, unknown> = { name: 'Perbaikan' }) {
  const response = await send(world, signed, 'POST', API_ROUTES.tickets.boards, body);
  expect(response.statusCode, response.body).toBe(201);
  return ticketBoardResponseSchema.parse(response.json()).board;
}

async function createTicket(signed: Agent, body: Record<string, unknown>) {
  const response = await send(world, signed, 'POST', API_ROUTES.tickets.list, body);
  expect(response.statusCode, response.body).toBe(201);
  const ticket = ticketActionResponseSchema.parse(response.json()).ticket;
  if (!ticket) throw new Error('tiket tidak terlihat oleh pembuatnya');
  return ticket;
}

const column = (board: TicketBoard, name: string) => {
  const found = board.columns.find((item) => item.name === name);
  if (!found) throw new Error(`kolom ${name} tidak ada`);
  return found;
};

describe('board, kolom, atribut', () => {
  it('Supervisor boleh atur board (CS/Teknisi 403); kolom bawaan; tambah/urutkan/hapus kolom berisi tiket', async () => {
    const cs = await agent(world, 'cs', 'Sinta CS');
    const supervisor = await agent(world, 'supervisor', 'Rina Supervisor');
    expect(
      (await send(world, cs, 'POST', API_ROUTES.tickets.boards, { name: 'X' })).statusCode,
    ).toBe(403);
    const board = await createBoard(supervisor);
    expect(board.columns.map((item) => [item.name, item.isDone])).toEqual([
      ['Baru', false],
      ['Dikerjakan', false],
      ['Selesai', true],
    ]);
    const added = await send(
      world,
      supervisor,
      'POST',
      apiPath(API_ROUTES.tickets.columns, { boardId: board.id }),
      { name: 'Menunggu Pelanggan', position: 1 },
    );
    expect(added.statusCode, added.body).toBe(201);
    const withColumn = ticketBoardResponseSchema.parse(added.json()).board;
    expect(withColumn.columns.map((item) => item.name)).toEqual([
      'Baru',
      'Menunggu Pelanggan',
      'Dikerjakan',
      'Selesai',
    ]);
    const ticket = await createTicket(cs, {
      boardId: board.id,
      columnId: column(withColumn, 'Menunggu Pelanggan').id,
      title: 'Tunggu konfirmasi jadwal',
    });
    const columnUrl = apiPath(API_ROUTES.tickets.column, {
      boardId: board.id,
      columnId: column(withColumn, 'Menunggu Pelanggan').id,
    });
    expect((await send(world, supervisor, 'DELETE', columnUrl, {})).statusCode).toBe(409);
    const removed = await send(world, supervisor, 'DELETE', columnUrl, {
      moveToColumnId: column(withColumn, 'Selesai').id,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const moved = await send(
      world,
      cs,
      'GET',
      apiPath(API_ROUTES.tickets.ticket, { ticketId: ticket.id }),
    );
    const after = ticketResponseSchema.parse(moved.json()).ticket;
    expect(after.column.name).toBe('Selesai');
    expect(after.closedAt).not.toBeNull();
    const audit = await harness.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'ticket_board.configured'));
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('atribut board: wajib & jenis ditegakkan saat buat/ubah tiket', async () => {
    const board = await createBoard(world.owner);
    const attribute = await send(
      world,
      world.owner,
      'POST',
      apiPath(API_ROUTES.tickets.attributes, { boardId: board.id }),
      { key: 'SN ONT', label: 'SN ONT', type: 'text', required: true },
    );
    expect(attribute.statusCode, attribute.body).toBe(201);
    await send(
      world,
      world.owner,
      'POST',
      apiPath(API_ROUTES.tickets.attributes, { boardId: board.id }),
      {
        key: 'Jadwal',
        label: 'Jadwal kunjungan',
        type: 'date',
      },
    );
    const missing = await send(world, world.owner, 'POST', API_ROUTES.tickets.list, {
      boardId: board.id,
      title: 'Ganti ONT',
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toContain('attributes.SN ONT');
    const ticket = await createTicket(world.owner, {
      boardId: board.id,
      title: 'Ganti ONT',
      attributes: [
        { key: 'sn ont', value: 'ZTEG1234' },
        { key: 'jadwal', value: '20/11/2026' },
      ],
    });
    expect(ticket.attributes).toEqual([
      { key: 'SN ONT', value: 'ZTEG1234' },
      { key: 'Jadwal', value: '2026-11-20' },
    ]);
  });
});

describe('cakupan Teknisi: tiket miliknya + percakapan terkait tiketnya', () => {
  it('akses percakapan lewat tiket terbuka; hilang saat tiket selesai; tidak bisa ubah penanggung jawab/tautan', async () => {
    const cs = await agent(world, 'cs', 'Sinta CS');
    const teknisi = await agent(world, 'teknisi', 'Arya Teknisi');
    const other = await agent(world, 'teknisi', 'Bayu Teknisi');
    const board = await createBoard(world.owner);
    const { conversation, contact } = await seedConversation(world, { name: '101PUTU@G2' });
    const conversationUrl = apiPath(API_ROUTES.inbox.conversation, {
      conversationId: conversation.id,
    });
    expect((await send(world, teknisi, 'GET', conversationUrl)).statusCode).toBe(404);

    const ticket = await createTicket(cs, {
      boardId: board.id,
      title: 'Internet mati — cek ODP',
      conversationId: conversation.id,
      assigneeUserId: teknisi.userId,
      priority: 'high',
    });
    expect(ticket.contact?.id).toBe(contact.id);
    expect(ticket.conversation?.id).toBe(conversation.id);

    // Teknisi pemegang: lihat percakapan + kontak, muncul di daftar inbox-nya, boleh menulis catatan.
    expect((await send(world, teknisi, 'GET', conversationUrl)).statusCode).toBe(200);
    const inbox = await send(world, teknisi, 'GET', API_ROUTES.inbox.conversations);
    expect(
      conversationListResponseSchema.parse(inbox.json()).conversations.map((item) => item.id),
    ).toEqual([conversation.id]);
    expect(
      (
        await send(
          world,
          teknisi,
          'GET',
          apiPath(API_ROUTES.inbox.contact, { contactId: contact.id }),
        )
      ).statusCode,
    ).toBe(200);
    const note = await send(
      world,
      teknisi,
      'POST',
      apiPath(API_ROUTES.inbox.notes, { conversationId: conversation.id }),
      { body: 'Sudah dicek, ODP aman.' },
    );
    expect(note.statusCode, note.body).toBe(201);
    // Teknisi lain tidak.
    expect((await send(world, other, 'GET', conversationUrl)).statusCode).toBe(404);
    const ticketUrl = apiPath(API_ROUTES.tickets.ticket, { ticketId: ticket.id });
    expect((await send(world, other, 'GET', ticketUrl)).statusCode).toBe(404);

    // Teknisi tidak bisa mengalihkan tiket atau mengganti tautannya (aturan turunan, diaudit).
    const reassign = await send(world, teknisi, 'PATCH', ticketUrl, {
      assigneeUserId: other.userId,
    });
    expect(reassign.statusCode).toBe(403);
    const relink = await send(world, teknisi, 'PATCH', ticketUrl, { contactId: null });
    expect(relink.statusCode).toBe(403);
    const denied = await harness.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.access.denied'));
    expect(JSON.stringify(denied)).toContain('ticket.own.restricted_fields');
    // …tetapi boleh mengubah isi, berkomentar, dan memindah kolom.
    expect(
      (await send(world, teknisi, 'PATCH', ticketUrl, { description: 'Kabel drop putus.' }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await send(
          world,
          teknisi,
          'POST',
          apiPath(API_ROUTES.tickets.comments, { ticketId: ticket.id }),
          { body: 'Menuju lokasi.' },
        )
      ).statusCode,
    ).toBe(201);
    const done = await send(
      world,
      teknisi,
      'POST',
      apiPath(API_ROUTES.tickets.move, { ticketId: ticket.id }),
      { columnId: column(board, 'Selesai').id },
    );
    expect(done.statusCode, done.body).toBe(200);
    expect(ticketActionResponseSchema.parse(done.json()).ticket?.closedAt).not.toBeNull();
    // Tiket selesai → akses lewat tiket berakhir.
    expect((await send(world, teknisi, 'GET', conversationUrl)).statusCode).toBe(404);

    const events = await send(
      world,
      cs,
      'GET',
      apiPath(API_ROUTES.tickets.events, { ticketId: ticket.id }),
    );
    const kinds = events.json<{ events: { kind: string }[] }>().events.map((item) => item.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['created', 'updated', 'commented', 'moved', 'closed']),
    );
    // Riwayat tanpa isi deskripsi/komentar.
    const rows = await harness.db.select().from(ticketEvents);
    expect(JSON.stringify(rows)).not.toContain('Kabel drop');
  });

  it('Teknisi membuat tiket: selalu miliknya; tautan hanya ke data yang ia lihat', async () => {
    const teknisi = await agent(world, 'teknisi', 'Arya Teknisi');
    const board = await createBoard(world.owner);
    const { conversation } = await seedConversation(world);
    const own = await createTicket(teknisi, { boardId: board.id, title: 'Survei lokasi baru' });
    expect(own.assignee?.id).toBe(teknisi.userId);
    const forOther = await send(world, teknisi, 'POST', API_ROUTES.tickets.list, {
      boardId: board.id,
      title: 'Untuk orang lain',
      assigneeUserId: world.owner.userId,
    });
    expect(forOther.statusCode).toBe(403);
    // Percakapan di luar cakupannya tidak bisa ditautkan (supaya tiket tidak membuka akses).
    const sneaky = await send(world, teknisi, 'POST', API_ROUTES.tickets.list, {
      boardId: board.id,
      title: 'Buka akses',
      conversationId: conversation.id,
    });
    expect(sneaky.statusCode).toBe(400);
    const list = await send(world, teknisi, 'GET', `${API_ROUTES.tickets.list}?status=all`);
    expect(ticketListResponseSchema.parse(list.json()).tickets.map((item) => item.title)).toEqual([
      'Survei lokasi baru',
    ]);
  });
});

describe('Kanban & daftar', () => {
  it('urutan per kolom (afterTicketId), saringan, kursor', async () => {
    const board = await createBoard(world.owner);
    const first = await createTicket(world.owner, { boardId: board.id, title: 'Tiket A' });
    const second = await createTicket(world.owner, { boardId: board.id, title: 'Tiket B' });
    const third = await createTicket(world.owner, { boardId: board.id, title: 'Tiket C' });
    const move = await send(
      world,
      world.owner,
      'POST',
      apiPath(API_ROUTES.tickets.move, { ticketId: third.id }),
      { columnId: column(board, 'Baru').id, afterTicketId: first.id },
    );
    expect(move.statusCode, move.body).toBe(200);
    const kanban = await send(
      world,
      world.owner,
      'GET',
      apiPath(API_ROUTES.tickets.kanban, { boardId: board.id }),
    );
    expect(kanban.statusCode, kanban.body).toBe(200);
    const body = ticketKanbanResponseSchema.parse(kanban.json());
    expect(body.columns[0]?.tickets.map((ticket) => ticket.title)).toEqual([
      'Tiket A',
      'Tiket C',
      'Tiket B',
    ]);
    expect(body.columns[0]?.total).toBe(3);
    const search = await send(
      world,
      world.owner,
      'GET',
      `${API_ROUTES.tickets.list}?q=%23${String(second.number)}`,
    );
    expect(
      ticketListResponseSchema.parse(search.json()).tickets.map((ticket) => ticket.id),
    ).toEqual([second.id]);
    const page = ticketListResponseSchema.parse(
      (await send(world, world.owner, 'GET', `${API_ROUTES.tickets.list}?limit=2`)).json(),
    );
    expect(page.tickets).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe('API tiket untuk bot', () => {
  it('tickets:write membuat/mengubah/komentar; tickets:read hanya baca; outbox ticket.created/updated', async () => {
    const board = await createBoard(world.owner);
    await harness.db.insert(webhookEndpoints).values({
      organizationId: world.organizationId,
      url: 'https://n8n.contoh.id/webhook/tiket',
      events: ['ticket.created', 'ticket.updated'],
      secretEncrypted: 'x',
    });
    const { contact } = await seedConversation(world, { phone: '+6281377778888' });
    const writer = await createApiKey(world, ['tickets:write']);
    const reader = await createApiKey(world, ['tickets:read']);
    const contactsOnly = await createApiKey(world, ['contacts:read']);
    const body = {
      title: 'Gangguan dari bot',
      contactPhone: '+6281377778888',
      columnName: 'dikerjakan',
      priority: 'urgent',
    };
    expect(
      (await api(world, contactsOnly, 'POST', API_ROUTES.publicApi.tickets, body)).statusCode,
    ).toBe(403);
    expect((await api(world, reader, 'POST', API_ROUTES.publicApi.tickets, body)).statusCode).toBe(
      403,
    );
    const created = await api(world, writer, 'POST', API_ROUTES.publicApi.tickets, body);
    expect(created.statusCode, created.body).toBe(201);
    const ticket = ticketResponseSchema.parse(created.json()).ticket;
    expect(ticket).toMatchObject({
      boardId: board.id,
      column: { name: 'Dikerjakan' },
      contact: { id: contact.id },
      createdBy: { kind: 'api_key', name: 'n8n tiket' },
    });
    const url = apiPath(API_ROUTES.publicApi.ticket, { ticketId: ticket.id });
    const read = await api(world, reader, 'GET', url);
    expect(read.statusCode).toBe(200);
    const updated = await api(world, writer, 'PATCH', url, {
      columnName: 'Selesai',
      priority: 'normal',
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(ticketResponseSchema.parse(updated.json()).ticket).toMatchObject({
      priority: 'normal',
      column: { name: 'Selesai' },
    });
    expect(ticketResponseSchema.parse(updated.json()).ticket.closedAt).not.toBeNull();
    const comment = await api(
      world,
      writer,
      'POST',
      apiPath(API_ROUTES.publicApi.ticketComments, { ticketId: ticket.id }),
      { body: 'Pelanggan konfirmasi sudah normal.' },
    );
    expect(comment.statusCode, comment.body).toBe(201);
    const search = await api(world, reader, 'GET', `${API_ROUTES.publicApi.tickets}?status=closed`);
    expect(ticketListResponseSchema.parse(search.json()).tickets.map((item) => item.id)).toEqual([
      ticket.id,
    ]);
    const boards = await api(world, reader, 'GET', API_ROUTES.publicApi.ticketBoards);
    expect(boards.statusCode).toBe(200);

    const outbox = await harness.db
      .select({ type: outgoingEvents.type, ticketId: outgoingEvents.ticketId })
      .from(outgoingEvents);
    expect(outbox.map((row) => row.type).sort()).toEqual([
      'ticket.created',
      'ticket.updated',
      'ticket.updated',
      'ticket.updated',
    ]);
    expect(new Set(outbox.map((row) => row.ticketId))).toEqual(new Set([ticket.id]));
  });
});
