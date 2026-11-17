/**
 * Penerima webhook WhatsApp (ROADMAP Fase 2 "Webhook masuk") di atas Postgres + Redis sungguhan.
 * Notifikasi disusun dan ditandatangani `testing/fake-meta-webhooks.ts` (bentuk contoh resmi Meta) —
 * tidak pernah memanggil Meta.
 *
 * Mencakup: jabat tangan GET (benar/salah, challenge berbahaya), tanda tangan (hilang/salah/benar,
 * satu byte diubah), batas body, idempotensi (pesan & status), routing per `phone_number_id` + WABA
 * (channel lain di URL yang sama, organisasi lain), channel nonaktif/terhapus, kejadian lama, field
 * lain, antrean gagal → 503 + pemulihan, batas laju + kejadian keamanan, dan log tanpa isi/rahasia.
 */
import { createSecretBox, sealChannelSecret, Secret, type WhatsAppSecretKind } from '@balesin/core';
import { auditLogs, channels, newId, webhookEvents } from '@balesin/db';
import { insertOrganization } from '@balesin/db/testing';
import {
  API_ROUTES,
  AUDIT_ACTIONS,
  WEBHOOK_ROUTES,
  apiPath,
  errorEnvelopeSchema,
  securitySummaryResponseSchema,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  combinedNotification,
  errorNotification,
  fakeWamid,
  handshakeQuery,
  imageMessageNotification,
  signedWebhook,
  signWebhookBody,
  statusNotification,
  templateStatusNotification,
  whatsAppNotification,
  textMessageNotification,
  unixTimestamp,
  unsupportedMessageNotification,
} from '../../testing/fake-meta';
import {
  TEST_MASTER_KEY,
  call,
  completeSetup,
  createIntegrationHarness,
  integrationConfig,
  type IntegrationHarness,
  type SignedInWithTwoFactor,
} from '../../testing/integration';
import { WEBHOOK_REJECTED_MESSAGE } from './webhook-guard';
import { WEBHOOK_BODY_LIMIT_BYTES } from './whatsapp-webhook.service';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const OTHER_APP_SECRET = 'fedcba9876543210fedcba9876543210';
const VERIFY_TOKEN = 'verify-token-acak-milik-channel-ini-0123456789';
const TOKEN = 'EAAGm0PX4ZCpsBAtokenSistemUserRahasia0123456789ABCDEF';
const WABA = '102290129340398';
const PHONE = '106540352242922';
const PHONE_2 = '106540352249999';
const PHONE_3 = '106540352240000';
const META_IP = '173.252.127.1';
const SECRET_MESSAGE = 'ISI-PESAN-RAHASIA-PELANGGAN-7731';

let harness: IntegrationHarness;
let owner: SignedInWithTwoFactor;
let organizationId: string;
let channelId: string;
const box = createSecretBox(new Secret(TEST_MASTER_KEY));

interface ChannelSeed {
  organizationId?: string;
  phoneNumberId?: string;
  wabaId?: string;
  appSecret?: string;
  verifyToken?: string;
  enabled?: boolean;
  deleted?: boolean;
  name?: string;
}

/** Channel WhatsApp langsung di database (rahasia dienkripsi seperti buatan wizard). */
async function insertChannel(seed: ChannelSeed = {}): Promise<string> {
  const id = newId();
  const owner = { id, organizationId: seed.organizationId ?? organizationId };
  const seal = (kind: WhatsAppSecretKind, value: string) =>
    sealChannelSecret(box, owner, kind, value);
  await harness.db.insert(channels).values({
    id,
    organizationId: owner.organizationId,
    type: 'whatsapp',
    name: seed.name ?? 'CS Utama',
    enabled: seed.enabled ?? true,
    waPhoneNumberId: seed.phoneNumberId ?? PHONE,
    waBusinessAccountId: seed.wabaId ?? WABA,
    ...(seed.deleted
      ? { deletedAt: new Date() }
      : {
          waAccessTokenEncrypted: seal('accessToken', TOKEN),
          waAccessTokenTail: 'CDEF',
          waAppSecretEncrypted: seal('appSecret', seed.appSecret ?? APP_SECRET),
          waAppSecretTail: 'cdef',
          waVerifyTokenEncrypted: seal('verifyToken', seed.verifyToken ?? VERIFY_TOKEN),
          waVerifyTokenRotatedAt: new Date(),
        }),
  });
  return id;
}

