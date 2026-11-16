/**
 * Pesan masuk → kontak, percakapan, pesan; status pesan keluar (Fase 2 butir 4) — Postgres
 * sungguhan. Kejadian disusun dari notifikasi contoh lewat `splitWhatsAppWebhook` (sama dengan
 * penerima di api), lalu job berisi ID saja diproses `processWebhookJob` dengan pemroses bawaan.
 */
import { randomBytes } from 'node:crypto';

import { splitWhatsAppWebhook, WEBHOOK_JOBS } from '@balesin/core';
import { createLogCapture, type LogCapture } from '@balesin/core/testing';
import {
  channels,
  closeDb,
  contacts,
  conversations,
  createDb,
  messages,
  newId,
  webhookEvents,
  type Database,
  type NewWebhookEvent,
} from '@balesin/db';
import { insertOrganization } from '@balesin/db/testing';
import { CUSTOMER_SERVICE_WINDOW_MS } from '@balesin/shared';
import { UnrecoverableError } from 'bullmq';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { processWebhookJob } from '../queues/webhooks';
import { countsAsCustomerMessage, inboundOccurredAt, messageTypeOf } from './handlers';

const WABA = '102290129340398';
const PHONE_NUMBER_ID = '106540352242922';
const SECRET_TEXT = 'ISI-PESAN-PELANGGAN-RAHASIA-7731';
const CUSTOMER_NAME = 'Budi Rahasia Santoso';

let db: Database;
let logs: LogCapture;
let organizationId: string;
let channelId: string;

beforeAll(() => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-worker-inbound' });
}, 30_000);

afterAll(async () => {
  if (db) await closeDb(db);
}, 30_000);

beforeEach(async () => {
  logs = createLogCapture();
  organizationId = (await insertOrganization(db)).id;
  channelId = newId();
  await db.insert(channels).values({
    id: channelId,
    organizationId,
    type: 'whatsapp',
    name: 'CS Utama',
    waPhoneNumberId: PHONE_NUMBER_ID,
    waBusinessAccountId: WABA,
    waAccessTokenEncrypted: 'tiruan',
    waAppSecretEncrypted: 'tiruan',
    waVerifyTokenEncrypted: 'tiruan',
    waVerifyTokenRotatedAt: new Date(),
  });
});

const wamid = () => `wamid.${randomBytes(12).toString('hex')}`;
const unix = (date: Date) => String(Math.floor(date.getTime() / 1000));

interface Customer {
  waId?: string | null;
  userId?: string | null;
  name?: string;
}

function messageNotification(
  message: Record<string, unknown>,
  customer: Customer = {},
): Record<string, unknown> {
  const waId = customer.waId === undefined ? '6281234567890' : customer.waId;
  const userId = customer.userId === undefined ? 'ID.1001' : customer.userId;
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '6281100001111', phone_number_id: PHONE_NUMBER_ID },
              contacts: [
                {
                  profile: { name: customer.name ?? CUSTOMER_NAME },
                  ...(waId === null ? {} : { wa_id: waId }),
                  ...(userId === null ? {} : { user_id: userId }),
                },
              ],
              messages: [
                {
                  ...(waId === null ? {} : { from: waId }),
                  ...(userId === null ? {} : { from_user_id: userId }),
                  id: wamid(),
                  timestamp: unix(new Date()),
                  type: 'text',
                  text: { body: SECRET_TEXT },
                  ...message,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function statusNotification(target: string, status: string, errorCode?: number) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '6281100001111', phone_number_id: PHONE_NUMBER_ID },
              statuses: [
                {
                  id: target,
                  status,
                  timestamp: unix(new Date()),
                  recipient_id: '6281234567890',
                  ...(errorCode ? { errors: [{ code: errorCode, title: 'gagal' }] } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Simpan kejadian notifikasi (seperti penerima api) lalu proses job-nya; hasil job per kejadian. */
async function deliver(
  body: unknown,
  overrides: Partial<NewWebhookEvent> = {},
): Promise<{ eventIds: string[]; results: Awaited<ReturnType<typeof processWebhookJob>>[] }> {
  const { items } = splitWhatsAppWebhook(body);
  const rows = await db
    .insert(webhookEvents)
    .values(
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
        ...overrides,
      })),
    )
    .returning();
  const results = [];
  for (const row of rows) results.push(await process(row.id));
  return { eventIds: rows.map((row) => row.id), results };
}

function process(eventId: string) {
  return processWebhookJob(
    {
      name: WEBHOOK_JOBS.whatsappEvent,
      data: { organizationId, eventId },
      attemptsMade: 0,
      opts: { attempts: 3 },
    },
    { db, logger: logs.logger },
  );
}

const contactRows = () =>
  db
    .select()
    .from(contacts)
    .where(eq(contacts.organizationId, organizationId))
    .orderBy(asc(contacts.number));
const conversationRows = () =>
  db
    .select()
    .from(conversations)
    .where(eq(conversations.organizationId, organizationId))
    .orderBy(asc(conversations.number));
const messageRows = () =>
  db
    .select()
    .from(messages)
    .where(eq(messages.organizationId, organizationId))
    .orderBy(asc(messages.number));
async function eventRow(id: string) {
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, id));
  return row;
}

