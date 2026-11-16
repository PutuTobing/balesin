/**
 * Review keamanan Fase 2 — hapus & ekspor data kontak
 * (docs/security-reviews/2026-11-18-fase2-hapus-ekspor-diagnosis.md). Penjaga regresi (`it`) + temuan
 * yang dikunci `it.fails`. Postgres + Redis sungguhan.
 */
import { channels, contacts, conversationNotes, conversations, messages, newId } from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import { API_ROUTES, apiPath } from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createPasswordHasher } from '../auth/password-hasher';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const PASSWORD = 'sandi-review-hapus-ekspor-6';
const NOTE_TEXT = 'CATATAN-SESI-INTERNAL-RAHASIA-4410';

let harness: IntegrationHarness;
let owner: SignedIn & { userId: string };
let organizationId: string;
let channelId: string;
const hasher = createPasswordHasher();

async function agent(role: 'supervisor' | 'teknisi') {
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

async function seed(org = organizationId, channel = channelId) {
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId: org,
      channelType: 'whatsapp',
      waBsuid: `ID.REVIEW.${newId().slice(-8)}`,
      phone: '+6281377776666',
      profileName: 'Rudi Pelanggan',
    })
    .returning();
  const [conversation] = await harness.db
    .insert(conversations)
    .values({
      organizationId: org,
      contactId: contact!.id,
      channelId: channel,
      status: 'unserved',
      lastMessageAt: new Date(),
    })
    .returning();
  await harness.db.insert(messages).values({
    organizationId: org,
    conversationId: conversation!.id,
    contactId: contact!.id,
    channelId: channel,
    direction: 'inbound',
    senderKind: 'customer',
    type: 'text',
    wamid: `wamid.${newId()}`,
    text: 'Halo',
    occurredAt: new Date(),
  });
  return { contact: contact!, conversation: conversation! };
}

async function insertChannel(org: string) {
  const id = newId();
  await harness.db.insert(channels).values({
    id,
    organizationId: org,
    type: 'whatsapp',
    name: 'CS Utama',
    waPhoneNumberId: `10654035224${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`,
    waBusinessAccountId: '102290129340398',
    waAccessTokenEncrypted: 'x',
    waAppSecretEncrypted: 'x',
    waVerifyTokenEncrypted: 'x',
    waVerifyTokenRotatedAt: new Date(),
  });
  return id;
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
  owner = { ...signed, userId: signed.session.user.id };
  channelId = await insertChannel(organizationId);
});
afterAll(async () => {
  await harness?.close();
});

describe('ekspor', () => {
  it('Teknisi 403; kontak organisasi lain 404; catatan sesi & BSUID tidak ikut', async () => {
    const { contact, conversation } = await seed();
    await harness.db.insert(conversationNotes).values({
      organizationId,
      conversationId: conversation.id,
      authorUserId: owner.userId,
      body: NOTE_TEXT,
    });
    const url = apiPath(API_ROUTES.inbox.contactExport, { contactId: contact.id });
    const teknisi = await agent('teknisi');
    expect(
      (await call(harness.app, 'GET', url, undefined, { cookie: teknisi.cookie })).statusCode,
    ).toBe(403);

    const response = await call(harness.app, 'GET', url, undefined, {
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain(NOTE_TEXT);
    expect(response.body).not.toContain(contact.waBsuid!);

    const other = await insertOrganization(harness.db);
    const foreign = await seed(other.id, await insertChannel(other.id));
    const cross = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.contactExport, { contactId: foreign.contact.id }),
      undefined,
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(cross.statusCode).toBe(404);
  });

  // GET ber-efek-samping (audit, jatah 20/jam, berkas PII) — pola proyek: ekspor audit CSV, unduh
  // media, dan profil bisnis memakai `requireCsrf`. Ekspor kontak belum.
  it.fails('ekspor tanpa X-CSRF-Token ditolak (pola GET ber-efek-samping)', async () => {
    const { contact } = await seed();
    const response = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.contactExport, { contactId: contact.id }),
      undefined,
      { cookie: owner.cookie },
    );
    expect(response.statusCode).toBe(403); // saat ini 200
  });
});

describe('hapus', () => {
  it('kontak organisasi lain → 404 dan tidak ada yang terhapus', async () => {
    const other = await insertOrganization(harness.db);
    const foreign = await seed(other.id, await insertChannel(other.id));
    const supervisor = await agent('supervisor');
    const url = apiPath(API_ROUTES.inbox.contact, { contactId: foreign.contact.id });
    expect(
      (
        await call(
          harness.app,
          'DELETE',
          url,
          {},
          { cookie: supervisor.cookie, csrf: supervisor.csrf },
        )
      ).statusCode,
    ).toBe(403);
    const response = await call(
      harness.app,
      'DELETE',
      url,
      { confirmation: { password: 'apa-saja-salah-1' } },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect([400, 404]).toContain(response.statusCode);
    const still = await harness.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.id, foreign.contact.id));
    expect(still).toHaveLength(1);
  });
});
