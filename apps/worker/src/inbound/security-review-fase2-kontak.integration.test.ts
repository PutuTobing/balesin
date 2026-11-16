/**
 * Review keamanan Fase 2 butir 4 — kontak & percakapan dari webhook
 * (docs/security-reviews/2026-11-16-fase2-kontak-percakapan.md). Penjaga regresi (`it`) + temuan
 * yang dikunci `it.fails` (harus menjadi `it` setelah diperbaiki). Postgres sungguhan; notifikasi
 * disusun di sini dan dipecah `splitWhatsAppWebhook` seperti penerima api.
 */
import { randomBytes } from 'node:crypto';

import { splitWhatsAppWebhook, WEBHOOK_JOBS } from '@balesin/core';
import { createLogCapture, type LogCapture } from '@balesin/core/testing';
import {
  channels,
  closeDb,
  contacts,
  createDb,
  messages,
  newId,
  webhookEvents,
  type Database,
} from '@balesin/db';
import { insertOrganization } from '@balesin/db/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { processWebhookJob } from '../queues/webhooks';

const WABA = '102290129340398';
const PHONE_NUMBER_ID = '106540352242922';

let db: Database;
let logs: LogCapture;
let organizationId: string;
let channelId: string;

beforeAll(() => {
  db = createDb(inject('testDatabaseUrl'), { applicationName: 'balesin-test-review-kontak' });
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

interface Customer {
  waId: string;
  userId: string;
  name: string;
}
const ANI: Customer = { waId: '6281200000001', userId: 'ID.ani.1', name: 'Ani Pelanggan' };
const BUDI: Customer = { waId: '6281200000002', userId: 'ID.budi.2', name: 'Budi Pelanggan' };

function notification(customer: Customer, message: Record<string, unknown>) {
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
                  profile: { name: customer.name },
                  wa_id: customer.waId,
                  user_id: customer.userId,
                },
              ],
              messages: [
                {
                  from: customer.waId,
                  from_user_id: customer.userId,
                  id: wamid(),
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'halo' },
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

async function deliver(body: unknown) {
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
      })),
    )
    .returning();
  for (const row of rows) {
    await processWebhookJob(
      {
        name: WEBHOOK_JOBS.whatsappEvent,
        data: { organizationId, eventId: row.id },
        attemptsMade: 0,
        opts: { attempts: 3 },
      },
      { db, logger: logs.logger },
    );
  }
}

const messageRows = () =>
  db
    .select()
    .from(messages)
    .where(eq(messages.organizationId, organizationId))
    .orderBy(asc(messages.number));

describe('penjaga regresi', () => {
  it('pesan dua pelanggan → dua kontak & percakapan terpisah; log tanpa nama/nomor/BSUID/isi', async () => {
    await deliver(notification(ANI, { text: { body: 'ISI-RAHASIA-ANI' } }));
    await deliver(notification(BUDI, { text: { body: 'ISI-RAHASIA-BUDI' } }));
    const rows = await db
      .select()
      .from(contacts)
      .where(eq(contacts.organizationId, organizationId));
    expect(rows).toHaveLength(2);
    const all = logs.text();
    for (const forbidden of [
      ANI.name,
      ANI.waId,
      ANI.userId,
      'ISI-RAHASIA-ANI',
      BUDI.waId,
      'ISI-RAHASIA-BUDI',
    ]) {
      expect(all).not.toContain(forbidden);
    }
  });
});

describe('R1 — balas-kutip/reaksi ditautkan ke pesan kontak LAIN di channel yang sama', () => {
  // `messageIdByWamid` hanya mencocokkan organisasi + channel + wamid. Pesan Budi yang (lewat payload
  // bertanda tangan) merujuk wamid pesan Ani tertaut ke pesan Ani — data lintas kontak. Untuk
  // Teknisi (cakupan per percakapan), `replyTo.messageId`/`reaction.messageId` menunjuk pesan di
  // luar cakupannya, dan UI yang kelak menampilkan kutipan/reaksi pada sasaran akan mencampur dua
  // pelanggan.
  it.fails(
    'balas-kutip Budi ke wamid pesan Ani tidak ditautkan (replyToMessageId null)',
    async () => {
      const aniWamid = wamid();
      await deliver(notification(ANI, { id: aniWamid }));
      await deliver(notification(BUDI, { context: { id: aniWamid } }));
      const rows = await messageRows();
      const budiReply = rows.find((row) => row.replyToWamid === aniWamid);
      expect(budiReply).toBeDefined();
      expect(budiReply?.replyToMessageId).toBeNull(); // saat ini = ID pesan Ani
    },
  );

  it.fails(
    'reaksi Budi ke wamid pesan Ani tidak ditautkan (reactionToMessageId null)',
    async () => {
      const aniWamid = wamid();
      await deliver(notification(ANI, { id: aniWamid }));
      await deliver(notification(BUDI, {})); // Budi punya percakapan terbuka
      await deliver(
        notification(BUDI, {
          type: 'reaction',
          text: undefined,
          reaction: { message_id: aniWamid, emoji: '😂' },
        }),
      );
      const reaction = (await messageRows()).find((row) => row.type === 'reaction');
      expect(reaction).toBeDefined();
      expect(reaction?.reactionToMessageId).toBeNull(); // saat ini = ID pesan Ani
    },
  );
});

describe('R2 — teks pelanggan berisiko disimpan & dikirim ke web apa adanya', () => {
  it.fails('referral.source_url bukan http(s) (mis. javascript:) tidak disimpan', async () => {
    await deliver(
      notification(ANI, {
        referral: {
          source_url: 'javascript:alert(document.cookie)',
          source_type: 'ad',
          source_id: '1',
          headline: 'Promo',
          body: 'Klik',
        },
      }),
    );
    const [row] = await messageRows();
    const referral = (row?.extras as { referral?: { sourceUrl?: string | null } }).referral;
    expect(referral).toBeDefined();
    expect(referral?.sourceUrl ?? null).toBeNull(); // saat ini 'javascript:…'
  });

  it.fails('nama berkas dokumen tanpa pengubah arah (U+202E) / pemisah path', async () => {
    await deliver(
      notification(ANI, {
        type: 'document',
        text: undefined,
        document: {
          id: '1003383421387256',
          mime_type: 'application/pdf',
          filename: '../tagihan‮fdp.exe',
        },
      }),
    );
    const [row] = await messageRows();
    const filename = (row?.media as { filename?: string | null } | null)?.filename ?? '';
    expect(filename).not.toMatch(/[‪-‮⁦-⁩]/); // saat ini memuat U+202E
    expect(filename).not.toMatch(/[\\/]/);
  });
});