const urlFor = (id: string) => apiPath(WEBHOOK_ROUTES.whatsapp, { channelId: id });

interface PostOptions {
  secret?: string;
  signature?: string | null;
  rawBody?: string;
  ip?: string;
  contentType?: string;
}

function post(id: string, notification: unknown, options: PostOptions = {}) {
  const { body, headers } = signedWebhook(notification, options.secret ?? APP_SECRET, {
    signature: options.signature,
    rawBody: options.rawBody,
  });
  if (options.contentType) headers['content-type'] = options.contentType;
  return harness.app.inject({
    method: 'POST',
    url: urlFor(id),
    headers,
    payload: body,
    remoteAddress: options.ip ?? META_IP,
  });
}

function handshake(id: string, query: string, ip = META_IP) {
  return harness.app.inject({ method: 'GET', url: `${urlFor(id)}?${query}`, remoteAddress: ip });
}

async function eventsOf(id: string) {
  return harness.db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.channelId, id))
    .orderBy(webhookEvents.createdAt, webhookEvents.id);
}

async function allEvents() {
  return harness.db.select().from(webhookEvents);
}

function expectRejected(response: Awaited<ReturnType<typeof post>>) {
  expect(response.statusCode, response.body).toBe(403);
  // Tanpa alasan apa pun (tanpa header / salah / jabat tangan salah tampak sama).
  const { error } = errorEnvelopeSchema.parse(response.json());
  expect(error).toMatchObject({ code: 'FORBIDDEN', message: WEBHOOK_REJECTED_MESSAGE });
  expect(error.details).toBeUndefined();
}

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  channelId = await insertChannel();
});
afterAll(async () => {
  await harness?.close();
});

