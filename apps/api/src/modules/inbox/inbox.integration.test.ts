/**
 * Inbox ujung ke ujung (Fase 2 butir 4) di atas Postgres sungguhan:
 * POST webhook bertanda tangan (Meta tiruan) → pemroses worker (`processWebhookJob`, kode worker
 * yang sama dengan produksi) → kontak/percakapan/pesan tersimpan → tampil di API baca inbox.
 *
 * Mencakup juga: aneka jenis pesan, status pesan keluar, tab/channel/cari/kursor, cakupan Teknisi,
 * isolasi organisasi, 404 untuk ID asing/bukan UUID, respons tanpa payload mentah/BSUID/ID media,
 * dan hapus kontak (UU PDP) yang ikut mengosongkan `webhook_events`.
 */
import { createSecretBox, sealChannelSecret, Secret, WEBHOOK_JOBS } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import { channels, contacts, conversations, messages, newId, webhookEvents } from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  WEBHOOK_ROUTES,
  apiPath,
  contactResponseSchema,
  conversationListResponseSchema,
  conversationResponseSchema,
  errorEnvelopeSchema,
  messageListResponseSchema,
  type ConversationListResponse,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Kode worker yang sama dengan produksi (tes saja; api tidak bergantung pada worker saat berjalan).
import { contactIdentityLockKey as workerLockKey } from '../../../../worker/src/inbound/contacts';
import { processWebhookJob } from '../../../../worker/src/queues/webhooks';
import { createPasswordHasher } from '../auth/password-hasher';
import { contactIdentityLockKey, deleteContactData } from '../contacts/contacts.repo';
import {
  FAKE_WEBHOOK_DEFAULTS,
  buttonMessageNotification,
  fakeWamid,
  interactiveReplyNotification,
  locationMessageNotification,
  mediaMessageNotification,
  reactionMessageNotification,
  signedWebhook,
  statusNotification,
  textMessageNotification,
} from '../../testing/fake-meta';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const WABA = FAKE_WEBHOOK_DEFAULTS.wabaId;
const PHONE = FAKE_WEBHOOK_DEFAULTS.phoneNumberId;
const PHONE_2 = '106540352249999';
const SECRET_TEXT = 'ISI-PESAN-PELANGGAN-INBOX-9182';
const PASSWORD = 'sandi-uji-inbox-teknisi-01';
const META_IP = '173.252.127.1';

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const hasher = createPasswordHasher();
const workerLogs = createLogCapture();

async function insertChannel(phoneNumberId: string = PHONE, name = 'CS Utama'): Promise<string> {
  const id = newId();
  const target = { id, organizationId };
  await harness.db.insert(channels).values({
    id,
    organizationId,
    type: 'whatsapp',
    name,
    waPhoneNumberId: phoneNumberId,
    waBusinessAccountId: WABA,
    waAccessTokenEncrypted: sealChannelSecret(
      box,
      target,
      'accessToken',
      'EAAtokenTiruan0123456789',
    ),
    waAccessTokenTail: '6789',
    waAppSecretEncrypted: sealChannelSecret(box, target, 'appSecret', APP_SECRET),
    waAppSecretTail: 'cdef',
    waVerifyTokenEncrypted: sealChannelSecret(
      box,
      target,
      'verifyToken',
      'verify-token-0123456789',
    ),
    waVerifyTokenRotatedAt: new Date(),
  });
  return id;
}

/** Notifikasi bertanda tangan → penerima (200) → semua job yang diantrekan diproses worker. */
async function receive(notification: unknown, target = channelId): Promise<void> {
  const { body, headers } = signedWebhook(notification, APP_SECRET);
  const response = await harness.app.inject({
    method: 'POST',
    url: apiPath(WEBHOOK_ROUTES.whatsapp, { channelId: target }),
    headers,
    payload: body,
    remoteAddress: META_IP,
  });
  expect(response.statusCode, response.body).toBe(200);
  const jobs = harness.webhookJobs.splice(0);
  for (const data of jobs) {
    await processWebhookJob(
      { name: WEBHOOK_JOBS.whatsappEvent, data, attemptsMade: 0, opts: { attempts: 8 } },
      { db: harness.db, logger: workerLogs.logger },
    );
  }
}

