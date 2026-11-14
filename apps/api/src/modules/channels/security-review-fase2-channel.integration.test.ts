/**
 * Review keamanan Fase 2 butir 1–2 — channel WhatsApp Cloud API
 * (docs/security-reviews/2026-11-15-fase2-channel-whatsapp.md). Penjaga regresi + celah yang
 * dikunci `it.fails`. Server Graph API TIRUAN lokal (`testing/fake-meta.ts`) — tidak pernah
 * memanggil Meta sungguhan.
 */
import { auditLogs, channels } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  apiPath,
  channelSummaryListResponseSchema,
  channelWebhookResponseSchema,
  createChannelResponseSchema,
  errorEnvelopeSchema,
  type UserRole,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startFakeMeta, type FakeMeta } from '../../testing/fake-meta';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  freshTotpCode,
  login,
  OWNER,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { createPasswordHasher } from '../auth/password-hasher';

const TOKEN = 'EAAGm0PX4ZCpsBAtokenReviewKeamananFase2abcdef0123456789';
const APP_SECRET = '0123456789abcdef0123456789abcdef';
const OTHER_APP_SECRET = 'fedcba9876543210fedcba9876543210';
const PHONE_ID = '106540352242922';
const WABA_ID = '102290129340398';
const OTHER_WABA_ID = '102290129349999';
const PASSWORD = 'sandi-anggota-review-fase2';

let harness: IntegrationHarness;
let fake: FakeMeta;
const hasher = createPasswordHasher();
const routes = API_ROUTES.channels;
const path = (template: string, channelId: string) => apiPath(template, { channelId });

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
  fake.wabas.add(WABA_ID);
  fake.phoneNumbers.set(PHONE_ID, {
    id: PHONE_ID,
    wabaId: WABA_ID,
    display_phone_number: '+62 811-2345-678',
    verified_name: 'Maju Jaya',
    quality_rating: 'GREEN',
    status: 'CONNECTED',
    name_status: 'APPROVED',
    profile: { about: 'Layanan pelanggan', websites: ['https://majujaya.test'] },
  });
});
afterAll(async () => {
  await harness?.close();
  await fake?.close();
});

const send = (
  signed: SignedIn,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
) => call(harness.app, method, url, body, { cookie: signed.cookie, csrf: signed.csrf });

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

async function createChannel(signed: SignedIn) {
  const response = await send(signed, 'POST', routes.settings, {
    type: 'whatsapp',
    name: 'CS Utama',
    phoneNumberId: PHONE_ID,
    wabaId: WABA_ID,
    accessToken: TOKEN,
    appSecret: APP_SECRET,
  });
  expect(response.statusCode, response.body).toBe(201);
  return createChannelResponseSchema.parse(response.json());
}

async function channelRow(id: string) {
  const [row] = await harness.db.select().from(channels).where(eq(channels.id, id));
  if (!row) throw new Error('Channel tidak ada');
  return row;
}

