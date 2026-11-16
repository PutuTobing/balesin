/**
 * Lapisan kompatibel MobiChat (Fase 3) — TES KONTRAK terhadap workflow n8n ULAN
 * (`fixtures/ulan-mobichat.json`, potongan verbatim dari docs/reference/n8n/ulan-workflow.json):
 * setiap permintaan yang dikirim node n8n ke MobiChat diputar ulang ke Balesin (path, query, body,
 * nama header persis), lalu jawabannya dibaca dengan KODE PEMBACA ASLI workflow (daftar pesan,
 * pelanggan vs tim, lampiran, `role: chatbot`). Ditambah aturan yang tetap berlaku lewat jalur ini:
 * scope/RBAC, jendela 24 jam, rem darurat, batas harian per key, idempotensi, SSRF `media_url`,
 * URL media bertanda tangan. Postgres + Redis sungguhan, Graph Meta TIRUAN.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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
import {
  channels,
  conversationEvents,
  conversationNotes,
  conversations,
  contacts,
  messages,
  newId,
  organizations,
} from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  MOBICHAT_ROUTES,
  WEBHOOK_ROUTES,
  apiPath,
  createApiKeyResponseSchema,
  mobichatBotErrorSchema,
  mobichatBotReplyResponseSchema,
  mobichatConversationStatusResponseSchema,
  mobichatErrorSchema,
  mobichatMessagesResponseSchema,
  mobichatSendMessagesResponseSchema,
  type ApiKeyScope,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { processSendMessageJob } from '../../../../worker/src/queues/messages';
import { processWebhookJob } from '../../../../worker/src/queues/webhooks';
import { createPasswordHasher } from '../auth/password-hasher';
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
  confirmationFor,
  createIntegrationHarness,
  integrationConfig,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { createMediaUrlSigner } from './media-signature';
import ulan from './fixtures/ulan-mobichat.json';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const TOKEN = 'EAAtokenTiruanKompatMobichat012345';
const PHONE = FAKE_WEBHOOK_DEFAULTS.phoneNumberId;
const META_IP = '173.252.127.1';
const WA = FAKE_WEBHOOK_DEFAULTS.customerWaId;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(200, 3),
]);
const ULAN_SCOPES: ApiKeyScope[] = ['messages:send', 'conversations:write', 'contacts:write'];

let fake: FakeMeta;
let harness: IntegrationHarness;
let owner: SignedIn;
let organizationId: string;
let channelId: string;
let mediaServer: Server;
let mediaOrigin = '';
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const logs = createLogCapture();
const hasher = createPasswordHasher();

/** Kode pembaca ASLI workflow (fixture verbatim) → fungsi. Sumber tepercaya: berkas repo sendiri. */
function reader<T>(source: string): T {
  const body = source.replace(/^const \w+ = /, '').replace(/;$/, '');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const build = new Function(`return (${body});`) as () => T;
  return build();
}
const daftarPesan = reader<(x: unknown) => Record<string, unknown>[]>(ulan.pembaca.daftarPesan);
const isCustomer = reader<(m: unknown) => boolean>(ulan.pembaca.isCustomer);
const pelangganMsg = reader<(m: unknown) => boolean>(ulan.pembaca.pelangganMsg);
const lampiranDari = reader<(m: unknown) => Record<string, unknown>[]>(ulan.pembaca.lampiranDari);
const tipeDari = reader<(a: unknown) => string>(ulan.pembaca.tipeDari);
const stiker = reader<(a: unknown) => boolean>(ulan.pembaca.stiker);
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const masihBot = new Function('a', ulan.pembaca.masihBot) as (a: unknown[]) => boolean;

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
    waAccessTokenTail: '2345',
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
    logger: logs.logger,
  });
}

/** Pesan pelanggan masuk lewat jalur webhook Meta sungguhan (penerima + worker produksi). */
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
      { db: harness.db, logger: logs.logger, publisher: publisher() },
    );
  }
}

