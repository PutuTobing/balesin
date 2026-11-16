/**
 * Perbaikan review keamanan webhook keluar (docs/security-reviews/2026-11-19-fase3-webhook-keluar.md):
 *  - Info 3: satu kejadian outbox yang gagal dibangun TIDAK memacetkan kejadian lain (savepoint per
 *    kejadian; yang gagal dibuang + dicatat tanpa isi);
 *  - Info 5: galat DB yang dicatat tidak memuat teks/parameter kueri;
 *  - Info 6: rotasi rahasia dengan `revokePrevious` → rahasia lama langsung berhenti ditandatangani.
 * (R1/R2 diuji di `packages/core/src/net/security-review-fase3-webhook-keluar.test.ts`.)
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createSecretBox, Secret } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import { contacts, newId, outgoingEvents, webhookDeliveries } from '@balesin/db';
import {
  API_ROUTES,
  apiPath,
  outgoingWebhookSecretResponseSchema,
  webhookDeliveryResponseSchema,
} from '@balesin/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  errorRef,
  processWebhooksOutTick,
  scrubSnippet,
} from '../../../../worker/src/queues/webhooks-out';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  confirmationFor,
  createIntegrationHarness,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let receiverOrigin = '';
const received: { headers: IncomingHttpHeaders; body: string }[] = [];
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const logs = createLogCapture();

const receiver = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    received.push({ headers: request.headers, body: Buffer.concat(chunks).toString() });
    response.writeHead(200).end('ok');
  });
});

const tick = () =>
  processWebhooksOutTick({
    db: harness.db,
    logger: logs.logger,
    secretBox: box,
    allowLoopback: true,
    timeoutMs: 2_000,
  });

async function createWebhook() {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.outgoingWebhooks.list,
    {
      url: `${receiverOrigin}/hook`,
      events: ['contact.created'],
      confirmation: await confirmationFor(),
    },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return outgoingWebhookSecretResponseSchema.parse(response.json());
}

async function contactEvent(name: string) {
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'whatsapp',
      waBsuid: `ID.${newId().slice(-10)}`,
      phone: `+62813${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      name,
    })
    .returning();
  const id = newId();
  await harness.db.insert(outgoingEvents).values({
    id,
    organizationId,
    type: 'contact.created',
    contactId: contact!.id,
  });
  return id;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverOrigin = `http://127.0.0.1:${String((receiver.address() as AddressInfo).port)}`;
  harness = await createIntegrationHarness({ overrides: { webhookAllowLoopback: true } });
});
beforeEach(async () => {
  await harness.reset();
  received.length = 0;
  logs.lines.length = 0;
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
});
afterAll(async () => {
  await harness?.close();
  await new Promise((resolve) => receiver.close(resolve));
});

describe('Info 3 & 5: kejadian beracun tidak memacetkan outbox', () => {
  it('kejadian yang gagal dibuang + dicatat tanpa isi; kejadian lain tetap terkirim', async () => {
    await createWebhook();
    const poison = await contactEvent('Kontak Beracun');
    await contactEvent('Kontak Sehat');
    // Galat deterministik HANYA untuk kejadian beracun (pemicu sementara di DB tes).
    await harness.db.execute(
      sql.raw(`
        create or replace function tolak_racun() returns trigger as $$
        begin
          if new.event_id = '${poison}' then
            raise exception 'racun %', new.payload::text;
          end if;
          return new;
        end $$ language plpgsql;
        create trigger tolak_racun before insert on webhook_deliveries
          for each row execute function tolak_racun();`),
    );
    try {
      const result = await tick();
      expect(result.dispatched).toBe(1);
      expect(await harness.db.select().from(outgoingEvents)).toHaveLength(0);
      expect(
        received.map(
          (item) =>
            (JSON.parse(item.body) as { data: { contact: { name: string } } }).data.contact.name,
        ),
      ).toEqual(['Kontak Sehat']);
      const text = logs.lines.join('\n');
      expect(text).toContain(poison);
      expect(text).toContain('Kejadian webhook keluar gagal dibangun');
      // Tanpa teks kueri, parameter, atau isi payload.
      expect(text).not.toContain('Kontak Beracun');
      expect(text).not.toContain('insert into');
    } finally {
      await harness.db.execute(
        sql.raw(
          'drop trigger if exists tolak_racun on webhook_deliveries; drop function if exists tolak_racun();',
        ),
      );
    }
  });

  it('errorRef hanya nama + kode + constraint', () => {
    const error = Object.assign(new Error('Failed query: insert ... params: rahasia'), {
      cause: { code: '23505', constraint: 'x_unique', detail: 'Key (phone)=(+62...)' },
    });
    expect(errorRef(error)).toEqual({
      errorName: 'Error',
      errorCode: '23505',
      constraint: 'x_unique',
    });
  });
});

describe('Info 6: cabut rahasia lama seketika saat rotasi', () => {
  it('revokePrevious → hanya rahasia baru yang menandatangani', async () => {
    const { webhook, secret: oldSecret } = await createWebhook();
    const rotate = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.outgoingWebhooks.rotateSecret, { webhookId: webhook.id }),
      { confirmation: await confirmationFor(), revokePrevious: true },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(rotate.statusCode, rotate.body).toBe(200);
    const rotated = outgoingWebhookSecretResponseSchema.parse(rotate.json());
    expect(rotated.webhook.previousSecretExpiresAt).toBeNull();
    const test = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.outgoingWebhooks.test, { webhookId: webhook.id }),
      {},
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    webhookDeliveryResponseSchema.parse(test.json());
    await tick();
    const delivery = received[0]!;
    const signature = String(delivery.headers['x-balesin-signature']);
    const t = /t=(\d+)/.exec(signature)?.[1] ?? '';
    const sign = (secret: string) =>
      `v1=${createHmac('sha256', secret).update(`${t}.${delivery.body}`).digest('hex')}`;
    expect(signature.split(',')).toContain(sign(rotated.secret));
    expect(signature.split(',')).not.toContain(sign(oldSecret));
    expect(signature.match(/v1=/g)).toHaveLength(1);
    expect(await harness.db.select().from(webhookDeliveries)).toHaveLength(1);
  });
});

describe('review MobiChat S1: potongan jawaban tanpa rahasia', () => {
  it('key yang disisipkan (utuh / terpotong di batas) + pola blsn_/whsec_ disensor', () => {
    const key = ['blsn', 'live', 'a'.repeat(16), 'Z'.repeat(43)].join('_');
    const whsec = `whsec_${'q'.repeat(30)}`;
    const echoed = scrubSnippet(`{"mobichat_api_key":"${key}","x":"${whsec}"}`, key) ?? '';
    expect(echoed).not.toContain('Z'.repeat(20));
    expect(echoed).not.toContain('q'.repeat(20));
    // Terpotong di akhir potongan 500 byte: awalan key ≥ 12 karakter ikut disensor.
    const cut = scrubSnippet(`prefix ${key.slice(0, 30)}`, key) ?? '';
    expect(cut).not.toContain(key.slice(0, 30));
    // Key lain (bukan yang disisipkan) tetap tertangkap pola umum.
    const other = ['blsn', 'live', 'b'.repeat(16), 'Y'.repeat(43)].join('_');
    expect(scrubSnippet(other, null)).not.toContain('Y'.repeat(20));
    expect(scrubSnippet(null, key)).toBeNull();
    expect(scrubSnippet('diterima', key)).toBe('diterima');
  });
});