describe('jabat tangan GET', () => {
  it('verify token benar → 200 text/plain berisi hub.challenge', async () => {
    const response = await handshake(channelId, handshakeQuery(VERIFY_TOKEN, '1158201444'));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('1158201444');
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('verify token salah / mode salah / challenge berbahaya / tanpa parameter → 403 tanpa pantulan', async () => {
    const cases = [
      handshakeQuery('verify-token-salah'),
      handshakeQuery(`${VERIFY_TOKEN}x`),
      handshakeQuery(VERIFY_TOKEN.slice(0, -1)),
      handshakeQuery(VERIFY_TOKEN).replace('subscribe', 'unsubscribe'),
      handshakeQuery(VERIFY_TOKEN, '<script>alert(1)</script>'),
      handshakeQuery(VERIFY_TOKEN, 'a'.repeat(129)),
      `${handshakeQuery(VERIFY_TOKEN)}&hub.verify_token=${VERIFY_TOKEN}`,
      '',
    ];
    for (const query of cases) {
      const response = await handshake(channelId, query);
      expectRejected(response);
      expect(response.body).not.toContain('script');
      expect(response.body).not.toContain('1158201444');
    }
  });

  it('channel tidak ada / ID asal / terhapus → 404; HEAD tidak memantulkan apa pun', async () => {
    const deleted = await insertChannel({ phoneNumberId: PHONE_2, deleted: true });
    for (const id of [newId(), 'bukan-uuid', deleted]) {
      const response = await handshake(id, handshakeQuery(VERIFY_TOKEN));
      expect(response.statusCode, id).toBe(404);
    }
    const head = await harness.app.inject({
      method: 'HEAD',
      url: `${urlFor(channelId)}?${handshakeQuery(VERIFY_TOKEN)}`,
    });
    expect(head.statusCode).toBe(404);
    expect(head.body).not.toContain('1158201444');
  });

  it('channel nonaktif tetap bisa diverifikasi (memasang webhook sebelum mengaktifkan)', async () => {
    const disabled = await insertChannel({ phoneNumberId: PHONE_2, enabled: false });
    const response = await handshake(disabled, handshakeQuery(VERIFY_TOKEN, '42'));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('42');
  });

  it('verify token tidak pernah masuk log', async () => {
    await handshake(channelId, handshakeQuery(VERIFY_TOKEN));
    await handshake(channelId, handshakeQuery(`${VERIFY_TOKEN}-salah`));
    expect(harness.logs.text()).not.toContain(VERIFY_TOKEN);
  });
});

describe('POST: tanda tangan', () => {
  it('tanda tangan benar → 200, kejadian tersimpan (tanpa header/rahasia), job berisi ID saja', async () => {
    const wamid = fakeWamid();
    const response = await post(
      channelId,
      textMessageNotification({ wamid, body: SECRET_MESSAGE }),
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: 'received' });

    const [event, ...rest] = await eventsOf(channelId);
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      organizationId,
      channelId,
      source: 'whatsapp',
      kind: 'message',
      field: 'messages',
      dedupKey: `m:${wamid}`,
      externalId: wamid,
      status: 'pending',
      attempts: 0,
      lastError: null,
      processedAt: null,
    });
    const stored = JSON.stringify(event?.payload);
    expect(stored).toContain(SECRET_MESSAGE);
    for (const forbidden of [APP_SECRET, VERIFY_TOKEN, TOKEN, 'sha256=', 'x-hub-signature']) {
      expect(stored).not.toContain(forbidden);
    }
    expect(harness.webhookJobs).toEqual([{ organizationId, eventId: event?.id }]);
  });

  it('tanpa tanda tangan / format salah / App Secret lain → 403, tidak ada yang tersimpan', async () => {
    const notification = textMessageNotification();
    const body = JSON.stringify(notification);
    for (const signature of [
      null,
      '',
      signWebhookBody(body, APP_SECRET).replace('sha256=', ''),
      signWebhookBody(body, APP_SECRET).replace('sha256=', 'sha1='),
      `${signWebhookBody(body, APP_SECRET)}0`,
      signWebhookBody(body, OTHER_APP_SECRET),
      signWebhookBody(`${body} `, APP_SECRET),
    ]) {
      expectRejected(await post(channelId, notification, { signature }));
    }
    expect(await allEvents()).toEqual([]);
    expect(harness.webhookJobs).toEqual([]);
  });

  it('satu byte body diubah setelah ditandatangani → 403', async () => {
    const body = JSON.stringify(textMessageNotification({ body: 'Transfer ke rekening 1234' }));
    const signature = signWebhookBody(body, APP_SECRET);
    const tampered = body.replace('1234', '1235');
    expect(tampered).not.toBe(body);
    expectRejected(await post(channelId, undefined, { rawBody: tampered, signature }));
    expect(await allEvents()).toEqual([]);
  });

  it('body lebih dari batas → 413 sebelum diperiksa; tipe bukan JSON → 415', async () => {
    const huge = JSON.stringify({ padding: 'x'.repeat(WEBHOOK_BODY_LIMIT_BYTES) });
    const tooLarge = await post(channelId, undefined, { rawBody: huge });
    expect(tooLarge.statusCode).toBe(413);

    const plain = await post(channelId, textMessageNotification(), { contentType: 'text/plain' });
    expect(plain.statusCode).toBe(415);
    expect(await allEvents()).toEqual([]);
  });

  it('body bertanda tangan sah tetapi bukan JSON / bukan notifikasi WhatsApp → 200, diabaikan', async () => {
    const notJson = await post(channelId, undefined, { rawBody: 'bukan json' });
    expect(notJson.statusCode).toBe(200);
    const page = await post(channelId, { object: 'page', entry: [] });
    expect(page.statusCode).toBe(200);
    expect(await allEvents()).toEqual([]);
  });

  it('rahasia channel tidak bisa dibuka (master key kosong) → 503, Meta mengirim ulang', async () => {
    await harness.rebuild({ config: { ...integrationConfig(), masterKey: null } });
    try {
      const response = await post(channelId, textMessageNotification());
      expect(response.statusCode).toBe(503);
      const verify = await handshake(channelId, handshakeQuery(VERIFY_TOKEN));
      expect(verify.statusCode).toBe(503);
    } finally {
      await harness.rebuild();
    }
  });
});