async function outboundMessage(
  conversationId: string,
  contactId: string,
  status: 'pending' | 'sent' = 'sent',
) {
  const id = wamid();
  await db.insert(messages).values({
    organizationId,
    conversationId,
    contactId,
    channelId,
    direction: 'outbound',
    senderKind: 'agent',
    type: 'text',
    wamid: id,
    text: 'Balasan agen',
    status,
    occurredAt: new Date(),
  });
  return id;
}

describe('pesan masuk pertama', () => {
  it('membuat kontak, percakapan "Belum dilayani", pesan, dan jendela 24 jam dari jam server', async () => {
    const receivedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    // Cap waktu Meta 3 jam "di depan" jam server: tidak dipakai untuk jendela (R4).
    const metaTime = new Date(receivedAt.getTime() + 3 * 60 * 60 * 1000);
    const { eventIds, results } = await deliver(
      messageNotification({ timestamp: unix(metaTime) }, { name: '  Budi\u202e Santoso ' }),
      { receivedAt },
    );
    expect(results).toEqual([{ status: 'processed' }]);

    const [contact] = await contactRows();
    expect(contact).toMatchObject({
      channelType: 'whatsapp',
      waBsuid: 'ID.1001',
      phone: '+6281234567890',
      profileName: 'Budi Santoso',
      name: null,
    });
    expect(contact?.number).toBeGreaterThan(0);

    const [conversation] = await conversationRows();
    expect(conversation).toMatchObject({
      contactId: contact?.id,
      channelId,
      status: 'unserved',
      assigneeUserId: null,
      unreadCount: 1,
      resolvedAt: null,
    });
    expect(conversation?.lastInboundAt?.getTime()).toBe(receivedAt.getTime());
    expect(conversation?.windowExpiresAt?.getTime()).toBe(
      receivedAt.getTime() + CUSTOMER_SERVICE_WINDOW_MS,
    );
    expect(conversation?.lastMessageAt.getTime()).toBe(receivedAt.getTime());

    const [message] = await messageRows();
    expect(message).toMatchObject({
      conversationId: conversation?.id,
      contactId: contact?.id,
      direction: 'inbound',
      senderKind: 'customer',
      type: 'text',
      rawType: 'text',
      text: SECRET_TEXT,
      status: null,
    });
    // Urutan tampilan: cap waktu Meta dijepit ke ≤ waktu diterima.
    expect(message?.occurredAt.getTime()).toBe(receivedAt.getTime());

    const event = await eventRow(eventIds[0]!);
    expect(event).toMatchObject({ status: 'processed', contactId: contact?.id });

    // Tanpa isi pesan / nomor / nama pelanggan di log.
    const text = logs.text();
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain('6281234567890');
    expect(text).not.toContain('Santoso');
  });

  it('percakapan baru: titik kait bot dipakai bila diisi', async () => {
    const { items } = splitWhatsAppWebhook(messageNotification({}));
    const [row] = await db
      .insert(webhookEvents)
      .values({
        organizationId,
        channelId,
        source: 'whatsapp',
        kind: items[0]!.kind,
        field: items[0]!.field,
        dedupKey: items[0]!.dedupKey,
        externalId: items[0]!.externalId,
        payload: items[0]!.payload as unknown as Record<string, unknown>,
        occurredAt: items[0]!.occurredAt,
      })
      .returning();
    const { createInboundHandlers } = await import('./handlers');
    await processWebhookJob(
      { name: WEBHOOK_JOBS.whatsappEvent, data: { organizationId, eventId: row!.id } },
      {
        db,
        logger: logs.logger,
        handlers: createInboundHandlers({ initialConversationStatus: () => 'bot' }),
      },
    );
    expect((await conversationRows()).map((row) => row.status)).toEqual(['bot']);
  });
});

