/**
 * Channel WhatsApp Cloud API (ROADMAP Fase 2 butir 1–2) di atas Postgres + Redis sungguhan dan
 * server Graph API TIRUAN lokal (`testing/fake-meta.ts`) — tidak pernah memanggil Meta sungguhan.
 *
 * Mencakup: wizard (buat, validasi, URL webhook + verify token), enkripsi kredensial + petunjuk
 * tersamar, tes koneksi (berhasil + kasus error Meta), ganti kredensial dengan konfirmasi identitas,
 * nonaktifkan/hapus, profil bisnis, batas laju, dan penyalahgunaan: CS/Supervisor ke pengaturan &
 * verify token, IDOR lintas organisasi, rahasia tidak pernah muncul di respons/log/audit. Juga
 * pemberitahuan ke Owner (job antrean + kejadian `channel_changed` di ringkasan keamanan) saat
 * channel diubah oleh selain Owner.
 */
import { appSecretProof, createSecretBox, Secret, WHATSAPP_SECRET_PURPOSES } from '@balesin/core';
import { auditLogs, channels } from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  channelResponseSchema,
  channelSettingsListResponseSchema,
  channelSummaryListResponseSchema,
  channelTestResultSchema,
  channelWebhookResponseSchema,
  createChannelResponseSchema,
  errorEnvelopeSchema,
  businessProfileResponseSchema,
  securitySummaryResponseSchema,
  updateBusinessProfileResponseSchema,
  type ErrorEnvelope,
  type UserRole,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startFakeMeta, metaErrorBody, type FakeMeta } from '../../testing/fake-meta';
