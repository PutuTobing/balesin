/**
 * Antrian `messages` (kirim pesan keluar, Fase 2 butir 6) — Postgres sungguhan, klien Graph
 * tiruan di memori (merekam payload; bisa melempar `MetaApiError`).
 */
import { randomBytes } from 'node:crypto';

import {
  MESSAGE_JOBS,
  MetaApiError,
  Secret,
  createSecretBox,
  sealChannelSecret,
  splitWhatsAppWebhook,
  type InboxBusEventInput,
  type MetaGraphClient,
  type MetaRequest,
} from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import {
  channels,
  closeDb,
  contacts,
  conversations,
  createDb,
  mediaFiles,
  messages,
  newId,
  organizations,
  users,
  webhookEvents,
  type Database,
  type NewMessageRow,
} from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import { UnrecoverableError } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { markStaleSendClaims } from './maintenance';
import { processSendMessageJob } from './messages';

const box = createSecretBox(new Secret(randomBytes(32)));
const SECRET_TEXT = 'BALASAN-AGEN-RAHASIA-5512';
const PHONE_ID = '106540352242922';

let db: Database;
let organizationId: string;
let channelId: string;
let contactId: string;
let conversationId: string;
let agentId: string;
const logs = createLogCapture();

interface StubMeta {
  client: MetaGraphClient;
  sent: Array<{ path: readonly string[]; body: Record<string, unknown> | undefined }>;
}

function stubMeta(
  outcome: () => unknown = () => ({
    messages: [{ id: `wamid.OUT${randomBytes(4).toString('hex')}` }],
  }),
): StubMeta {
  const sent: StubMeta['sent'] = [];
  return {
    sent,
    client: {
      version: 'v26.0',
      async request<T>(_credentials: unknown, request: MetaRequest<T>): Promise<T> {
        sent.push({ path: request.path, body: request.body });
        return request.schema.parse(await outcome());
      },
      download: () => Promise.reject(new Error('tidak dipakai')),
    },
  };
}

beforeAll(() => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-worker-messages' });
}, 30_000);
afterAll(async () => {
  if (db) await closeDb(db);
}, 30_000);

beforeEach(async () => {
  organizationId = (await insertOrganization(db)).id;
  channelId = newId();
  const owner = { id: channelId, organizationId };
  await db.insert(channels).values({
    id: channelId,
    organizationId,
    type: 'whatsapp',
    name: 'CS',
    waPhoneNumberId: PHONE_ID,
    waBusinessAccountId: '102290129340398',
    waAccessTokenEncrypted: sealChannelSecret(box, owner, 'accessToken', 'EAAtoken'),
    waAppSecretEncrypted: sealChannelSecret(box, owner, 'appSecret', 'rahasia-app'),
    waVerifyTokenEncrypted: sealChannelSecret(box, owner, 'verifyToken', 'verify'),
    waVerifyTokenRotatedAt: new Date(),
  });
  const [contact] = await db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'whatsapp',
      waBsuid: `ID.${newId().slice(-6)}`,
      phone: '+6281234567890',
    })
    .returning();
  contactId = contact!.id;
  const now = Date.now();
  const [conversation] = await db
    .insert(conversations)
    .values({
      organizationId,
      contactId,
      channelId,
      status: 'served',
      lastMessageAt: new Date(now),
      lastInboundAt: new Date(now - 60_000),
      windowExpiresAt: new Date(now + 23 * 60 * 60 * 1000),
    })
    .returning();
  conversationId = conversation!.id;
  agentId = (await insertUser(db, organizationId, { role: 'cs' })).id;
});

async function outbound(overrides: Partial<NewMessageRow> = {}) {
  const [row] = await db
    .insert(messages)
    .values({
      organizationId,
      conversationId,
      contactId,
      channelId,
      direction: 'outbound',
      senderKind: 'agent',
      senderUserId: agentId,
      type: 'text',
      text: SECRET_TEXT,
      status: 'pending',
      sendAttempts: 1,
      occurredAt: new Date(),
      ...overrides,
    })
    .returning();
  return row!;
}