describe('idempotensi', () => {
  it('job ganda dan wamid yang sama di kejadian lain tidak menggandakan pesan/penghitung', async () => {
    const id = wamid();
    const { eventIds } = await deliver(messageNotification({ id }));
    expect(await process(eventIds[0]!)).toEqual({ status: 'skipped', reason: 'already_done' });

    // Kejadian kedua dengan wamid sama (mis. kunci dedup berbeda karena versi lama).
    await deliver(messageNotification({ id }), { dedupKey: `m:${id}:salinan` });

    expect(await messageRows()).toHaveLength(1);
    expect((await conversationRows())[0]?.unreadCount).toBe(1);
  });
});

describe('jendela 24 jam & penghitung', () => {
  it('pesan berikutnya memperpanjang jendela; kejadian yang terlambat diproses tidak memundurkannya', async () => {
    const first = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const later = new Date(Date.now() - 60 * 60 * 1000);
    const earlier = new Date(Date.now() - 10 * 60 * 60 * 1000);
    await deliver(messageNotification({}), { receivedAt: first });
    await deliver(messageNotification({}), { receivedAt: later });
    await deliver(messageNotification({}), { receivedAt: earlier });

    const [conversation] = await conversationRows();
    expect(await conversationRows()).toHaveLength(1);
    expect(conversation?.unreadCount).toBe(3);
    expect(conversation?.lastInboundAt?.getTime()).toBe(later.getTime());
    expect(conversation?.windowExpiresAt?.getTime()).toBe(
      later.getTime() + CUSTOMER_SERVICE_WINDOW_MS,
    );
    expect(conversation?.lastMessageAt.getTime()).toBe(later.getTime());
  });

  it('percakapan "Selesai" + pesan baru → percakapan BARU (sesi baru), yang lama tetap selesai', async () => {
    await deliver(messageNotification({}));
    const [old] = await conversationRows();
    await db
      .update(conversations)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(eq(conversations.id, old!.id));

    await deliver(messageNotification({}));
    const rows = await conversationRows();
    expect(rows.map((row) => row.status)).toEqual(['resolved', 'unserved']);
    expect(rows[1]?.number).toBeGreaterThan(rows[0]!.number);
    expect(rows[1]?.contactId).toBe(rows[0]?.contactId);
    expect(rows[1]?.unreadCount).toBe(1);
    expect(await contactRows()).toHaveLength(1);
  });
});