import {
  OWNER,
  TEST_MASTER_KEY,
  call,
  completeSetup,
  createIntegrationHarness,
  freshTotpCode,
  login,
  type CallOptions,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { createPasswordHasher } from '../auth/password-hasher';

const TOKEN = 'EAAGm0PX4ZCpsBAtokenSistemUserRahasia0123456789ABCDEF';
const TOKEN_2 = 'EAAGm0PX4ZCpsBAtokenBaruYangLainSekali9876543210ZYXW';
const APP_SECRET = '0123456789abcdef0123456789abcdef';
const PHONE_ID = '106540352242922';
const PHONE_ID_2 = '106540352249999';
const WABA_ID = '102290129340398';

let harness: IntegrationHarness;
let fake: FakeMeta;
const hasher = createPasswordHasher();
const PASSWORD = 'sandi-anggota-channel-01';

/** Semua respons sepanjang berkas tes — diperiksa tidak pernah memuat token/App Secret. */
const bodies: string[] = [];

beforeAll(async () => {
  fake = await startFakeMeta();
  harness = await createIntegrationHarness({
    config: { metaGraphBaseUrl: fake.url, apiUrl: 'https://balesin.contoh.co.id/api' },
    overrides: { meta: { sleep: () => Promise.resolve() } },
  });
});
beforeEach(async () => {
  await harness.reset();
  fake.reset();
  fake.tokens.set(TOKEN, { appSecret: APP_SECRET });
  fake.tokens.set(TOKEN_2, { appSecret: APP_SECRET });
  fake.wabas.add(WABA_ID);
  fake.phoneNumbers.set(PHONE_ID, {
    id: PHONE_ID,
    wabaId: WABA_ID,
    display_phone_number: '+62 811-2345-678',
    verified_name: 'Maju Jaya',
    quality_rating: 'GREEN',
    status: 'CONNECTED',
    name_status: 'APPROVED',
    code_verification_status: 'VERIFIED',
    whatsapp_business_manager_messaging_limit: 'TIER_2K',
    throughput: { level: 'STANDARD' },
    profile: {
      about: 'Layanan pelanggan',
      websites: ['https://majujaya.test'],
      vertical: 'RETAIL',
    },
  });
});
afterAll(async () => {
  await harness?.close();
  await fake?.close();
});

type Response = Awaited<ReturnType<typeof call>>;

const DEFAULT_OPTIONS = () => ({
  config: { metaGraphBaseUrl: fake.url, apiUrl: 'https://balesin.contoh.co.id/api' },
  overrides: { meta: { sleep: () => Promise.resolve() } },
});
const rebuildDefault = () => harness.rebuild(DEFAULT_OPTIONS());
const routes = API_ROUTES.channels;

const as = (signed: { cookie: string; csrf: string }): CallOptions => ({
  cookie: signed.cookie,
  csrf: signed.csrf,
});

async function send(
  signed: SignedIn,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
) {
  const response = await call(harness.app, method, url, body, as(signed));
  bodies.push(response.body);
  return response;
}

function errorOf(response: Response): ErrorEnvelope['error'] {
  return errorEnvelopeSchema.parse(response.json()).error;
}

const path = (template: string, channelId: string) => apiPath(template, { channelId });

async function member(owner: SignedIn, role: UserRole): Promise<SignedIn> {
  const email = `${role}-${Math.random().toString(36).slice(2, 8)}@majujaya.test`;
  await insertUser(harness.db, owner.session.organization.id, {
    role,
    email,
    name: `Pengguna ${role}`,
    passwordHash: await hasher.hash(PASSWORD),
  });
  return login(harness.app, { email, password: PASSWORD });
}

const wizardBody = (overrides: Record<string, unknown> = {}) => ({
  type: 'whatsapp',
  name: 'CS Utama',
  phoneNumberId: PHONE_ID,
  wabaId: WABA_ID,
  accessToken: TOKEN,
  appSecret: APP_SECRET,
  ...overrides,
});

async function createChannel(owner: SignedIn, overrides: Record<string, unknown> = {}) {
  const response = await send(owner, 'POST', routes.settings, wizardBody(overrides));
  expect(response.statusCode, response.body).toBe(201);
  return createChannelResponseSchema.parse(response.json());
}

async function testChannel(owner: SignedIn, channelId: string) {
  const response = await send(owner, 'POST', path(routes.test, channelId));
  expect(response.statusCode, response.body).toBe(200);
  return channelTestResultSchema.parse(response.json());
}

const ownerConfirmation = async () => ({
  password: OWNER.password,
  code: await freshTotpCode(OWNER.email),
});

async function channelRow(id: string) {
  const [row] = await harness.db.select().from(channels).where(eq(channels.id, id));
  if (!row) throw new Error('Channel tidak ada');
  return row;
}

describe('wizard: buat channel', () => {
  it('201: channel + webhook; rahasia hanya tersamar; tersimpan terenkripsi terikat channel', async () => {
    const owner = await completeSetup(harness.app);
    const { channel, webhook } = await createChannel(owner);

    expect(channel).toMatchObject({
      type: 'whatsapp',
      name: 'CS Utama',
      enabled: true,
      status: 'untested',
      phoneNumberId: PHONE_ID,
      wabaId: WABA_ID,
      accessTokenHint: `••••${TOKEN.slice(-4)}`,
      appSecretHint: `••••${APP_SECRET.slice(-4)}`,
      lastTest: null,
      number: null,
      warnings: [],
    });
    expect(channel.webhookUrl).toBe(
      `https://balesin.contoh.co.id/api/webhooks/whatsapp/${channel.id}`,
    );
    expect(webhook).toMatchObject({
      channelId: channel.id,
      callbackUrl: channel.webhookUrl,
      subscribeFields: ['messages', 'message_template_status_update', 'account_update'],
      warning: null,
    });
    expect(webhook.verifyToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await channelRow(channel.id);
    const stored = JSON.stringify(row);
    for (const secret of [TOKEN, APP_SECRET, webhook.verifyToken]) {
      expect(stored).not.toContain(secret);
    }
    const box = createSecretBox(new Secret(TEST_MASTER_KEY));
    const context = (purpose: string, subjectId = channel.id) => ({
      organizationId: owner.session.organization.id,
      purpose,
      subjectId,
    });
    expect(
      box.decrypt(row.waAccessTokenEncrypted ?? '', context(WHATSAPP_SECRET_PURPOSES.accessToken)),
    ).toBe(TOKEN);
    expect(
      box.decrypt(row.waVerifyTokenEncrypted ?? '', context(WHATSAPP_SECRET_PURPOSES.verifyToken)),
    ).toBe(webhook.verifyToken);
    // Teks sandi terikat channel & kolom: konteks lain tidak bisa membukanya.
    expect(() =>
      box.decrypt(
        row.waAccessTokenEncrypted ?? '',
        context(WHATSAPP_SECRET_PURPOSES.accessToken, '00000000-0000-4000-8000-000000000000'),
      ),
    ).toThrow();
    expect(() =>
      box.decrypt(row.waAccessTokenEncrypted ?? '', context(WHATSAPP_SECRET_PURPOSES.appSecret)),
    ).toThrow();

    const [audit] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'channel.created'));
    expect(audit).toMatchObject({ targetType: 'channel', targetId: channel.id });
    expect(audit?.metadata).toEqual({
      type: 'whatsapp',
      name: 'CS Utama',
      phoneNumberId: PHONE_ID,
      wabaId: WABA_ID,
      change: 'created',
      actorRole: 'owner',
      ownersNotified: false,
    });
  });

  it('400 per isian dengan pesan Indonesia; token ditempel dengan spasi tepi tetap diterima', async () => {
    const owner = await completeSetup(harness.app);
    const bad = await send(
      owner,
      'POST',
      routes.settings,
      wizardBody({
        name: ' ',
        phoneNumberId: '12a',
        wabaId: '',
        accessToken: 'EAA token dengan spasi panjang sekali',
        appSecret: 'pendek',
      }),
    );
    expect(bad.statusCode).toBe(400);
    const fields = errorOf(bad).details?.map((detail) => detail.field) ?? [];
    expect(fields).toEqual(
      expect.arrayContaining(['name', 'phoneNumberId', 'wabaId', 'accessToken', 'appSecret']),
    );

    const unsupported = await send(owner, 'POST', routes.settings, { type: 'telegram' });
    expect(unsupported.statusCode).toBe(400);

    const { channel } = await createChannel(owner, { accessToken: `  ${TOKEN}\n` });
    expect(channel.accessTokenHint).toBe(`••••${TOKEN.slice(-4)}`);
  });

  it('409 bila Phone Number ID sudah menjadi channel lain; setelah dihapus boleh dibuat lagi', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    const duplicate = await send(owner, 'POST', routes.settings, wizardBody({ name: 'Kembar' }));
    expect(duplicate.statusCode).toBe(409);
    expect(errorOf(duplicate).details?.[0]?.field).toBe('phoneNumberId');

    const removed = await send(
      owner,
      'DELETE',
      path(routes.channel, channel.id),
      await ownerConfirmation(),
    );
    expect(removed.statusCode, removed.body).toBe(200);
    await createChannel(owner, { name: 'CS Utama (baru)' });
  });

  it('503 tanpa BALESIN_MASTER_KEY: kredensial tidak pernah disimpan polos', async () => {
    const owner = await completeSetup(harness.app);
    await harness.rebuild({
      config: { metaGraphBaseUrl: fake.url, masterKey: null },
      overrides: { meta: { sleep: () => Promise.resolve() } },
    });
    try {
      const list = channelSettingsListResponseSchema.parse(
        (await send(owner, 'GET', routes.settings)).json(),
      );
      expect(list.canStoreSecrets).toBe(false);
      const response = await send(owner, 'POST', routes.settings, wizardBody());
      expect(response.statusCode).toBe(503);
      expect(errorOf(response).message).toContain('BALESIN_MASTER_KEY');
      expect(await harness.db.select().from(channels)).toHaveLength(0);
    } finally {
      await rebuildDefault();
    }
  });
});