function run(
  messageId: string,
  meta: MetaGraphClient,
  extra: {
    attemptsMade?: number;
    attempts?: number;
    publisher?: (events: readonly InboxBusEventInput[]) => void;
  } = {},
) {
  return processSendMessageJob(
    {
      name: MESSAGE_JOBS.send,
      data: { organizationId, messageId },
      attemptsMade: extra.attemptsMade ?? 0,
      opts: { attempts: extra.attempts ?? 5 },
    },
    {
      db,
      logger: logs.logger,
      meta,
      secretBox: box,
      publisher: {
        publish: (events) => {
          extra.publisher?.(events);
          return Promise.resolve();
        },
      },
    },
  );
}

const rowOf = async (id: string) =>
  (await db.select().from(messages).where(eq(messages.id, id)))[0];

describe('kirim pesan keluar', () => {
  it('teks + balas-kutip → payload Meta benar, wamid tersimpan, status tetap pending, event terbit', async () => {
    const [quoted] = await db
      .insert(messages)
      .values({
        organizationId,
        conversationId,
        contactId,
        channelId,
        direction: 'inbound',
        senderKind: 'customer',
        type: 'text',
        wamid: 'wamid.MASUK1',
        text: 'halo',
        occurredAt: new Date(),
      })
      .returning();
    const message = await outbound({ replyToMessageId: quoted!.id, replyToWamid: 'wamid.MASUK1' });
    const meta = stubMeta();
    const published: InboxBusEventInput[] = [];
    const result = await run(message.id, meta.client, {
      publisher: (events) => published.push(...events),
    });
    expect(result.status).toBe('sent');
    expect(meta.sent).toHaveLength(1);
    expect(meta.sent[0]?.path).toEqual([PHONE_ID, 'messages']);
    expect(meta.sent[0]?.body).toMatchObject({
      to: '6281234567890',
      type: 'text',
      text: { body: SECRET_TEXT },
      context: { message_id: 'wamid.MASUK1' },
    });
    const row = await rowOf(message.id);
    expect(row).toMatchObject({ status: 'pending', failureReason: null });
    expect(row?.wamid).toMatch(/^wamid\.OUT/);
    expect(published.map((event) => event.type)).toEqual([
      'message.status',
      'conversation.updated',
    ]);
    expect(logs.text()).not.toContain(SECRET_TEXT);
    expect(logs.text()).not.toContain('6281234567890');

    // Job ganda / setelah diterima Meta tidak mengirim lagi.
    expect(await run(message.id, meta.client)).toEqual({
      status: 'skipped',
      reason: 'not_pending',
    });
    expect(meta.sent).toHaveLength(1);
  });

  it('status webhook yang datang SEBELUM wamid tersimpan diputar ulang', async () => {
    const message = await outbound();
    const wamid = 'wamid.CEPAT1';
    const notification = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: PHONE_ID },
                statuses: ['sent', 'delivered'].map((status) => ({
                  id: wamid,
                  status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: '6281234567890',
                })),
              },
            },
          ],
        },
      ],
    };
    const { items } = splitWhatsAppWebhook(notification);
    await db.insert(webhookEvents).values(
      items.map((item) => ({
        organizationId,
        channelId,
        source: 'whatsapp' as const,
        kind: item.kind,
        field: item.field,
        dedupKey: item.dedupKey,
        externalId: item.externalId,
        payload: item.payload as unknown as Record<string, unknown>,
        occurredAt: item.occurredAt,
        status: 'processed' as const,
        processedAt: new Date(),
      })),
    );
    await run(message.id, stubMeta(() => ({ messages: [{ id: wamid }] })).client);
    expect(await rowOf(message.id)).toMatchObject({ wamid, status: 'delivered' });
  });

  it('pemeriksaan ulang saat kirim: jendela lewat / channel nonaktif / pengirim nonaktif / Teknisi bukan agen / tanpa nomor', async () => {
    const meta = stubMeta();
    const cases: Array<[string, () => Promise<unknown>, string]> = [
      [
        'jendela',
        () =>
          db
            .update(conversations)
            .set({ windowExpiresAt: new Date(Date.now() - 1000) })
            .where(eq(conversations.id, conversationId)),
        'window_closed',
      ],
      [
        'channel',
        () => db.update(channels).set({ enabled: false }).where(eq(channels.id, channelId)),
        'channel_unavailable',
      ],
      [
        'pengirim',
        () => db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, agentId)),
        'sender_not_allowed',
      ],
      [
        'teknisi',
        () => db.update(users).set({ role: 'teknisi' }).where(eq(users.id, agentId)),
        'sender_not_allowed',
      ],
      [
        'nomor',
        () => db.update(contacts).set({ phone: null }).where(eq(contacts.id, contactId)),
        'recipient_unavailable',
      ],
    ];
    for (const [label, breakIt, reason] of cases) {
      const message = await outbound();
      await breakIt();
      expect(await run(message.id, meta.client), label).toMatchObject({ status: 'failed', reason });
      expect(await rowOf(message.id), label).toMatchObject({
        status: 'failed',
        failureReason: reason,
      });
      // Pulihkan untuk kasus berikutnya.
      await db
        .update(conversations)
        .set({ windowExpiresAt: new Date(Date.now() + 60 * 60 * 1000) })
        .where(eq(conversations.id, conversationId));
      await db.update(channels).set({ enabled: true }).where(eq(channels.id, channelId));
      await db.update(users).set({ disabledAt: null, role: 'cs' }).where(eq(users.id, agentId));
      await db.update(contacts).set({ phone: '+6281234567890' }).where(eq(contacts.id, contactId));
    }
    expect(meta.sent).toEqual([]);
  });

  it('Teknisi yang menjadi agen percakapan boleh mengirim', async () => {
    await db.update(users).set({ role: 'teknisi' }).where(eq(users.id, agentId));
    await db
      .update(conversations)
      .set({ assigneeUserId: agentId })
      .where(eq(conversations.id, conversationId));
    const message = await outbound();
    expect((await run(message.id, stubMeta().client)).status).toBe('sent');
  });

  it('penolakan Meta: kode disimpan; batas laju diulang BullMQ kecuali percobaan terakhir; koneksi putus = delivery_unknown', async () => {
    const rejected = await outbound();
    const reject = stubMeta(() => {
      throw new MetaApiError({ kind: 'unknown', metaCode: 131026, operation: 'message.send' });
    });
    expect(await run(rejected.id, reject.client)).toMatchObject({
      status: 'failed',
      reason: 'meta_rejected',
      errorCode: 131026,
    });

    const limited = await outbound();
    const rateLimited = stubMeta(() => {
      throw new MetaApiError({
        kind: 'rate_limited',
        retryable: true,
        metaCode: 130429,
        operation: 'message.send',
      });
    });
    await expect(run(limited.id, rateLimited.client, { attemptsMade: 0 })).rejects.toThrow();
    expect((await rowOf(limited.id))?.status).toBe('pending');
    expect(await run(limited.id, rateLimited.client, { attemptsMade: 4 })).toMatchObject({
      status: 'failed',
      reason: 'meta_rejected',
      errorCode: 130429,
    });

    const unknown = await outbound();
    const network = stubMeta(() => {
      throw new MetaApiError({ kind: 'network_error', retryable: true, operation: 'message.send' });
    });
    expect(await run(unknown.id, network.client)).toMatchObject({
      status: 'failed',
      reason: 'delivery_unknown',
    });
  });

  it('media: dikirim dengan ID media Meta; media kedaluwarsa = media_unavailable', async () => {
    const [file] = await db
      .insert(mediaFiles)
      .values({
        organizationId,
        channelId,
        source: 'upload',
        kind: 'document',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
        filename: 'tagihan.pdf',
        storageKey: `uploads/${newId()}`,
        metaMediaRef: '9000000001',
        uploadedByUserId: agentId,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    const message = await outbound({ type: 'document', text: 'Tagihan', mediaFileId: file!.id });
    const meta = stubMeta();
    await run(message.id, meta.client);
    expect(meta.sent[0]?.body).toMatchObject({
      type: 'document',
      document: { id: '9000000001', caption: 'Tagihan', filename: 'tagihan.pdf' },
    });

    await db
      .update(mediaFiles)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(mediaFiles.id, file!.id));
    const expired = await outbound({ type: 'document', mediaFileId: file!.id });
    expect(await run(expired.id, meta.client)).toMatchObject({ reason: 'media_unavailable' });
  });

  it('kredensial tak bisa dibuka → credentials_unavailable; payload rusak → gagal permanen', async () => {
    const message = await outbound();
    const result = await processSendMessageJob(
      { name: MESSAGE_JOBS.send, data: { organizationId, messageId: message.id } },
      { db, logger: logs.logger, meta: stubMeta().client, secretBox: null },
    );
    expect(result).toMatchObject({ status: 'failed', reason: 'credentials_unavailable' });
    await expect(
      processSendMessageJob(
        { name: MESSAGE_JOBS.send, data: { messageId: 'x' } },
        { db, logger: logs.logger, meta: stubMeta().client, secretBox: box },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});

describe('review ruang chat R2/R3/S2', () => {
  it('R3: klaim tanpa wamid (percobaan sebelumnya terhenti) → delivery_unknown, Meta tidak dipanggil lagi', async () => {
    const message = await outbound({ sendClaimedAt: new Date(Date.now() - 3 * 60_000) });
    const meta = stubMeta();
    expect(await run(message.id, meta.client)).toMatchObject({
      status: 'failed',
      reason: 'delivery_unknown',
    });
    expect(meta.sent).toEqual([]);
  });

  it('R5: klaim yang masih baru (percobaan lain sedang memanggil Meta) → dilewati, tetap pending', async () => {
    const message = await outbound({ sendClaimedAt: new Date(Date.now() - 30_000) });
    const meta = stubMeta();
    expect(await run(message.id, meta.client)).toEqual({
      status: 'skipped',
      reason: 'not_pending',
    });
    expect(meta.sent).toEqual([]);
    const [row] = await db.select().from(messages).where(eq(messages.id, message.id));
    expect(row?.status).toBe('pending');
  });

  it('R5: Meta menerima setelah pesan ditandai delivery_unknown → wamid disimpan, status sent', async () => {
    const message = await outbound();
    const meta = stubMeta(async () => {
      // Pemeriksa klaim macet menandai pesan SELAGI panggilan Meta berjalan.
      await db
        .update(messages)
        .set({ status: 'failed', failureReason: 'delivery_unknown' })
        .where(eq(messages.id, message.id));
      return { messages: [{ id: 'wamid.PULIH01' }] };
    });
    expect(await run(message.id, meta.client)).toMatchObject({ status: 'sent' });
    const [row] = await db.select().from(messages).where(eq(messages.id, message.id));
    expect(row).toMatchObject({ status: 'sent', wamid: 'wamid.PULIH01', failureReason: null });
  });

  it('R5: pemeriksa berkala hanya menandai klaim yang lebih tua dari batas', async () => {
    const stale = await outbound({ sendClaimedAt: new Date(Date.now() - 3 * 60_000) });
    const fresh = await outbound({ sendClaimedAt: new Date(Date.now() - 30_000) });
    const published: InboxBusEventInput[] = [];
    const count = await markStaleSendClaims(db, {
      publisher: {
        publish: (events) => {
          published.push(...events);
          return Promise.resolve();
        },
      },
    });
    expect(count).toBeGreaterThanOrEqual(1);
    const rows = await db
      .select({ id: messages.id, status: messages.status, reason: messages.failureReason })
      .from(messages)
      .where(inArray(messages.id, [stale.id, fresh.id]));
    expect(rows.find((row) => row.id === stale.id)).toMatchObject({
      status: 'failed',
      reason: 'delivery_unknown',
    });
    expect(rows.find((row) => row.id === fresh.id)?.status).toBe('pending');
    expect(published).toContainEqual(
      expect.objectContaining({ type: 'message.status', messageId: stale.id }),
    );
  });

  it('R3: dua job bersamaan untuk pesan yang sama → Meta dipanggil SEKALI', async () => {
    const message = await outbound();
    const meta = stubMeta();
    await Promise.all([run(message.id, meta.client), run(message.id, meta.client)]);
    expect(meta.sent).toHaveLength(1);
  });

  it('S2: rem darurat ditarik → sending_paused tanpa memanggil Meta', async () => {
    await db
      .update(organizations)
      .set({ sendingPausedAt: new Date() })
      .where(eq(organizations.id, organizationId));
    const message = await outbound();
    const meta = stubMeta();
    expect(await run(message.id, meta.client)).toMatchObject({ reason: 'sending_paused' });
    expect(meta.sent).toEqual([]);
  });

  it('R2: yang diperiksa saat kirim ulang = penekan "Kirim ulang" (lastSentBy), bukan penulis', async () => {
    const other = (await insertUser(db, organizationId, { role: 'cs' })).id;
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, agentId));
    const message = await outbound({ lastSentByUserId: other });
    expect((await run(message.id, stubMeta().client)).status).toBe('sent');
    const disabledResender = await outbound({ lastSentByUserId: agentId, senderUserId: other });
    expect(await run(disabledResender.id, stubMeta().client)).toMatchObject({
      reason: 'sender_not_allowed',
    });
  });
});