async function drainSends() {
  const meta = createMetaGraphClient({
    version: 'v26.0',
    baseUrl: fake.url,
    sleep: () => Promise.resolve(),
  });
  for (const job of harness.messageJobs.splice(0)) {
    await processSendMessageJob(
      {
        name: MESSAGE_JOBS.send,
        data: { organizationId: job.organizationId, messageId: job.messageId },
        attemptsMade: 0,
        opts: { attempts: 5 },
      },
      { db: harness.db, logger: logs.logger, meta, secretBox: box, publisher: publisher() },
    );
  }
}

async function createKey(scopes: ApiKeyScope[] = ULAN_SCOPES, dailySendLimit?: number) {
  const response = await call(
    harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    {
      name: 'ULAN n8n',
      scopes,
      ...(dailySendLimit ? { dailySendLimit } : {}),
      confirmation: await confirmationFor(),
    },
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  expect(response.statusCode, response.body).toBe(201);
  return createApiKeyResponseSchema.parse(response.json());
}

/** Permintaan gaya n8n: header kunci dengan NAMA yang dipakai node (`X-API-Key` / `x-api-key`). */
function n8n(
  key: string | null,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown,
  options: { header?: string; extraHeaders?: Record<string, string> } = {},
) {
  return harness.app.inject({
    method,
    url,
    headers: {
      ...(key ? { [options.header ?? 'X-API-Key']: key } : {}),
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.extraHeaders,
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}

async function onlyConversation() {
  const [row] = await harness.db
    .select()
    .from(conversations)
    .where(eq(conversations.organizationId, organizationId));
  if (!row) throw new Error('belum ada percakapan');
  return row;
}

/** Ganti placeholder fixture (`{cid}`, `{cid:number}`, `{wa}`, `{mediaUrl}`). */
function fill(value: unknown, vars: { cid: number; mediaUrl: string }): unknown {
  if (value === '{cid:number}') return vars.cid;
  if (typeof value === 'string') {
    return value
      .replace('{cid}', String(vars.cid))
      .replace('{wa}', WA)
      .replace('{mediaUrl}', vars.mediaUrl);
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  }
  return value;
}

beforeAll(async () => {
  fake = await startFakeMeta();
  mediaServer = createServer((request, response) => {
    if (request.url === '/qr/png') {
      response.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    } else if (request.url === '/pindah') {
      response.writeHead(302, { location: '/qr/png' }).end();
    } else {
      response.writeHead(404).end('tidak ada');
    }
  });
  await new Promise<void>((resolve) => mediaServer.listen(0, '127.0.0.1', resolve));
  mediaOrigin = `http://127.0.0.1:${String((mediaServer.address() as AddressInfo).port)}`;
  harness = await createIntegrationHarness({
    config: { ...integrationConfig(), metaGraphBaseUrl: fake.url },
    overrides: { webhookAllowLoopback: true },
  });
});
beforeEach(async () => {
  await harness.reset();
  fake.reset();
  fake.tokens.set(TOKEN, { appSecret: APP_SECRET });
  fake.phoneNumbers.set(PHONE, { id: PHONE, wabaId: FAKE_WEBHOOK_DEFAULTS.wabaId });
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  channelId = await insertChannel();
});
afterAll(async () => {
  await harness?.close();
  await fake?.close();
  await new Promise((resolve) => mediaServer?.close(resolve));
});

describe('kontrak workflow ULAN (permintaan & pembaca asli)', () => {
  it('semua permintaan node n8n dijawab 2xx dan dibaca benar oleh kode workflow', async () => {
    const { secret } = await createKey();
    await receive(textMessageNotification({ body: 'Kak, tagihan saya berapa ya?' }));
    const row = await onlyConversation();
    // Bot memegang percakapan (saklar bot = butir berikutnya; di sini disetel langsung).
    await harness.db
      .update(conversations)
      .set({ status: 'bot' })
      .where(eq(conversations.id, row.id));
    const vars = { cid: row.number, mediaUrl: `${mediaOrigin}/qr/png` };

    const status = (
      await n8n(
        secret,
        'GET',
        `${MOBICHAT_ROUTES.conversationStatus}?conversationId=${String(row.number)}`,
      )
    ).json<unknown>();
    const parsedStatus = mobichatConversationStatusResponseSchema.parse(status);
    expect(masihBot(parsedStatus.assignments)).toBe(true);

    for (const step of ulan.permintaan) {
      const query =
        'query' in step && step.query ? (fill(step.query, vars) as Record<string, string>) : null;
      const url = query ? `${step.path}?${new URLSearchParams(query).toString()}` : step.path;
      const body = 'body' in step ? fill(step.body, vars) : undefined;
      const response = await n8n(secret, step.method as 'GET' | 'POST' | 'PUT', url, body, {
        header: step.header,
      });
      expect(response.statusCode, `${step.node}: ${response.body}`).toBeGreaterThanOrEqual(200);
      expect(response.statusCode, `${step.node}: ${response.body}`).toBeLessThan(300);
      const json = response.json<Record<string, unknown>>();
      expect(json.success, step.node).not.toBe(false);
      if (step.method === 'GET' && step.path === MOBICHAT_ROUTES.messages) {
        const list = daftarPesan(json);
        expect(list.length, step.node).toBeGreaterThan(0);
        expect(
          list.some((message) => isCustomer(message)),
          step.node,
        ).toBe(true);
      }
    }
    await drainSends();

    // Pesan bot (teks + gambar QRIS dari media_url) terkirim ke Meta dan tercatat sebagai bot.
    const texts = fake.sentMessages.map((sent) => sent.body);
    expect(texts.some((body) => body.type === 'text')).toBe(true);
    expect(texts.some((body) => body.type === 'image')).toBe(true);
    const history = (
      await n8n(
        secret,
        'GET',
        `${MOBICHAT_ROUTES.messages}?conversation_id=${String(row.number)}&limit=30`,
      )
    ).json<unknown>();
    const list = daftarPesan(mobichatMessagesResponseSchema.parse(history));
    const bots = list.filter((message) => message.type === 'api-bot');
    expect(bots.length).toBe(2);
    for (const message of bots) {
      expect(isCustomer(message)).toBe(false);
      expect(pelangganMsg(message)).toBe(false);
      expect(message.sender_name).toBe('ULAN n8n');
    }
    // Pesan terakhir pelanggan masih terbaca sebagai pelanggan.
    expect(list.filter((message) => isCustomer(message)).map((m) => m.text)).toEqual([
      'Kak, tagihan saya berapa ya?',
    ]);

    // Handoff berhasil: bot tidak lagi memegang → antrian "Belum dilayani".
    const after = mobichatConversationStatusResponseSchema.parse(
      (
        await n8n(
          secret,
          'GET',
          `${MOBICHAT_ROUTES.conversationStatus}?conversationId=${String(row.number)}`,
        )
      ).json(),
    );
    expect(masihBot(after.assignments)).toBe(false);
    expect(after.status).toBe('unserved');

    // Efek samping: nama kontak, tag (tag lama tetap), catatan tim oleh bot, jejak pelaku = key.
    const [contact] = await harness.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, row.contactId));
    expect(contact?.name).toBe('1000023TRIANINGSIH@RJBS');
    const notes = await harness.db
      .select()
      .from(conversationNotes)
      .where(eq(conversationNotes.conversationId, row.id));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ authorUserId: null });
    expect(notes[0]?.apiKeyId).not.toBeNull();
    const events = await harness.db
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, row.id));
    expect(events.map((event) => event.kind).sort()).toEqual(['handoff', 'note_added']);
    expect(events.every((event) => event.actorUserId === null && event.apiKeyId !== null)).toBe(
      true,
    );

    // Tab Log web menampilkan pelaku "Bot · <nama key>".
    const log = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.events, { conversationId: row.id }),
      undefined,
      { cookie: owner.cookie },
    );
    expect(log.statusCode, log.body).toBe(200);
    expect(log.body).toContain('Bot · ULAN n8n');
    // Catatan web: penulis bot, tidak bisa diubah agen.
    const notesView = await call(
      harness.app,
      'GET',
      apiPath(API_ROUTES.inbox.notes, { conversationId: row.id }),
      undefined,
      { cookie: owner.cookie },
    );
    expect(notesView.body).toContain('Bot · ULAN n8n');
    expect(notesView.json<{ notes: { canEdit: boolean }[] }>().notes[0]?.canEdit).toBe(false);
  });

  it('tag lewat nomor: tag lama tetap; nomor tak dikenal 404 dengan pesan yang dibaca node', async () => {
    const { secret } = await createKey();
    await receive(textMessageNotification({ body: 'Halo' }));
    const tag = (tags: string[]) =>
      n8n(secret, 'PUT', MOBICHAT_ROUTES.tagsWhatsapp, { whatsapp_number: WA, tags });
    expect((await tag(['PELANGGAN-LAMA'])).statusCode).toBe(200);
    const second = await tag(['MITRA-SURYA']);
    expect(second.json<{ contact: { tags: string[] } }>().contact.tags.sort()).toEqual([
      'MITRA-SURYA',
      'PELANGGAN-LAMA',
    ]);
    // Format nomor lain yang wajar juga diterima (0…, +62…).
    expect(
      (
        await n8n(secret, 'PUT', MOBICHAT_ROUTES.tagsWhatsapp, {
          whatsapp_number: '081234567890',
          tags: ['X'],
        })
      ).statusCode,
    ).toBe(200);
    const missing = await n8n(secret, 'PUT', MOBICHAT_ROUTES.tagsWhatsapp, {
      whatsapp_number: '6289999999999',
      tags: ['MITRA-SURYA'],
    });
    expect(missing.statusCode).toBe(404);
    const body = mobichatErrorSchema.parse(missing.json());
    const pesanGagal = reader<(b: unknown) => string>(
      `const f = b => ${ulan.pembaca.pesanGagalTag
        .replace(/^pesan = /, '')
        .replace(/;$/, '')
        .replace("(typeof r.body === 'string' ? r.body : '')", "''")}`,
    );
    expect(pesanGagal(body)).toContain('tidak ditemukan');
  });

  it('lampiran: URL bertanda tangan bisa diunduh tanpa header, dibaca pembaca lampiran workflow', async () => {
    const { secret, apiKey } = await createKey();
    fake.media.set('8880001', { bytes: JPEG, mimeType: 'image/jpeg' });
    await receive(
      mediaMessageNotification('image', { mediaId: '8880001', caption: 'bukti transfer' }),
    );
    await receive(mediaMessageNotification('sticker', { mediaId: '8880002' }));
    const row = await onlyConversation();
    const list = daftarPesan(
      (
        await n8n(
          secret,
          'GET',
          `${MOBICHAT_ROUTES.messages}?conversation_id=${String(row.number)}`,
        )
      ).json(),
    );
    const photo = list.find((message) => message.message_type === 'image');
    expect(photo?.text).toBe('bukti transfer');
    const [attachment] = lampiranDari(photo);
    expect(tipeDari(attachment)).toBe('image/jpeg');
    expect(stiker(attachment)).toBe(false);
    const sticker = list.find((message) => message.message_type === 'sticker');
    expect(stiker(lampiranDari(sticker)[0])).toBe(true);

    const url = new URL(String(attachment?.signed_url));
    expect(url.origin).toBe(new URL(integrationConfig().appUrl).origin);
    const path = `${url.pathname}${url.search}`;
    const download = await harness.app.inject({ method: 'GET', url: path });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers['content-type']).toBe('image/jpeg');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.rawPayload.equals(JPEG)).toBe(true);

    // Dirusak / pesan lain / key dicabut → 404 seragam.
    const tampered = path.replace(/sig=[^&]+/, 'sig=AAAA');
    expect((await harness.app.inject({ method: 'GET', url: tampered })).statusCode).toBe(404);
    const otherMessage = path.replace(
      `/media/${String(photo?.id)}`,
      `/media/${String(sticker?.id)}`,
    );
    expect((await harness.app.inject({ method: 'GET', url: otherMessage })).statusCode).toBe(404);
    const revoke = await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.apiKeys.revoke, { apiKeyId: apiKey.id }),
      {},
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    expect(revoke.statusCode, revoke.body).toBe(200);
    expect((await harness.app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
  });
});

