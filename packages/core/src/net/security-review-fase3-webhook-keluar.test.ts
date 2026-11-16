/**
 * Tes penjaga review keamanan Fase 3 — webhook keluar / SSRF
 * (docs/security-reviews/2026-11-19-fase3-webhook-keluar.md).
 *
 * `it` = perilaku aman yang harus tetap benar. `it.fails` = temuan terbuka (perilaku yang
 * DIHARAPKAN; gagal sekarang) — ubah ke `it` setelah diperbaiki.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { classifyAddress, deliverWebhook, parseWebhookUrl } from './outgoing-webhook';

const base = { body: '{"x":1}', headers: {}, privateCidrs: [] as string[] };
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('review keamanan — klasifikasi & URL', () => {
  it('bentuk lain loopback/metadata (heks IPv4-mapped, desimal, oktal/heks, singkat) tetap terlarang', () => {
    for (const raw of [
      'https://[::ffff:127.0.0.1]/',
      'https://[::ffff:7f00:1]/',
      'https://[0:0:0:0:0:ffff:7f00:1]/',
      'https://[::ffff:169.254.169.254]/',
      'https://2130706433/',
      'https://0x7f.1/',
      'https://0177.0.0.1/',
      'https://127.1/',
      'https://0/',
      'https://[::]/',
      'https://[fe80::1%25eth0]/',
    ]) {
      const parsed = parseWebhookUrl(raw, []);
      expect('error' in parsed ? parsed.error : 'lolos', raw).toMatch(
        /blocked_address|invalid_url/,
      );
    }
  });

  it('IPv4-mapped bentuk heks ke jaringan privat = privat (butuh allowlist), bukan publik', () => {
    expect(classifyAddress('::ffff:a00:1')).toBe('private');
    expect(parseWebhookUrl('https://[::ffff:a00:1]/', [])).toEqual({
      error: 'private_not_allowed',
    });
  });

  it('kredensial di URL, skema lain, dan port di luar daftar ditolak', () => {
    expect(parseWebhookUrl('https://u:p@hook.contoh.id/', [])).toEqual({ error: 'credentials' });
    expect(parseWebhookUrl('ftp://hook.contoh.id/', [])).toEqual({ error: 'scheme' });
    expect(parseWebhookUrl('file:///etc/passwd', [])).toEqual({ error: 'scheme' });
    expect(parseWebhookUrl('https://hook.contoh.id:6379/', [])).toEqual({ error: 'port' });
    expect(parseWebhookUrl('https://hook.contoh.id:22/', [])).toEqual({ error: 'port' });
  });

  it('allowLoopback mati (produksi): 127.0.0.1/::1 dengan port bebas tetap ditolak', () => {
    expect('error' in parseWebhookUrl('http://127.0.0.1:6379/', [])).toBe(true);
    expect('error' in parseWebhookUrl('https://[::1]/', [])).toBe(true);
  });

  it.fails('IPv4-compatible IPv6 (::/96, mis. ::7f00:1) diperlakukan terlarang', () => {
    expect(classifyAddress('::7f00:1')).toBe('forbidden');
  });

  it.fails('6to4 yang membungkus loopback/metadata (2002::/16) diperlakukan terlarang', () => {
    expect(classifyAddress('2002:7f00:1::1')).toBe('forbidden');
    expect(classifyAddress('2002:a9fe:a9fe::1')).toBe('forbidden');
  });

  it.fails('NAT64 local-use (64:ff9b:1::/48, RFC 8215) diperlakukan terlarang', () => {
    expect(classifyAddress('64:ff9b:1::a9fe:a9fe')).toBe('forbidden');
  });
});

describe('review keamanan — pengiriman', () => {
  async function listen(handler: Parameters<typeof createServer>[1], port = 0) {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    return (server.address() as AddressInfo).port;
  }

  it('DNS di-resolve SEKALI; soket ke IP terperiksa; Host tetap nama aslinya', async (context) => {
    const seen: IncomingHttpHeaders[] = [];
    let port = 0;
    for (const candidate of [8443, 8080, 5678]) {
      try {
        port = await listen((request, response) => {
          seen.push(request.headers);
          response.writeHead(200).end('ok');
        }, candidate);
        break;
      } catch {
        port = 0;
      }
    }
    if (port === 0) {
      context.skip();
      return;
    }
    let lookups = 0;
    const result = await deliverWebhook({
      ...base,
      // Nama ini tidak bisa di-resolve sungguhan: hanya bisa sampai bila soket memakai IP terperiksa.
      url: `http://penerima-uji.invalid:${String(port)}/hook`,
      allowLoopback: true,
      lookup: () => {
        lookups += 1;
        return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
      },
    });
    expect(result).toMatchObject({ ok: true, httpStatus: 200 });
    expect(lookups).toBe(1);
    expect(seen[0]?.host).toBe(`penerima-uji.invalid:${String(port)}`);
  });

  it('jawaban yang menetes perlahan tetap dihentikan batas waktu total; potongan ≤ batas & tanpa karakter kontrol', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(200);
      const timer = setInterval(() => response.write('a'), 50);
      response.on('close', () => clearInterval(timer));
    });
    const slow = await deliverWebhook({
      ...base,
      url: `http://127.0.0.1:${String(port)}/`,
      allowLoopback: true,
      timeoutMs: 300,
    });
    expect(slow).toMatchObject({ ok: false, errorCode: 'timeout' });
    expect(slow.durationMs).toBeLessThan(1_500);

    const big = await listen((_request, response) => {
      response.writeHead(400).end(`\u0000\u001b[31m${'z'.repeat(10_000)}`);
    });
    const result = await deliverWebhook({
      ...base,
      url: `http://127.0.0.1:${String(big)}/`,
      allowLoopback: true,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'http_400', retryable: false });
    expect(Buffer.byteLength(result.snippet ?? '')).toBeLessThanOrEqual(500);
    expect(result.snippet).not.toMatch(/\p{Cc}/u);
  });

  it.fails(
    'waktu resolusi DNS ikut batas waktu total (DNS lambat tidak menahan worker melewati timeoutMs)',
    async () => {
      const result = await deliverWebhook({
        ...base,
        url: 'https://dns-lambat.invalid/hook',
        timeoutMs: 200,
        lookup: () =>
          new Promise((resolve) =>
            setTimeout(() => resolve([{ address: '127.0.0.1', family: 4 }]), 1_500),
          ),
      });
      expect(result.durationMs).toBeLessThan(1_000);
    },
  );
});
