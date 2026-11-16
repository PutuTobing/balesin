/**
 * Sisa Fase 2: hapus kontak (UU PDP) + ekspor data satu kontak, diagnosis webhook per channel, dan
 * `channelId` di kejadian keamanan "webhook ditolak". Postgres + Redis sungguhan.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSecretBox, sealChannelSecret, Secret } from '@balesin/core';
import {
  auditLogs,
  channels,
  contacts,
  conversations,
  mediaFiles,
  messages,
  newId,
  webhookEvents,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  WEBHOOK_ROUTES,
  apiPath,
  contactExportSchema,
  deleteContactResponseSchema,
  inboxStreamEventSchema,
  securitySummaryResponseSchema,
  webhookHealthResponseSchema,
  type InboxStreamEvent,
  type UserRole,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { recordAudit } from '../audit/audit';
import { createPasswordHasher } from '../auth/password-hasher';
import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  confirmationFor,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';

const PASSWORD = 'sandi-uji-hapus-kontak-01';
const APP_SECRET = '0123456789abcdef0123456789abcdef';
const MEDIA_DIR = join(tmpdir(), `balesin-tes-media-${String(process.pid)}`);

type Agent = SignedIn & { userId: string; name: string };

let harness: IntegrationHarness;
let owner: Agent;
let organizationId: string;
let channelId: string;
const hasher = createPasswordHasher();
const box = createSecretBox(new Secret(TEST_MASTER_KEY));

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

function send(signed: SignedIn, method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) {
  return call(harness.app, method, url, body, {
    cookie: signed.cookie,
    ...(method === 'GET' ? {} : { csrf: signed.csrf }),
  });
}

/** Kontak + percakapan terbuka + 2 pesan (satu gambar dengan berkas di disk). */
async function seed() {
  const [contact] = await harness.db
    .insert(contacts)
    .values({
      organizationId,
      channelType: 'whatsapp',
      waBsuid: 'ID.RAHASIA12345',
      phone: '+6281311112222',
      profileName: 'Siti Pelanggan',
      email: 'siti@contoh.id',
    })
    .returning();
  const [conversation] = await harness.db
    .insert(conversations)
    .values({
      organizationId,
      contactId: contact!.id,
      channelId,
      status: 'unserved',
      lastMessageAt: new Date(),
    })
    .returning();
  const storageKey = `inbound/${randomUUID()}`;
  await mkdir(join(MEDIA_DIR, 'inbound'), { recursive: true });
  await writeFile(join(MEDIA_DIR, storageKey), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]));
  const [file] = await harness.db
    .insert(mediaFiles)
    .values({
      organizationId,
      channelId,
      source: 'inbound',
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 5,
      sha256: 'a'.repeat(64),
      filename: 'ktp.jpg',
      storageKey,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    .returning();
  const base = {
    organizationId,
    conversationId: conversation!.id,
    contactId: contact!.id,
    channelId,
    direction: 'inbound' as const,
    senderKind: 'customer' as const,
    occurredAt: new Date(),
  };
  await harness.db.insert(messages).values([
    { ...base, type: 'text', wamid: `wamid.${newId()}`, text: 'Alamat saya Jl. Mawar 5' },
    {
      ...base,
      type: 'image',
      wamid: `wamid.${newId()}`,
      mediaFileId: file!.id,
      media: {
        kind: 'image',
        metaMediaId: '777',
        mimeType: 'image/jpeg',
        sha256: null,
        filename: 'ktp.jpg',
        voice: false,
        animated: false,
      },
    },
  ]);
  return { contact: contact!, conversation: conversation!, storageKey };
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
  const target = { id: channelId, organizationId };
  await harness.db.insert(channels).values({
    id: channelId,
    organizationId,
    type: 'whatsapp',
    name: 'CS Utama',
    waPhoneNumberId: '106540352242922',
    waBusinessAccountId: '102290129340398',
    waAccessTokenEncrypted: sealChannelSecret(
      box,
      target,
      'accessToken',
      'EAAtokenTiruan0123456789',
    ),
    waAppSecretEncrypted: sealChannelSecret(box, target, 'appSecret', APP_SECRET),
    waVerifyTokenEncrypted: sealChannelSecret(box, target, 'verifyToken', 'verify-token-01234'),
    waVerifyTokenRotatedAt: new Date(),
  });
});
afterAll(async () => {
  await harness?.close();
});