describe('tes koneksi', () => {
  it('berhasil: status terhubung + data nomor; appsecret_proof & versi terkunci dikirim; token di header', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    const result = await testChannel(owner, channel.id);

    expect(result).toMatchObject({ ok: true, code: 'ok', warnings: [] });
    expect(result.number).toMatchObject({
      displayPhoneNumber: '+62 811-2345-678',
      verifiedName: 'Maju Jaya',
      qualityRating: 'GREEN',
      status: 'CONNECTED',
      messagingLimit: 'TIER_2K',
      throughputLevel: 'STANDARD',
    });

    for (const request of fake.requests) {
      expect(request.version).toBe('v26.0');
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.query.appsecret_proof).toBe(appSecretProof(TOKEN, APP_SECRET));
      expect(JSON.stringify(request.query)).not.toContain(TOKEN);
    }
    expect(fake.requests.map((request) => request.path)).toEqual([
      `/${PHONE_ID}`,
      `/${WABA_ID}/phone_numbers`,
    ]);

    const detail = channelResponseSchema.parse(
      (await send(owner, 'GET', path(routes.channel, channel.id))).json(),
    ).channel;
    expect(detail.status).toBe('connected');
    expect(detail.lastTest).toMatchObject({ ok: true, code: 'ok' });
    expect(detail.number?.verifiedName).toBe('Maju Jaya');

    // Nama tampilan dari tes muncul di ringkasan inbox.
    const summary = channelSummaryListResponseSchema.parse(
      (await send(owner, 'GET', routes.list)).json(),
    );
    expect(summary.channels).toEqual([
      {
        id: channel.id,
        type: 'whatsapp',
        name: 'CS Utama',
        enabled: true,
        displayPhoneNumber: '+62 811-2345-678',
      },
    ]);
  });

  it('peringatan untuk kualitas rendah, nomor belum terhubung, nama belum disetujui', async () => {
    const owner = await completeSetup(harness.app);
    const number = fake.phoneNumbers.get(PHONE_ID);
    if (number) {
      number.quality_rating = 'RED';
      number.status = 'PENDING';
      number.name_status = 'PENDING_REVIEW';
    }
    const { channel } = await createChannel(owner);
    const result = await testChannel(owner, channel.id);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'number_not_connected',
      'quality_low',
      'display_name_not_approved',
    ]);
  });

  it.each([
    ['token salah', () => fake.tokens.delete(TOKEN), 'token_invalid', /Pengguna Sistem/],
    [
      'token kedaluwarsa',
      () => fake.tokens.set(TOKEN, { appSecret: APP_SECRET, expired: true }),
      'token_expired',
      /kedaluwarsa/,
    ],
    [
      'App Secret salah (appsecret_proof ditolak)',
      () => fake.tokens.set(TOKEN, { appSecret: 'fedcba9876543210fedcba9876543210' }),
      'app_secret_invalid',
      /App Secret/,
    ],
    [
      'izin kurang',
      () => fake.tokens.set(TOKEN, { appSecret: APP_SECRET, noPermission: true }),
      'permission_denied',
      /whatsapp_business_management/,
    ],
    [
      'Phone Number ID tidak ditemukan',
      () => fake.phoneNumbers.delete(PHONE_ID),
      'phone_number_not_found',
      /Phone Number ID/,
    ],
    ['WABA tidak ditemukan', () => fake.wabas.delete(WABA_ID), 'waba_not_found', /WABA ID/],
    [
      'nomor bukan milik WABA',
      () => {
        const number = fake.phoneNumbers.get(PHONE_ID);
        if (number) number.wabaId = '999999999999';
      },
      'phone_number_waba_mismatch',
      /tidak termasuk/,
    ],
    [
      'nomor belum terdaftar (133010)',
      () =>
        fake.failNext(`/${PHONE_ID}`, {
          status: 400,
          body: metaErrorBody(133010, 'Account not registered'),
        }),
      'phone_not_registered',
      /pendaftaran nomor/,
    ],
  ])('%s → %s', async (_label, arrange, code, message) => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    arrange();
    const result = await testChannel(owner, channel.id);
    expect(result).toMatchObject({ ok: false, code });
    expect(result.message).toMatch(message);

    const detail = channelResponseSchema.parse(
      (await send(owner, 'GET', path(routes.channel, channel.id))).json(),
    ).channel;
    expect(detail.status).toBe('failed');
    expect(detail.lastTest?.code).toBe(code);
  });

  it('gangguan sementara Meta diulang otomatis; batas laju Meta dilaporkan rate_limited', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    fake.failNext(`/${PHONE_ID}`, { status: 500, body: metaErrorBody(2, 'Service unavailable') });
    expect((await testChannel(owner, channel.id)).code).toBe('ok');

    fake.failNext(`/${PHONE_ID}`, {
      status: 400,
      body: metaErrorBody(80007, 'Rate limit hit'),
      headers: { 'retry-after': '600' },
    });
    expect((await testChannel(owner, channel.id)).code).toBe('rate_limited');
    // Nomor itu "didinginkan" di proses ini: tes berikutnya tidak memanggil Meta sama sekali.
    fake.requests.length = 0;
    expect((await testChannel(owner, channel.id)).code).toBe('rate_limited');
    expect(fake.requests).toHaveLength(0);
    // Klien baru (masa dingin hilang) supaya tes lain tidak ikut terkena.
    await rebuildDefault();
  });

  it('versi API lama tanpa isian baru: diulang dengan isian dasar', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    fake.failNext(`/${PHONE_ID}`, {
      status: 400,
      body: metaErrorBody(
        100,
        '(#100) Tried accessing nonexisting field (whatsapp_business_manager_messaging_limit)',
      ),
    });
    const result = await testChannel(owner, channel.id);
    expect(result.code).toBe('ok');
    expect(result.number?.messagingLimit).toBeNull();
  });

  it('kredensial yang tidak bisa dibuka (master key berganti) → secret_unavailable', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    await harness.db
      .update(channels)
      .set({ waAccessTokenEncrypted: 'v1.rusak.rusak' })
      .where(eq(channels.id, channel.id));
    const result = await testChannel(owner, channel.id);
    expect(result).toMatchObject({ ok: false, code: 'secret_unavailable' });
    expect(fake.requests).toHaveLength(0);
  });

  it('429 setelah 10 tes per 5 menit per pengguna', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    for (let index = 0; index < 10; index += 1) await testChannel(owner, channel.id);
    const limited = await send(owner, 'POST', path(routes.test, channel.id));
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(errorOf(limited).message).toContain('tes koneksi');
  });
});

