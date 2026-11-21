/**
 * Perbaikan review ruang chat (docs/security-reviews/2026-11-17-fase2-ruang-chat.md): S2 batas kirim
 * harian/per percakapan + rem darurat, R2 penulis asli dipertahankan saat kirim ulang, R1 Office
 * ber-makro lewat unggahan, S1 unggahan berhenti di batas jenis, R4 metadata media dikosongkan,
 * Info 3 NUL di lokasi, Info 6 unduhan dari channel nonaktif. Postgres + Redis + Meta tiruan.
 */
import { randomUUID } from 'node:crypto';

import { createSecretBox, sealChannelSecret, Secret, WEBHOOK_JOBS } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import {
  auditLogs,
  channels,
  conversations,
  mediaFiles,
  messages,
  newId,
  organizations,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  AUDIT_ACTIONS,
  WEBHOOK_ROUTES,
  apiPath,
  errorEnvelopeSchema,
  messageResponseSchema,
  securitySummaryResponseSchema,
  sendingLimitsResponseSchema,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { processWebhookJob } from '../../../../worker/src/queues/webhooks';
import { createPasswordHasher } from '../auth/password-hasher';
import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import {
  FAKE_WEBHOOK_DEFAULTS,
  mediaMessageNotification,
  signedWebhook,
  startFakeMeta,
  textMessageNotification,
  type FakeMeta,
} from '../../testing/fake-meta';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  createIntegrationHarness,
  integrationConfig,
  login,
  withConfirmation,
  type IntegrationHarness,
  type SignedIn,
  type SignedInWithTwoFactor,
} from '../../testing/integration';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const TOKEN = 'EAAtokenTiruanRemKirim0123456789';
const PHONE = FAKE_WEBHOOK_DEFAULTS.phoneNumberId;
const PASSWORD = 'sandi-uji-rem-kirim-01';

let fake: FakeMeta;
let harness: IntegrationHarness;
let owner: SignedInWithTwoFactor;
let organizationId: string;
let channelId: string;
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const hasher = createPasswordHasher();
const workerLogs = createLogCapture();

async function receive(notification: unknown) {
  const { body, headers } = signedWebhook(notification, APP_SECRET);
  const response = await harness.app.inject({
    method: 'POST',
    url: apiPath(WEBHOOK_ROUTES.whatsapp, { channelId }),
    headers,
    payload: body,
    remoteAddress: '173.252.127.1',
  });
  expect(response.statusCode).toBe(200);
  for (const data of harness.webhookJobs.splice(0)) {
    await processWebhookJob(
      { name: WEBHOOK_JOBS.whatsappEvent, data, attemptsMade: 0, opts: { attempts: 8 } },
      { db: harness.db, logger: workerLogs.logger },
    );
  }
}

async function conversationId() {
  const [row] = await harness.db.select({ id: conversations.id }).from(conversations);
  return row!.id;
}

function sendText(signed: SignedIn, conversation: string, text = 'Halo') {
  return call(
    harness.app,
    'POST',
    apiPath(API_ROUTES.inbox.messages, { conversationId: conversation }),
    { type: 'text', clientMessageId: randomUUID(), text },
    { cookie: signed.cookie, csrf: signed.csrf },
  );
}