describe('review fase 2 — penjaga regresi', () => {
  it('GET business-profile: tanpa token CSRF / lintas situs = 403 dan Meta tidak dipanggil', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    const url = path(routes.businessProfile, channel.id);
    fake.requests.length = 0;

    const noCsrf = await call(harness.app, 'GET', url, undefined, {
      cookie: owner.cookie,
      origin: null,
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(noCsrf.json()).error.code).toBe('CSRF_INVALID');

    const crossSite = await call(harness.app, 'GET', url, undefined, {
      cookie: owner.cookie,
      csrf: owner.csrf,
      origin: null,
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(fake.requests).toHaveLength(0);

    const ok = await send(owner, 'GET', url);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('PATCH parsial: nilai sama tanpa konfirmasi tidak menulis apa pun; campuran dengan nilai baru tetap wajib konfirmasi', async () => {
    const owner = await completeSetup(harness.app);
    const admin = await member(owner, 'admin');
    const { channel } = await createChannel(owner);
    const before = await channelRow(channel.id);
    const auditsBefore = await harness.db.select().from(auditLogs);
    const url = path(routes.channel, channel.id);

    // Nilai sama persis = bukan penggantian: 200, baris & audit tidak berubah, Owner tidak diberi tahu.
    const same = await send(admin, 'PATCH', url, {
      accessToken: `  ${TOKEN}\n`,
      appSecret: APP_SECRET,
      phoneNumberId: PHONE_ID,
      wabaId: WABA_ID,
    });
    expect(same.statusCode, same.body).toBe(200);
    expect(await channelRow(channel.id)).toEqual(before);
    expect(await harness.db.select().from(auditLogs)).toHaveLength(auditsBefore.length);
    expect(harness.channelChangeNotices).toEqual([]);

    // Satu isian berbeda di antara nilai-nilai sama → tetap wajib konfirmasi, tidak ada yang tertulis.
    for (const body of [
      { accessToken: TOKEN, appSecret: OTHER_APP_SECRET },
      { phoneNumberId: PHONE_ID, wabaId: OTHER_WABA_ID },
      { name: 'Nama Baru', appSecret: OTHER_APP_SECRET },
    ]) {
      const response = await send(admin, 'PATCH', url, body);
      expect(response.statusCode, response.body).toBe(400);
      expect(errorEnvelopeSchema.parse(response.json()).error.details?.[0]?.field).toBe(
        'confirmation.password',
      );
      expect(await channelRow(channel.id)).toEqual(before);
    }

    // Konfirmasi milik orang lain (password Owner + kode Owner) tidak berlaku untuk Admin.
    const borrowed = await send(admin, 'PATCH', url, {
      appSecret: OTHER_APP_SECRET,
      confirmation: { password: OWNER.password, code: await freshTotpCode(OWNER.email) },
    });
    expect(borrowed.statusCode).toBe(400);
    expect((await channelRow(channel.id)).waAppSecretEncrypted).toBe(before.waAppSecretEncrypted);
  });

  it('verify token: 43 karakter base64url, unik per channel, hanya lewat rute webhook', async () => {
    const owner = await completeSetup(harness.app);
    const first = await createChannel(owner);
    fake.phoneNumbers.set('106540352249999', { id: '106540352249999', wabaId: WABA_ID });
    const second = await send(owner, 'POST', routes.settings, {
      type: 'whatsapp',
      name: 'CS Kedua',
      phoneNumberId: '106540352249999',
      wabaId: WABA_ID,
      accessToken: TOKEN,
      appSecret: APP_SECRET,
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondToken = createChannelResponseSchema.parse(second.json()).webhook.verifyToken;

    for (const token of [first.webhook.verifyToken, secondToken]) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(first.webhook.verifyToken).not.toBe(secondToken);

    const rotated = await send(owner, 'POST', path(routes.rotateVerifyToken, first.channel.id));
    const rotatedToken = channelWebhookResponseSchema.parse(rotated.json()).verifyToken;
    expect(rotatedToken).not.toBe(first.webhook.verifyToken);

    for (const url of [routes.settings, path(routes.channel, first.channel.id), routes.list]) {
      const response = await send(owner, 'GET', url);
      expect(response.statusCode).toBe(200);
      for (const secret of [TOKEN, APP_SECRET, rotatedToken, secondToken]) {
        expect(response.body).not.toContain(secret);
      }
    }
  });

  it('400 validasi tidak memantulkan token/App Secret yang ditolak', async () => {
    const owner = await completeSetup(harness.app);
    const badToken = `${TOKEN} sisa`;
    const badSecret = `${APP_SECRET}!`;
    const response = await send(owner, 'POST', routes.settings, {
      type: 'whatsapp',
      name: 'CS Utama',
      phoneNumberId: PHONE_ID,
      wabaId: WABA_ID,
      accessToken: badToken,
      appSecret: badSecret,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(TOKEN);
    expect(response.body).not.toContain(APP_SECRET);
  });

  it('GET /channels (CS): hanya id, jenis, nama, aktif, nomor tampilan', async () => {
    const owner = await completeSetup(harness.app);
    const { channel } = await createChannel(owner);
    const cs = await member(owner, 'cs');
    const response = await send(cs, 'GET', routes.list);
    expect(response.statusCode).toBe(200);
    const raw = response.json<{ channels: Array<Record<string, unknown>> }>();
    expect(Object.keys(raw.channels[0] ?? {}).sort()).toEqual(
      ['displayPhoneNumber', 'enabled', 'id', 'name', 'type'].sort(),
    );
    expect(channelSummaryListResponseSchema.parse(raw).channels[0]?.id).toBe(channel.id);
    for (const leaked of [PHONE_ID, WABA_ID, 'webhooks/whatsapp', '••••']) {
      expect(response.body).not.toContain(leaked);
    }
  });
});

describe('review fase 2 — celah yang dikunci it.fails', () => {
  /**
   * S1: Admin (sesi dibobol) bisa mengganti profil bisnis RESMI nomor perusahaan — website, email,
   * deskripsi — ke tautan phishing tanpa konfirmasi identitas, tanpa pemberitahuan ke Owner, dan
   * audit hanya mencatat NAMA isian (nilai lama tidak bisa dipulihkan / dibandingkan).
   */
  it.fails(
    'S1: Admin mengubah website profil bisnis → Owner diberi tahu + audit menyimpan nilai lama & baru',
    async () => {
      const owner = await completeSetup(harness.app);
      const { channel } = await createChannel(owner);
      const admin = await member(owner, 'admin');
      harness.channelChangeNotices.length = 0;

      const response = await send(admin, 'PUT', path(routes.businessProfile, channel.id), {
        websites: ['https://majujaya-bayar.example'],
        email: 'tagihan@majujaya-bayar.example',
      });
      expect(response.statusCode, response.body).toBe(200);

      // Yang diharapkan: perubahan profil publik oleh selain Owner diberitahukan.
      expect(harness.channelChangeNotices.length).toBeGreaterThan(0);
      const [audit] = await harness.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'channel.business_profile_updated'));
      expect(JSON.stringify(audit?.metadata)).toContain('https://majujaya.test');
      expect(JSON.stringify(audit?.metadata)).toContain('https://majujaya-bayar.example');
    },
  );

  /**
   * R3: channel yang dinonaktifkan Owner (mis. karena token dicurigai bocor) bisa diaktifkan lagi
   * diam-diam oleh Admin — `enable` tidak diberitahukan.
   */
  it.fails(
    'R3: Admin mengaktifkan lagi channel yang dinonaktifkan Owner → Owner diberi tahu',
    async () => {
      const owner = await completeSetup(harness.app);
      const { channel } = await createChannel(owner);
      expect((await send(owner, 'POST', path(routes.disable, channel.id))).statusCode).toBe(200);
      const admin = await member(owner, 'admin');
      harness.channelChangeNotices.length = 0;

      const enabled = await send(admin, 'POST', path(routes.enable, channel.id));
      expect(enabled.statusCode, enabled.body).toBe(200);
      expect(harness.channelChangeNotices.length).toBeGreaterThan(0);
    },
  );
});