describe('ubah, nonaktifkan, hapus', () => {
  it('ganti nama tanpa konfirmasi; ganti token WAJIB konfirmasi identitas; status kembali belum dites', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    await testChannel(owner, channel.id);

    const renamed = await send(owner, 'PATCH', path(routes.channel, channel.id), {
      name: 'CS Kedua',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(channelResponseSchema.parse(renamed.json()).channel).toMatchObject({
      name: 'CS Kedua',
      status: 'connected',
    });

    // Token yang SAMA dengan yang tersimpan bukan penggantian: tidak perlu konfirmasi.
    const same = await send(owner, 'PATCH', path(routes.channel, channel.id), {
      accessToken: TOKEN,
    });
    expect(same.statusCode).toBe(200);

    const unconfirmed = await send(owner, 'PATCH', path(routes.channel, channel.id), {
      accessToken: TOKEN_2,
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(errorOf(unconfirmed).details?.[0]?.field).toBe('confirmation.password');

    const wrong = await send(owner, 'PATCH', path(routes.channel, channel.id), {
      accessToken: TOKEN_2,
      confirmation: { password: 'bukan-password-owner-99', code: await freshTotpCode(OWNER.email) },
    });
    expect(wrong.statusCode).toBe(400);
    expect(errorOf(wrong).details?.[0]?.field).toBe('confirmation.password');

    const replaced = await send(owner, 'PATCH', path(routes.channel, channel.id), {
      accessToken: TOKEN_2,
      confirmation: await ownerConfirmation(),
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const after = channelResponseSchema.parse(replaced.json()).channel;
    expect(after).toMatchObject({
      accessTokenHint: `••••${TOKEN_2.slice(-4)}`,
      appSecretHint: `••••${APP_SECRET.slice(-4)}`,
      status: 'untested',
      lastTest: null,
      number: null,
    });

    // App Secret tetap yang lama (tidak perlu diisi ulang) dan token baru dipakai.
    fake.requests.length = 0;
    expect((await testChannel(owner, channel.id)).code).toBe('ok');
    expect(fake.requests[0]?.authorization).toBe(`Bearer ${TOKEN_2}`);

    const updates = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'channel.updated'));
    expect(updates.map((row) => row.metadata.changedFields)).toEqual([['name'], ['accessToken']]);
  });

  it('nonaktifkan / aktifkan tercatat di audit', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    const disabled = await send(owner, 'POST', path(routes.disable, channel.id));
    expect(channelResponseSchema.parse(disabled.json()).channel.enabled).toBe(false);
    const enabled = await send(owner, 'POST', path(routes.enable, channel.id));
    expect(channelResponseSchema.parse(enabled.json()).channel.enabled).toBe(true);
    const actions = (await harness.db.select().from(auditLogs)).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['channel.disabled', 'channel.enabled']));
  });

  it('hapus wajib konfirmasi; rahasia dimusnahkan; channel hilang dari semua daftar', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);

    const missing = await send(owner, 'DELETE', path(routes.channel, channel.id), {});
    expect(missing.statusCode).toBe(400);
    const wrong = await send(owner, 'DELETE', path(routes.channel, channel.id), {
      password: 'bukan-password-owner-99',
      code: await freshTotpCode(OWNER.email),
    });
    expect(wrong.statusCode).toBe(400);
    expect(errorOf(wrong).details?.[0]?.field).toBe('password');

    const removed = await send(
      owner,
      'DELETE',
      path(routes.channel, channel.id),
      await ownerConfirmation(),
    );
    expect(removed.json()).toEqual({ status: 'deleted' });

    const row = await channelRow(channel.id);
    expect(row.deletedAt).not.toBeNull();
    expect(row).toMatchObject({
      waAccessTokenEncrypted: null,
      waAppSecretEncrypted: null,
      waVerifyTokenEncrypted: null,
      enabled: false,
    });
    expect((await send(owner, 'GET', path(routes.channel, channel.id))).statusCode).toBe(404);
    expect((await send(owner, 'GET', path(routes.webhook, channel.id))).statusCode).toBe(404);
    expect(
      channelSettingsListResponseSchema.parse((await send(owner, 'GET', routes.settings)).json())
        .channels,
    ).toEqual([]);
    expect(
      channelSummaryListResponseSchema.parse((await send(owner, 'GET', routes.list)).json())
        .channels,
    ).toEqual([]);
  });
});

