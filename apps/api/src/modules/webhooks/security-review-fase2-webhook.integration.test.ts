/**
 * Review keamanan Fase 2 butir 3 — penerima webhook WhatsApp
 * (docs/security-reviews/2026-11-16-fase2-webhook.md). Penjaga regresi + celah S1/S2 yang dulu
 * dikunci `it.fails` (kini `it` biasa setelah diperbaiki). Notifikasi disusun dan ditandatangani
 * `testing/fake-meta-webhooks.ts` — tidak pernah memanggil Meta.
 */
import { createSecretBox, sealChannelSecret, Secret, type WhatsAppSecretKind } from '@balesin/core';
import { channels, newId, webhookEvents } from '@balesin/db';
import { WEBHOOK_ROUTES, apiPath } from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  combinedNotification,
  fakeWamid,
  handshakeQuery,
  signedWebhook,
  signWebhookBody,
  textMessageNotification,
} from '../../testing/fake-meta';
import {
  TEST_MASTER_KEY,
  completeSetup,
  createIntegrationHarness,
  type IntegrationHarness,
} from '../../testing/integration';

const APP_SECRET = '0123456789abcdef0123456789abcdef';
const OTHER_APP_SECRET = 'fedcba9876543210fedcba9876543210';
const VERIFY_TOKEN = 'verify-token-acak-milik-channel-ini-0123456789';
const TOKEN = 'EAAGm0PX4ZCpsBAtokenSistemUserRahasia0123456789ABCDEF';
const WABA = '102290129340398';
const PHONE = '106540352242922';
/** IP keluar Meta (dipakai untuk jabat tangan DAN notifikasi). */
const META_IP = '173.252.127.1';

let harness: IntegrationHarness;
let organizationId: string;
let channelId: string;
const box = createSecretBox(new Secret(TEST_MASTER_KEY));

async function insertChannel(): Promise<string> {
  const id = newId();
  const owner = { id, organizationId };
  const seal = (kind: WhatsAppSecretKind, value: string) =>
    sealChannelSecret(box, owner, kind, value);
  await harness.db.insert(channels).values({
    id,
    organizationId,
    type: 'whatsapp',
    name: 'CS Utama',
    enabled: true,
    waPhoneNumberId: PHONE,
    waBusinessAccountId: WABA,
    waAccessTokenEncrypted: seal('accessToken', TOKEN),
    waAccessTokenTail: 'CDEF',
    waAppSecretEncrypted: seal('appSecret', APP_SECRET),
    waAppSecretTail: 'cdef',
    waVerifyTokenEncrypted: seal('verifyToken', VERIFY_TOKEN),
    waVerifyTokenRotatedAt: new Date(),
  });
  return id;
}

const urlFor = (id: string) => apiPath(WEBHOOK_ROUTES.whatsapp, { channelId: id });

function post(
  id: string,
  notification: unknown,
  options: { secret?: string; rawBody?: string; signature?: string; ip?: string } = {},
) {
  const { body, headers } = signedWebhook(notification, options.secret ?? APP_SECRET, {
    rawBody: options.rawBody,
    signature: options.signature,
  });
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
  return harness.db.select().from(webhookEvents).where(eq(webhookEvents.channelId, id));
}

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
  const owner = await completeSetup(harness.app);
  organizationId = owner.session.organization.id;
  channelId = await insertChannel();
});
afterAll(async () => {
  await harness?.close();
});