describe('POST: idempotensi', () => {
  it('pesan yang sama dikirim ulang Meta → tetap satu baris; job diantre ulang hanya selama pending', async () => {
    const notification = textMessageNotification({ wamid: fakeWamid() });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await post(channelId, notification)).statusCode).toBe(200);
    }
    const events = await eventsOf(channelId);
    expect(events).toHaveLength(1);
    // ID job = ID kejadian (BullMQ tidak menggandakannya).
    expect(new Set(harness.webhookJobs.map((job) => job.eventId))).toEqual(
      new Set([events[0]?.id]),
    );

    // Sudah diproses worker → kiriman ulang berikutnya tidak diantre lagi.
    await harness.db
      .update(webhookEvents)
      .set({ status: 'processed', processedAt: new Date() })
      .where(eq(webhookEvents.channelId, channelId));
    harness.webhookJobs.length = 0;
    expect((await post(channelId, notification)).statusCode).toBe(200);
    expect(harness.webhookJobs).toEqual([]);
    expect(await eventsOf(channelId)).toHaveLength(1);
  });

  it('status unik per (wamid, status): sent/delivered/read/failed tersimpan, ulangan tidak', async () => {
    const wamid = fakeWamid();
    for (const status of ['sent', 'delivered', 'read', 'failed', 'delivered', 'read'] as const) {
      expect((await post(channelId, statusNotification({ wamid, status }))).statusCode).toBe(200);
    }
    const events = await eventsOf(channelId);
    expect(events.map((event) => event.dedupKey).sort()).toEqual(
      ['delivered', 'failed', 'read', 'sent'].map((status) => `s:${wamid}:${status}`),
    );
    expect(events.every((event) => event.kind === 'status' && event.externalId === wamid)).toBe(
      true,
    );
  });

  it('wamid sama di channel lain tidak dianggap duplikat', async () => {
    const other = await insertChannel({ phoneNumberId: PHONE_2, appSecret: OTHER_APP_SECRET });
    const wamid = fakeWamid();
    await post(channelId, textMessageNotification({ wamid }));
    await post(other, textMessageNotification({ wamid, phoneNumberId: PHONE_2 }), {
      secret: OTHER_APP_SECRET,
    });
    expect(await eventsOf(channelId)).toHaveLength(1);
    expect(await eventsOf(other)).toHaveLength(1);
  });

  it('satu notifikasi berisi pesan, gambar, status, error, tidak-didukung → satu baris per kejadian', async () => {
    const notification = combinedNotification(
      textMessageNotification(),
      imageMessageNotification(),
      unsupportedMessageNotification(),
      statusNotification({ wamid: fakeWamid(), status: 'delivered' }),
      errorNotification(),
    );
    expect((await post(channelId, notification)).statusCode).toBe(200);
    const kinds = (await eventsOf(channelId)).map((event) => event.kind).sort();
    expect(kinds).toEqual(['error', 'message', 'message', 'message', 'status']);
    expect(harness.webhookJobs).toHaveLength(5);
    // Kiriman ulang notifikasi gabungan yang sama: tidak ada baris baru (error pun terdeteksi).
    await post(channelId, notification);
    expect(await eventsOf(channelId)).toHaveLength(5);
  });

  it('bagian yang rusak dibuang tanpa menggagalkan bagian lain', async () => {
    const notification = textMessageNotification();
    const value = (notification.entry as { changes: { value: { messages: unknown[] } }[] }[])[0]!
      .changes[0]!.value;
    value.messages.push({ from: '628', timestamp: '1', type: 'text' });
    expect((await post(channelId, notification)).statusCode).toBe(200);
    expect(await eventsOf(channelId)).toHaveLength(1);
  });
});