describe('identitas kontak', () => {
  it('hanya BSUID (username tanpa nomor), lalu nomor menyusul → kontak yang sama dilengkapi', async () => {
    await deliver(messageNotification({}, { waId: null, userId: 'ID.2002' }));
    expect(await contactRows()).toMatchObject([{ waBsuid: 'ID.2002', phone: null }]);

    await deliver(messageNotification({}, { waId: '6285550001111', userId: 'ID.2002' }));
    expect(await contactRows()).toMatchObject([{ waBsuid: 'ID.2002', phone: '+6285550001111' }]);
    expect(await conversationRows()).toHaveLength(1);
  });

  it('hanya nomor (tanpa BSUID), lalu BSUID menyusul → kontak yang sama dilengkapi', async () => {
    await deliver(messageNotification({}, { waId: '6285550002222', userId: null }));
    expect(await contactRows()).toMatchObject([{ waBsuid: null, phone: '+6285550002222' }]);

    await deliver(messageNotification({}, { waId: '6285550002222', userId: 'ID.3003' }));
    expect(await contactRows()).toMatchObject([{ waBsuid: 'ID.3003', phone: '+6285550002222' }]);
  });

  it('pelanggan ganti nomor (BSUID sama) → nomor kontak diperbarui', async () => {
    await deliver(messageNotification({}, { waId: '6285550003333', userId: 'ID.4004' }));
    await deliver(messageNotification({}, { waId: '6285550004444', userId: 'ID.4004' }));
    expect(await contactRows()).toMatchObject([{ waBsuid: 'ID.4004', phone: '+6285550004444' }]);
  });

  it('nomor didaur ulang ke orang lain (BSUID berbeda) → kontak baru; nomor dilepas dari yang lama', async () => {
    await deliver(messageNotification({}, { waId: '6285550005555', userId: 'ID.5005' }));
    await deliver(messageNotification({}, { waId: '6285550005555', userId: 'ID.6006' }));
    const rows = await contactRows();
    expect(rows).toMatchObject([
      { waBsuid: 'ID.5005', phone: null },
      { waBsuid: 'ID.6006', phone: '+6285550005555' },
    ]);
    expect(await conversationRows()).toHaveLength(2);
  });

  it('kontak hanya-nomor lama + kontak BSUID berbeda dengan nomor itu → tidak digabung otomatis', async () => {
    await deliver(messageNotification({}, { waId: '6285550006666', userId: null }));
    await deliver(messageNotification({}, { waId: null, userId: 'ID.7007' }));
    await deliver(messageNotification({}, { waId: '6285550006666', userId: 'ID.7007' }));
    expect(await contactRows()).toMatchObject([
      { waBsuid: null, phone: '+6285550006666' },
      { waBsuid: 'ID.7007', phone: null },
    ]);
  });

  it('nama profil baru memperbarui profile_name, tidak menimpa nama dari tim', async () => {
    await deliver(messageNotification({}, { name: 'Nama Lama' }));
    await db
      .update(contacts)
      .set({ name: '1500040SUWANTO@KWSN' })
      .where(eq(contacts.organizationId, organizationId));
    await deliver(messageNotification({}, { name: 'Nama Baru' }));
    expect(await contactRows()).toMatchObject([
      { name: '1500040SUWANTO@KWSN', profileName: 'Nama Baru' },
    ]);
  });

  it('pengenal pengirim tidak sah → gagal permanen tanpa membuat apa pun', async () => {
    const body = messageNotification({}, { waId: 'bukan-nomor', userId: 'bsuid tidak sah' });
    const { items } = splitWhatsAppWebhook(body);
    const [row] = await db
      .insert(webhookEvents)
      .values({
        organizationId,
        channelId,
        source: 'whatsapp',
        kind: 'message',
        field: 'messages',
        dedupKey: items[0]!.dedupKey,
        externalId: items[0]!.externalId,
        payload: items[0]!.payload as unknown as Record<string, unknown>,
        occurredAt: items[0]!.occurredAt,
      })
      .returning();
    await expect(process(row!.id)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await eventRow(row!.id)).toMatchObject({
      status: 'failed',
      lastError: 'WebhookPayloadError',
    });
    expect(await contactRows()).toEqual([]);
  });

  it('dua pesan pertama dari pelanggan baru diproses bersamaan → satu kontak, satu percakapan', async () => {
    const bodies = Array.from({ length: 6 }, () => messageNotification({}, { userId: 'ID.8008' }));
    const stored = [];
    for (const body of bodies) {
      const { items } = splitWhatsAppWebhook(body);
      const [row] = await db
        .insert(webhookEvents)
        .values({
          organizationId,
          channelId,
          source: 'whatsapp',
          kind: 'message',
          field: 'messages',
          dedupKey: items[0]!.dedupKey,
          externalId: items[0]!.externalId,
          payload: items[0]!.payload as unknown as Record<string, unknown>,
          occurredAt: items[0]!.occurredAt,
        })
        .returning();
      stored.push(row!.id);
    }
    const results = await Promise.all(stored.map((id) => process(id)));
    expect(results.every((result) => result.status === 'processed')).toBe(true);
    expect(await contactRows()).toHaveLength(1);
    expect(await conversationRows()).toHaveLength(1);
    expect(await messageRows()).toHaveLength(6);
    expect((await conversationRows())[0]?.unreadCount).toBe(6);
  });
});