describe('webhook: URL + verify token', () => {
  it('verify token dibuat ulang: yang lama tidak berlaku; tercatat di audit tanpa nilainya', async () => {
    const owner = await completeSetup(harness.app);
    const { channel, webhook } = await createChannel(owner);
    const shown = channelWebhookResponseSchema.parse(
      (await send(owner, 'GET', path(routes.webhook, channel.id))).json(),
    );
    expect(shown.verifyToken).toBe(webhook.verifyToken);

    const rotated = channelWebhookResponseSchema.parse(
      (await send(owner, 'POST', path(routes.rotateVerifyToken, channel.id))).json(),
    );
    expect(rotated.verifyToken).not.toBe(webhook.verifyToken);
    const again = channelWebhookResponseSchema.parse(
      (await send(owner, 'GET', path(routes.webhook, channel.id))).json(),
    );
    expect(again.verifyToken).toBe(rotated.verifyToken);

    const audit = JSON.stringify(await harness.db.select().from(auditLogs));
    expect(audit).toContain('channel.webhook_verify_token_rotated');
    expect(audit).not.toContain(webhook.verifyToken);
    expect(audit).not.toContain(rotated.verifyToken);
  });

  it('API_URL http/localhost → peringatan bahwa Meta butuh https publik', async () => {
    await harness.rebuild({
      config: { metaGraphBaseUrl: fake.url, apiUrl: 'http://localhost:3000' },
      overrides: { meta: { sleep: () => Promise.resolve() } },
    });
    try {
      const owner = await completeSetup(harness.app);
      const { webhook } = await createChannel(owner);
      expect(webhook.callbackUrl).toMatch(/^http:\/\/localhost:3000\/webhooks\/whatsapp\//);
      expect(webhook.warning).toContain('https');
    } finally {
      await rebuildDefault();
    }
  });
});

describe('profil bisnis', () => {
  it('baca dan ubah: hanya isian yang dikirim diteruskan ke Meta; audit menyebut nama isian', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    const read = await send(owner, 'GET', path(routes.businessProfile, channel.id));
    expect(read.statusCode, read.body).toBe(200);
    expect(businessProfileResponseSchema.parse(read.json()).profile).toEqual({
      about: 'Layanan pelanggan',
      address: null,
      description: null,
      email: null,
      websites: ['https://majujaya.test'],
      vertical: 'RETAIL',
    });

    fake.requests.length = 0;
    const updated = await send(owner, 'PUT', path(routes.businessProfile, channel.id), {
      description: 'Internet rumahan 😊\nBuka 08.00–17.00',
      email: 'CS@MajuJaya.test',
      websites: [],
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const body = updateBusinessProfileResponseSchema.parse(updated.json());
    expect(body.profile).toMatchObject({
      description: 'Internet rumahan 😊\nBuka 08.00–17.00',
      email: 'cs@majujaya.test',
      websites: [],
      about: 'Layanan pelanggan',
    });
    expect(fake.requests[0]).toMatchObject({ method: 'POST' });
    expect(fake.requests[0]?.body).toEqual({
      messaging_product: 'whatsapp',
      description: 'Internet rumahan 😊\nBuka 08.00–17.00',
      email: 'cs@majujaya.test',
      websites: [],
    });

    const [audit] = await harness.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'channel.business_profile_updated'));
    expect(audit?.metadata).toEqual({ changedFields: ['description', 'email', 'websites'] });
  });

  it('400 untuk isian di luar aturan Meta; 502 dengan pesan Indonesia bila Meta menolak', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    const invalid = await send(owner, 'PUT', path(routes.businessProfile, channel.id), {
      about: 'x'.repeat(140),
      websites: ['ftp://a.b', 'https://a.test', 'https://b.test'],
      vertical: 'KASINO',
      email: 'bukan-email',
    });
    expect(invalid.statusCode).toBe(400);
    expect(errorOf(invalid).details?.map((detail) => detail.field)).toEqual(
      expect.arrayContaining(['about', 'websites', 'vertical', 'email']),
    );
    expect(
      (await send(owner, 'PUT', path(routes.businessProfile, channel.id), {})).statusCode,
    ).toBe(400);

    fake.tokens.set(TOKEN, { appSecret: APP_SECRET, expired: true });
    const rejected = await send(owner, 'GET', path(routes.businessProfile, channel.id));
    expect(rejected.statusCode).toBe(502);
    expect(errorOf(rejected)).toMatchObject({ code: 'META_REQUEST_FAILED' });
    expect(errorOf(rejected).message).toMatch(/kedaluwarsa/);
  });
});