describe('POST: routing per nomor (bukan sekadar :channelId)', () => {
  it('nomor milik channel lain di organisasi yang sama dengan App Secret SAMA → disimpan untuk channel itu', async () => {
    const sibling = await insertChannel({ phoneNumberId: PHONE_2, name: 'CS Teknis' });
    const wamid = fakeWamid();
    expect(
      (await post(channelId, textMessageNotification({ wamid, phoneNumberId: PHONE_2 })))
        .statusCode,
    ).toBe(200);
    expect(await eventsOf(channelId)).toHaveLength(0);
    const [event] = await eventsOf(sibling);
    expect(event).toMatchObject({ dedupKey: `m:${wamid}`, organizationId });
  });

  it('App Secret berbeda / nomor tak dikenal / WABA lain / channel organisasi lain → dibuang, 200', async () => {
    await insertChannel({ phoneNumberId: PHONE_2, appSecret: OTHER_APP_SECRET });
    const otherOrganization = await insertOrganization(harness.db);
    const foreign = await insertChannel({
      organizationId: otherOrganization.id,
      phoneNumberId: PHONE_3,
    });

    for (const notification of [
      textMessageNotification({ phoneNumberId: PHONE_2 }),
      textMessageNotification({ phoneNumberId: '999999999999999' }),
      textMessageNotification({ wabaId: '999999999999999' }),
      textMessageNotification({ phoneNumberId: PHONE_3 }),
      templateStatusNotification({ wabaId: '999999999999999' }),
    ]) {
      expect((await post(channelId, notification)).statusCode).toBe(200);
    }
    expect(await allEvents()).toEqual([]);
    expect(await eventsOf(foreign)).toEqual([]);
    expect(harness.logs.text()).toContain('bukan milik channel ini');
  });

  it('field tingkat WABA: status template → diantrekan (Fase 4); field lain → "skipped" tanpa job', async () => {
    expect((await post(channelId, templateStatusNotification())).statusCode).toBe(200);
    const [template] = await eventsOf(channelId);
    expect(template).toMatchObject({
      kind: 'other',
      field: 'message_template_status_update',
      status: 'pending',
      payload: {
        template: {
          metaTemplateId: '1234567890',
          name: 'tagihan_bulanan',
          language: 'id',
          event: 'APPROVED',
        },
      },
    });
    expect(harness.webhookJobs).toHaveLength(1);
    harness.webhookJobs.length = 0;
    const account = whatsAppNotification(
      { event: 'VERIFIED_ACCOUNT', phone_number: '6281100001111' },
      { field: 'account_update' },
    );
    expect((await post(channelId, account)).statusCode).toBe(200);
    const other = (await eventsOf(channelId)).find((event) => event.field === 'account_update');
    expect(other).toMatchObject({ kind: 'other', status: 'skipped' });
    expect(other?.processedAt).toBeInstanceOf(Date);
    expect(other?.payload).not.toHaveProperty('template');
    expect(harness.webhookJobs).toEqual([]);
  });

  it('kejadian lebih tua dari 8 hari dibuang (putar ulang rekaman lama)', async () => {
    const old = unixTimestamp(new Date(Date.now() - 9 * 24 * 60 * 60 * 1000));
    const recent = unixTimestamp(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
    await post(channelId, textMessageNotification({ timestamp: old }));
    await post(channelId, textMessageNotification({ timestamp: recent }));
    expect(await eventsOf(channelId)).toHaveLength(1);
  });
});

describe('POST: channel nonaktif / terhapus', () => {
  it('nonaktif: tanda tangan sah → 200 tetapi dibuang; tanda tangan salah tetap 403', async () => {
    const disabled = await insertChannel({ phoneNumberId: PHONE_2, enabled: false });
    const notification = textMessageNotification({ phoneNumberId: PHONE_2 });
    expect((await post(disabled, notification)).statusCode).toBe(200);
    expectRejected(await post(disabled, notification, { secret: OTHER_APP_SECRET }));
    expect(await allEvents()).toEqual([]);
    expect(harness.webhookJobs).toEqual([]);
    // Saudara nonaktif juga tidak menerima kejadian yang dialihkan.
    expect((await post(channelId, notification)).statusCode).toBe(200);
    expect(await allEvents()).toEqual([]);
  });

  it('terhapus: 404 tanpa memeriksa rahasia (sudah dimusnahkan)', async () => {
    const deleted = await insertChannel({ phoneNumberId: PHONE_2, deleted: true });
    expect(
      (await post(deleted, textMessageNotification({ phoneNumberId: PHONE_2 }))).statusCode,
    ).toBe(404);
    expect((await post(newId(), textMessageNotification())).statusCode).toBe(404);
    expect((await post('bukan-uuid', textMessageNotification())).statusCode).toBe(404);
    expect(await allEvents()).toEqual([]);
  });
});

describe('POST: antrean gagal', () => {
  it('kejadian tersimpan tetapi antrean mati → 503; kiriman ulang Meta mengantre baris yang sama', async () => {
    await harness.rebuild({
      webhookQueue: { enqueue: () => Promise.reject(new Error('Redis mati')) },
    });
    try {
      const notification = textMessageNotification({ wamid: fakeWamid() });
      const failed = await post(channelId, notification);
      expect(failed.statusCode).toBe(503);
      const [event] = await eventsOf(channelId);
      expect(event?.status).toBe('pending');

      await harness.rebuild();
      const retried = await post(channelId, notification);
      expect(retried.statusCode).toBe(200);
      expect(await eventsOf(channelId)).toHaveLength(1);
      expect(harness.webhookJobs).toEqual([{ organizationId, eventId: event?.id }]);
    } finally {
      await harness.rebuild();
    }
  });
});

describe('batas laju & penyalahgunaan', () => {
  it('tanda tangan salah beruntun: 429 untuk IP itu saja, Meta (IP lain, tanda tangan benar) tetap diterima', async () => {
    const attacker = '203.0.113.9';
    const notification = textMessageNotification();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expectRejected(
        await post(channelId, notification, { secret: OTHER_APP_SECRET, ip: attacker }),
      );
    }
    const blocked = await post(channelId, notification, { secret: OTHER_APP_SECRET, ip: attacker });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    // Bahkan tanda tangan benar dari IP itu ditahan dulu (tidak membaca body sama sekali).
    expect((await post(channelId, notification, { ip: attacker })).statusCode).toBe(429);

    expect((await post(channelId, notification)).statusCode).toBe(200);
    expect(await eventsOf(channelId)).toHaveLength(1);
  });

  it('≥ 10 tanda tangan salah pada satu channel → satu kejadian keamanan (warning), tanpa payload', async () => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await post(channelId, textMessageNotification({ body: SECRET_MESSAGE }), {
        secret: OTHER_APP_SECRET,
        ip: `198.51.100.${attempt + 1}`,
      });
    }
    const rows = await harness.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, organizationId),
          eq(auditLogs.action, AUDIT_ACTIONS.channelWebhookSignatureRejected),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      targetType: 'channel',
      targetId: channelId,
      metadata: {
        name: 'CS Utama',
        phoneNumberId: PHONE,
        failures: 10,
        windowMinutes: 10,
        reason: 'signature_mismatch',
        // R1: banyak IP berbeda (pola "App Secret salah"), awalan saja — bukan alamat lengkap.
        distinctSources: 10,
        topSource: '198.51.100.0/24',
        topSourceFailures: 1,
      },
    });
    expect(JSON.stringify(rows[0])).not.toContain(SECRET_MESSAGE);

    const summary = await call(harness.app, 'GET', API_ROUTES.audit.securitySummary, undefined, {
      cookie: owner.cookie,
    });
    expect(summary.statusCode, summary.body).toBe(200);
    const parsed = securitySummaryResponseSchema.parse(summary.json());
    expect(parsed.counts.webhook_signature_failed).toBe(1);
    expect(parsed.events.find((event) => event.kind === 'webhook_signature_failed')).toMatchObject({
      severity: 'warning',
      actor: null,
      details: {
        name: 'CS Utama',
        phoneNumberId: PHONE,
        failures: 10,
        distinctSources: 10,
        topSource: '198.51.100.0/24',
      },
    });
    expect(parsed.latestWarningAt).not.toBeNull();
  });

  it('jabat tangan salah tidak memicu kejadian keamanan, tetapi tetap dibatasi per IP', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expectRejected(await handshake(channelId, handshakeQuery('tebakan')));
    }
    expect((await handshake(channelId, handshakeQuery(VERIFY_TOKEN))).statusCode).toBe(429);
    expect((await handshake(channelId, handshakeQuery(VERIFY_TOKEN), '10.9.9.9')).statusCode).toBe(
      200,
    );
    const alarms = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.channelWebhookSignatureRejected));
    expect(alarms).toEqual([]);
  });

  it('menebak ID channel dari satu IP → 429 setelah 30 percobaan (hanya untuk ID tak dikenal); channel terhapus tidak dihitung', async () => {
    const deleted = await insertChannel({ phoneNumberId: PHONE_2, deleted: true });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      expect((await post(deleted, textMessageNotification())).statusCode).toBe(404);
    }
    expect((await post(channelId, textMessageNotification())).statusCode).toBe(200);

    const scanner = '192.0.2.77';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await post(newId(), textMessageNotification(), { ip: scanner })).statusCode).toBe(
        404,
      );
    }
    expect((await post(newId(), textMessageNotification(), { ip: scanner })).statusCode).toBe(429);
    expect((await handshake(newId(), handshakeQuery('x'), scanner)).statusCode).toBe(429);
    // Channel yang ADA tidak ikut tertahan (review webhook S1 butir 2).
    expect((await post(channelId, textMessageNotification(), { ip: scanner })).statusCode).toBe(
      200,
    );
    expect((await handshake(channelId, handshakeQuery(VERIFY_TOKEN), scanner)).statusCode).toBe(
      200,
    );
  });

  it('tanda tangan POST salah hanya menahan POST: jabat tangan GET dari IP itu tetap dilayani (S1)', async () => {
    const attacker = '203.0.113.20';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expectRejected(
        await post(channelId, textMessageNotification(), {
          secret: OTHER_APP_SECRET,
          ip: attacker,
        }),
      );
    }
    expect((await post(channelId, textMessageNotification(), { ip: attacker })).statusCode).toBe(
      429,
    );
    expect((await handshake(channelId, handshakeQuery(VERIFY_TOKEN), attacker)).statusCode).toBe(
      200,
    );
  });

  it('kejadian keamanan dari SATU IP: sumber berbeda 1, kegagalan terbanyak = semuanya (R1)', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await post(channelId, textMessageNotification(), {
        secret: OTHER_APP_SECRET,
        ip: '203.0.113.30',
      });
    }
    const [alarm] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AUDIT_ACTIONS.channelWebhookSignatureRejected));
    expect(alarm?.metadata).toMatchObject({
      failures: 10,
      distinctSources: 1,
      topSource: '203.0.113.0/24',
      topSourceFailures: 10,
    });
    expect(JSON.stringify(alarm?.metadata)).not.toContain('203.0.113.30');
  });
});

