/**
 * Panel detail & quick reply (Fase 2 butir 8–9): tag (master + kontak + saringan), ubah kontak,
 * catatan sesi (penulis / moderasi), pesan ditandai, saringan media/file, log, quick reply — RBAC
 * per peran, cakupan Teknisi, CSRF, event WS hanya ID. Postgres + Redis sungguhan.
 */
import {
  auditLogs,
  channels,
  contactEvents,
  contactTags,
  contacts,
  conversationNotes,
  conversations,
  messages,
  newId,
  tags,
  type MessageRow,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  contactResponseSchema,
  conversationCountsResponseSchema,
  conversationEventListResponseSchema,
  conversationListResponseSchema,
  conversationNoteListResponseSchema,
  conversationNoteResponseSchema,
  inboxStreamEventSchema,
  messageListResponseSchema,
  messageResponseSchema,
  quickReplyListResponseSchema,
  quickReplyResponseSchema,
  securitySummaryResponseSchema,
  tagListResponseSchema,
  tagResponseSchema,
  useQuickReplyResponseSchema,
  type InboxStreamEvent,
  type UserRole,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from '../auth/password-hasher';
import { deleteContactData } from '../contacts/contacts.repo';
import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const PASSWORD = 'sandi-uji-panel-detail-01';

type Agent = SignedIn & { userId: string; name: string };
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

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
      profileName: 'Budi WA',
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

async function message(
  row: { id: string; contactId: string },
  type: MessageRow['type'],
): Promise<MessageRow> {
  const media =
    type === 'text'
      ? null
      : {
          kind: type as 'image',
          metaMediaId: '1',
          mimeType: null,
          sha256: null,
          filename: null,
          voice: false,
          animated: false,
        };
  const [inserted] = await harness.db
    .insert(messages)
    .values({
      organizationId,
      conversationId: row.id,
      contactId: row.contactId,
      channelId,
      direction: 'inbound',
      senderKind: 'customer',
      type,
      wamid: `wamid.${newId()}`,
      text: type === 'text' ? 'Halo kak' : null,
      media,
      occurredAt: new Date(),
    })
    .returning();
  return inserted!;
}

function send(
  signed: SignedIn,
  method: Method,
  url: string,
  body?: unknown,
  options: { csrf?: boolean } = {},
) {
  return call(harness.app, method, url, body, {
    cookie: signed.cookie,
    ...(method !== 'GET' && options.csrf !== false ? { csrf: signed.csrf } : {}),
  });
}

async function assign(row: { id: string }, userId: string) {
  const response = await send(
    owner,
    'POST',
    apiPath(API_ROUTES.inbox.assign, { conversationId: row.id }),
    { userId },
  );
  expect(response.statusCode, response.body).toBe(200);
}

async function createTag(signed: SignedIn, name: string, color = 'green') {
  const response = await send(signed, 'POST', API_ROUTES.tags.list, { name, color });
  expect(response.statusCode, response.body).toBe(201);
  return tagResponseSchema.parse(response.json()).tag;
}

const contactTagsUrl = (contactId: string) => apiPath(API_ROUTES.inbox.contactTags, { contactId });
const notesUrl = (conversationId: string) => apiPath(API_ROUTES.inbox.notes, { conversationId });
const noteUrl = (conversationId: string, noteId: string) =>
  apiPath(API_ROUTES.inbox.note, { conversationId, noteId });
const starUrl = (messageId: string) => apiPath(API_ROUTES.inbox.star, { messageId });

async function streamOf(signed: SignedIn): Promise<InboxStreamEvent[]> {
  const events: InboxStreamEvent[] = [];
  const socket = await harness.app.injectWS(API_ROUTES.inbox.stream, {
    headers: { cookie: signed.cookie, origin: TEST_APP_ORIGIN },
  });
  socket.on('message', (data: Buffer) => {
    events.push(inboxStreamEventSchema.parse(JSON.parse(data.toString('utf8'))));
  });
  return events;
}

async function waitFor(check: () => boolean) {
  const started = Date.now();
  while (Date.now() - started < 3000 && !check()) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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

describe('tag', () => {
  it('CS membuat & memasang tag; nama unik tanpa beda huruf; ubah/hapus hanya Owner/Admin', async () => {
    const cs = await agent('cs', 'Sinta CS');
    const tag = await createTag(cs, 'MITRA-SURYA');
    expect(tag).toMatchObject({ name: 'MITRA-SURYA', color: 'green', contactCount: 0 });
    const duplicate = await send(cs, 'POST', API_ROUTES.tags.list, { name: 'mitra-surya' });
    expect(duplicate.statusCode).toBe(409);
    for (const body of [{ name: '' }, { name: 'a\u202eb' }, { name: 'X', color: '#ff0000' }]) {
      expect((await send(cs, 'POST', API_ROUTES.tags.list, body)).statusCode).toBe(400);
    }
    const tagUrl = apiPath(API_ROUTES.tags.tag, { tagId: tag.id });
    expect((await send(cs, 'PATCH', tagUrl, { color: 'red' })).statusCode).toBe(403);
    expect((await send(cs, 'DELETE', tagUrl)).statusCode).toBe(403);
    const renamed = await send(owner, 'PATCH', tagUrl, { name: 'MITRA SURYA', color: 'red' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(tagResponseSchema.parse(renamed.json()).tag).toMatchObject({
      name: 'MITRA SURYA',
      color: 'red',
    });
    const audit = await harness.db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.targetId, tag.id));
    expect(audit.map((row) => row.action).sort()).toEqual(['tag.created', 'tag.updated']);

    const teknisi = await agent('teknisi', 'Arya Teknisi');
    expect((await send(teknisi, 'POST', API_ROUTES.tags.list, { name: 'X' })).statusCode).toBe(403);
    const listed = await send(teknisi, 'GET', API_ROUTES.tags.list);
    expect(tagListResponseSchema.parse(listed.json()).tags.map((row) => row.name)).toEqual([
      'MITRA SURYA',
    ]);
  });

  it('pasang/lepas tag kontak → tampil di daftar & kontak, saringan tagId, log, event WS', async () => {
    const cs = await agent('cs', 'Sinta CS');
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    const tagged = await conversation();
    const other = await conversation();
    await assign(tagged, teknisi.userId);
    const stream = await streamOf(teknisi);
    const tag = await createTag(cs, 'VIP', 'purple');

    expect(
      (await send(teknisi, 'POST', contactTagsUrl(tagged.contactId), { tagId: tag.id })).statusCode,
    ).toBe(403);
    expect(
      (await send(cs, 'POST', contactTagsUrl(tagged.contactId), { tagId: tag.id }, { csrf: false }))
        .statusCode,
    ).toBe(403);
    const added = await send(cs, 'POST', contactTagsUrl(tagged.contactId), { tagId: tag.id });
    expect(added.statusCode, added.body).toBe(200);
    expect(contactResponseSchema.parse(added.json()).contact.tags).toEqual([
      { id: tag.id, name: 'VIP', color: 'purple' },
    ]);
    // Idempoten.
    expect(
      (await send(cs, 'POST', contactTagsUrl(tagged.contactId), { tagId: tag.id })).statusCode,
    ).toBe(200);
    // Tag organisasi lain / tak dikenal → 404.
    expect(
      (await send(cs, 'POST', contactTagsUrl(tagged.contactId), { tagId: newId() })).statusCode,
    ).toBe(404);

    const list = await send(cs, 'GET', `${API_ROUTES.inbox.conversations}?tagId=${tag.id}`);
    const conversationsWithTag = conversationListResponseSchema.parse(list.json()).conversations;
    expect(conversationsWithTag.map((row) => row.id)).toEqual([tagged.id]);
    expect(conversationsWithTag[0]?.contact.tags).toEqual([
      { id: tag.id, name: 'VIP', color: 'purple' },
    ]);
    const counts = await send(cs, 'GET', `${API_ROUTES.inbox.counts}?tagId=${tag.id}`);
    expect(conversationCountsResponseSchema.parse(counts.json()).counts.all).toBe(1);
    expect(other.id).not.toBe(tagged.id);

    await waitFor(() => stream.some((event) => event.type === 'conversation.detail'));
    expect(stream).toContainEqual({
      type: 'conversation.detail',
      conversationId: tagged.id,
      section: 'tags',
    });
    expect(stream).toContainEqual({ type: 'tags.changed' });

    const removed = await send(
      cs,
      'DELETE',
      apiPath(API_ROUTES.inbox.contactTag, { contactId: tagged.contactId, tagId: tag.id }),
    );
    expect(contactResponseSchema.parse(removed.json()).contact.tags).toEqual([]);

    const log = await send(
      teknisi,
      'GET',
      apiPath(API_ROUTES.inbox.events, { conversationId: tagged.id }),
    );
    expect(conversationEventListResponseSchema.parse(log.json()).events).toMatchObject([
      { kind: 'assigned' },
      { kind: 'tag_added', actor: { name: 'Sinta CS' }, tag: { name: 'VIP', color: 'purple' } },
      { kind: 'tag_removed', tag: { name: 'VIP' } },
    ]);
  });

  it('hapus tag melepasnya dari semua kontak; batas tag per kontak', async () => {
    const row = await conversation();
    const tag = await createTag(owner, 'Lama');
    await send(owner, 'POST', contactTagsUrl(row.contactId), { tagId: tag.id });
    const deleted = await send(owner, 'DELETE', apiPath(API_ROUTES.tags.tag, { tagId: tag.id }));
    expect(deleted.json()).toEqual({ deleted: true });
    const contact = await send(
      owner,
      'GET',
      apiPath(API_ROUTES.inbox.contact, { contactId: row.contactId }),
    );
    expect(contactResponseSchema.parse(contact.json()).contact.tags).toEqual([]);

    const many = await harness.db
      .insert(tags)
      .values(
        Array.from({ length: 21 }, (_, index) => ({
          organizationId,
          name: `T${String(index)}`,
          color: 'blue',
        })),
      )
      .returning({ id: tags.id });
    for (const item of many.slice(0, 20)) {
      expect(
        (await send(owner, 'POST', contactTagsUrl(row.contactId), { tagId: item.id })).statusCode,
      ).toBe(200);
    }
    const over = await send(owner, 'POST', contactTagsUrl(row.contactId), { tagId: many[20]!.id });
    expect(over.statusCode).toBe(409);
  });
});

describe('ubah kontak', () => {
  it('nama/email/catatan/atribut tervalidasi; riwayat hanya nama isian; Teknisi tidak boleh', async () => {
    const row = await conversation();
    const url = apiPath(API_ROUTES.inbox.contact, { contactId: row.contactId });
    const cs = await agent('cs', 'Sinta CS');
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    await assign(row, teknisi.userId);
    expect((await send(teknisi, 'PATCH', url, { name: 'X' })).statusCode).toBe(403);

    for (const body of [
      {},
      { email: 'bukan-email' },
      { name: 'Budi\nSantoso' },
      {
        attributes: [
          { key: 'ID', value: '1' },
          { key: 'id', value: '2' },
        ],
      },
      { attributes: [{ key: '__proto__', value: 'x' }] },
      { notes: 'x'.repeat(2001) },
    ]) {
      const response = await send(cs, 'PATCH', url, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }

    const updated = await send(cs, 'PATCH', url, {
      name: '1500040SUWANTO@KWSN',
      email: 'Budi@Contoh.CO.ID',
      notes: 'Pelanggan lama.\nSuka telepon pagi.',
      attributes: [{ key: 'ID pelanggan', value: '1500040' }],
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(contactResponseSchema.parse(updated.json()).contact).toMatchObject({
      displayName: '1500040SUWANTO@KWSN',
      nameSource: 'team',
      email: 'budi@contoh.co.id',
      notes: 'Pelanggan lama.\nSuka telepon pagi.',
      attributes: [{ key: 'ID pelanggan', value: '1500040' }],
    });
    // Tidak berubah → tidak ada riwayat baru.
    await send(cs, 'PATCH', url, { email: 'budi@contoh.co.id' });
    const reset = await send(cs, 'PATCH', url, { name: null });
    expect(contactResponseSchema.parse(reset.json()).contact.nameSource).toBe('whatsapp');

    const history = await harness.db
      .select()
      .from(contactEvents)
      .where(eq(contactEvents.contactId, row.contactId));
    expect(history.map((event) => event.fields)).toEqual([
      ['name', 'email', 'notes', 'attributes'],
      ['name'],
    ]);
    // Riwayat tanpa nilai data pelanggan.
    expect(JSON.stringify(history)).not.toContain('SUWANTO');
    expect(JSON.stringify(history)).not.toContain('contoh.co.id');
  });
});

describe('catatan sesi', () => {
  it('Teknisi menulis di percakapannya; ubah hanya penulis; hapus penulis/Admin; log tanpa isi', async () => {
    const row = await conversation();
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    const outsider = await agent('teknisi', 'Bayu Teknisi');
    const cs = await agent('cs', 'Sinta CS');
    const admin = await agent('admin', 'Dewi Admin');
    await assign(row, teknisi.userId);
    const stream = await streamOf(cs);

    expect((await send(outsider, 'POST', notesUrl(row.id), { body: 'x' })).statusCode).toBe(404);
    expect((await send(outsider, 'GET', notesUrl(row.id))).statusCode).toBe(404);
    expect((await send(teknisi, 'POST', notesUrl(row.id), { body: '  ' })).statusCode).toBe(400);
    expect(
      (await send(teknisi, 'POST', notesUrl(row.id), { body: 'x' }, { csrf: false })).statusCode,
    ).toBe(403);

    const created = await send(teknisi, 'POST', notesUrl(row.id), {
      body: 'ONT merah, jadwalkan kunjungan.',
    });
    expect(created.statusCode, created.body).toBe(201);
    const note = conversationNoteResponseSchema.parse(created.json()).note;
    expect(note).toMatchObject({
      author: { id: teknisi.userId, name: 'Arya Teknisi' },
      edited: false,
      canEdit: true,
      canDelete: true,
    });

    const seen = conversationNoteListResponseSchema.parse(
      (await send(cs, 'GET', notesUrl(row.id))).json(),
    ).notes;
    expect(seen).toMatchObject([{ id: note.id, canEdit: false, canDelete: false }]);
    const asAdmin = conversationNoteListResponseSchema.parse(
      (await send(admin, 'GET', notesUrl(row.id))).json(),
    ).notes;
    expect(asAdmin).toMatchObject([{ canEdit: false, canDelete: true }]);

    expect((await send(cs, 'PATCH', noteUrl(row.id, note.id), { body: 'ubah' })).statusCode).toBe(
      403,
    );
    expect((await send(admin, 'PATCH', noteUrl(row.id, note.id), { body: 'x' })).statusCode).toBe(
      403,
    );
    expect((await send(cs, 'DELETE', noteUrl(row.id, note.id))).statusCode).toBe(403);
    const denied = await harness.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.access.denied'));
    expect(JSON.stringify(denied)).toContain('inbox.note.edit_others');

    const edited = await send(teknisi, 'PATCH', noteUrl(row.id, note.id), {
      body: 'ONT merah, kunjungan besok 09.00.',
    });
    expect(conversationNoteResponseSchema.parse(edited.json()).note).toMatchObject({
      body: 'ONT merah, kunjungan besok 09.00.',
      edited: true,
    });
    expect((await send(admin, 'DELETE', noteUrl(row.id, note.id))).json()).toEqual({
      deleted: true,
    });
    expect((await send(admin, 'DELETE', noteUrl(row.id, note.id))).statusCode).toBe(404);

    const log = conversationEventListResponseSchema.parse(
      (await send(cs, 'GET', apiPath(API_ROUTES.inbox.events, { conversationId: row.id }))).json(),
    ).events;
    expect(log.map((event) => event.kind)).toEqual([
      'assigned',
      'note_added',
      'note_updated',
      'note_deleted',
    ]);
    expect(JSON.stringify(log)).not.toContain('ONT merah');

    await waitFor(() => stream.some((event) => event.type === 'conversation.detail'));
    expect(stream).toContainEqual({
      type: 'conversation.detail',
      conversationId: row.id,
      section: 'notes',
    });
    expect(JSON.stringify(stream)).not.toContain('ONT merah');
  });
});

describe('pesan ditandai & media', () => {
  it('tandai/lepas; saringan starred/media/files; di luar cakupan 404', async () => {
    const row = await conversation();
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    const text = await message(row, 'text');
    const image = await message(row, 'image');
    const document = await message(row, 'document');

    expect((await send(teknisi, 'PUT', starUrl(text.id))).statusCode).toBe(404);
    const starred = await send(owner, 'PUT', starUrl(text.id));
    expect(starred.statusCode, starred.body).toBe(200);
    expect(messageResponseSchema.parse(starred.json()).message.starredAt).toEqual(
      expect.any(String),
    );
    expect((await send(owner, 'PUT', starUrl(text.id))).statusCode).toBe(200);

    const listOf = async (only: string) =>
      messageListResponseSchema
        .parse(
          (
            await send(
              owner,
              'GET',
              `${apiPath(API_ROUTES.inbox.messages, { conversationId: row.id })}?only=${only}`,
            )
          ).json(),
        )
        .messages.map((item) => item.id);
    expect(await listOf('starred')).toEqual([text.id]);
    expect(await listOf('media')).toEqual([image.id]);
    expect(await listOf('files')).toEqual([document.id]);

    const unstarred = await send(owner, 'DELETE', starUrl(text.id));
    expect(messageResponseSchema.parse(unstarred.json()).message.starredAt).toBeNull();
    expect(await listOf('starred')).toEqual([]);
    const [state] = await harness.db
      .select({ by: messages.starredByUserId })
      .from(messages)
      .where(and(eq(messages.id, text.id), eq(messages.organizationId, organizationId)));
    expect(state?.by).toBeNull();
  });
});

describe('quick reply', () => {
  it('kelola = Supervisor+; shortcut dinormalkan; variabel tak dikenal ditolak; audit memuat isi (R1)', async () => {
    const supervisor = await agent('supervisor', 'Rina Supervisor');
    const cs = await agent('cs', 'Sinta CS');
    const body = { shortcut: '/Salam', title: 'Salam pembuka', body: 'Halo {nama}, saya {agen}.' };
    expect((await send(cs, 'POST', API_ROUTES.quickReplies.list, body)).statusCode).toBe(403);
    const created = await send(supervisor, 'POST', API_ROUTES.quickReplies.list, body);
    expect(created.statusCode, created.body).toBe(201);
    const item = quickReplyResponseSchema.parse(created.json()).quickReply;
    expect(item).toMatchObject({ shortcut: 'salam', usageCount: 0 });
    expect(
      (await send(supervisor, 'POST', API_ROUTES.quickReplies.list, { ...body, shortcut: 'salam' }))
        .statusCode,
    ).toBe(409);
    for (const bad of [
      { ...body, shortcut: 'dua kata' },
      { ...body, shortcut: 'baru', body: 'Halo {nam}' },
      { ...body, shortcut: 'baru', body: 'x'.repeat(3501) },
    ]) {
      expect((await send(supervisor, 'POST', API_ROUTES.quickReplies.list, bad)).statusCode).toBe(
        400,
      );
    }
    const url = apiPath(API_ROUTES.quickReplies.quickReply, { quickReplyId: item.id });
    const updated = await send(supervisor, 'PATCH', url, { body: 'Selamat pagi {nama}.' });
    expect(quickReplyResponseSchema.parse(updated.json()).quickReply).toMatchObject({
      body: 'Selamat pagi {nama}.',
      updatedBy: { name: 'Rina Supervisor' },
    });
    const audit = await harness.db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.targetId, item.id));
    expect(audit.map((row) => row.action).sort()).toEqual([
      'quick_reply.created',
      'quick_reply.updated',
    ]);
    // Review panel R1: isi template (teks bisnis) ikut diaudit supaya perubahan bisa ditelusuri.
    expect(JSON.stringify(audit)).toContain('Selamat pagi');
    expect((await send(cs, 'DELETE', url)).statusCode).toBe(403);
    expect((await send(supervisor, 'DELETE', url)).json()).toEqual({ deleted: true });
  });

  it('pakai: isi variabel, penghitung naik, urut paling sering; Teknisi hanya percakapannya', async () => {
    const supervisor = await agent('supervisor', 'Rina Supervisor');
    const teknisi = await agent('teknisi', 'Arya Teknisi');
    const mine = await conversation();
    const notMine = await conversation();
    await harness.db
      .update(contacts)
      .set({ profileName: null })
      .where(eq(contacts.id, notMine.contactId));
    await assign(mine, teknisi.userId);
    const make = async (shortcut: string, text: string) =>
      quickReplyResponseSchema.parse(
        (
          await send(supervisor, 'POST', API_ROUTES.quickReplies.list, {
            shortcut,
            title: shortcut,
            body: text,
          })
        ).json(),
      ).quickReply;
    const greet = await make('salam', 'Halo {nama}, saya {agen}.');
    await make('alamat', 'Kantor kami di Jl. Contoh.');

    const useUrl = apiPath(API_ROUTES.quickReplies.use, { quickReplyId: greet.id });
    const used = await send(teknisi, 'POST', useUrl, { conversationId: mine.id });
    expect(used.statusCode, used.body).toBe(200);
    expect(useQuickReplyResponseSchema.parse(used.json()).text).toBe(
      'Halo Budi WA, saya Arya Teknisi.',
    );
    expect((await send(teknisi, 'POST', useUrl, { conversationId: notMine.id })).statusCode).toBe(
      404,
    );
    const fallback = await send(owner, 'POST', useUrl, { conversationId: notMine.id });
    expect(useQuickReplyResponseSchema.parse(fallback.json()).text).toBe(
      `Halo Kak, saya ${owner.name}.`,
    );

    const list = quickReplyListResponseSchema.parse(
      (await send(teknisi, 'GET', API_ROUTES.quickReplies.list)).json(),
    ).quickReplies;
    expect(list.map((row) => [row.shortcut, row.usageCount])).toEqual([
      ['salam', 2],
      ['alamat', 0],
    ]);
    const searched = quickReplyListResponseSchema.parse(
      (await send(teknisi, 'GET', `${API_ROUTES.quickReplies.list}?q=%2Falamat`)).json(),
    ).quickReplies;
    expect(searched.map((row) => row.shortcut)).toEqual(['alamat']);
  });
});

describe('hapus kontak (UU PDP)', () => {
  it('ikut menghapus tag kontak, riwayat kontak, dan catatan sesi', async () => {
    const row = await conversation();
    const tag = await createTag(owner, 'Hapus');
    await send(owner, 'POST', contactTagsUrl(row.contactId), { tagId: tag.id });
    await send(owner, 'PATCH', apiPath(API_ROUTES.inbox.contact, { contactId: row.contactId }), {
      notes: 'catatan',
    });
    await send(owner, 'POST', notesUrl(row.id), { body: 'catatan sesi' });
    await harness.db.transaction((tx) => deleteContactData(tx, organizationId, row.contactId));
    for (const [table, column] of [
      [contactTags, contactTags.contactId],
      [contactEvents, contactEvents.contactId],
    ] as const) {
      expect(await harness.db.select().from(table).where(eq(column, row.contactId))).toEqual([]);
    }
    expect(
      await harness.db
        .select()
        .from(conversationNotes)
        .where(eq(conversationNotes.conversationId, row.id)),
    ).toEqual([]);
  });
});

describe('quick reply — jejak isi & tautan/angka baru (review panel R1)', () => {
  it('audit menyimpan isi lama → baru; tautan/rekening baru oleh selain Owner → kejadian warning', async () => {
    const supervisor = await agent('supervisor', 'Rina Supervisor');
    const created = await send(supervisor, 'POST', API_ROUTES.quickReplies.list, {
      shortcut: 'rekening',
      title: 'Rekening',
      body: 'Silakan transfer ke rekening resmi kami.',
    });
    const item = quickReplyResponseSchema.parse(created.json()).quickReply;
    const url = apiPath(API_ROUTES.quickReplies.quickReply, { quickReplyId: item.id });
    await send(supervisor, 'PATCH', url, {
      body: 'Transfer ke BCA 1234 5678 90 atau bayar di https://bayar-cepat.example/x',
    });
    // Owner menambah tautan → tercatat tetapi bukan kejadian keamanan.
    await send(owner, 'PATCH', url, { body: 'Bayar lewat https://resmi.example' });

    const audit = await harness.db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.targetId, item.id));
    const updates = audit.filter((row) => row.action === 'quick_reply.updated');
    expect(updates).toHaveLength(2);
    expect(updates[0]?.metadata).toMatchObject({
      previous: { body: 'Silakan transfer ke rekening resmi kami.' },
      next: { body: expect.stringContaining('1234 5678 90') as unknown },
      risky: true,
      addedLinks: 1,
      addedNumbers: 1,
      actorRole: 'supervisor',
    });
    expect(updates[1]?.metadata).not.toHaveProperty('risky');

    const summary = securitySummaryResponseSchema.parse(
      (await send(owner, 'GET', API_ROUTES.audit.securitySummary)).json(),
    );
    expect(summary.counts.quick_reply_risky).toBe(1);
    expect(summary.events).toContainEqual(
      expect.objectContaining({
        kind: 'quick_reply_risky',
        severity: 'warning',
        details: expect.objectContaining({ shortcut: 'rekening', addedLinks: 1 }) as unknown,
      }),
    );
  });
});

describe('quick reply — review panel putaran 2 (R2)', () => {
  it('domain tanpa skema terdeteksi; isi audit utuh (≤ 3.500); hapus menyimpan isi terakhir', async () => {
    const supervisor = await agent('supervisor', 'Rina Supervisor');
    const created = await send(supervisor, 'POST', API_ROUTES.quickReplies.list, {
      shortcut: 'info',
      title: 'Info',
      body: 'Terima kasih sudah menghubungi kami.',
    });
    const item = quickReplyResponseSchema.parse(created.json()).quickReply;
    const url = apiPath(API_ROUTES.quickReplies.quickReply, { quickReplyId: item.id });
    const long = `Cek status di bayar-aman.co ya kak. ${'x'.repeat(2000)}`;
    await send(supervisor, 'PATCH', url, { body: long });
    await send(supervisor, 'DELETE', url);
    const audit = await harness.db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.targetId, item.id));
    const updated = audit.find((row) => row.action === 'quick_reply.updated');
    expect(updated?.metadata).toMatchObject({ risky: true, addedLinks: 1, next: { body: long } });
    const deleted = audit.find((row) => row.action === 'quick_reply.deleted');
    expect(deleted?.metadata).toMatchObject({ previous: { body: long } });
  });
});