describe('penyalahgunaan & isolasi', () => {
  it('CS/Teknisi hanya melihat nama channel; pengaturan, verify token, tes, profil = 403', async () => {
    const owner = await completeSetup(harness.app);
    const { channel, webhook } = await createChannel(owner);
    const cs = await member(owner, 'cs');
    const teknisi = await member(owner, 'teknisi');
    const supervisor = await member(owner, 'supervisor');

    for (const signed of [cs, teknisi]) {
      const list = await send(signed, 'GET', routes.list);
      expect(list.statusCode).toBe(200);
      expect(
        Object.keys(channelSummaryListResponseSchema.parse(list.json()).channels[0] ?? {}),
      ).toEqual(['id', 'type', 'name', 'enabled', 'displayPhoneNumber']);
      expect(list.body).not.toContain(PHONE_ID);
      expect(list.body).not.toContain('••••');
    }
    for (const signed of [cs, teknisi, supervisor]) {
      for (const [method, url, body] of [
        ['GET', routes.settings, undefined],
        ['POST', routes.settings, wizardBody({ phoneNumberId: PHONE_ID_2 })],
        ['GET', path(routes.channel, channel.id), undefined],
        ['PATCH', path(routes.channel, channel.id), { name: 'Diambil alih' }],
        ['GET', path(routes.webhook, channel.id), undefined],
        ['POST', path(routes.rotateVerifyToken, channel.id), undefined],
        ['POST', path(routes.test, channel.id), undefined],
        ['GET', path(routes.businessProfile, channel.id), undefined],
      ] as const) {
        const response = await send(signed, method, url, body);
        expect(response.statusCode, `${method} ${url}`).toBe(403);
        expect(response.body).not.toContain(webhook.verifyToken);
      }
    }
    expect((await channelRow(channel.id)).name).toBe('CS Utama');
  });

  it('Admin boleh mengelola channel (channels.manage)', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await member(owner, 'admin');
    const response = await send(admin, 'POST', routes.settings, wizardBody());
    expect(response.statusCode, response.body).toBe(201);
  });

  it('IDOR: channel organisasi lain = 404 di semua endpoint, tidak tersentuh', async () => {
    const owner = await completeSetup(harness.app);
    const other = await insertOrganization(harness.db);
    const box = createSecretBox(new Secret(TEST_MASTER_KEY));
    const foreignId = '0190f000-0000-7000-8000-00000000abcd';
    const seal = (purpose: string, value: string) =>
      box.encrypt(value, { organizationId: other.id, purpose, subjectId: foreignId });
    await harness.db.insert(channels).values({
      id: foreignId,
      organizationId: other.id,
      type: 'whatsapp',
      name: 'Milik organisasi lain',
      waPhoneNumberId: PHONE_ID,
      waBusinessAccountId: WABA_ID,
      waAccessTokenEncrypted: seal(WHATSAPP_SECRET_PURPOSES.accessToken, TOKEN),
      waAppSecretEncrypted: seal(WHATSAPP_SECRET_PURPOSES.appSecret, APP_SECRET),
      waVerifyTokenEncrypted: seal(WHATSAPP_SECRET_PURPOSES.verifyToken, 'verify-lain'),
      waVerifyTokenRotatedAt: new Date(),
    });

    for (const [method, url, body] of [
      ['GET', path(routes.channel, foreignId), undefined],
      ['PATCH', path(routes.channel, foreignId), { name: 'Dibajak' }],
      ['DELETE', path(routes.channel, foreignId), await ownerConfirmation()],
      ['POST', path(routes.disable, foreignId), undefined],
      ['POST', path(routes.test, foreignId), undefined],
      ['GET', path(routes.webhook, foreignId), undefined],
      ['POST', path(routes.rotateVerifyToken, foreignId), undefined],
      ['GET', path(routes.businessProfile, foreignId), undefined],
      ['PUT', path(routes.businessProfile, foreignId), { about: 'Dibajak' }],
    ] as const) {
      const response = await send(owner, method, url, body);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.body).not.toContain('verify-lain');
    }
    expect(
      channelSummaryListResponseSchema.parse((await send(owner, 'GET', routes.list)).json())
        .channels,
    ).toEqual([]);
    expect(fake.requests).toHaveLength(0);
    const row = await channelRow(foreignId);
    expect(row).toMatchObject({ name: 'Milik organisasi lain', enabled: true, deletedAt: null });
  });

  it('token, App Secret, dan proof tidak pernah muncul di respons, log, maupun audit', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    await testChannel(owner, channel.id);
    fake.tokens.delete(TOKEN);
    await testChannel(owner, channel.id);
    await send(owner, 'GET', path(routes.businessProfile, channel.id));
    await send(owner, 'PATCH', path(routes.channel, channel.id), {
      appSecret: 'fedcba9876543210fedcba9876543210',
      confirmation: await ownerConfirmation(),
    });

    const logs = harness.logs.lines.join('\n');
    const audit = JSON.stringify(await harness.db.select().from(auditLogs));
    const responses = bodies.join('\n');
    for (const secret of [
      TOKEN,
      APP_SECRET,
      'fedcba9876543210fedcba9876543210',
      appSecretProof(TOKEN, APP_SECRET),
    ]) {
      expect(responses).not.toContain(secret);
      expect(logs).not.toContain(secret);
      expect(audit).not.toContain(secret);
    }
    // Log memuat jejak panggilan Meta (operasi + kode), tanpa URL ber-query.
    expect(logs).toContain('phone_number.read');
    expect(logs).not.toContain('appsecret_proof=');
  });
});