describe('penjaga regresi', () => {
  it('body tanpa tanda tangan sah tidak pernah ditafsirkan (JSON rusak → 403, bukan 400/500)', async () => {
    const response = await post(channelId, undefined, {
      rawBody: '{"object":',
      secret: OTHER_APP_SECRET,
    });
    expect(response.statusCode).toBe(403);
    expect(await eventsOf(channelId)).toEqual([]);
  });

  it('__proto__/constructor di notifikasi bertanda tangan tidak mencemari prototipe dan tidak tersimpan', async () => {
    const wamid = fakeWamid();
    const base = JSON.stringify(textMessageNotification({ wamid }));
    // Disisipkan sebagai teks mentah (JSON.stringify membuang `__proto__` dari literal objek).
    const rawBody = base
      .replace(
        '"object":',
        '"__proto__":{"tercemar":true},"constructor":{"prototype":{"x":1}},"object":',
      )
      .replace('"type":"text"', '"type":"__proto__","__proto__":{"tercemar":true}');
    const response = await post(channelId, undefined, { rawBody });
    expect(response.statusCode, response.body).toBe(200);
    expect(({} as Record<string, unknown>).tercemar).toBeUndefined();
    const [event] = await eventsOf(channelId);
    expect(event?.externalId).toBe(wamid);
    expect(JSON.stringify(event?.payload)).not.toContain('tercemar');
  });

  it('ID channel tak dikenal dan channel terhapus sama-sama 404 (tidak membedakan); UUID huruf besar = sama', async () => {
    const unknown = await post(newId(), textMessageNotification(), { ip: '192.0.2.1' });
    expect(unknown.statusCode).toBe(404);
    const upper = await post(channelId.toUpperCase(), textMessageNotification());
    expect(upper.statusCode).toBe(200);
  });

  it('tanda tangan dengan App Secret LAIN tidak pernah menyimpan apa pun, walau nomornya benar', async () => {
    const response = await post(channelId, textMessageNotification(), { secret: OTHER_APP_SECRET });
    expect(response.statusCode).toBe(403);
    expect(await eventsOf(channelId)).toEqual([]);
  });
});

describe('S1 — kegagalan jabat tangan (bisa dipicu lewat server Meta) menahan notifikasi sah', () => {
  // Penyerang tanpa akun: membuat aplikasi Meta sendiri, lalu berulang kali memasang callback URL
  // korban (`POST /{app-id}/subscriptions` atau tombol "Verifikasi dan simpan") dengan verify token
  // asal. Setiap percobaan = GET jabat tangan GAGAL dari IP keluar Meta. Ember `webhook-tolak-ip`
  // (IP + channel) dan `webhook-tak-dikenal-ip` (IP) yang terisi lalu ikut menahan POST notifikasi
  // sah dari IP Meta yang sama.
  it('20 jabat tangan salah dari IP Meta tidak boleh menahan notifikasi bertanda tangan sah dari IP itu', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await handshake(channelId, handshakeQuery('tebakan-penyerang'))).statusCode).toBe(
        403,
      );
    }
    const legit = await post(channelId, textMessageNotification());
    expect(legit.statusCode, legit.body).toBe(200);
  });

  it('30 jabat tangan ke ID channel acak dari IP Meta tidak boleh menahan notifikasi channel yang ADA', async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await handshake(newId(), handshakeQuery('apa-saja'))).statusCode).toBe(404);
    }
    const legit = await post(channelId, textMessageNotification());
    expect(legit.statusCode, legit.body).toBe(200);
  });
});

describe('S2 — satu kejadian "beracun" menggagalkan seluruh notifikasi (503 terus-menerus)', () => {
  // Postgres `jsonb` menolak `\u0000` dan surrogate tunggal. Teks seperti itu lolos skema toleran,
  // lalu INSERT seluruh notifikasi gagal → 503 → Meta mengirim ulang sampai 7 hari → dibuang. Pesan
  // lain di notifikasi yang sama ikut hilang.
  for (const [label, poison] of [
    ['karakter NUL (\\u0000)', 'halo\u0000kak'],
    ['surrogate tunggal (\\ud800)', 'halo\ud800kak'],
  ] as const) {
    it(`${label}: pesan lain tetap tersimpan, jawaban 200`, async () => {
      const clean = fakeWamid();
      const notification = combinedNotification(
        textMessageNotification({ wamid: clean, body: 'pesan biasa' }),
        textMessageNotification({ body: poison }),
      );
      const response = await post(channelId, notification);
      expect(response.statusCode, response.body).toBe(200);
      const stored = await eventsOf(channelId);
      expect(stored.map((event) => event.externalId)).toContain(clean);
    });
  }

  it('timestamp angka (bilangan bulat aman) di luar rentang Date: bagian itu dibuang, bukan 503', async () => {
    const clean = fakeWamid();
    const bad = JSON.stringify(textMessageNotification({ timestamp: '1' })).replace(
      '"timestamp":"1"',
      '"timestamp":9007199254740991',
    );
    const good = JSON.stringify(textMessageNotification({ wamid: clean }));
    const rawBody = JSON.stringify(
      combinedNotification(
        JSON.parse(good) as Record<string, unknown>,
        JSON.parse(bad) as Record<string, unknown>,
      ),
    );
    const response = await post(channelId, undefined, {
      rawBody,
      signature: signWebhookBody(rawBody, APP_SECRET),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((await eventsOf(channelId)).map((event) => event.externalId)).toContain(clean);
  });
});