describe('aturan tetap berlaku lewat jalur kompatibel', () => {
  it('autentikasi: hanya X-API-Key (bukan Bearer/query); galat berbentuk MobiChat', async () => {
    const { secret } = await createKey();
    await receive(textMessageNotification({ body: 'Halo' }));
    const row = await onlyConversation();
    const url = `${MOBICHAT_ROUTES.messages}?conversation_id=${String(row.number)}`;
    const missing = await n8n(null, 'GET', url);
    expect(missing.statusCode).toBe(401);
    expect(mobichatErrorSchema.parse(missing.json()).message).toContain('X-API-Key');
    const bearer = await n8n(null, 'GET', url, undefined, {
      extraHeaders: { authorization: `Bearer ${secret}` },
    });
    expect(bearer.statusCode).toBe(401);
    expect((await n8n(null, 'GET', `${url}&api_key=${secret}`)).statusCode).toBe(401);
    const wrong = await n8n(`${secret.slice(0, -4)}AAAA`, 'GET', url);
    expect(wrong.statusCode).toBe(401);
    expect(mobichatErrorSchema.parse(wrong.json())).toMatchObject({ code: 'UNAUTHENTICATED' });
    // Key yang sama TIDAK berlaku di API v1 lewat X-API-Key (satu rute = satu cara autentikasi).
    const v1 = await n8n(secret, 'GET', API_ROUTES.publicApi.conversations);
    expect(v1.statusCode).toBe(401);
    // Bot API lama: bentuk `{ error }`.
    const bot = await n8n('salah', 'POST', MOBICHAT_ROUTES.botReply, {
      conversation_id: row.number,
      message_text: 'x',
    });
    expect(bot.statusCode).toBe(401);
    expect(mobichatBotErrorSchema.parse(bot.json()).error).toBeTruthy();
    // Nilai key tidak pernah tertulis di log.
    expect(harness.logs.lines.join(' ')).not.toContain(secret.slice(-20));
  });

  it('scope dipetakan per rute: baca saja tidak bisa kirim/handoff/ubah kontak', async () => {
    const { secret } = await createKey(['messages:read']);
    await receive(textMessageNotification({ body: 'Halo' }));
    const row = await onlyConversation();
    const cid = row.number;
    expect(
      (await n8n(secret, 'GET', `${MOBICHAT_ROUTES.messages}?conversation_id=${String(cid)}`))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await n8n(
          secret,
          'GET',
          `${MOBICHAT_ROUTES.conversationStatus}?conversationId=${String(cid)}`,
        )
      ).statusCode,
    ).toBe(200);
    for (const [method, url, body] of [
      [
        'POST',
        MOBICHAT_ROUTES.messages,
        { conversation_id: cid, messages: [{ message_type: 'text', text: 'x' }] },
      ],
      ['POST', MOBICHAT_ROUTES.unassignAgent, { conversation_id: cid }],
      ['POST', MOBICHAT_ROUTES.conversationStatus, { conversation_id: cid, status: 'unserved' }],
      ['POST', MOBICHAT_ROUTES.notes, { conversationId: cid, notes: 'x' }],
      ['PUT', MOBICHAT_ROUTES.contacts, { conversation_id: cid, full_name: 'X' }],
      ['PUT', MOBICHAT_ROUTES.tagsWhatsapp, { whatsapp_number: WA, tags: ['X'] }],
      ['POST', MOBICHAT_ROUTES.botReply, { conversation_id: cid, message_text: 'x' }],
    ] as const) {
      const response = await n8n(secret, method, url, body);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(
      await harness.db.select().from(messages).where(eq(messages.direction, 'outbound')),
    ).toHaveLength(0);
  });

  it('jendela 24 jam, rem darurat, batas harian per key, idempotensi', async () => {
    const { secret } = await createKey(['messages:send'], 2);
    await receive(textMessageNotification({ body: 'Halo' }));
    const row = await onlyConversation();
    const sendText = (text: string, idempotencyKey?: string) =>
      n8n(
        secret,
        'POST',
        MOBICHAT_ROUTES.messages,
        { conversation_id: String(row.number), messages: [{ message_type: 'text', text }] },
        idempotencyKey ? { extraHeaders: { 'idempotency-key': idempotencyKey } } : {},
      );

    const first = await sendText('Balasan 1', 'balas-1');
    expect(first.statusCode, first.body).toBe(200);
    const sent = mobichatSendMessagesResponseSchema.parse(first.json());
    expect(sent).toMatchObject({ success: true, conversation_id: row.number, status: 'pending' });
    const again = await sendText('Balasan 1', 'balas-1');
    expect(mobichatSendMessagesResponseSchema.parse(again.json()).message_id).toBe(sent.message_id);

    // Rem darurat → 423.
    await harness.db
      .update(organizations)
      .set({ sendingPausedAt: new Date() })
      .where(eq(organizations.id, organizationId));
    const paused = await sendText('Balasan 2');
    expect(paused.statusCode).toBe(423);
    expect(mobichatErrorSchema.parse(paused.json()).code).toBe('SENDING_PAUSED');
    await harness.db
      .update(organizations)
      .set({ sendingPausedAt: null })
      .where(eq(organizations.id, organizationId));

    // Batas harian key = 2: satu lagi boleh, berikutnya 429.
    expect((await sendText('Balasan 3')).statusCode).toBe(200);
    const limited = await sendText('Balasan 4');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();

    // Jendela 24 jam tutup → 409 WINDOW_CLOSED.
    await harness.db
      .update(conversations)
      .set({
        lastInboundAt: new Date(Date.now() - 30 * 3600_000),
        windowExpiresAt: new Date(Date.now() - 6 * 3600_000),
      })
      .where(eq(conversations.id, row.id));
    const closed = await sendText('Balasan 5');
    expect(closed.statusCode).toBe(409);
    expect(mobichatErrorSchema.parse(closed.json()).code).toBe('WINDOW_CLOSED');
  });

  it('Bot API lama: /api/bot/reply teks, tombol & daftar berbentuk MobiChat; flow ditolak jelas', async () => {
    const { secret } = await createKey(['messages:send']);
    await receive(textMessageNotification({ body: 'Halo' }));
    const row = await onlyConversation();
    const reply = await n8n(secret, 'POST', MOBICHAT_ROUTES.botReply, {
      conversation_id: String(row.number),
      message_text: 'Halo Kak',
      message_type: 'text',
    });
    expect(reply.statusCode, reply.body).toBe(200);
    const parsed = mobichatBotReplyResponseSchema.parse(reply.json());
    expect(parsed.result.data.contacts).toEqual([{ input: WA, wa_id: WA }]);
    // Tombol (≤ 3) & daftar (≤ 10) kini didukung; flow belum; batas Meta ditegakkan.
    const button = await n8n(secret, 'POST', MOBICHAT_ROUTES.botReply, {
      conversation_id: row.number,
      message_type: 'button',
      message_text: 'Sudah bayar?',
      list_options: [
        { id: 'ya', title: 'Ya' },
        { id: 'belum', title: 'Belum' },
      ],
    });
    expect(button.statusCode, button.body).toBe(200);
    const list = await n8n(secret, 'POST', MOBICHAT_ROUTES.botReply, {
      conversation_id: row.number,
      message_type: 'list',
      message_text: 'Pilih paket',
      list_title: 'Lihat paket',
      list_options: [
        { id: 'p10', title: '10 Mbps', description: 'Rp150.000/bulan' },
        { id: 'p20', title: '20 Mbps' },
      ],
    });
    expect(list.statusCode, list.body).toBe(200);
    const tooMany = await n8n(secret, 'POST', MOBICHAT_ROUTES.botReply, {
      conversation_id: row.number,
      message_type: 'button',
      message_text: 'Pilih',
      list_options: ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id })),
    });
    expect(tooMany.statusCode).toBe(400);
    expect(mobichatBotErrorSchema.parse(tooMany.json()).error).toContain('list_options');
    const flow = await n8n(secret, 'POST', MOBICHAT_ROUTES.botReply, {
      conversation_id: row.number,
      message_type: 'flow',
      message_text: 'Isi formulir',
      flow_name: 'daftar',
    });
    expect(flow.statusCode).toBe(400);
    expect(mobichatBotErrorSchema.parse(flow.json()).error).toContain('belum didukung');
    const stored = await harness.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, row.id), eq(messages.type, 'interactive')));
    expect(stored.map((message) => message.extras.interactiveMessage?.kind).sort()).toEqual([
      'button',
      'list',
    ]);
    const missing = await n8n(secret, 'POST', MOBICHAT_ROUTES.botReply, {
      conversation_id: 999999,
      message_text: 'x',
    });
    expect(missing.statusCode).toBe(404);
  });

  it('media_url: redirect diikuti; alamat terlarang/http publik ditolak; jenis berkas tetap disaring', async () => {
    const { secret } = await createKey(['messages:send']);
    await receive(textMessageNotification({ body: 'Halo' }));
    const row = await onlyConversation();
    const media = (mediaUrl: string, mediaType = 'image') =>
      n8n(secret, 'POST', MOBICHAT_ROUTES.messages, {
        conversation_id: row.number,
        messages: [
          { message_type: 'media', media_type: mediaType, media_url: mediaUrl, caption: 'QR' },
        ],
      });
    expect((await media(`${mediaOrigin}/pindah`)).statusCode).toBe(200);
    for (const blocked of [
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/qr.png',
      'http://93.184.216.34/qr.png',
      'file:///etc/passwd',
    ]) {
      const response = await media(blocked);
      expect(response.statusCode, blocked).toBe(400);
      expect(mobichatErrorSchema.parse(response.json()).message).toContain('media_url');
    }
    expect((await media(`${mediaOrigin}/tidak-ada`)).statusCode).toBe(404);
    // Jenis tidak didukung → validasi isi berkas tetap berlaku.
    expect((await media(`${mediaOrigin}/qr/png`, 'video')).statusCode).toBe(200);
  });

  it('handoff tidak merebut percakapan dari agen; assign agen; status lain ditolak', async () => {
    const { secret } = await createKey();
    await receive(textMessageNotification({ body: 'Halo' }));
    const row = await onlyConversation();
    const cs = await insertUser(harness.db, organizationId, {
      role: 'cs',
      email: 'cs.kompat@majujaya.test',
      name: 'Sari CS',
      passwordHash: await hasher.hash('sandi-uji-kompat-mobichat-01'),
    });
    const assign = await n8n(secret, 'POST', MOBICHAT_ROUTES.agents, {
      conversation_id: row.number,
      agent_id: cs.id,
    });
    expect(assign.statusCode, assign.body).toBe(200);
    const status = mobichatConversationStatusResponseSchema.parse(
      (
        await n8n(
          secret,
          'GET',
          `${MOBICHAT_ROUTES.conversationStatus}?conversation_id=${String(row.number)}`,
        )
      ).json(),
    );
    expect(status.assignments).toEqual([
      { user: { id: cs.id, name: 'Sari CS', email: null, role: 'agent' } },
    ]);
    // Handoff tanpa agent_id saat dipegang agen: sukses tanpa perubahan.
    const release = await n8n(secret, 'POST', MOBICHAT_ROUTES.unassignAgent, {
      conversation_id: row.number,
    });
    expect(release.statusCode).toBe(200);
    expect((await onlyConversation()).assigneeUserId).toBe(cs.id);
    // agent_id angka MobiChat → agen tidak ditemukan.
    expect(
      (
        await n8n(secret, 'POST', MOBICHAT_ROUTES.agents, {
          conversation_id: row.number,
          agent_id: 12,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await n8n(secret, 'POST', MOBICHAT_ROUTES.conversationStatus, {
          conversation_id: row.number,
          status: 'bot',
        })
      ).statusCode,
    ).toBe(400);
    // Key tidak pernah mengeluarkan/mengalihkan agen manusia (review Info 2): agent_id diabaikan,
    // assign ke agen lain 409, selesai hanya untuk chat bot.
    const unassign = await n8n(secret, 'POST', MOBICHAT_ROUTES.unassignAgent, {
      conversation_id: row.number,
      agent_id: cs.id,
    });
    expect(unassign.statusCode).toBe(200);
    expect(await onlyConversation()).toMatchObject({ status: 'served', assigneeUserId: cs.id });
    const other = await insertUser(harness.db, organizationId, {
      role: 'cs',
      email: 'cs2.kompat@majujaya.test',
      name: 'Dewi CS',
      passwordHash: await hasher.hash('sandi-uji-kompat-mobichat-02'),
    });
    expect(
      (
        await n8n(secret, 'POST', MOBICHAT_ROUTES.agents, {
          conversation_id: row.number,
          agent_id: other.id,
        })
      ).statusCode,
    ).toBe(409);
    const notBot = await n8n(secret, 'POST', MOBICHAT_ROUTES.conversationStatus, {
      conversation_id: row.number,
      status: 'resolved',
    });
    expect(notBot.statusCode).toBe(409);
    // Selesai (chat dipegang bot).
    await harness.db
      .update(conversations)
      .set({ status: 'bot', assigneeUserId: null })
      .where(eq(conversations.id, row.id));
    const resolved = await n8n(secret, 'POST', MOBICHAT_ROUTES.conversationStatus, {
      conversation_id: row.number,
      status: 'resolved',
    });
    expect(resolved.statusCode).toBe(200);
    expect((await onlyConversation()).status).toBe('resolved');
    // Percakapan tak dikenal → 404; ID bukan angka → 400.
    expect(
      (await n8n(secret, 'GET', `${MOBICHAT_ROUTES.conversationStatus}?conversationId=424242`))
        .statusCode,
    ).toBe(404);
    expect(
      (await n8n(secret, 'GET', `${MOBICHAT_ROUTES.conversationStatus}?conversationId=abc`))
        .statusCode,
    ).toBe(400);
  });

  it('key dicabut di tengah: aksi tulis ditolak di transaksi akhir', async () => {
    const { secret, apiKey } = await createKey();
    await receive(textMessageNotification({ body: 'Halo' }));
    const row = await onlyConversation();
    await harness.db
      .update(conversations)
      .set({ status: 'bot' })
      .where(eq(conversations.id, row.id));
    await call(
      harness.app,
      'POST',
      apiPath(API_ROUTES.apiKeys.revoke, { apiKeyId: apiKey.id }),
      {},
      { cookie: owner.cookie, csrf: owner.csrf },
    );
    const response = await n8n(secret, 'POST', MOBICHAT_ROUTES.unassignAgent, {
      conversation_id: row.number,
    });
    expect(response.statusCode).toBe(401);
    expect((await onlyConversation()).status).toBe('bot');
    expect(
      await harness.db
        .select()
        .from(conversationEvents)
        .where(and(eq(conversationEvents.conversationId, row.id))),
    ).toHaveLength(0);
  });
});

