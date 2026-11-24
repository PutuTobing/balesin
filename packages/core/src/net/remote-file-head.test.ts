/**
 * Review 9A-2 S5/R8: `fetchRemoteFile` — byte awal diperiksa sebelum sisanya ditampung
 * (`acceptHead`), User-Agent pemanggil dikirim ke SEMUA lompatan. Server tiruan di loopback.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchRemoteFile } from './outgoing-webhook';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const agents: string[] = [];
let sentAfterHead = 0;
let origin = '';

const server = createServer((request, response) => {
  agents.push(String(request.headers['user-agent']));
  if (request.url === '/png') {
    response.writeHead(200, { 'content-length': String(PNG_HEAD.length + 4) });
    response.end(Buffer.concat([PNG_HEAD, Buffer.from('ekor')]));
  } else if (request.url === '/alih') {
    response.writeHead(302, { location: '/png' }).end();
  } else if (request.url === '/html-menetes') {
    // Tanpa Content-Length; kepala bukan raster lalu terus mengirim.
    response.writeHead(200, { 'content-type': 'image/png' });
    response.write('<html><body>');
    const timer = setInterval(() => {
      sentAfterHead += 1;
      if (!response.write('x'.repeat(64 * 1024))) clearInterval(timer);
    }, 5);
    response.on('close', () => clearInterval(timer));
  } else {
    response.writeHead(404).end();
  }
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => {
  server.close();
});

const acceptHead = {
  bytes: 12,
  accept: (head: Buffer) => head.subarray(0, 4).equals(PNG_HEAD.subarray(0, 4)),
};

describe('fetchRemoteFile — acceptHead & userAgent', () => {
  it('kepala raster diterima; isi utuh; UA pemanggil dipakai juga setelah redirect', async () => {
    agents.length = 0;
    const result = await fetchRemoteFile({
      url: `${origin}/alih`,
      privateCidrs: [],
      maxBytes: 1024,
      allowLoopback: true,
      userAgent: 'Mozilla/5.0 (uji)',
      acceptHead,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.toString('latin1').endsWith('ekor')).toBe(true);
    expect(agents).toEqual(['Mozilla/5.0 (uji)', 'Mozilla/5.0 (uji)']);
  });

  it('kepala bukan raster → content_rejected seketika (sisa isi tidak ditampung)', async () => {
    sentAfterHead = 0;
    const result = await fetchRemoteFile({
      url: `${origin}/html-menetes`,
      privateCidrs: [],
      maxBytes: 5 * 1024 * 1024,
      timeoutMs: 3_000,
      allowLoopback: true,
      acceptHead,
    });
    expect(result).toMatchObject({ ok: false, error: 'content_rejected' });
    expect(sentAfterHead).toBeLessThan(20);
  });

  it('tanpa userAgent → UA bawaan', async () => {
    agents.length = 0;
    await fetchRemoteFile({
      url: `${origin}/png`,
      privateCidrs: [],
      maxBytes: 1024,
      allowLoopback: true,
    });
    expect(agents).toEqual(['Balesin-Media/1.0']);
  });
});