async function signIn(
  role: 'cs' | 'teknisi',
  name: string,
): Promise<SignedIn & { userId: string }> {
  const user = await insertUser(harness.db, organizationId, {
    role,
    name,
    email: `${role}.${newId().slice(-8)}@majujaya.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  const signed = await login(harness.app, { email: user.email, password: PASSWORD });
  return { ...signed, userId: user.id };
}

function get(signed: SignedIn, url: string) {
  return call(harness.app, 'GET', url, undefined, { cookie: signed.cookie });
}

async function listConversations(signed: SignedIn, query = ''): Promise<ConversationListResponse> {
  const response = await get(signed, `${API_ROUTES.inbox.conversations}${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return conversationListResponseSchema.parse(response.json());
}

async function messagesOf(signed: SignedIn, conversationId: string, query = '') {
  const response = await get(
    signed,
    `${apiPath(API_ROUTES.inbox.messages, { conversationId })}${query}`,
  );
  expect(response.statusCode, response.body).toBe(200);
  return messageListResponseSchema.parse(response.json());
}

function expectNotFound(response: Awaited<ReturnType<typeof get>>) {
  expect(response.statusCode, response.body).toBe(404);
  expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
}

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  channelId = await insertChannel();
});
afterAll(async () => {
  await harness?.close();
});

describe('ujung ke ujung: webhook → worker → GET /conversations', () => {
  it('pesan teks masuk menjadi percakapan "Belum dilayani" lengkap dengan kontak & pesan', async () => {
    await receive(textMessageNotification({ body: SECRET_TEXT }));

    const list = await listConversations(owner);
    expect(list.nextCursor).toBeNull();
    expect(list.conversations).toHaveLength(1);
    const [conversation] = list.conversations;
    expect(conversation).toMatchObject({
      status: 'unserved',
      channel: { id: channelId, name: 'CS Utama', type: 'whatsapp' },
      contact: {
        displayName: FAKE_WEBHOOK_DEFAULTS.customerName,
        phone: `+${FAKE_WEBHOOK_DEFAULTS.customerWaId}`,
      },
      assignee: null,
      unreadCount: 1,
      windowOpen: true,
      lastMessage: { direction: 'inbound', type: 'text', text: SECRET_TEXT, status: null },
      resolvedAt: null,
    });
    const windowMs =
      Date.parse(conversation!.windowExpiresAt!) - Date.parse(conversation!.lastInboundAt!);
    expect(windowMs).toBe(24 * 60 * 60 * 1000);

    const detail = await get(
      owner,
      apiPath(API_ROUTES.inbox.conversation, { conversationId: conversation!.id }),
    );
    expect(detail.statusCode).toBe(200);
    expect(conversationResponseSchema.parse(detail.json()).conversation.id).toBe(conversation!.id);

    const { messages: rows, nextCursor } = await messagesOf(owner, conversation!.id);
    expect(nextCursor).toBeNull();
    expect(rows).toMatchObject([
      {
        direction: 'inbound',
        senderKind: 'customer',
        type: 'text',
        text: SECRET_TEXT,
        status: null,
      },
    ]);

    const contact = await get(
      owner,
      apiPath(API_ROUTES.inbox.contact, { contactId: conversation!.contact.id }),
    );
    expect(contact.statusCode).toBe(200);
    expect(contactResponseSchema.parse(contact.json()).contact).toMatchObject({
      channelType: 'whatsapp',
      name: null,
      profileName: FAKE_WEBHOOK_DEFAULTS.customerName,
      phone: `+${FAKE_WEBHOOK_DEFAULTS.customerWaId}`,
    });

    // Tidak ada payload mentah, BSUID, maupun isi pesan di log api/worker.
    for (const response of [detail, contact]) {
      expect(response.body).not.toContain(FAKE_WEBHOOK_DEFAULTS.customerUserId);
      expect(response.body).not.toContain('payload');
    }
    expect(harness.logs.text()).not.toContain(SECRET_TEXT);
    expect(workerLogs.text()).not.toContain(SECRET_TEXT);
  });

  it('kontak hanya-BSUID (username) dan hanya-nomor sama-sama tampil', async () => {
    await receive(
      textMessageNotification({
        customer: { waId: null, userId: 'ID.5550001', name: 'Tanpa Nomor', username: 'tanpanomor' },
      }),
    );
    await receive(
      textMessageNotification({ customer: { waId: '6285550009999', userId: null, name: 'Lama' } }),
    );
    const { conversations: rows } = await listConversations(owner);
    expect(rows.map((row) => row.contact).sort((a, b) => a.number - b.number)).toMatchObject([
      { displayName: 'Tanpa Nomor', phone: null },
      { displayName: 'Lama', phone: '+6285550009999' },
    ]);
  });

  it('aneka jenis pesan dipetakan tanpa ID media Meta; reaksi & balas-kutip ditautkan', async () => {
    const first = fakeWamid();
    await receive(textMessageNotification({ wamid: first, body: 'Halo' }));
    await receive(
      mediaMessageNotification('image', { caption: 'Bukti transfer', mediaId: '777001' }),
    );
    await receive(mediaMessageNotification('document', { filename: 'ktp.pdf', mediaId: '777002' }));
    await receive(mediaMessageNotification('audio', { voice: true, mediaId: '777003' }));
    await receive(mediaMessageNotification('video', { mediaId: '777004' }));
    await receive(mediaMessageNotification('sticker', { mediaId: '777005' }));
    await receive(locationMessageNotification({ name: 'Rumah' }));
    await receive(
      interactiveReplyNotification({
        reply: 'list_reply',
        id: 'PAKET_20',
        title: 'Paket 20 Mbps',
        description: 'Rp200.000',
      }),
    );
    await receive(buttonMessageNotification({ text: 'Hubungi CS', payload: 'HUBUNGI_CS' }));
    await receive(textMessageNotification({ replyTo: first, body: 'Ini balasan' }));
    await receive(reactionMessageNotification({ targetWamid: first, emoji: '🙏' }));

    const [conversation] = (await listConversations(owner)).conversations;
    const { messages: rows } = await messagesOf(owner, conversation!.id, '?limit=100');
    const byType = (type: string) => rows.filter((row) => row.type === type);
    const firstMessage = rows.find((row) => row.text === 'Halo');

    expect(byType('image')[0]).toMatchObject({
      text: 'Bukti transfer',
      media: { kind: 'image', mimeType: 'image/jpeg', voice: false },
    });
    expect(byType('document')[0]?.media).toMatchObject({ kind: 'document', filename: 'ktp.pdf' });
    expect(byType('audio')[0]?.media).toMatchObject({ kind: 'audio', voice: true });
    expect(byType('video')).toHaveLength(1);
    expect(byType('sticker')).toHaveLength(1);
    expect(byType('location')[0]?.location).toMatchObject({
      latitude: -7.2575,
      longitude: 112.7521,
      name: 'Rumah',
    });
    expect(byType('interactive').map((row) => row.interactive)).toEqual(
      expect.arrayContaining([
        { kind: 'list_reply', id: 'PAKET_20', title: 'Paket 20 Mbps', description: 'Rp200.000' },
        { kind: 'button', id: 'HUBUNGI_CS', title: 'Hubungi CS', description: null },
      ]),
    );
    expect(rows.find((row) => row.text === 'Ini balasan')?.replyTo).toEqual({
      messageId: firstMessage?.id,
    });
    expect(byType('reaction')[0]?.reaction).toEqual({ emoji: '🙏', messageId: firstMessage?.id });

    const body = JSON.stringify(rows);
    for (const mediaId of ['777001', '777002', '777003', '777004', '777005']) {
      expect(body).not.toContain(mediaId);
    }
    expect(body).not.toContain('metaMediaId');
    // Reaksi tidak menambah "belum dibaca"; 10 pesan lain menambah.
    expect((await listConversations(owner)).conversations[0]?.unreadCount).toBe(10);
  });

  it('status pesan keluar dari webhook memperbarui pesan (hanya maju)', async () => {
    await receive(textMessageNotification());
    const [row] = await harness.db.select().from(conversations);
    const outgoing = fakeWamid();
    await harness.db.insert(messages).values({
      organizationId,
      conversationId: row!.id,
      contactId: row!.contactId,
      channelId,
      direction: 'outbound',
      senderKind: 'agent',
      type: 'text',
      wamid: outgoing,
      text: 'Baik kak, kami cek dulu.',
      status: 'pending',
      occurredAt: new Date(),
    });
    await receive(statusNotification({ wamid: outgoing, status: 'sent' }));
    await receive(statusNotification({ wamid: outgoing, status: 'read' }));
    await receive(statusNotification({ wamid: outgoing, status: 'delivered' }));
    await receive(statusNotification({ wamid: fakeWamid(), status: 'delivered' }));

    const { messages: rows } = await messagesOf(owner, row!.id);
    expect(rows.find((message) => message.direction === 'outbound')).toMatchObject({
      status: 'read',
      senderKind: 'agent',
    });
    expect((await listConversations(owner)).conversations[0]?.lastMessage).toMatchObject({
      direction: 'outbound',
      status: 'read',
    });
  });
});

describe('GET /conversations: tab, channel, cari, kursor', () => {
  async function seedFive() {
    const second = await insertChannel(PHONE_2, 'Teknisi');
    const customers = [
      { waId: '6281200000001', userId: 'ID.9001', name: 'Andi Wijaya' },
      { waId: '6281200000002', userId: 'ID.9002', name: 'Bunga Lestari' },
      { waId: '6281200000003', userId: 'ID.9003', name: 'Candra 100% Asli' },
      { waId: '6281200000004', userId: 'ID.9004', name: 'Dewi_Sartika' },
    ];
    for (const customer of customers) {
      await receive(textMessageNotification({ customer }));
    }
    await receive(
      textMessageNotification({
        phoneNumberId: PHONE_2,
        customer: { waId: '6289999000005', userId: 'ID.9005', name: 'Eko Teknisi' },
      }),
      second,
    );
    return second;
  }

  it('urut pesan terakhir terbaru; tab status; channel', async () => {
    const second = await seedFive();
    const all = await listConversations(owner);
    expect(all.conversations.map((row) => row.contact.displayName)).toEqual([
      'Eko Teknisi',
      'Dewi_Sartika',
      'Candra 100% Asli',
      'Bunga Lestari',
      'Andi Wijaya',
    ]);

    const target = all.conversations.find((row) => row.contact.displayName === 'Bunga Lestari');
    await harness.db
      .update(conversations)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(eq(conversations.id, target!.id));
    expect((await listConversations(owner, '?status=resolved')).conversations).toHaveLength(1);
    expect((await listConversations(owner, '?status=unserved')).conversations).toHaveLength(4);
    expect((await listConversations(owner, '?status=served')).conversations).toHaveLength(0);
    expect(
      (await listConversations(owner, `?channelId=${second}`)).conversations.map(
        (row) => row.channel.name,
      ),
    ).toEqual(['Teknisi']);
  });

  it('cari nama (wildcard di-escape) dan nomor (termasuk awalan 0)', async () => {
    await seedFive();
    const names = async (q: string) =>
      (await listConversations(owner, `?q=${encodeURIComponent(q)}`)).conversations.map(
        (row) => row.contact.displayName,
      );
    expect(await names('bunga')).toEqual(['Bunga Lestari']);
    expect(await names('100%')).toEqual(['Candra 100% Asli']);
    expect(await names('%')).toEqual(['Candra 100% Asli']);
    expect(await names('_')).toEqual(['Dewi_Sartika']);
    expect(await names('0812-0000-0002')).toEqual(['Bunga Lestari']);
    expect(await names('+62 812 0000 0003')).toEqual(['Candra 100% Asli']);
    expect(await names('99990')).toEqual(['Eko Teknisi']);
    expect(await names('tidak ada')).toEqual([]);
  });

  it('kursor: halaman bersambung tanpa duplikat; kursor rusak → 400', async () => {
    await seedFive();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const page = await listConversations(owner, query);
      seen.push(...page.conversations.map((row) => row.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);

    const bad = await get(owner, `${API_ROUTES.inbox.conversations}?cursor=bukan-kursor`);
    expect(bad.statusCode).toBe(400);
    const tooMany = await get(owner, `${API_ROUTES.inbox.conversations}?limit=1000`);
    expect(tooMany.statusCode).toBe(400);
  });

  it('pesan: terbaru dulu dengan kursor ke yang lebih lama', async () => {
    for (let index = 1; index <= 5; index += 1) {
      await receive(textMessageNotification({ body: `pesan ${String(index)}` }));
    }
    const [conversation] = (await listConversations(owner)).conversations;
    const first = await messagesOf(owner, conversation!.id, '?limit=3');
    expect(first.messages.map((row) => row.text)).toEqual(['pesan 5', 'pesan 4', 'pesan 3']);
    const second = await messagesOf(owner, conversation!.id, `?limit=3&cursor=${first.nextCursor}`);
    expect(second.messages.map((row) => row.text)).toEqual(['pesan 2', 'pesan 1']);
    expect(second.nextCursor).toBeNull();
  });
});

describe('cakupan & isolasi', () => {
  it('Teknisi hanya melihat percakapan & kontak yang di-assign kepadanya; CS melihat semua', async () => {
    await receive(
      textMessageNotification({
        customer: { waId: '6281300000001', userId: 'ID.7101', name: 'Pelanggan Satu' },
      }),
    );
    await receive(
      textMessageNotification({
        customer: { waId: '6281300000002', userId: 'ID.7102', name: 'Pelanggan Dua' },
      }),
    );
    const teknisi = await signIn('teknisi', 'Arya Teknisi');
    const cs = await signIn('cs', 'Sinta CS');
    const all = (await listConversations(owner)).conversations;
    const mine = all.find((row) => row.contact.displayName === 'Pelanggan Satu')!;
    const other = all.find((row) => row.contact.displayName === 'Pelanggan Dua')!;

    expect((await listConversations(teknisi)).conversations).toEqual([]);
    expectNotFound(
      await get(teknisi, apiPath(API_ROUTES.inbox.contact, { contactId: mine.contact.id })),
    );

    await harness.db
      .update(conversations)
      .set({ status: 'served', assigneeUserId: teknisi.userId })
      .where(eq(conversations.id, mine.id));

    const visible = await listConversations(teknisi);
    expect(visible.conversations.map((row) => row.id)).toEqual([mine.id]);
    expect(visible.conversations[0]?.assignee).toEqual({
      id: teknisi.userId,
      name: 'Arya Teknisi',
    });
    expect((await listConversations(teknisi, '?q=Dua')).conversations).toEqual([]);
    expect((await messagesOf(teknisi, mine.id)).messages).toHaveLength(1);
    expectNotFound(
      await get(teknisi, apiPath(API_ROUTES.inbox.conversation, { conversationId: other.id })),
    );
    expectNotFound(
      await get(teknisi, apiPath(API_ROUTES.inbox.messages, { conversationId: other.id })),
    );
    expect(
      (await get(teknisi, apiPath(API_ROUTES.inbox.contact, { contactId: mine.contact.id })))
        .statusCode,
    ).toBe(200);
    expectNotFound(
      await get(teknisi, apiPath(API_ROUTES.inbox.contact, { contactId: other.contact.id })),
    );

    expect((await listConversations(cs)).conversations).toHaveLength(2);
    expect(
      (await get(cs, apiPath(API_ROUTES.inbox.contact, { contactId: other.contact.id })))
        .statusCode,
    ).toBe(200);
  });

  it('data organisasi lain dan ID bukan UUID → 404 yang sama', async () => {
    const foreignOrg = await insertOrganization(harness.db);
    const [foreignContact] = await harness.db
      .insert(contacts)
      .values({ organizationId: foreignOrg.id, channelType: 'whatsapp', waBsuid: 'ID.asing' })
      .returning();
    const foreignChannel = newId();
    await harness.db.insert(channels).values({
      id: foreignChannel,
      organizationId: foreignOrg.id,
      type: 'whatsapp',
      name: 'Asing',
      waPhoneNumberId: '199999999999',
      waBusinessAccountId: WABA,
      waAccessTokenEncrypted: 'x',
      waAppSecretEncrypted: 'x',
      waVerifyTokenEncrypted: 'x',
      waVerifyTokenRotatedAt: new Date(),
    });
    const [foreignConversation] = await harness.db
      .insert(conversations)
      .values({
        organizationId: foreignOrg.id,
        contactId: foreignContact!.id,
        channelId: foreignChannel,
        status: 'unserved',
        lastMessageAt: new Date(),
      })
      .returning();

    expect((await listConversations(owner)).conversations).toEqual([]);
    expectNotFound(
      await get(
        owner,
        apiPath(API_ROUTES.inbox.conversation, { conversationId: foreignConversation!.id }),
      ),
    );
    expectNotFound(
      await get(
        owner,
        apiPath(API_ROUTES.inbox.messages, { conversationId: foreignConversation!.id }),
      ),
    );
    expectNotFound(
      await get(owner, apiPath(API_ROUTES.inbox.contact, { contactId: foreignContact!.id })),
    );
    for (const id of ['123', 'bukan-uuid', "1' or '1'='1"]) {
      expectNotFound(
        await get(owner, apiPath(API_ROUTES.inbox.conversation, { conversationId: id })),
      );
      expectNotFound(await get(owner, apiPath(API_ROUTES.inbox.contact, { contactId: id })));
    }
    // Saringan channel organisasi lain = daftar kosong (bukan bocor).
    expect((await listConversations(owner, `?channelId=${foreignChannel}`)).conversations).toEqual(
      [],
    );
  });
});

describe('hapus kontak (UU PDP): deleteContactData', () => {
  it('menghapus pesan/percakapan/kontak dan mengosongkan kejadian webhook terkait; kiriman ulang tidak menghidupkannya', async () => {
    const notification = textMessageNotification({ body: SECRET_TEXT });
    await receive(notification);
    await receive(
      textMessageNotification({
        customer: { waId: '6281400000002', userId: 'ID.lain', name: 'Orang Lain' },
      }),
    );
    const [contact] = await harness.db
      .select()
      .from(contacts)
      .where(eq(contacts.waBsuid, FAKE_WEBHOOK_DEFAULTS.customerUserId));

    // Kejadian `pending` milik kontak ini yang belum diproses worker (belum ada contact_id).
    const pendingWamid = fakeWamid();
    const { body, headers } = signedWebhook(
      textMessageNotification({ wamid: pendingWamid, body: SECRET_TEXT }),
      APP_SECRET,
    );
    await harness.app.inject({
      method: 'POST',
      url: apiPath(WEBHOOK_ROUTES.whatsapp, { channelId }),
      headers,
      payload: body,
      remoteAddress: META_IP,
    });
    const pendingJobs = harness.webhookJobs.splice(0);
    expect(pendingJobs).toHaveLength(1);

    const result = await harness.db.transaction((tx) =>
      deleteContactData(tx, organizationId, contact!.id),
    );
    expect(result).toEqual({ messages: 1, conversations: 1, webhookEvents: 2 });

    expect(await harness.db.select().from(contacts).where(eq(contacts.id, contact!.id))).toEqual(
      [],
    );
    expect(
      await harness.db.select().from(messages).where(eq(messages.contactId, contact!.id)),
    ).toEqual([]);
    const events = await harness.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.organizationId, organizationId));
    const containsSecret = events.filter((event) =>
      JSON.stringify(event.payload).includes(SECRET_TEXT),
    );
    expect(containsSecret).toEqual([]);
    const pendingEvent = events.find((event) => event.externalId === pendingWamid);
    expect(pendingEvent).toMatchObject({
      status: 'skipped',
      lastError: 'contact_deleted',
      payload: {},
    });
    // Kontak lain tidak tersentuh.
    expect(
      (await listConversations(owner)).conversations.map((row) => row.contact.displayName),
    ).toEqual(['Orang Lain']);

    // Job lama yang telanjur diantre tidak menghidupkan kontak; begitu juga kiriman ulang Meta.
    await processWebhookJob(
      {
        name: WEBHOOK_JOBS.whatsappEvent,
        data: pendingJobs[0],
        attemptsMade: 0,
        opts: { attempts: 8 },
      },
      { db: harness.db, logger: workerLogs.logger },
    );
    await receive(notification);
    expect(
      await harness.db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.organizationId, organizationId),
            eq(contacts.waBsuid, FAKE_WEBHOOK_DEFAULTS.customerUserId),
          ),
        ),
    ).toEqual([]);

    expect(
      await harness.db.transaction((tx) => deleteContactData(tx, organizationId, contact!.id)),
    ).toBeUndefined();
  });

  it('kunci advisory identitas sama dengan worker', () => {
    expect(contactIdentityLockKey(organizationId, 'whatsapp', 'bsuid', 'ID.1')).toBe(
      workerLockKey(organizationId, 'whatsapp', 'bsuid', 'ID.1'),
    );
  });
});