function upload(signed: SignedIn, conversation: string, filename: string, bytes: Buffer) {
  const boundary = `----balesin${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return harness.app.inject({
    method: 'POST',
    url: apiPath(API_ROUTES.inbox.upload, { conversationId: conversation }),
    headers: {
      cookie: signed.cookie,
      origin: TEST_APP_ORIGIN,
      'x-csrf-token': signed.csrf,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
}

beforeAll(async () => {
  fake = await startFakeMeta();
  harness = await createIntegrationHarness({
    config: { ...integrationConfig(), metaGraphBaseUrl: fake.url },
  });
});
beforeEach(async () => {
  await harness.reset();
  fake.reset();
  fake.tokens.set(TOKEN, { appSecret: APP_SECRET });
  fake.phoneNumbers.set(PHONE, { id: PHONE, wabaId: FAKE_WEBHOOK_DEFAULTS.wabaId });
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  channelId = newId();
  const target = { id: channelId, organizationId };
  await harness.db.insert(channels).values({
    id: channelId,
    organizationId,
    type: 'whatsapp',
    name: 'CS Utama',
    waPhoneNumberId: PHONE,
    waBusinessAccountId: FAKE_WEBHOOK_DEFAULTS.wabaId,
    waAccessTokenEncrypted: sealChannelSecret(box, target, 'accessToken', TOKEN),
    waAppSecretEncrypted: sealChannelSecret(box, target, 'appSecret', APP_SECRET),
    waVerifyTokenEncrypted: sealChannelSecret(box, target, 'verifyToken', 'verify-01234567'),
    waVerifyTokenRotatedAt: new Date(),
  });
});
afterAll(async () => {
  await harness?.close();
  await fake?.close();
});

describe('S2 — batas kirim & rem darurat', () => {
  it('pengaturan: baca (Owner/Admin), ubah butuh konfirmasi identitas, CS tidak boleh (403)', async () => {
    const read = await call(harness.app, 'GET', API_ROUTES.sendingLimits.settings, undefined, {
      cookie: owner.cookie,
    });
    expect(sendingLimitsResponseSchema.parse(read.json()).limits).toMatchObject({
      dailyPerUser: 500,
      dailyPerOrganization: 5000,
      perConversationPerMinute: 20,
      paused: null,
    });
    const values = { dailyPerUser: 3, dailyPerOrganization: 100, perConversationPerMinute: 10 };
    const unconfirmed = await call(harness.app, 'PUT', API_ROUTES.sendingLimits.settings, values, {
      cookie: owner.cookie,
      csrf: owner.csrf,
    });
    expect(unconfirmed.statusCode).toBe(400);
    const saved = await call(
      harness.app,
      'PUT',
      API_ROUTES.sendingLimits.settings,
      await withConfirmation(owner, values),
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(saved.statusCode, saved.body).toBe(200);
    const cs = await insertUser(harness.db, organizationId, {
      role: 'cs',
      email: 'cs.rem@majujaya.test',
      passwordHash: await hasher.hash(PASSWORD),
    });
    const signedCs = await login(harness.app, { email: cs.email, password: PASSWORD });
    expect(
      (
        await call(harness.app, 'GET', API_ROUTES.sendingLimits.settings, undefined, {
          cookie: signedCs.cookie,
        })
      ).statusCode,
    ).toBe(403);
    const [audit] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.sendingLimitsUpdated));
    expect(audit?.metadata).toMatchObject({ dailyPerUser: 3, actorRole: 'owner' });
  });

  it('rem darurat: kirim → 423, banner + email Owner; lanjut butuh konfirmasi', async () => {
    await receive(textMessageNotification());
    const conversation = await conversationId();
    const paused = await call(
      harness.app,
      'POST',
      API_ROUTES.sendingLimits.pause,
      { reason: 'Akun CS dicurigai dibobol' },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(paused.statusCode, paused.body).toBe(200);
    expect(sendingLimitsResponseSchema.parse(paused.json()).limits.paused).toMatchObject({
      reason: 'Akun CS dicurigai dibobol',
      by: { id: owner.session.user.id },
    });
    const blocked = await sendText(owner, conversation);
    expect(blocked.statusCode).toBe(423);
    expect(errorEnvelopeSchema.parse(blocked.json()).error.code).toBe('SENDING_PAUSED');
    expect(harness.adminNotices.map((notice) => notice.event)).toEqual(['sending_paused']);

    const summary = securitySummaryResponseSchema.parse(
      (
        await call(harness.app, 'GET', API_ROUTES.audit.securitySummary, undefined, {
          cookie: owner.cookie,
        })
      ).json(),
    );
    expect(summary.events).toContainEqual(
      expect.objectContaining({ kind: 'sending_paused', severity: 'warning' }),
    );

    expect(
      (
        await call(
          harness.app,
          'POST',
          API_ROUTES.sendingLimits.resume,
          {},
          {
            cookie: owner.cookie,
            csrf: owner.csrf,
          },
        )
      ).statusCode,
    ).toBe(400);
    const resumed = await call(
      harness.app,
      'POST',
      API_ROUTES.sendingLimits.resume,
      await withConfirmation(owner, {}),
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect((await sendText(owner, conversation)).statusCode).toBe(202);
  });

  it('batas harian pengguna → 429 + audit + email Owner sekali; batas per percakapan → 429', async () => {
    await receive(textMessageNotification());
    const conversation = await conversationId();
    await harness.db
      .update(organizations)
      .set({ sendDailyLimitPerUser: 2, sendPerConversationPerMinute: 50 })
      .where(eq(organizations.id, organizationId));
    expect((await sendText(owner, conversation)).statusCode).toBe(202);
    expect((await sendText(owner, conversation)).statusCode).toBe(202);
    const limited = await sendText(owner, conversation);
    expect(limited.statusCode).toBe(429);
    expect(errorEnvelopeSchema.parse(limited.json()).error.message).toContain(
      'Batas kirim harianmu',
    );
    expect((await sendText(owner, conversation)).statusCode).toBe(429);
    const reached = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.sendingLimitReached));
    expect(reached).toHaveLength(1);
    expect(reached[0]?.metadata).toMatchObject({ scope: 'user', limit: 2 });
    expect(harness.adminNotices.map((notice) => notice.event)).toEqual(['sending_limit_reached']);

    await harness.db
      .update(organizations)
      .set({ sendDailyLimitPerUser: 1000, sendPerConversationPerMinute: 1 })
      .where(eq(organizations.id, organizationId));
    // Dua pesan menit ini sudah tercatat untuk percakapan ini → melewati batas 1/menit.
    const flood = await sendText(owner, conversation);
    expect(flood.statusCode).toBe(429);
    expect(errorEnvelopeSchema.parse(flood.json()).error.message).toContain('pelanggan ini');
  });
});

describe('R2 — kirim ulang mempertahankan penulis asli', () => {
  it('senderUserId tetap penulis; lastSentBy = penekan "Kirim ulang"; idempotensi penulis tetap utuh', async () => {
    await receive(textMessageNotification());
    const conversation = await conversationId();
    const clientMessageId = randomUUID();
    const sent = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.messages, { conversationId: conversation }),
      { type: 'text', clientMessageId, text: 'Halo' },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    const id = messageResponseSchema.parse(sent.json()).message.id;
    await harness.db
      .update(messages)
      .set({ status: 'failed', failureReason: 'meta_rejected', errorCode: 130429 })
      .where(eq(messages.id, id));
    const cs = await insertUser(harness.db, organizationId, {
      role: 'cs',
      email: 'cs.retry@majujaya.test',
      passwordHash: await hasher.hash(PASSWORD),
    });
    const signedCs = await login(harness.app, { email: cs.email, password: PASSWORD });
    const retried = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.retry, { messageId: id }),
      undefined,
      {
        cookie: signedCs.cookie,
        csrf: signedCs.csrf,
      },
    );
    expect(retried.statusCode, retried.body).toBe(202);
    const [row] = await harness.db.select().from(messages).where(eq(messages.id, id));
    expect(row).toMatchObject({
      senderUserId: owner.session.user.id,
      lastSentByUserId: cs.id,
      sendClaimedAt: null,
    });
    const again = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.messages, { conversationId: conversation }),
      { type: 'text', clientMessageId, text: 'Halo' },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(again.statusCode).toBe(200);
    expect(messageResponseSchema.parse(again.json()).message.id).toBe(id);
  });
});

describe('S1/R1 — unggahan dialirkan & isi wadah Office diperiksa', () => {
  it('gambar > 5 MB berhenti di batas jenisnya (413) tanpa berkas Meta', async () => {
    await receive(textMessageNotification());
    const conversation = await conversationId();
    const big = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(6 * 1024 * 1024, 1),
    ]);
    const response = await upload(owner, conversation, 'besar.jpg', big);
    expect(response.statusCode).toBe(413);
    expect(fake.media.size).toBe(0);
  });

  it('dokumen Word lama ber-makro (CFB + _VBA_PROJECT) ditolak 415', async () => {
    await receive(textMessageNotification());
    const conversation = await conversationId();
    const doc = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(504, 0),
      Buffer.from('WordDocument_VBA_PROJECT', 'utf16le'),
    ]);
    expect((await upload(owner, conversation, 'tagihan.doc', doc)).statusCode).toBe(415);
    const clean = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(504, 0),
      Buffer.from('WordDocument', 'utf16le'),
    ]);
    expect((await upload(owner, conversation, 'tagihan.doc', clean)).statusCode).toBe(201);
  });
});

describe('R4 & Info', () => {
  it('R4: pembersih mengosongkan nama berkas, sidik, dan ID media Meta', async () => {
    fake.media.set('5550001', {
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]),
      mimeType: 'image/jpeg',
    });
    await receive(mediaMessageNotification('image', { mediaId: '5550001' }));
    const [incoming] = await harness.db.select().from(messages).where(eq(messages.type, 'image'));
    const download = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.media, { messageId: incoming!.id }),
      undefined,
      {
        cookie: owner.cookie,
        csrf: owner.csrf,
      },
    );
    expect(download.statusCode).toBe(200);
    await harness.db.update(mediaFiles).set({ expiresAt: new Date(Date.now() - 1000) });
    await harness.app.outbound.purgeExpiredMedia();
    const [file] = await harness.db.select().from(mediaFiles);
    expect(file).toMatchObject({
      storageKey: null,
      filename: null,
      metaMediaRef: null,
      sha256: '0'.repeat(64),
    });
  });

  it('Info 6: channel nonaktif → unduhan BARU ditolak (404); Info 3: NUL di lokasi → 400', async () => {
    fake.media.set('5550002', {
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      mimeType: 'image/jpeg',
    });
    await receive(mediaMessageNotification('image', { mediaId: '5550002' }));
    const conversation = await conversationId();
    const located = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.messages, { conversationId: conversation }),
      {
        type: 'location',
        clientMessageId: randomUUID(),
        latitude: 1,
        longitude: 1,
        name: 'a\u0000b',
      },
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(located.statusCode).toBe(400);
    await harness.db
      .update(channels)
      .set({ enabled: false, disabledAt: new Date() })
      .where(eq(channels.id, channelId));
    const [incoming] = await harness.db
      .select()
      .from(messages)
      .where(and(eq(messages.type, 'image'), eq(messages.organizationId, organizationId)));
    const response = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.media, { messageId: incoming!.id }),
      undefined,
      {
        cookie: owner.cookie,
        csrf: owner.csrf,
      },
    );
    expect(response.statusCode).toBe(404);
    expect(fake.requests.some((request) => request.path.includes('5550002'))).toBe(false);
  });
});