describe('hapus kontak (UU PDP)', () => {
  it('Owner/Admin + konfirmasi identitas; berkas media langsung hilang; audit tanpa data pribadi; WS', async () => {
    const { contact, conversation, storageKey } = await seed();
    const url = apiPath(API_ROUTES.inbox.contact, { contactId: contact.id });
    const cs = await agent('cs', 'Sinta CS');
    const supervisor = await agent('supervisor', 'Rina Supervisor');
    expect((await send(cs, 'DELETE', url, {})).statusCode).toBe(403);
    expect((await send(supervisor, 'DELETE', url, {})).statusCode).toBe(403);
    expect((await send(owner, 'DELETE', url, {})).statusCode).toBe(400);
    expect(
      (await send(owner, 'DELETE', url, { confirmation: { password: 'salah-sekali-123' } }))
        .statusCode,
    ).toBe(400);

    const events: InboxStreamEvent[] = [];
    const socket = await harness.app.injectWS(API_ROUTES.inbox.stream, {
      headers: { cookie: cs.cookie, origin: TEST_APP_ORIGIN },
    });
    socket.on('message', (data: Buffer) => {
      events.push(inboxStreamEventSchema.parse(JSON.parse(data.toString('utf8'))));
    });

    const deleted = await send(owner, 'DELETE', url, { confirmation: await confirmationFor() });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleteContactResponseSchema.parse(deleted.json()).deleted).toEqual({
      messages: 2,
      conversations: 1,
      webhookEvents: 0,
      mediaFiles: 1,
    });
    await expect(stat(join(MEDIA_DIR, storageKey))).rejects.toThrow();
    expect(await harness.db.select().from(contacts)).toEqual([]);
    expect(await harness.db.select().from(messages)).toEqual([]);

    const audit = await harness.db
      .select({ metadata: auditLogs.metadata, targetId: auditLogs.targetId })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'contact.deleted'));
    expect(audit).toEqual([
      {
        targetId: contact.id,
        metadata: expect.objectContaining({
          messages: 2,
          conversations: 1,
          hadOpenConversation: true,
        }) as unknown,
      },
    ]);
    for (const secret of ['Siti', '6281311112222', 'siti@contoh.id', 'ID.RAHASIA', 'Mawar']) {
      expect(JSON.stringify(audit)).not.toContain(secret);
    }

    const started = Date.now();
    while (Date.now() - started < 3000 && !events.some((e) => e.type === 'conversation.removed')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(events).toContainEqual({
      type: 'conversation.removed',
      conversationId: conversation.id,
    });
    socket.terminate();
    expect(
      (await send(owner, 'DELETE', url, { confirmation: await confirmationFor() })).statusCode,
    ).toBe(404);
  });

  it('ekspor satu kontak: contacts.export (Supervisor ya, CS tidak); tanpa ID internal; diaudit', async () => {
    const { contact } = await seed();
    const url = apiPath(API_ROUTES.inbox.contactExport, { contactId: contact.id });
    const cs = await agent('cs', 'Sinta CS');
    const supervisor = await agent('supervisor', 'Rina Supervisor');
    expect((await send(cs, 'GET', url)).statusCode).toBe(403);
    const response = await send(supervisor, 'GET', url);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="kontak-${String(contact.number)}.json"`,
    );
    const data = contactExportSchema.parse(response.json());
    expect(data.contact).toMatchObject({
      phone: '+6281311112222',
      profileName: 'Siti Pelanggan',
      email: 'siti@contoh.id',
    });
    expect(data.conversations).toHaveLength(1);
    expect(data.messages.map((message) => message.type).sort()).toEqual(['image', 'text']);
    expect(data.truncated).toBe(false);
    expect(response.body).not.toContain('ID.RAHASIA');
    expect(response.body).not.toContain('"777"');
    const audit = await harness.db
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'contact.exported'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('Siti');
  });
});

describe('diagnosis webhook per channel', () => {
  it('hitungan 24 jam per status + tanda tangan gagal, tanpa payload; channels.manage', async () => {
    const url = apiPath(API_ROUTES.channels.webhookHealth, { channelId });
    const idle = webhookHealthResponseSchema.parse((await send(owner, 'GET', url)).json()).health;
    expect(idle).toMatchObject({ status: 'idle', lastReceivedAt: null });

    const old = new Date(Date.now() - 30 * 60_000);
    const row = (status: 'processed' | 'pending' | 'failed' | 'skipped', extra = {}) => ({
      organizationId,
      channelId,
      source: 'whatsapp' as const,
      kind: 'other' as const,
      field: 'messages',
      dedupKey: `o:${newId()}`,
      payload: { rahasia: 'isi pesan pelanggan' },
      status,
      processedAt: status === 'processed' || status === 'skipped' ? new Date() : null,
      ...extra,
    });
    await harness.db
      .insert(webhookEvents)
      .values([
        row('processed'),
        row('processed'),
        row('skipped'),
        row('pending', { receivedAt: old }),
        row('failed', { lastError: 'db_error' }),
        row('failed', { lastError: 'rejected:23514' }),
        row('failed', { lastError: 'expired_pending' }),
      ]);
    const bad = await call(
      harness.app,
      'POST',
      apiPath(WEBHOOK_ROUTES.whatsapp, { channelId }),
      { object: 'whatsapp_business_account', entry: [] },
      { headers: { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }, origin: null },
    );
    expect(bad.statusCode).toBe(403);

    const cs = await agent('cs', 'Sinta CS');
    expect((await send(cs, 'GET', url)).statusCode).toBe(403);
    const response = await send(owner, 'GET', url);
    const health = webhookHealthResponseSchema.parse(response.json()).health;
    expect(health).toMatchObject({
      status: 'attention',
      stalledPending: 1,
      last24h: {
        received: 7,
        processed: 2,
        skipped: 1,
        pending: 1,
        failed: 1,
        rejected: 1,
        expiredPending: 1,
        signatureFailures: 1,
      },
    });
    expect(health.lastReceivedAt).not.toBeNull();
    expect(health.lastSignatureFailureAt).not.toBeNull();
    expect(response.body).not.toContain('isi pesan pelanggan');
    expect(
      (await send(owner, 'GET', apiPath(API_ROUTES.channels.webhookHealth, { channelId: newId() })))
        .statusCode,
    ).toBe(404);
  });

  it('kejadian keamanan webhook_signature_failed membawa channelId (juga baris lama via target)', async () => {
    await recordAudit(harness.db, {
      organizationId,
      actorUserId: null,
      action: 'channel.webhook_signature_rejected',
      targetType: 'channel',
      targetId: channelId,
      metadata: { name: 'CS Utama', failures: 10, windowMinutes: 10, reason: 'signature_invalid' },
      client: { ip: '203.0.113.9', userAgent: null },
    });
    const summary = securitySummaryResponseSchema.parse(
      (await send(owner, 'GET', API_ROUTES.audit.securitySummary)).json(),
    );
    expect(summary.events).toContainEqual(
      expect.objectContaining({
        kind: 'webhook_signature_failed',
        details: expect.objectContaining({ channelId }) as unknown,
      }),
    );
  });
});
