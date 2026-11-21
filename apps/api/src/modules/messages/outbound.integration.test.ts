/**
 * Ruang chat ujung ke ujung (Fase 2 butir 6) di atas Postgres + Redis sungguhan dan server Meta
 * TIRUAN: kirim → antrean → worker (kode produksi) → Graph tiruan → webhook status → status maju →
 * event WebSocket; unggah media (magic bytes), unduh media masuk (host Meta tiruan, header aman),
 * kirim ulang, jendela 24 jam, cakupan Teknisi, idempotensi, pembersih media.
 */
import { randomUUID } from 'node:crypto';

import {
  createInboxEventPublisher,
  createMetaGraphClient,
  createSecretBox,
  MESSAGE_JOBS,
  sealChannelSecret,
  Secret,
  WEBHOOK_JOBS,
} from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import { channels, conversations, mediaFiles, messages, newId } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  WEBHOOK_ROUTES,
  apiPath,
  errorEnvelopeSchema,
  inboxStreamEventSchema,
  messageListResponseSchema,
  messageResponseSchema,
  uploadMediaResponseSchema,
  type InboxStreamEvent,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { processWebhookJob } from '../../../../worker/src/queues/webhooks';
import { processSendMessageJob } from '../../../../worker/src/queues/messages';
import { createPasswordHasher } from '../auth/password-hasher';
import {
  FAKE_WEBHOOK_DEFAULTS,
  mediaMessageNotification,
  metaErrorBody,
  signedWebhook,
  startFakeMeta,
  statusNotification,
  textMessageNotification,
  type FakeMeta,
} from '../../testing/fake-meta';
import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  createIntegrationHarness,
  integrationConfig,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const TOKEN = 'EAAtokenTiruanRuangChat0123456789';
const PHONE = FAKE_WEBHOOK_DEFAULTS.phoneNumberId;
const META_IP = '173.252.127.1';
const PASSWORD = 'sandi-uji-ruang-chat-01';
const SECRET_REPLY = 'BALASAN-AGEN-RAHASIA-7781';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);

let fake: FakeMeta;
let harness: IntegrationHarness;
let owner: SignedIn & { userId: string };
let organizationId: string;
let channelId: string;
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const hasher = createPasswordHasher();
const workerLogs = createLogCapture();

async function insertChannel(): Promise<string> {
  const id = newId();
  const target = { id, organizationId };
  await harness.db.insert(channels).values({
    id,
    organizationId,
    type: 'whatsapp',
    name: 'CS Utama',
    waPhoneNumberId: PHONE,
    waBusinessAccountId: FAKE_WEBHOOK_DEFAULTS.wabaId,
    waAccessTokenEncrypted: sealChannelSecret(box, target, 'accessToken', TOKEN),
    waAccessTokenTail: '6789',
    waAppSecretEncrypted: sealChannelSecret(box, target, 'appSecret', APP_SECRET),
    waAppSecretTail: 'cdef',
    waVerifyTokenEncrypted: sealChannelSecret(box, target, 'verifyToken', 'verify-token-01234'),
    waVerifyTokenRotatedAt: new Date(),
  });
  return id;
}

function publisher() {
  return createInboxEventPublisher(harness.redis, {
    prefix: harness.redisPrefix,
    logger: workerLogs.logger,
  });
}

/** Webhook bertanda tangan → penerima → worker webhook. */
async function receive(notification: unknown): Promise<void> {
  const { body, headers } = signedWebhook(notification, APP_SECRET);
  const response = await harness.app.inject({
    method: 'POST',
    url: apiPath(WEBHOOK_ROUTES.whatsapp, { channelId }),
    headers,
    payload: body,
    remoteAddress: META_IP,
  });
  expect(response.statusCode, response.body).toBe(200);
  for (const data of harness.webhookJobs.splice(0)) {
    await processWebhookJob(
      { name: WEBHOOK_JOBS.whatsappEvent, data, attemptsMade: 0, opts: { attempts: 8 } },
      { db: harness.db, logger: workerLogs.logger, publisher: publisher() },
    );
  }
}