describe('jenis pesan', () => {
  it('gambar: metadata media (ID media Meta saja) + keterangan sebagai teks', async () => {
    await deliver(
      messageNotification({
        type: 'image',
        text: undefined,
        image: {
          id: '1003383421387256',
          mime_type: 'image/jpeg',
          sha256: 'abc=',
          caption: 'Bukti transfer',
        },
      }),
    );
    expect(await messageRows()).toMatchObject([
      {
        type: 'image',
        text: 'Bukti transfer',
        media: {
          kind: 'image',
          metaMediaId: '1003383421387256',
          mimeType: 'image/jpeg',
          voice: false,
        },
      },
    ]);
  });

  it('balas-kutip & reaksi ditautkan ke pesan sasaran; reaksi tidak memperpanjang jendela', async () => {
    const first = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await deliver(messageNotification({}), { receivedAt: first });
    const [conversation] = await conversationRows();
    const outgoing = await outboundMessage(conversation!.id, conversation!.contactId);

    await deliver(messageNotification({ context: { id: outgoing } }), { receivedAt: first });
    await deliver(
      messageNotification({
        type: 'reaction',
        text: undefined,
        reaction: { message_id: outgoing, emoji: '👍' },
      }),
    );

    const rows = await messageRows();
    const target = rows.find((row) => row.wamid === outgoing);
    const reply = rows.find((row) => row.replyToWamid === outgoing);
    const reaction = rows.find((row) => row.type === 'reaction');
    expect(reply?.replyToMessageId).toBe(target?.id);
    expect(reaction).toMatchObject({
      reactionEmoji: '👍',
      reactionToWamid: outgoing,
      reactionToMessageId: target?.id,
      conversationId: conversation?.id,
    });
    const [after] = await conversationRows();
    expect(after?.unreadCount).toBe(2);
    expect(after?.lastInboundAt?.getTime()).toBe(first.getTime());
  });

  it('reaksi tanpa percakapan sebelumnya tidak membuat percakapan', async () => {
    const { results } = await deliver(
      messageNotification({
        type: 'reaction',
        text: undefined,
        reaction: { message_id: 'wamid.tidak-ada', emoji: '❤️' },
      }),
    );
    expect(results).toEqual([{ status: 'processed' }]);
    expect(await conversationRows()).toEqual([]);
    expect(await messageRows()).toEqual([]);
  });

  it('pemetaan jenis Meta → jenis Balesin', () => {
    expect(messageTypeOf('button')).toBe('interactive');
    expect(messageTypeOf('order')).toBe('unsupported');
    expect(messageTypeOf('unknown')).toBe('unsupported');
    expect(messageTypeOf('system')).toBe('system');
    expect(countsAsCustomerMessage('reaction')).toBe(false);
    expect(countsAsCustomerMessage('system')).toBe(false);
    expect(countsAsCustomerMessage('unsupported')).toBe(true);
    const received = new Date('2026-11-16T10:00:00Z');
    expect(inboundOccurredAt(new Date('2026-11-16T09:00:00Z'), received).toISOString()).toBe(
      '2026-11-16T09:00:00.000Z',
    );
    expect(inboundOccurredAt(new Date('2026-11-16T11:00:00Z'), received)).toBe(received);
  });

  it('balasan tombol & jenis belum didukung', async () => {
    await deliver(
      messageNotification({
        type: 'interactive',
        text: undefined,
        interactive: { type: 'button_reply', button_reply: { id: 'BAYAR', title: 'Sudah bayar' } },
      }),
    );
    await deliver(
      messageNotification({
        type: 'unsupported',
        text: undefined,
        unsupported: { type: 'edit' },
        errors: [{ code: 131051, title: 'Message type unknown' }],
      }),
    );
    expect(await messageRows()).toMatchObject([
      {
        type: 'interactive',
        text: 'Sudah bayar',
        extras: { interactive: { kind: 'button_reply', id: 'BAYAR', title: 'Sudah bayar' } },
      },
      { type: 'unsupported', rawType: 'unsupported', errorCode: 131051 },
    ]);
  });
});

describe('status pesan keluar', () => {
  async function conversationWithOutbound(status: 'pending' | 'sent' = 'pending') {
    await deliver(messageNotification({}));
    const [conversation] = await conversationRows();
    const id = await outboundMessage(conversation!.id, conversation!.contactId, status);
    const statusOf = async () =>
      (
        await db
          .select({ status: messages.status, errorCode: messages.errorCode })
          .from(messages)
          .where(and(eq(messages.organizationId, organizationId), eq(messages.wamid, id)))
      )[0];
    return { id, statusOf };
  }

  it('hanya maju: sent → read; delivered yang terlambat & failed setelah dibaca diabaikan', async () => {
    const { id, statusOf } = await conversationWithOutbound();
    const receivedAt = new Date(Date.now() - 1000);
    const { eventIds } = await deliver(statusNotification(id, 'sent'), { receivedAt });
    expect(await statusOf()).toEqual({ status: 'sent', errorCode: null });
    expect((await eventRow(eventIds[0]!))?.contactId).not.toBeNull();

    await deliver(statusNotification(id, 'read'));
    await deliver(statusNotification(id, 'delivered'));
    await deliver(statusNotification(id, 'failed', 131049));
    expect(await statusOf()).toEqual({ status: 'read', errorCode: null });
  });

  it('failed dari sent menyimpan kode error Meta', async () => {
    const { id, statusOf } = await conversationWithOutbound('sent');
    await deliver(statusNotification(id, 'failed', 131049));
    expect(await statusOf()).toEqual({ status: 'failed', errorCode: 131049 });
  });

  it('status untuk pesan yang tidak dikenal → diproses tanpa error, tidak ada yang berubah', async () => {
    const { eventIds, results } = await deliver(
      statusNotification('wamid.tidak-dikenal', 'delivered'),
    );
    expect(results).toEqual([{ status: 'processed' }]);
    expect((await eventRow(eventIds[0]!))?.contactId).toBeNull();
  });

  it('status pesan MASUK dengan wamid sama tidak mengubah pesan masuk', async () => {
    const id = wamid();
    await deliver(messageNotification({ id }));
    await deliver(statusNotification(id, 'read'));
    expect((await messageRows())[0]?.status).toBeNull();
  });
});