describe('URL media bertanda tangan (unit)', () => {
  const signer = createMediaUrlSigner(
    new Secret(Buffer.alloc(32, 9)),
    'https://balesin.contoh.id/',
  );
  const kid = '00000000-0000-4000-8000-000000000001';
  const at = new Date('2026-11-17T00:00:00Z');

  it('berlaku 1 jam, terikat nomor pesan dan key', () => {
    const url = new URL(signer.url(42, kid, at) ?? '');
    expect(url.origin + url.pathname).toBe('https://balesin.contoh.id/api/public/media/42');
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig') ?? '';
    expect(signer.verify({ messageNumber: 42, exp, kid, sig }, at)).toBe(true);
    expect(signer.verify({ messageNumber: 43, exp, kid, sig }, at)).toBe(false);
    expect(signer.verify({ messageNumber: 42, exp, kid: kid.replace('1', '2'), sig }, at)).toBe(
      false,
    );
    expect(signer.verify({ messageNumber: 42, exp: exp + 60, kid, sig }, at)).toBe(false);
    expect(
      signer.verify({ messageNumber: 42, exp, kid, sig }, new Date(at.getTime() + 3601_000)),
    ).toBe(false);
  });

  it('tanpa master key: tidak ada URL dan tidak ada yang sah', () => {
    const none = createMediaUrlSigner(null, 'https://balesin.contoh.id');
    expect(none.url(1, kid, at)).toBeNull();
    expect(none.verify({ messageNumber: 1, exp: 0, kid, sig: '' }, at)).toBe(false);
  });
});