describe('pemberitahuan ke Owner bila channel diubah selain Owner', () => {
  /** Admin dengan 2FA terdaftar + konfirmasi identitasnya. */
  async function signInAdmin(owner: SignedIn) {
    const admin = await member(owner, 'admin');
    const confirm = async () => ({
      password: PASSWORD,
      code: await freshTotpCode(admin.session.user.email),
    });
    return { admin, confirm };
  }

  async function channelAudits() {
    return harness.db.select().from(auditLogs).where(eq(auditLogs.targetType, 'channel'));
  }

  async function summaryOf(owner: SignedIn) {
    const response = await send(owner, 'GET', API_ROUTES.audit.securitySummary);
    expect(response.statusCode, response.body).toBe(200);
    return securitySummaryResponseSchema.parse(response.json());
  }

  it('Admin: buat, ganti kredensial, buat ulang verify token, nonaktifkan, hapus → satu job per Owner aktif + warning di ringkasan', async () => {
    const owner = await completeSetup(harness.app);
    const organizationId = owner.session.organization.id;
    const secondOwner = await insertUser(harness.db, organizationId, {
      role: 'owner',
      email: 'owner-kedua@majujaya.test',
      name: 'Owner Kedua',
    });
    await insertUser(harness.db, organizationId, {
      role: 'owner',
      email: 'owner-nonaktif@majujaya.test',
      name: 'Owner Nonaktif',
      disabledAt: new Date(),
    });
    const { admin, confirm } = await signInAdmin(owner);

    const { channel, webhook } = await createChannel(admin);
    // Ganti nama saja dan mengaktifkan kembali TIDAK diberitahukan.
    const renamed = await send(admin, 'PATCH', path(routes.channel, channel.id), {
      name: 'CS Kedua',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const replaced = await send(admin, 'PATCH', path(routes.channel, channel.id), {
      phoneNumberId: PHONE_ID_2,
      accessToken: TOKEN_2,
      confirmation: await confirm(),
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const rotated = await send(admin, 'POST', path(routes.rotateVerifyToken, channel.id));
    expect(rotated.statusCode, rotated.body).toBe(200);
    const newVerifyToken = channelWebhookResponseSchema.parse(rotated.json()).verifyToken;
    expect((await send(admin, 'POST', path(routes.disable, channel.id))).statusCode).toBe(200);
    expect((await send(admin, 'POST', path(routes.enable, channel.id))).statusCode).toBe(200);
    const removed = await send(admin, 'DELETE', path(routes.channel, channel.id), await confirm());
    expect(removed.statusCode, removed.body).toBe(200);

    const audits = await channelAudits();
    const auditById = new Map(audits.map((row) => [row.id, row]));
    const notices = harness.channelChangeNotices;
    // 5 perubahan × 2 Owner aktif (Owner nonaktif tidak ikut).
    expect(notices).toHaveLength(10);
    expect(new Set(notices.map((notice) => notice.recipientUserId))).toEqual(
      new Set([owner.session.user.id, secondOwner.id]),
    );
    for (const notice of notices) {
      // Payload hanya ID — rincian dibaca worker dari audit.
      expect(Object.keys(notice).sort()).toEqual([
        'auditLogId',
        'organizationId',
        'recipientUserId',
      ]);
      expect(notice.organizationId).toBe(organizationId);
      expect(auditById.get(notice.auditLogId)?.actorUserId).toBe(admin.session.user.id);
    }
    expect(
      notices
        .filter((notice) => notice.recipientUserId === owner.session.user.id)
        .map((notice) => auditById.get(notice.auditLogId)?.metadata.change),
    ).toEqual(['created', 'credentials_changed', 'verify_token_rotated', 'disabled', 'deleted']);

    const notified = audits.filter((row) => row.metadata.ownersNotified === true);
    expect(notified.map((row) => row.action).sort()).toEqual(
      [
        'channel.created',
        'channel.deleted',
        'channel.disabled',
        'channel.updated',
        'channel.webhook_verify_token_rotated',
      ].sort(),
    );
    for (const row of notified) expect(row.metadata.actorRole).toBe('admin');
    const credentialAudit = notified.find((row) => row.action === 'channel.updated');
    expect(credentialAudit?.metadata).toMatchObject({
      change: 'credentials_changed',
      changedFields: ['phoneNumberId', 'accessToken'],
      previousPhoneNumberId: PHONE_ID,
      phoneNumberId: PHONE_ID_2,
    });
    const quiet = audits.filter((row) => row.metadata.ownersNotified !== true);
    expect(quiet.map((row) => row.action).sort()).toEqual(['channel.enabled', 'channel.updated']);
    for (const row of quiet) expect(row.metadata).not.toHaveProperty('change');

    const summary = await summaryOf(owner);
    const events = summary.events.filter((event) => event.kind === 'channel_changed');
    expect(events).toHaveLength(5);
    expect(summary.counts.channel_changed).toBe(5);
    for (const event of events) {
      expect(event.severity).toBe('warning');
      expect(event.actor?.id).toBe(admin.session.user.id);
      expect(event.subject).toBeNull();
      expect(event.details.actorRole).toBe('admin');
    }
    expect(events.map((event) => event.details.change).sort()).toEqual(
      ['created', 'credentials_changed', 'deleted', 'disabled', 'verify_token_rotated'].sort(),
    );
    expect(
      events.find((event) => event.details.change === 'credentials_changed')?.details,
    ).toMatchObject({ name: 'CS Kedua', phoneNumberId: PHONE_ID_2 });
    expect(summary.latestWarningAt).not.toBeNull();

    // Tidak ada rahasia di audit, ringkasan, maupun payload antrean.
    const visible = JSON.stringify([audits, summary, notices]);
    for (const secret of [TOKEN, TOKEN_2, APP_SECRET, webhook.verifyToken, newVerifyToken]) {
      expect(visible).not.toContain(secret);
    }
  });

  it('Owner sendiri yang mengubah: tidak ada email dan tidak ada kejadian di ringkasan keamanan', async () => {
    const owner = await completeSetup(harness.app);
    await insertUser(harness.db, owner.session.organization.id, {
      role: 'owner',
      email: 'owner-lain@majujaya.test',
      name: 'Owner Lain',
    });
    const { channel } = await createChannel(owner);
    const replaced = await send(owner, 'PATCH', path(routes.channel, channel.id), {
      appSecret: 'fedcba9876543210fedcba9876543210',
      confirmation: await ownerConfirmation(),
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const rotated = await send(owner, 'POST', path(routes.rotateVerifyToken, channel.id));
    expect(rotated.statusCode).toBe(200);
    expect((await send(owner, 'POST', path(routes.disable, channel.id))).statusCode).toBe(200);
    const removed = await send(
      owner,
      'DELETE',
      path(routes.channel, channel.id),
      await ownerConfirmation(),
    );
    expect(removed.statusCode).toBe(200);

    expect(harness.channelChangeNotices).toEqual([]);
    const audits = await channelAudits();
    expect(audits).toHaveLength(5);
    for (const row of audits) {
      expect(row.metadata).toMatchObject({ ownersNotified: false, actorRole: 'owner' });
    }
    const summary = await summaryOf(owner);
    expect(summary.counts.channel_changed).toBe(0);
    expect(summary.events.filter((event) => event.kind === 'channel_changed')).toEqual([]);
  });

  it('pemberitahuan tidak bisa diantrekan: perubahan oleh Admin BATAL (503); oleh Owner tetap jalan', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    const { admin } = await signInAdmin(owner);
    await harness.rebuild({
      ...DEFAULT_OPTIONS(),
      notifier: {
        accountLocked: () => Promise.resolve(),
        securityNotice: () => Promise.resolve(),
        securityNoticeAdmin: () => Promise.resolve(),
        invitation: () => Promise.resolve(),
        accountToken: () => Promise.resolve(),
        emailSettingsChanged: () => Promise.resolve(),
        channelChanged: () => Promise.reject(new Error('antrian mati')),
      },
    });
    try {
      const created = await send(
        admin,
        'POST',
        routes.settings,
        wizardBody({ phoneNumberId: PHONE_ID_2 }),
      );
      expect(created.statusCode).toBe(503);
      expect(errorOf(created).message).toContain('pemberitahuan ke Owner');
      expect((await send(admin, 'POST', path(routes.disable, channel.id))).statusCode).toBe(503);
      expect(
        (await send(admin, 'POST', path(routes.rotateVerifyToken, channel.id))).statusCode,
      ).toBe(503);

      const rows = await harness.db.select().from(channels);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: channel.id, enabled: true });
      expect((await channelAudits()).map((row) => row.action)).toEqual(['channel.created']);

      // Ganti nama oleh Admin tidak butuh pemberitahuan; Owner tidak memberi tahu dirinya sendiri.
      const renamed = await send(admin, 'PATCH', path(routes.channel, channel.id), {
        name: 'CS Baru',
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect((await send(owner, 'POST', path(routes.disable, channel.id))).statusCode).toBe(200);
    } finally {
      await rebuildDefault();
    }
  });
});
