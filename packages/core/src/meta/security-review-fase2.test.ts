/**
 * Review keamanan Fase 2 butir 1–2 (docs/security-reviews/2026-11-15-fase2-channel-whatsapp.md):
 * penjaga regresi + celah yang dikunci `it.fails` untuk klien Graph API Meta. Tidak pernah memanggil
 * Meta sungguhan — `fetch` tiruan.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Secret } from '../secret';
import { createLogCapture } from '../testing';
import { createMetaGraphClient, DEFAULT_META_GRAPH_VERSION } from './graph-client';

const TOKEN_A = 'EAAGorganisasiPertamaTokenRahasia0123456789abcdef';
const TOKEN_B = 'EAAGorganisasiKeduaTokenLainSekali9876543210zyxwv';
const APP_SECRET = '0123456789abcdef0123456789abcdef';
const okSchema = z.object({ id: z.string() });

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('review fase 2 — klien Graph API', () => {
  it('penjaga: pesan error Meta yang memantulkan token tidak bocor ke log (redaksi logger)', async () => {
    const capture = createLogCapture();
    const client = createMetaGraphClient({
      version: DEFAULT_META_GRAPH_VERSION,
      fetch: () =>
        Promise.resolve(
          json(400, {
            error: {
              message: `Malformed access token ${TOKEN_A}`,
              type: 'OAuthException',
              code: 190,
              fbtrace_id: 'Abc',
            },
          }),
        ),
      logger: capture.logger,
      sleep: () => Promise.resolve(),
    });
    await expect(
      client.request(
        { accessToken: new Secret(TOKEN_A), appSecret: new Secret(APP_SECRET) },
        { operation: 'tes', method: 'GET', path: ['123'], schema: okSchema },
      ),
    ).rejects.toMatchObject({ kind: 'token_invalid' });
    const logged = capture.text();
    expect(logged).toContain('Graph API Meta menolak permintaan');
    expect(logged).not.toContain(TOKEN_A);
    expect(logged).not.toContain(APP_SECRET);
  });

  it('penjaga: total waktu satu permintaan dibatasi jumlah percobaan (3) — tidak mengulang tanpa akhir', async () => {
    let calls = 0;
    const client = createMetaGraphClient({
      version: DEFAULT_META_GRAPH_VERSION,
      fetch: () => {
        calls += 1;
        return Promise.resolve(json(503, { error: { code: 2, message: 'x' } }));
      },
      sleep: () => Promise.resolve(),
    });
    await expect(
      client.request(
        { accessToken: new Secret(TOKEN_A), appSecret: new Secret(APP_SECRET) },
        { operation: 'tes', method: 'GET', path: ['123'], schema: okSchema },
      ),
    ).rejects.toMatchObject({ kind: 'temporarily_unavailable' });
    expect(calls).toBe(3);
  });

  /**
   * R1: masa dingin batas laju dikunci HANYA dengan segmen path pertama (ID objek Meta), tanpa
   * memperhitungkan token/organisasi/channel. Batas laju yang dialami SATU kredensial (mis. channel
   * organisasi lain yang mengisi Phone Number ID/WABA ID yang sama, atau profil bisnis yang di-spam)
   * membuat permintaan kredensial LAIN ke objek yang sama ikut gagal tanpa pernah sampai ke Meta.
   * Yang diharapkan: kunci masa dingin memuat identitas kredensial (mis. hash token) atau channel.
   */
  it('R1: batas laju milik satu kredensial tidak memblokir kredensial lain untuk ID objek yang sama', async () => {
    const seen: string[] = [];
    const responses = [
      json(400, { error: { code: 80007, message: 'rate limit' } }, { 'retry-after': '3600' }),
      json(200, { id: '106540352242922' }),
    ];
    const client = createMetaGraphClient({
      version: DEFAULT_META_GRAPH_VERSION,
      fetch: ((_url: URL, init: RequestInit) => {
        seen.push((init.headers as Record<string, string>).authorization ?? '');
        const next = responses.shift();
        return next ? Promise.resolve(next) : Promise.reject(new Error('habis'));
      }) as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    const request = {
      operation: 'phone_number.read',
      method: 'GET' as const,
      path: ['106540352242922'],
      schema: okSchema,
    };

    // Kredensial A (mis. channel organisasi/aplikasi lain) kena batas laju lama.
    await expect(
      client.request({ accessToken: new Secret(TOKEN_A), appSecret: null }, request),
    ).rejects.toMatchObject({ kind: 'rate_limited' });

    // Kredensial B (pemilik sah nomor itu) seharusnya tetap bisa memanggil Meta.
    await expect(
      client.request(
        { accessToken: new Secret(TOKEN_B), appSecret: new Secret(APP_SECRET) },
        request,
      ),
    ).resolves.toEqual({ id: '106540352242922' });
    expect(seen).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]);
  });
});
