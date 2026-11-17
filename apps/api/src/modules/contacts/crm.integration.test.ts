/**
 * CRM Fase 5: definisi atribut + validasi nilai, daftar & cari kontak (cakupan), ekspor massal
 * (konfirmasi + audit + kebal rumus), gabung duplikat (pindah riwayat, lintas organisasi mustahil),
 * impor massal (tabel → kontak). Postgres + Redis sungguhan.
 */
import { randomUUID } from 'node:crypto';

import {
  auditLogs,
  contactEvents,
  contactTags,
  contacts,
  conversations,
  messages,
  newId,
  organizations,
  tags,
  tickets,
} from '@balesin/db';
import {
  API_ROUTES,
  apiPath,
  contactImportResultSchema,
  contactListResponseSchema,
  contactResponseSchema,
  mergeContactResponseSchema,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import {
  confirmationFor,
  confirmationOf,
  createIntegrationHarness,
  type IntegrationHarness,
} from '../../testing/integration';
import {
  agent,
  seedConversation,
  send,
  setupWorld,
  type Fase5World,
} from '../../testing/crm-fixtures';

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

const ownerSend = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
  send(world, world.owner, method, url, body);

describe('definisi atribut kontak', () => {
  it('kelola = settings.workspace.manage (CS 403); nilai divalidasi & dibakukan; wajib saat simpan dari aplikasi', async () => {
    const cs = await agent(world, 'cs', 'Sinta CS');
    const definition = {
      key: 'Paket',
      label: 'Paket internet',
      type: 'select',
      options: ['10 Mbps', '20 Mbps'],
      required: true,
    };
    expect((await send(world, cs, 'POST', API_ROUTES.crm.attributes, definition)).statusCode).toBe(
      403,
    );
    const created = await ownerSend('POST', API_ROUTES.crm.attributes, definition);
    expect(created.statusCode, created.body).toBe(201);
    expect(
      (await ownerSend('POST', API_ROUTES.crm.attributes, { ...definition, key: 'paket' }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await ownerSend('POST', API_ROUTES.crm.attributes, {
          key: 'Tagihan',
          label: 'Tagihan',
          type: 'number',
        })
      ).statusCode,
    ).toBe(201);
    const list = await send(world, cs, 'GET', API_ROUTES.crm.attributes);
    expect(list.statusCode).toBe(200);
    expect(list.json<{ attributes: unknown[] }>().attributes).toHaveLength(2);

    const { contact } = await seedConversation(world);
    const url = apiPath(API_ROUTES.inbox.contact, { contactId: contact.id });
    const invalid = await send(world, cs, 'PATCH', url, {
      attributes: [
        { key: 'Paket', value: '100 Mbps' },
        { key: 'Tagihan', value: 'mahal' },
      ],
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toContain('attributes.Paket');
    // Wajib: "Paket" tidak boleh hilang saat disimpan dari aplikasi.
    const missing = await send(world, cs, 'PATCH', url, {
      attributes: [{ key: 'ODP', value: 'ODP-1' }],
    });
    expect(missing.statusCode).toBe(400);
    const ok = await send(world, cs, 'PATCH', url, {
      attributes: [
        { key: 'paket', value: '20 mbps' },
        { key: 'tagihan', value: '150000,0' },
      ],
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(contactResponseSchema.parse(ok.json()).contact.attributes).toEqual([
      { key: 'Paket', value: '20 Mbps' },
      { key: 'Tagihan', value: '150000' },
    ]);
    const audit = await harness.db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'attribute_definition.created'));
    expect(audit).toHaveLength(2);
  });
});

describe('daftar & cari kontak', () => {
  it('saringan nama/tag/atribut/duplikat + kursor; Teknisi hanya kontak percakapannya', async () => {
    const teknisi = await agent(world, 'teknisi', 'Arya Teknisi');
    const a = await seedConversation(world, { name: '101PUTU@G2', assigneeUserId: teknisi.userId });
    const b = await seedConversation(world, { name: '202MADE@G3' });
    await harness.db
      .update(contacts)
      .set({
        attributes: [{ key: 'Area', value: 'G3' }],
        possibleDuplicateOfContactId: a.contact.id,
      })
      .where(eq(contacts.id, b.contact.id));
    const [tag] = await harness.db
      .insert(tags)
      .values({ organizationId: world.organizationId, name: 'MITRA-SURYA', color: 'blue' })
      .returning();
    await harness.db
      .insert(contactTags)
      .values({ organizationId: world.organizationId, contactId: a.contact.id, tagId: tag!.id });

    const ids = async (query: string, signed = world.owner) => {
      const response = await send(world, signed, 'GET', `${API_ROUTES.crm.contacts}${query}`);
      expect(response.statusCode, response.body).toBe(200);
      return contactListResponseSchema.parse(response.json()).contacts.map((contact) => contact.id);
    };
    expect(await ids('')).toEqual([b.contact.id, a.contact.id]);
    expect(await ids('?q=putu')).toEqual([a.contact.id]);
    expect(await ids(`?tagId=${tag!.id}`)).toEqual([a.contact.id]);
    expect(await ids('?attributeKey=area&attributeValue=G3')).toEqual([b.contact.id]);
    expect(await ids('?possibleDuplicate=true')).toEqual([b.contact.id]);
    expect(await ids('', teknisi)).toEqual([a.contact.id]);

    const first = await ownerSend('GET', `${API_ROUTES.crm.contacts}?limit=1`);
    const page = contactListResponseSchema.parse(first.json());
    expect(page.contacts[0]?.possibleDuplicateOfContactId).toBe(a.contact.id);
    expect(page.nextCursor).not.toBeNull();
    expect(await ids(`?limit=1&cursor=${page.nextCursor ?? ''}`)).toEqual([a.contact.id]);
  });
});

describe('ekspor kontak massal', () => {
  it('contacts.export + konfirmasi identitas; CSV kebal rumus; audit tanpa data pribadi', async () => {
    await seedConversation(world, { name: '=HYPERLINK("http://jahat")' });
    await seedConversation(world, { name: 'Budi' });
    const cs = await agent(world, 'cs', 'Sinta CS');
    expect((await send(world, cs, 'POST', API_ROUTES.crm.exportContacts, {})).statusCode).toBe(403);
    const unconfirmed = await ownerSend('POST', API_ROUTES.crm.exportContacts, {});
    expect(unconfirmed.statusCode).toBe(400);
    const response = await ownerSend('POST', API_ROUTES.crm.exportContacts, {
      filter: {},
      confirmation: await confirmationFor(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain(`"'=HYPERLINK(""http://jahat"")"`);
    expect(response.body).toContain('"Budi"');
    const [audit] = await harness.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'contact.bulk_exported'));
    expect(audit?.metadata).toMatchObject({ rows: 2, filtered: false });
    expect(JSON.stringify(audit)).not.toContain('Budi');

    // Supervisor juga boleh (PRD §4 "Impor/ekspor kontak massal").
    const supervisor = await agent(world, 'supervisor', 'Rina Supervisor');
    const bySupervisor = await send(world, supervisor, 'POST', API_ROUTES.crm.exportContacts, {
      filter: { q: 'Budi' },
      confirmation: await confirmationOf(supervisor),
    });
    expect(bySupervisor.statusCode, bySupervisor.body).toBe(200);
    expect(bySupervisor.headers['x-export-rows']).toBe('1');
  });
});

describe('gabung kontak duplikat', () => {
  it('riwayat, tag, tiket pindah; identitas pindah ke kontak tanpa nomor; sumber terhapus; audit', async () => {
    // Kontak lama hanya catatan CRM (identitas dilepas) + kontak baru bertanda "mungkin duplikat".
    const [old] = await harness.db
      .insert(contacts)
      .values({
        organizationId: world.organizationId,
        channelType: 'whatsapp',
        name: '101PUTU@G2',
        attributes: [{ key: 'ID', value: '101' }],
        waIdentityReleasedAt: new Date(),
      })
      .returning();
    const fresh = await seedConversation(world, { phone: '+6281311112222' });
    await harness.db
      .update(contacts)
      .set({
        possibleDuplicateOfContactId: old!.id,
        attributes: [
          { key: 'ID', value: 'baru' },
          { key: 'Area', value: 'G2' },
        ],
      })
      .where(eq(contacts.id, fresh.contact.id));
    await harness.db.insert(messages).values({
      organizationId: world.organizationId,
      conversationId: fresh.conversation.id,
      contactId: fresh.contact.id,
      channelId: world.channelId,
      direction: 'inbound',
      senderKind: 'customer',
      type: 'text',
      wamid: `wamid.${newId()}`,
      text: 'halo',
      occurredAt: new Date(),
    });
    const [tag] = await harness.db
      .insert(tags)
      .values({ organizationId: world.organizationId, name: 'MITRA-BAYU', color: 'green' })
      .returning();
    await harness.db.insert(contactTags).values({
      organizationId: world.organizationId,
      contactId: fresh.contact.id,
      tagId: tag!.id,
    });

    const cs = await agent(world, 'cs', 'Sinta CS');
    const url = apiPath(API_ROUTES.crm.merge, { contactId: old!.id });
    const teknisi = await agent(world, 'teknisi', 'Arya Teknisi');
    expect(
      (await send(world, teknisi, 'POST', url, { sourceContactId: fresh.contact.id })).statusCode,
    ).toBe(403);
    expect(
      (await send(world, cs, 'POST', url, { sourceContactId: fresh.contact.id })).statusCode,
    ).toBe(400);
    expect(
      (
        await send(world, cs, 'POST', url, {
          sourceContactId: old!.id,
          confirmation: await confirmationOf(cs),
        })
      ).statusCode,
    ).toBe(400);

    const merged = await send(world, cs, 'POST', url, {
      sourceContactId: fresh.contact.id,
      confirmation: await confirmationOf(cs),
    });
    expect(merged.statusCode, merged.body).toBe(200);
    const body = mergeContactResponseSchema.parse(merged.json());
    expect(body.moved).toEqual({ conversations: 1, messages: 1, tags: 1, tickets: 0 });
    expect(body.contact).toMatchObject({
      id: old!.id,
      phone: '+6281311112222',
      name: '101PUTU@G2',
      possibleDuplicateOfContactId: null,
      attributes: [
        { key: 'ID', value: '101' },
        { key: 'Area', value: 'G2' },
      ],
    });
    expect(body.contact.tags?.map((item) => item.name)).toEqual(['MITRA-BAYU']);
    expect(
      await harness.db.select().from(contacts).where(eq(contacts.id, fresh.contact.id)),
    ).toEqual([]);
    const [conversation] = await harness.db
      .select({ contactId: conversations.contactId })
      .from(conversations)
      .where(eq(conversations.id, fresh.conversation.id));
    expect(conversation?.contactId).toBe(old!.id);
    const events = await harness.db
      .select({ kind: contactEvents.kind })
      .from(contactEvents)
      .where(and(eq(contactEvents.contactId, old!.id), eq(contactEvents.kind, 'merged')));
    expect(events).toHaveLength(1);
    const [audit] = await harness.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'contact.merged'));
    expect(audit?.metadata).toMatchObject({ sourceContactId: fresh.contact.id, conversations: 1 });
    expect(JSON.stringify(audit)).not.toContain('6281311112222');
  });

  it('tolak: identitas WhatsApp berbeda, percakapan terbuka di channel sama, lintas organisasi', async () => {
    const a = await seedConversation(world);
    const b = await seedConversation(world);
    const url = apiPath(API_ROUTES.crm.merge, { contactId: a.contact.id });
    const differentNumbers = await ownerSend('POST', url, {
      sourceContactId: b.contact.id,
      confirmation: await confirmationFor(),
    });
    expect(differentNumbers.statusCode).toBe(409);

    // Kontak organisasi lain: tidak ditemukan (404), tidak pernah digabung.
    const [otherOrg] = await harness.db
      .insert(organizations)
      .values({ name: 'PT Lain', timezone: 'Asia/Jakarta' })
      .returning();
    const [foreign] = await harness.db
      .insert(contacts)
      .values({ organizationId: otherOrg!.id, channelType: 'whatsapp', phone: '+6281399990000' })
      .returning();
    const cross = await ownerSend('POST', url, {
      sourceContactId: foreign!.id,
      confirmation: await confirmationFor(),
    });
    expect(cross.statusCode).toBe(404);
    expect(
      await harness.db.select().from(contacts).where(eq(contacts.id, foreign!.id)),
    ).toHaveLength(1);

    // Dua kontak tanpa nomor berbeda tapi sama-sama punya percakapan terbuka di channel yang sama.
    const [noPhone] = await harness.db
      .insert(contacts)
      .values({
        organizationId: world.organizationId,
        channelType: 'whatsapp',
        waIdentityReleasedAt: new Date(),
      })
      .returning();
    await harness.db.insert(conversations).values({
      organizationId: world.organizationId,
      contactId: noPhone!.id,
      channelId: world.channelId,
      status: 'unserved',
      lastMessageAt: new Date(),
    });
    const clash = await ownerSend(
      'POST',
      apiPath(API_ROUTES.crm.merge, { contactId: noPhone!.id }),
      {
        sourceContactId: a.contact.id,
        confirmation: await confirmationFor(),
      },
    );
    expect(clash.statusCode).toBe(409);
    expect(clash.body).toContain('percakapan terbuka');
  });

  it('tiket kontak sumber ikut pindah', async () => {
    const [old] = await harness.db
      .insert(contacts)
      .values({
        organizationId: world.organizationId,
        channelType: 'whatsapp',
        waIdentityReleasedAt: new Date(),
      })
      .returning();
    const fresh = await seedConversation(world, { status: 'resolved' });
    const board = await ownerSend('POST', API_ROUTES.tickets.boards, { name: 'Perbaikan' });
    expect(board.statusCode, board.body).toBe(201);
    const boardId = board.json<{ board: { id: string } }>().board.id;
    const created = await ownerSend('POST', API_ROUTES.tickets.list, {
      boardId,
      title: 'ONT mati',
      contactId: fresh.contact.id,
    });
    expect(created.statusCode, created.body).toBe(201);
    const merged = await ownerSend('POST', apiPath(API_ROUTES.crm.merge, { contactId: old!.id }), {
      sourceContactId: fresh.contact.id,
      confirmation: await confirmationFor(),
    });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(mergeContactResponseSchema.parse(merged.json()).moved.tickets).toBe(1);
    const [ticket] = await harness.db.select({ contactId: tickets.contactId }).from(tickets);
    expect(ticket?.contactId).toBe(old!.id);
  });
});

describe('impor kontak massal (CSV lewat parser terisolasi)', () => {
  function upload(signed: Fase5World['owner'], mapping: unknown, csv: string) {
    const boundary = `----balesin${randomUUID()}`;
    const CRLF = '\r\n';
    const payload = Buffer.concat([
      Buffer.from(
        [
          `--${boundary}`,
          'Content-Disposition: form-data; name="mapping"',
          '',
          typeof mapping === 'string' ? mapping : JSON.stringify(mapping),
          `--${boundary}`,
          'Content-Disposition: form-data; name="file"; filename="kontak.csv"',
          'Content-Type: text/csv',
          '',
          '',
        ].join(CRLF),
      ),
      Buffer.from(csv, 'utf8'),
      Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
    ]);
    return harness.app.inject({
      method: 'POST',
      url: API_ROUTES.crm.importContacts,
      payload,
      headers: {
        cookie: signed.cookie,
        'x-csrf-token': signed.csrf,
        origin: TEST_APP_ORIGIN,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
  }

  it('buat, perbarui (isian dipetakan saja), lewati baris bermasalah; uji coba tidak menyimpan; audit', async () => {
    await ownerSend('POST', API_ROUTES.crm.attributes, {
      key: 'Tagihan',
      label: 'Tagihan',
      type: 'number',
    });
    const existing = await seedConversation(world, { phone: '+6281200000001', name: 'Lama' });
    const csv = [
      'nomor,nama,email,tagihan,tag',
      '081200000001,Putu Baru,,150000,MITRA-SURYA',
      '0812-0000-0002,Made,made@contoh.id,,"MITRA-SURYA; VIP"',
      '0812 0000 0002,Ganda,,,',
      'abc,Salah,,,',
      '081200000003,Email salah,bukan-email,,',
      '081200000004,Tagihan salah,,mahal,',
    ].join('\r\n');
    const mapping = {
      phoneColumn: 'nomor',
      nameColumn: 'nama',
      emailColumn: 'email',
      tagsColumn: 'tag',
      attributes: [{ column: 'tagihan', key: 'tagihan' }],
      dryRun: true,
    };
    const cs = await agent(world, 'cs', 'Sinta CS');
    expect((await upload(cs, mapping, csv)).statusCode).toBe(403);

    const dry = await upload(world.owner, mapping, csv);
    expect(dry.statusCode, dry.body).toBe(200);
    expect(contactImportResultSchema.parse(dry.json())).toMatchObject({
      dryRun: true,
      created: 1,
      updated: 1,
      skipped: 4,
    });
    expect(await harness.db.select().from(contacts)).toHaveLength(1);

    const committed = await upload(world.owner, { ...mapping, dryRun: false }, csv);
    expect(committed.statusCode, committed.body).toBe(200);
    const result = contactImportResultSchema.parse(committed.json());
    expect(result).toMatchObject({ created: 1, updated: 1, skipped: 4, sourceRows: 6 });
    expect(result.issueCounts).toMatchObject({
      duplicate: 1,
      phone_invalid: 1,
      email_invalid: 1,
      attribute_invalid: 1,
    });
    expect(result.issues).toContainEqual({ row: 7, issue: 'attribute_invalid', key: 'Tagihan' });
    const [updated] = await harness.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, existing.contact.id));
    expect(updated).toMatchObject({
      name: 'Putu Baru',
      attributes: [{ key: 'Tagihan', value: '150000' }],
    });
    const [made] = await harness.db
      .select()
      .from(contacts)
      .where(eq(contacts.phone, '+6281200000002'));
    expect(made).toMatchObject({ name: 'Made', email: 'made@contoh.id' });
    const tagRows = await harness.db.select({ name: tags.name }).from(tags);
    expect(tagRows.map((row) => row.name).sort()).toEqual(['MITRA-SURYA', 'VIP']);

    // Mode "hanya baru": nomor yang sudah ada dilewati.
    const createOnly = await upload(
      world.owner,
      { phoneColumn: 'nomor', mode: 'create_only' },
      'nomor\r\n081200000001\r\n',
    );
    expect(contactImportResultSchema.parse(createOnly.json())).toMatchObject({
      created: 0,
      skipped: 1,
      issueCounts: { exists: 1 },
    });
    const [audit] = await harness.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'contact.imported'));
    expect(audit?.metadata).toMatchObject({ created: 1, updated: 1, skipped: 4 });
    expect(JSON.stringify(audit)).not.toContain('Putu');

    // Pemetaan rusak / kolom tidak ada → 400.
    expect((await upload(world.owner, { phoneColumn: 'hp' }, csv)).statusCode).toBe(400);
    expect((await upload(world.owner, 'bukan-json', csv)).statusCode).toBe(400);
  });
});
