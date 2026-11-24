/**
 * Event real-time modul Email lewat hub WebSocket Inbox (KONTRAK-API-EMAIL §10): hanya ke soket yang
 * penggunanya punya hak ≥ `read` atas akun SAAT ITU; akun pribadi hanya pemiliknya (Owner tidak);
 * `mail.access.changed` hanya ke pengguna yang disebut; banjir event → satu `mail.resync`.
 */
import { parseMailBusMessage, type MailBusEvent } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import { mailAccountAccess, mailAccounts, newId, type NewMailAccountRow } from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import type { UserRole } from '@balesin/shared';
import type { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInboxStreamHub, type InboxStreamHub } from '../realtime/inbox-stream';
import { createIntegrationHarness, type IntegrationHarness } from '../../testing/integration';

let harness: IntegrationHarness;
let hub: InboxStreamHub;

interface FakeSocket {
  sent: { type: string }[];
  socket: WebSocket;
}

function fakeSocket(): FakeSocket {
  const sent: { type: string }[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: (data: string) => sent.push(JSON.parse(data) as { type: string }),
    on: () => socket,
    close: () => undefined,
    terminate: () => undefined,
    ping: () => undefined,
  };
  return { sent, socket: socket as unknown as WebSocket };
}

function account(organizationId: string, overrides: Partial<NewMailAccountRow>): NewMailAccountRow {
  return {
    id: newId(),
    organizationId,
    kind: 'shared',
    provider: 'cpanel',
    displayName: 'CS',
    emailAddress: `cs-${newId().slice(-8)}@contoh.test`,
    fromName: 'Tim CS',
    color: 'tagBlue',
    imapHost: 'mail.contoh.test',
    imapPort: 993,
    imapSecurity: 'ssl',
    imapUsername: 'cs',
    imapPasswordEncrypted: 'v1.x.y',
    smtpHost: 'mail.contoh.test',
    smtpPort: 465,
    smtpSecurity: 'ssl',
    ...overrides,
  };
}

const created = (organizationId: string, accountId: string): MailBusEvent => ({
  v: 1,
  type: 'mail',
  organizationId,
  accountId,
  event: {
    type: 'mail.message.created',
    accountId,
    folderId: newId(),
    messageId: newId(),
    receivedAt: new Date().toISOString(),
  },
});

beforeAll(async () => {
  harness = await createIntegrationHarness();
  hub = createInboxStreamHub({
    db: harness.db,
    sessions: harness.app.inboxStream as never,
    redis: null,
    prefix: 'tes',
    logger: createLogCapture('silent').logger,
    coalesceMs: 0,
    maxMailEventsPerSecond: 5,
  });
});

afterAll(async () => {
  await hub?.close();
  await harness?.close();
});

describe('penyaringan event mail.* per hak akun', () => {
  it('pribadi → hanya pemilik; bersama → Owner + pemegang grant; Teknisi tanpa grant tidak', async () => {
    const org = await insertOrganization(harness.db);
    const people: Record<string, { id: string; socket: FakeSocket }> = {};
    for (const role of ['owner', 'cs', 'teknisi', 'supervisor'] as UserRole[]) {
      const user = await insertUser(harness.db, org.id, { role });
      const socket = fakeSocket();
      hub.register(socket.socket, {
        userId: user.id,
        organizationId: org.id,
        role,
        sessionTokenHash: newId(),
      });
      socket.sent.length = 0; // buang `hello`
      people[role] = { id: user.id, socket };
    }
    const cs = people.cs!;
    const owner = people.owner!;
    const teknisi = people.teknisi!;
    const supervisor = people.supervisor!;
    const personal = account(org.id, { kind: 'personal', ownerUserId: cs.id });
    const shared = account(org.id, {});
    await harness.db.insert(mailAccounts).values([personal, shared]);
    await harness.db.insert(mailAccountAccess).values({
      organizationId: org.id,
      accountId: shared.id as string,
      principalType: 'user',
      userId: supervisor.id,
      level: 'read',
    });

    await hub.deliverMail([created(org.id, personal.id as string)]);
    expect(cs.socket.sent.map((event) => event.type)).toEqual(['mail.message.created']);
    expect(owner.socket.sent).toEqual([]);
    expect(teknisi.socket.sent).toEqual([]);

    for (const person of Object.values(people)) person.socket.sent.length = 0;
    await hub.deliverMail([created(org.id, shared.id as string)]);
    expect(owner.socket.sent).toHaveLength(1);
    expect(supervisor.socket.sent).toHaveLength(1);
    expect(cs.socket.sent).toEqual([]);
    expect(teknisi.socket.sent).toEqual([]);

    // Grant dicabut → seketika tidak menerima lagi (dibaca segar per batch).
    await harness.db.delete(mailAccountAccess);
    supervisor.socket.sent.length = 0;
    await hub.deliverMail([created(org.id, shared.id as string)]);
    expect(supervisor.socket.sent).toEqual([]);

    // `mail.access.changed` hanya ke pengguna yang disebut.
    for (const person of Object.values(people)) person.socket.sent.length = 0;
    await hub.deliverMail([
      {
        v: 1,
        type: 'mail',
        organizationId: org.id,
        userIds: [teknisi.id],
        event: { type: 'mail.access.changed' },
      },
    ]);
    expect(teknisi.socket.sent.map((event) => event.type)).toEqual(['mail.access.changed']);
    expect(owner.socket.sent).toEqual([]);

    // Banjir event satu akun → kelebihan diganti satu `mail.resync`.
    const busy = account(org.id, {});
    await harness.db.insert(mailAccounts).values(busy);
    owner.socket.sent.length = 0;
    await hub.deliverMail(Array.from({ length: 12 }, () => created(org.id, busy.id as string)));
    const types = owner.socket.sent.map((event) => event.type);
    expect(types.filter((type) => type === 'mail.message.created')).toHaveLength(5);
    expect(types.filter((type) => type === 'mail.resync')).toHaveLength(1);
  });

  it('pesan Redis tidak sah/berisi isian asing dibuang', () => {
    expect(parseMailBusMessage('{"type":"mail"}')).toBeNull();
    const accountId = newId();
    const message = JSON.stringify({
      v: 1,
      type: 'mail',
      organizationId: newId(),
      accountId,
      event: { type: 'mail.resync', accountId: newId() },
    });
    // accountId event harus sama dengan accountId amplop.
    expect(parseMailBusMessage(message)).toBeNull();
  });
});
