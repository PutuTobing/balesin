import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  classifyAddress,
  deliverWebhook,
  normalizePrivateCidr,
  parseWebhookUrl,
  webhookSignature,
} from './outgoing-webhook';

describe('klasifikasi alamat (SSRF)', () => {
  it('terlarang selalu; privat; publik', () => {
    for (const ip of [
      '127.0.0.1',
      '::1',
      '0.0.0.0',
      '169.254.169.254',
      'fd00:ec2::254',
      'fe80::1',
      '224.0.0.1',
      'ff02::1',
      '255.255.255.255',
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      'bukan-ip',
    ]) {
      expect(classifyAddress(ip), ip).toBe('forbidden');
    }
    for (const ip of [
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.10',
      '100.64.0.1',
      'fd12:3456::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(classifyAddress(ip), ip).toBe('private');
    }
    for (const ip of ['8.8.8.8', '203.0.113.10', '2606:4700::1111']) {
      expect(classifyAddress(ip), ip).toBe('public');
    }
  });

  it('allowlist hanya menerima CIDR privat yang seluruhnya di dalam rentang privat', () => {
    expect(normalizePrivateCidr('10.0.5.0/24')).toBe('10.0.5.0/24');
    expect(normalizePrivateCidr('192.168.1.10')).toBe('192.168.1.10/32');
    expect(normalizePrivateCidr('FD00::/8')).toBe('fd00::/8');
    for (const bad of [
      '10.0.0.0/7',
      '8.8.8.0/24',
      '127.0.0.0/8',
      '169.254.0.0/16',
      '172.16.0.0/11',
      '10.0.0.0/33',
      'x',
    ]) {
      expect(normalizePrivateCidr(bad), bad).toBeNull();
    }
  });

  it('URL: https wajib untuk publik; http hanya ke IP privat yang diizinkan; port & kredensial', () => {
    expect('error' in parseWebhookUrl('https://n8n.contoh.id/webhook/abc', [])).toBe(false);
    const cases: [string, string[], string][] = [
      ['ftp://contoh.id', [], 'scheme'],
      ['https://user:pw@contoh.id', [], 'credentials'],
      ['https://contoh.id:22/x', [], 'port'],
      ['http://127.0.0.1:5678/webhook', [], 'blocked_address'],
      ['http://169.254.169.254/latest/meta-data', [], 'blocked_address'],
      ['http://[fd00:ec2::254]/', [], 'blocked_address'],
      ['http://10.0.0.5:5678/webhook', [], 'private_not_allowed'],
      ['bukan url', [], 'invalid_url'],
    ];
    for (const [url, cidrs, error] of cases) {
      expect(parseWebhookUrl(url, cidrs), url).toEqual({ error });
    }
    expect('error' in parseWebhookUrl('http://10.0.0.5:5678/webhook', ['10.0.0.0/24'])).toBe(false);
    // Nama host + http: diputuskan SETELAH DNS (publik → https_required).
    expect('error' in parseWebhookUrl('http://n8n.lan:5678/webhook', [])).toBe(false);
  });

  it('tanda tangan t=…,v1=… atas `${t}.${body}`; rahasia lama ikut selama tumpang tindih', () => {
    const header = webhookSignature(['baru', 'lama'], 1_700_000_000, '{"a":1}');
    const expected = (secret: string) =>
      createHmac('sha256', secret).update('1700000000.{"a":1}').digest('hex');
    expect(header).toBe(`t=1700000000,v1=${expected('baru')},v1=${expected('lama')}`);
  });
});

describe('deliverWebhook (server penerima tiruan)', () => {
  const received: { path: string; body: string }[] = [];
  let origin = '';
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ path: request.url ?? '', body: Buffer.concat(chunks).toString() });
      if (request.url === '/redirect') {
        response.writeHead(302, { location: 'http://169.254.169.254/' }).end();
      } else if (request.url === '/error') {
        response.writeHead(500).end('x'.repeat(5000));
      } else if (request.url === '/lambat') {
        setTimeout(() => response.writeHead(200).end(), 2_000);
      } else {
        response.writeHead(200).end('ok');
      }
    });
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(() => {
    server.close();
  });

  const base = { body: '{"x":1}', headers: {}, privateCidrs: [] as string[] };

  it('terkirim; redirect tidak diikuti; 5xx bisa diulang + potongan dibatasi; batas waktu', async () => {
    expect(
      await deliverWebhook({ ...base, url: `${origin}/ok`, allowLoopback: true }),
    ).toMatchObject({
      ok: true,
      httpStatus: 200,
      snippet: 'ok',
    });
    expect(
      await deliverWebhook({ ...base, url: `${origin}/redirect`, allowLoopback: true }),
    ).toMatchObject({ ok: false, errorCode: 'redirect', retryable: false });
    const failed = await deliverWebhook({ ...base, url: `${origin}/error`, allowLoopback: true });
    expect(failed).toMatchObject({ ok: false, errorCode: 'http_500', retryable: true });
    expect(failed.snippet?.length).toBeLessThanOrEqual(500);
    expect(
      await deliverWebhook({
        ...base,
        url: `${origin}/lambat`,
        allowLoopback: true,
        timeoutMs: 200,
      }),
    ).toMatchObject({ ok: false, errorCode: 'timeout', retryable: true });
    expect(received.filter((item) => item.path === '/redirect')).toHaveLength(1);
  });

  it('DNS rebinding / alamat terlarang hasil DNS ditolak SEBELUM menyambung', async () => {
    const before = received.length;
    // Nama publik yang di-resolve ke loopback (rebinding) → ditolak; tidak ada permintaan masuk.
    expect(
      await deliverWebhook({
        ...base,
        url: `https://contoh-rebinding.test:443/hook`,
        lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      }),
    ).toMatchObject({ ok: false, errorCode: 'blocked_address' });
    expect(
      await deliverWebhook({
        ...base,
        url: 'http://publik.test/hook',
        lookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
      }),
    ).toMatchObject({ ok: false, errorCode: 'https_required' });
    // Campuran publik + privat yang belum diizinkan → ditolak.
    expect(
      await deliverWebhook({
        ...base,
        url: 'https://campuran.test/hook',
        lookup: () =>
          Promise.resolve([
            { address: '203.0.113.10', family: 4 },
            { address: '10.0.0.8', family: 4 },
          ]),
      }),
    ).toMatchObject({ ok: false, errorCode: 'private_not_allowed' });
    // Tidak ada permintaan yang sampai ke server mana pun.
    expect(received.length).toBe(before);
  });
});
