/**
 * Webhook keluar Fase 5: body `ticket.created`/`ticket.updated` dibangun saat dispatch dari database
 * (tiket + kontak tautan + pelaku), tiket yang sudah dihapus tidak dikirim. Postgres sungguhan.
 */
import {
  closeDb,
  contacts,
  createDb,
  outgoingEvents,
  ticketBoards,
  ticketColumns,
  tickets,
  type Database,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { buildEventBody } from './webhooks-out';

let db: Database;

beforeAll(() => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-worker-ticket-out' });
}, 30_000);

afterAll(async () => {
  if (db) await closeDb(db);
}, 30_000);

describe('payload webhook tiket', () => {
  it('memuat tiket (board, kolom, penanggung jawab) + kontak + pelaku; tiket terhapus → null', async () => {
    const organization = await insertOrganization(db);
    const agent = await insertUser(db, organization.id, { role: 'teknisi', name: 'Arya Teknisi' });
    const [board] = await db
      .insert(ticketBoards)
      .values({ organizationId: organization.id, name: 'Perbaikan' })
      .returning();
    const [column] = await db
      .insert(ticketColumns)
      .values({
        organizationId: organization.id,
        boardId: board!.id,
        name: 'Selesai',
        position: 0,
        isDone: true,
      })
      .returning();
    const [contact] = await db
      .insert(contacts)
      .values({
        organizationId: organization.id,
        channelType: 'whatsapp',
        phone: `+62813${String(Date.now()).slice(-8)}`,
        name: '101PUTU@G2',
      })
      .returning();
    const [ticket] = await db
      .insert(tickets)
      .values({
        organizationId: organization.id,
        boardId: board!.id,
        columnId: column!.id,
        title: 'ONT mati',
        priority: 'urgent',
        assigneeUserId: agent.id,
        contactId: contact!.id,
        attributes: [{ key: 'SN ONT', value: 'ZTEG1234' }],
        closedAt: new Date(),
      })
      .returning();
    const [event] = await db
      .insert(outgoingEvents)
      .values({
        organizationId: organization.id,
        type: 'ticket.updated',
        ticketId: ticket!.id,
        actorUserId: agent.id,
      })
      .returning();

    const body = await buildEventBody(db, event!);
    expect(body).toMatchObject({
      id: event!.id,
      event: 'ticket.updated',
      data: {
        ticket: {
          id: ticket!.id,
          number: ticket!.number,
          board: { id: board!.id, name: 'Perbaikan' },
          column: { id: column!.id, name: 'Selesai', is_done: true },
          title: 'ONT mati',
          priority: 'urgent',
          assignee: { id: agent.id, name: 'Arya Teknisi' },
          contact_id: contact!.id,
          conversation_id: null,
          attributes: [{ key: 'SN ONT', value: 'ZTEG1234' }],
        },
        contact: { id: contact!.id, name: '101PUTU@G2' },
        actor: { id: agent.id, name: 'Arya Teknisi' },
      },
    });

    await db.delete(tickets).where(eq(tickets.id, ticket!.id));
    expect(await buildEventBody(db, event!)).toBeNull();
    // Basis data dipakai bersama berkas tes lain yang memeriksa outbox kosong.
    await db.delete(outgoingEvents).where(eq(outgoingEvents.id, event!.id));
  });
});
