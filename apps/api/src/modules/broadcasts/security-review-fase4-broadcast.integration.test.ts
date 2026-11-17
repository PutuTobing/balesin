/**
 * Tes penjaga review keamanan Fase 4 — broadcast (integrasi)
 * (docs/security-reviews/2026-11-20-fase4-broadcast.md).
 *
 * `it` = regresi. `it.fails` = temuan terbuka (perilaku yang DIHARAPKAN; gagal sekarang).
 */
import { randomUUID } from 'node:crypto';

import { broadcastRecipients, channels, contacts, messageTemplates, newId } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  broadcastResponseSchema,
  type BroadcastCampaign,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from '../auth/password-hasher';
import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import {
  call,
  completeSetup,
  confirmationFor,
  confirmationOf,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const WABA = '102290129340398';
const PASSWORD = 'sandi-uji-review-broadcast-01';

let harness: IntegrationHarness;
let owner: SignedIn;
let supervisor: SignedIn;
let organizationId: string;
let channelId: string;
let templateId: string;
const hasher = createPasswordHasher();
const as = (signed: SignedIn) => ({ cookie: signed.cookie, csrf: signed.csrf });

async function signIn(role: 'supervisor' | 'cs', email: string): Promise<SignedIn> {
  await insertUser(harness.db, organizationId, {
    role,
    email,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return login(harness.app, { email, password: PASSWORD });
}

async function create(signed: SignedIn, name: string): Promise<BroadcastCampaign> {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.broadcasts.list,
    { name, channelId, templateId },
    as(signed),
  );
  expect(response.statusCode, response.body).toBe(201);
  return broadcastResponseSchema.parse(response.json()).broadcast;
}

function upload(signed: SignedIn, id: string, csv: string) {
  const boundary = `----balesin${randomUUID()}`;
  return harness.app.inject({
    method: 'POST',
    url: apiPath(API_ROUTES.broadcasts.upload, { broadcastId: id }),
    headers: {
      cookie: signed.cookie,
      origin: TEST_APP_ORIGIN,
      'x-csrf-token': signed.csrf,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="t.csv"\r\nContent-Type: text/csv\r\n\r\n`,
      ),
      Buffer.from(csv, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}

const csvOf = (count: number, start: number) =>
  [
    'nama,nomor',
    ...Array.from(
      { length: count },
      (_, index) => `Pelanggan ${String(index)},+62812${String(start + index).padStart(8, '0')}`,
    ),
  ].join('\n');

async function submitCampaign(signed: SignedIn, name: string, csv: string) {
  const campaign = await create(signed, name);
  const imported = await upload(signed, campaign.id, csv);
  expect(imported.statusCode, imported.body).toBe(200);
  const patched = await call(
    harness.app,
    'PATCH',
    apiPath(API_ROUTES.broadcasts.broadcast, { broadcastId: campaign.id }),
    { mapping: { body: { '1': { kind: 'column', column: 'nama' } }, header: null, buttons: {} } },
    as(signed),
  );
  expect(patched.statusCode, patched.body).toBe(200);
  const response = await call(
    harness.app,
    'POST',
    apiPath(API_ROUTES.broadcasts.submit, { broadcastId: campaign.id }),
    { confirmation: await confirmationOf(signed) },
    as(signed),
  );
  expect(response.statusCode, response.body).toBe(200);
  return broadcastResponseSchema.parse(response.json()).broadcast;
}

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  channelId = newId();
  await harness.db.insert(channels).values({
    id: channelId,
    organizationId,
    type: 'whatsapp',
    name: 'CS Utama',
    waPhoneNumberId: '106540352242922',
    waBusinessAccountId: WABA,
    waAccessTokenEncrypted: 'x',
    waAppSecretEncrypted: 'x',
    waVerifyTokenEncrypted: 'x',
    waVerifyTokenRotatedAt: new Date(),
  });
  templateId = newId();
  await harness.db.insert(messageTemplates).values({
    id: templateId,
    organizationId,
    channelId,
    wabaId: WABA,
    metaTemplateId: '5550009',
    name: 'info_layanan',
    language: 'id',
    category: 'UTILITY',
    status: 'APPROVED',
    content: {
      parameterFormat: 'positional',
      header: null,
      body: { text: 'Halo {{1}}, ada info layanan.', examples: { '1': 'Budi' } },
      footer: null,
      buttons: [],
      authentication: null,
    } as never,
    source: 'meta',
  });
  supervisor = await signIn('supervisor', 'spv.review@majujaya.test');
});
afterAll(async () => {
  await harness?.close();
});

describe('review keamanan — siapa boleh mengirim broadcast', () => {
  it('CS tidak bisa membuat broadcast; Supervisor tidak bisa menyetujui; pengaju tidak bisa menyetujui sendiri', async () => {
    const cs = await signIn('cs', 'cs.review@majujaya.test');
    const denied = await call(
      harness.app,
      'POST',
      API_ROUTES.broadcasts.list,
      { name: 'Spam', channelId, templateId },
      as(cs),
    );
    expect(denied.statusCode).toBe(403);

    const big = await submitCampaign(owner, 'Besar', csvOf(51, 0));
    expect(big.status).toBe('pending_approval');
    const bySupervisor = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.broadcasts.approve, { broadcastId: big.id }),
      { confirmation: await confirmationOf(supervisor) },
      as(supervisor),
    );
    expect(bySupervisor.statusCode).toBe(403);
    const byOwnself = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.broadcasts.approve, { broadcastId: big.id }),
      { confirmation: await confirmationFor() },
      as(owner),
    );
    expect(byOwnself.statusCode).toBe(403);
  });

  it('S1: memecah kampanye di bawah ambang (3 × 50 penerima / 24 jam oleh satu pengguna) tetap butuh persetujuan', async () => {
    const first = await submitCampaign(supervisor, 'Bagian 1', csvOf(50, 0));
    const second = await submitCampaign(supervisor, 'Bagian 2', csvOf(50, 100));
    const third = await submitCampaign(supervisor, 'Bagian 3', csvOf(50, 200));
    expect(first.status).toBe('scheduled');
    // Total 150 penerima tanpa satu pun persetujuan: kampanye ke-2/ke-3 harus menunggu persetujuan.
    expect([second.status, third.status]).toContain('pending_approval');
  });
});

describe('review keamanan — UU PDP', () => {
  it('R1: hapus kontak juga menghapus baris penerima broadcast yang belum diproses (nomor + data kolom)', async () => {
    const phone = '+6281299887766';
    const [contact] = await harness.db
      .insert(contacts)
      .values({ organizationId, channelType: 'whatsapp', phone, profileName: 'Akan dihapus' })
      .returning();
    const campaign = await create(owner, 'Pengingat');
    const imported = await upload(owner, campaign.id, `nama,nomor\nAkan dihapus,${phone}`);
    expect(imported.statusCode, imported.body).toBe(200);
    const removed = await call(
      harness.app,
      'DELETE',
      apiPath(API_ROUTES.inbox.contact, { contactId: contact!.id }),
      { confirmation: await confirmationFor() },
      as(owner),
    );
    expect(removed.statusCode, removed.body).toBe(200);
    const left = await harness.db
      .select()
      .from(broadcastRecipients)
      .where(eq(broadcastRecipients.phone, phone));
    expect(left).toHaveLength(0);
  });
});
