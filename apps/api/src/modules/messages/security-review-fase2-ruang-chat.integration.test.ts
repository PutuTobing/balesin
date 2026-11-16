/**
 * Review keamanan Fase 2 butir 6 — ruang chat (docs/security-reviews/2026-11-17-fase2-ruang-chat.md).
 * Penjaga regresi (`it`) + temuan yang dikunci `it.fails` (harus menjadi `it` setelah diperbaiki).
 * Postgres + Redis sungguhan, server Meta TIRUAN lokal — tidak pernah memanggil Meta sungguhan.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSecretBox, sealChannelSecret, Secret, WEBHOOK_JOBS } from '@balesin/core';
import { createLogCapture } from '@balesin/core/testing';
import { channels, conversations, mediaFiles, messages, newId } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import { API_ROUTES, WEBHOOK_ROUTES, apiPath, uploadMediaResponseSchema } from '@balesin/shared';
import { eq } from 'drizzle-orm';
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
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { createMediaStore } from './media-store';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const TOKEN = 'EAAtokenTiruanReviewRuangChat01234';
const PHONE = FAKE_WEBHOOK_DEFAULTS.phoneNumberId;
const PASSWORD = 'sandi-review-ruang-chat-9';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4_000, 7)]);

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
    waAccessTokenTail: '1234',
    waAppSecretEncrypted: sealChannelSecret(box, target, 'appSecret', APP_SECRET),
    waAppSecretTail: 'cdef',
    waVerifyTokenEncrypted: sealChannelSecret(box, target, 'verifyToken', 'verify-token-01234'),
    waVerifyTokenRotatedAt: new Date(),
  });
  return id;
}

async function receive(notification: unknown): Promise<void> {
  const { body, headers } = signedWebhook(notification, APP_SECRET);
  const response = await harness.app.inject({
    method: 'POST',
    url: apiPath(WEBHOOK_ROUTES.whatsapp, { channelId }),
    headers,
    payload: body,
    remoteAddress: '173.252.127.1',
  });
  expect(response.statusCode, response.body).toBe(200);
  for (const data of harness.webhookJobs.splice(0)) {
    await processWebhookJob(
      { name: WEBHOOK_JOBS.whatsappEvent, data, attemptsMade: 0, opts: { attempts: 8 } },
      { db: harness.db, logger: workerLogs.logger },
    );
  }
}

async function conversationId(): Promise<string> {
  const [row] = await harness.db.select({ id: conversations.id }).from(conversations);
  if (!row) throw new Error('belum ada percakapan');
  return row.id;
}

function upload(signed: SignedIn, conversation: string, filename: string, bytes: Buffer) {
  const boundary = `----review${randomUUID()}`;
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

describe('penjaga regresi', () => {
  it('mediaId unggahan pengguna lain tidak bisa dikirim (404), walau satu organisasi & channel', async () => {
    await receive(textMessageNotification());
    const conversation = await conversationId();
    const cs = await signIn('cs');
    const uploaded = await upload(owner, conversation, 'foto.jpg', JPEG);
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const { media } = uploadMediaResponseSchema.parse(uploaded.json());
    const response = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.inbox.messages, { conversationId: conversation }),
      { type: 'media', clientMessageId: randomUUID(), mediaId: media.id },
      { cookie: cs.cookie, csrf: cs.csrf },
    );
    expect(response.statusCode).toBe(404);
    expect(harness.messageJobs).toEqual([]);
  });

  it('Teknisi tidak bisa mengunduh media / mengunggah ke percakapan di luar cakupan (404)', async () => {
    fake.media.set('8880001', { bytes: JPEG, mimeType: 'image/jpeg' });
    await receive(mediaMessageNotification('image', { mediaId: '8880001' }));
    const conversation = await conversationId();
    const [incoming] = await harness.db.select().from(messages).where(eq(messages.type, 'image'));
    const teknisi = await signIn('teknisi');
    const download = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.media, { messageId: incoming!.id }),
      undefined,
      { cookie: teknisi.cookie, csrf: teknisi.csrf },
    );
    expect(download.statusCode).toBe(404);
    expect((await upload(teknisi, conversation, 'foto.jpg', JPEG)).statusCode).toBe(404);
    expect(fake.requests.some((request) => request.path.includes('8880001'))).toBe(false);
  });

  it('kunci penyimpanan media di luar pola / traversal ditolak sebelum menyentuh disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'balesin-review-media-'));
    try {
      const store = createMediaStore(dir);
      for (const key of ['uploads/../../etc/passwd', '../x', 'uploads/abc', '/etc/passwd']) {
        await expect(store.open(key)).rejects.toThrow();
        await expect(store.remove(key)).rejects.toThrow();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('S1 — unduhan media masuk tanpa single-flight (memori & jatah Meta)', () => {
  // Setiap permintaan pertama untuk media yang belum di-cache mengunduh SELURUH berkas (≤ 100 MB) ke
  // memori. Permintaan bersamaan untuk media yang sama tidak digabung → N unduhan, N baris
  // media_files, N berkas di disk. Akun CS curian + satu dokumen 100 MB yang dikirim penyerang ke
  // nomor bisnis = puluhan × 100 MB di memori proses api (OOM), sebelum batas laju 120/menit menahan.
  it.fails('dua permintaan bersamaan untuk media yang sama → satu unduhan dari Meta', async () => {
    fake.media.set('8880002', { bytes: JPEG, mimeType: 'image/jpeg' });
    await receive(mediaMessageNotification('image', { mediaId: '8880002' }));
    const [incoming] = await harness.db.select().from(messages).where(eq(messages.type, 'image'));
    const url = apiPath(API_ROUTES.inbox.media, { messageId: incoming!.id });
    const get = () =>
      call(harness.app, 'GET', url, undefined, { cookie: owner.cookie, csrf: owner.csrf });
    const responses = await Promise.all([get(), get(), get()]);
    for (const response of responses) expect(response.statusCode).toBe(200);
    const files = await harness.db
      .select({ id: mediaFiles.id })
      .from(mediaFiles)
      .where(eq(mediaFiles.source, 'inbound'));
    expect(files).toHaveLength(1); // saat ini 2–3 (satu per permintaan yang berbarengan)
  });
});