describe('pengerasan setelah review webhook (S2, R2, R4)', () => {
  it('teks "beracun" disimpan dalam bentuk bersih (NUL dibuang, surrogate → U+FFFD)', async () => {
    const wamid = fakeWamid();
    const response = await post(
      channelId,
      textMessageNotification({
        wamid,
        body: 'halo\u0000kak \ud83d',
        customer: { name: 'Bu\u0000di' },
      }),
    );
    expect(response.statusCode, response.body).toBe(200);
    const [event] = await eventsOf(channelId);
    const payload = event?.payload as {
      message: { text: { body: string } };
      contact: { profile: { name: string } };
    };
    expect(payload.message.text.body).toBe('halokak \ufffd');
    expect(payload.contact.profile.name).toBe('Budi');
    expect(event?.externalId).toBe(wamid);
  });

  it('cap waktu > 1 jam di masa depan dibuang; sedikit di depan (jam Meta lebih cepat) diterima (R4)', async () => {
    const future = unixTimestamp(new Date(Date.now() + 2 * 60 * 60 * 1000));
    const nearFuture = unixTimestamp(new Date(Date.now() + 30 * 60 * 1000));
    const far = fakeWamid();
    const near = fakeWamid();
    expect(
      (await post(channelId, textMessageNotification({ wamid: far, timestamp: future })))
        .statusCode,
    ).toBe(200);
    expect(
      (await post(channelId, textMessageNotification({ wamid: near, timestamp: nearFuture })))
        .statusCode,
    ).toBe(200);
    expect((await eventsOf(channelId)).map((event) => event.externalId)).toEqual([near]);
    expect(harness.logs.text()).toContain('masa depan');
  });

  it('satu notifikasi untuk beberapa nomor: saudara dimuat sekaligus dan setiap kejadian ke pemiliknya (R2)', async () => {
    const second = await insertChannel({ phoneNumberId: PHONE_2, name: 'CS Teknis' });
    const third = await insertChannel({ phoneNumberId: PHONE_3, name: 'CS Tagihan' });
    const notification = combinedNotification(
      textMessageNotification(),
      textMessageNotification({ phoneNumberId: PHONE_2 }),
      textMessageNotification({ phoneNumberId: PHONE_3 }),
      textMessageNotification({ phoneNumberId: '999999999999999' }),
    );
    expect((await post(channelId, notification)).statusCode).toBe(200);
    expect(await eventsOf(channelId)).toHaveLength(1);
    expect(await eventsOf(second)).toHaveLength(1);
    expect(await eventsOf(third)).toHaveLength(1);
    expect(harness.logs.text()).toContain('bukan milik channel ini');
  });
});

describe('privasi log', () => {
  it('tidak ada isi pesan, nomor pelanggan, App Secret, tanda tangan, atau verify token di log', async () => {
    const notification = textMessageNotification({ body: SECRET_MESSAGE });
    const body = JSON.stringify(notification);
    await post(channelId, notification);
    await post(channelId, notification, { secret: OTHER_APP_SECRET });
    await post(channelId, notification, { signature: null });
    await post(
      channelId,
      textMessageNotification({ body: SECRET_MESSAGE, phoneNumberId: PHONE_3 }),
    );
    await handshake(channelId, handshakeQuery(VERIFY_TOKEN));

    const text = harness.logs.text();
    expect(text).toContain('Webhook WhatsApp diterima');
    expect(text).toContain('Webhook ditolak');
    for (const forbidden of [
      SECRET_MESSAGE,
      '6281234567890',
      'Budi Santoso',
      APP_SECRET,
      OTHER_APP_SECRET,
      VERIFY_TOKEN,
      signWebhookBody(body, APP_SECRET).slice(7),
      signWebhookBody(body, OTHER_APP_SECRET).slice(7),
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});