/** Jalankan job kirim yang diantrekan api dengan worker produksi + Graph tiruan. */
async function drainSends() {
  const meta = createMetaGraphClient({
    version: 'v26.0',
    baseUrl: fake.url,
    sleep: () => Promise.resolve(),
  });
  const results = [];
  for (const job of harness.messageJobs.splice(0)) {
    results.push(
      await processSendMessageJob(
        {
          name: MESSAGE_JOBS.send,
          data: { organizationId: job.organizationId, messageId: job.messageId },
          attemptsMade: 0,
          opts: { attempts: 5 },
        },
        { db: harness.db, logger: workerLogs.logger, meta, secretBox: box, publisher: publisher() },
      ),
    );
  }
  return results;
}

async function conversationId(): Promise<string> {
  const [row] = await harness.db.select({ id: conversations.id }).from(conversations);
  if (!row) throw new Error('belum ada percakapan');
  return row.id;
}

function send(signed: SignedIn, conversation: string, body: unknown, csrf = true) {
  return call(
    harness.app,
    'POST',
    apiPath(API_ROUTES.inbox.messages, { conversationId: conversation }),
    body,
    { cookie: signed.cookie, ...(csrf ? { csrf: signed.csrf } : {}) },
  );
}

function multipart(filename: string, bytes: Buffer, contentType = 'application/octet-stream') {
  const boundary = `----balesin${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

function upload(signed: SignedIn, conversation: string, filename: string, bytes: Buffer) {
  const { payload, contentType } = multipart(filename, bytes, 'image/jpeg');
  return harness.app.inject({
    method: 'POST',
    url: apiPath(API_ROUTES.inbox.upload, { conversationId: conversation }),
    headers: {
      cookie: signed.cookie,
      origin: TEST_APP_ORIGIN,
      'x-csrf-token': signed.csrf,
      'content-type': contentType,
    },
    payload,
  });
}

async function messagesOf(conversation: string) {
  const response = await call(
    harness.app,
    'GET',
    `${apiPath(API_ROUTES.inbox.messages, { conversationId: conversation })}?limit=100`,
    undefined,
    { cookie: owner.cookie },
  );
  return messageListResponseSchema.parse(response.json()).messages;
}

async function signIn(role: 'cs' | 'teknisi'): Promise<SignedIn & { userId: string }> {
  const user = await insertUser(harness.db, organizationId, {
    role,
    email: `${role}.${newId().slice(-8)}@majujaya.test`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return {
    ...(await login(harness.app, { email: user.email, password: PASSWORD })),
    userId: user.id,
  };
}

beforeAll(async () => {
  fake = await startFakeMeta();
  harness = await createIntegrationHarness({
    config: { ...integrationConfig(), metaGraphBaseUrl: fake.url },
    overrides: { inboxStream: { heartbeatMs: 3_600_000, revalidateMs: 3_600_000 } },
  });
});
beforeEach(async () => {
  await harness.reset();
  fake.reset();
  fake.tokens.set(TOKEN, { appSecret: APP_SECRET });
  fake.phoneNumbers.set(PHONE, { id: PHONE, wabaId: FAKE_WEBHOOK_DEFAULTS.wabaId });
  const signed = await completeSetup(harness.app);
  owner = { ...signed, userId: signed.session.user.id };
  organizationId = signed.session.organization.id;
  channelId = await insertChannel();
});
afterAll(async () => {
  await harness?.close();
  await fake?.close();
});

describe('kirim teks ujung ke ujung', () => {
  it('kirim → worker → Meta tiruan → webhook sent/read → status maju + event WS', async () => {
    await receive(textMessageNotification({ body: 'Halo, internet mati' }));
    const conversation = await conversationId();

    const events: InboxStreamEvent[] = [];
    const socket = await harness.app.injectWS(API_ROUTES.inbox.stream, {
      headers: { cookie: owner.cookie, origin: TEST_APP_ORIGIN },
    });
    socket.on('message', (data: Buffer) => {
      events.push(inboxStreamEventSchema.parse(JSON.parse(data.toString('utf8'))));
    });

    const clientMessageId = randomUUID();
    const response = await send(owner, conversation, {
      type: 'text',
      clientMessageId,
      text: SECRET_REPLY,
    });
    expect(response.statusCode, response.body).toBe(202);
    const { message } = messageResponseSchema.parse(response.json());
    expect(message).toMatchObject({
      direction: 'outbound',
      senderKind: 'agent',
      senderUserId: owner.userId,
      status: 'pending',
      text: SECRET_REPLY,
      failure: null,
    });
    expect(harness.messageJobs).toEqual([{ organizationId, messageId: message.id, attempt: 1 }]);

    // Idempoten: permintaan yang sama tidak membuat pesan/job baru.
    const again = await send(owner, conversation, {
      type: 'text',
      clientMessageId,
      text: SECRET_REPLY,
    });
    expect(again.statusCode).toBe(200);
    expect(messageResponseSchema.parse(again.json()).message.id).toBe(message.id);
    expect(harness.messageJobs).toHaveLength(1);

    expect(await drainSends()).toMatchObject([{ status: 'sent' }]);
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]?.body).toMatchObject({
      to: FAKE_WEBHOOK_DEFAULTS.customerWaId,
      type: 'text',
      text: { body: SECRET_REPLY },
    });
    const wamid = fake.sentMessages[0]!.wamid;

    await receive(statusNotification({ wamid, status: 'sent' }));
    await receive(statusNotification({ wamid, status: 'read' }));
    await receive(statusNotification({ wamid, status: 'delivered' }));
    const outgoing = (await messagesOf(conversation)).find((row) => row.id === message.id);
    expect(outgoing?.status).toBe('read');

    const started = Date.now();
    while (
      !events.some((event) => event.type === 'message.status') &&
      Date.now() - started < 3000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['message.created', 'message.status', 'conversation.updated']),
    );
    expect(JSON.stringify(events)).not.toContain(SECRET_REPLY);
    socket.terminate();
    expect(harness.logs.text()).not.toContain(SECRET_REPLY);
    expect(workerLogs.text()).not.toContain(SECRET_REPLY);
  });

  it('di luar jendela 24 jam → 409 WINDOW_CLOSED, tidak ada pesan/job', async () => {
    await receive(textMessageNotification());
    const conversation = await conversationId();
    await harness.db
      .update(conversations)
      .set({ windowExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(conversations.id, conversation));
    const response = await send(owner, conversation, {
      type: 'text',
      clientMessageId: randomUUID(),
      text: 'x',
    });
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('WINDOW_CLOSED');
    expect(harness.messageJobs).toEqual([]);
  });

  it('CSRF wajib; Teknisi hanya percakapan yang di-assign (404 selain itu); ID asing 404', async () => {
    await receive(textMessageNotification());
    const conversation = await conversationId();
    const body = { type: 'text', clientMessageId: randomUUID(), text: 'x' };
    expect((await send(owner, conversation, body, false)).statusCode).toBe(403);

    const teknisi = await signIn('teknisi');
    expect(
      (await send(teknisi, conversation, { ...body, clientMessageId: randomUUID() })).statusCode,
    ).toBe(404);
    await harness.db
      .update(conversations)
      .set({ status: 'served', assigneeUserId: teknisi.userId })
      .where(eq(conversations.id, conversation));
    expect(
      (await send(teknisi, conversation, { ...body, clientMessageId: randomUUID() })).statusCode,
    ).toBe(202);
    expect(
      (await send(owner, newId(), { ...body, clientMessageId: randomUUID() })).statusCode,
    ).toBe(404);
  });

  it('Meta menolak (131026) → failed + penjelasan; kirim ulang → pending percobaan ke-2', async () => {
    await receive(textMessageNotification());
    const conversation = await conversationId();
    fake.failNext(`/${PHONE}/messages`, {
      status: 400,
      body: metaErrorBody(131026, 'Message undeliverable'),
    });
    const sent = await send(owner, conversation, {
      type: 'text',
      clientMessageId: randomUUID(),
      text: 'x',
    });
    const id = messageResponseSchema.parse(sent.json()).message.id;
    expect(await drainSends()).toMatchObject([
      { status: 'failed', reason: 'meta_rejected', errorCode: 131026 },
    ]);
    const failed = (await messagesOf(conversation)).find((row) => row.id === id);
    expect(failed?.failure).toMatchObject({
      reason: 'meta_rejected',
      code: 131026,
      retryable: true,
    });
    expect(failed?.failure?.message).toContain('kanal lain');

    const retry = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.retry, { messageId: id }),
      undefined,
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(retry.statusCode, retry.body).toBe(202);
    expect(messageResponseSchema.parse(retry.json()).message).toMatchObject({
      status: 'pending',
      failure: null,
    });
    expect(harness.messageJobs).toEqual([{ organizationId, messageId: id, attempt: 2 }]);
    expect(await drainSends()).toMatchObject([{ status: 'sent' }]);
    // Yang sudah berhasil tidak bisa "dikirim ulang".
    const twice = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.retry, { messageId: id }),
      undefined,
      {
        cookie: owner.cookie,
        csrf: owner.csrf,
      },
    );
    expect(twice.statusCode).toBe(409);
  });

  it('balas-kutip & reaksi ke pesan pelanggan; reaksi bukan emoji ditolak', async () => {
    await receive(textMessageNotification({ wamid: 'wamid.PELANGGAN1' }));
    const conversation = await conversationId();
    const [incoming] = await harness.db
      .select()
      .from(messages)
      .where(eq(messages.wamid, 'wamid.PELANGGAN1'));
    expect(
      (
        await send(owner, conversation, {
          type: 'reaction',
          clientMessageId: randomUUID(),
          targetMessageId: incoming!.id,
          emoji: 'ok',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await send(owner, conversation, {
          type: 'reaction',
          clientMessageId: randomUUID(),
          targetMessageId: incoming!.id,
          emoji: '👍',
        })
      ).statusCode,
    ).toBe(202);
    expect(
      (
        await send(owner, conversation, {
          type: 'text',
          clientMessageId: randomUUID(),
          text: 'Baik kak',
          replyToMessageId: incoming!.id,
        })
      ).statusCode,
    ).toBe(202);
    await drainSends();
    expect(fake.sentMessages.map((sent) => sent.body)).toEqual([
      expect.objectContaining({
        type: 'reaction',
        reaction: { message_id: 'wamid.PELANGGAN1', emoji: '👍' },
      }),
      expect.objectContaining({ type: 'text', context: { message_id: 'wamid.PELANGGAN1' } }),
    ]);
  });
});

describe('media', () => {
  it('unggah JPEG → Meta tiruan menerima berkas → kirim gambar memakai ID media', async () => {
    await receive(textMessageNotification());
    const conversation = await conversationId();
    const uploaded = await upload(owner, conversation, '../../foto\u202ekirim.jpg', JPEG);
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const { media } = uploadMediaResponseSchema.parse(uploaded.json());
    expect(media).toMatchObject({
      kind: 'image',
      mimeType: 'image/jpeg',
      filename: 'fotokirim.jpg',
      sizeBytes: JPEG.length,
    });
    const [stored] = await harness.db.select().from(mediaFiles).where(eq(mediaFiles.id, media.id));
    expect(fake.media.get(stored!.metaMediaRef!)?.bytes.equals(JPEG)).toBe(true);
    expect(stored?.storageKey).toMatch(/^uploads\/[0-9a-f-]{36}$/);

    const sent = await send(owner, conversation, {
      type: 'media',
      clientMessageId: randomUUID(),
      mediaId: media.id,
      caption: 'Bukti',
    });
    expect(sent.statusCode, sent.body).toBe(202);
    expect(messageResponseSchema.parse(sent.json()).message).toMatchObject({
      type: 'image',
      text: 'Bukti',
      mediaAvailable: true,
    });
    await drainSends();
    expect(fake.sentMessages[0]?.body).toMatchObject({
      type: 'image',
      image: { id: stored!.metaMediaRef, caption: 'Bukti' },
    });
  });

  it('isi bukan media yang didukung (SVG/HTML berkedok .jpg) → 415; tanpa berkas Meta', async () => {
    await receive(textMessageNotification());
    const conversation = await conversationId();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const response = await upload(owner, conversation, 'foto.jpg', svg);
    expect(response.statusCode).toBe(415);
    expect(fake.media.size).toBe(0);
  });

  it('unduh media masuk: CSRF wajib; dari host Meta tiruan; header aman; disimpan cache', async () => {
    fake.media.set('7770001', { bytes: JPEG, mimeType: 'text/html' });
    await receive(
      mediaMessageNotification('image', { mediaId: '7770001', caption: 'Bukti transfer' }),
    );
    const [incoming] = await harness.db.select().from(messages).where(eq(messages.type, 'image'));
    const url = apiPath(API_ROUTES.inbox.media, { messageId: incoming!.id });

    expect(
      (await call(harness.app, 'GET', url, undefined, { cookie: owner.cookie })).statusCode,
    ).toBe(403);
    const response = await call(harness.app, 'GET', url, undefined, {
      cookie: owner.cookie,
      csrf: owner.csrf,
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.rawPayload.equals(JPEG)).toBe(true);
    // Content-Type dari hasil deteksi isi, BUKAN dari Meta (`text/html`).
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.headers['content-disposition']).toMatch(/^inline/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain('sandbox');

    // Kedua kali dari cache (tanpa panggilan Meta baru).
    const before = fake.requests.length;
    await call(harness.app, 'GET', url, undefined, { cookie: owner.cookie, csrf: owner.csrf });
    expect(fake.requests.length).toBe(before);
  });

  it('media masuk tak dikenali (HTML) → attachment octet-stream; nama berkas RFC 5987', async () => {
    fake.media.set('7770002', {
      bytes: Buffer.from('<html><script>alert(1)</script>'),
      mimeType: 'text/html',
    });
    await receive(
      mediaMessageNotification('document', {
        mediaId: '7770002',
        filename: 'laporan "akhir" ü.html',
      }),
    );
    const [incoming] = await harness.db
      .select()
      .from(messages)
      .where(eq(messages.type, 'document'));
    const response = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.media, { messageId: incoming!.id }),
      undefined,
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    const disposition = String(response.headers['content-disposition']);
    expect(disposition).toMatch(
      /^attachment; filename="laporan _akhir_ _.html"; filename\*=UTF-8''/,
    );
    expect(disposition).toContain('%C3%BC');
  });

  it('pembersih: salinan kedaluwarsa dihapus dari disk dan ditandai', async () => {
    fake.media.set('7770003', { bytes: JPEG, mimeType: 'image/jpeg' });
    await receive(mediaMessageNotification('image', { mediaId: '7770003' }));
    const [incoming] = await harness.db.select().from(messages).where(eq(messages.type, 'image'));
    await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.media, { messageId: incoming!.id }),
      undefined,
      {
        cookie: owner.cookie,
        csrf: owner.csrf,
      },
    );
    await harness.db.update(mediaFiles).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await harness.app.outbound.purgeExpiredMedia()).toBeGreaterThanOrEqual(1);
    const [file] = await harness.db.select().from(mediaFiles);
    expect(file).toMatchObject({ storageKey: null });
    expect(file?.deletedAt).toBeInstanceOf(Date);
  });
});
