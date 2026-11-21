import { createECDH, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
  checkPushEndpoint,
  encryptPushPayload,
  generateVapidKeys,
  parseP256PublicKey,
  sendWebPush,
  vapidAuthorization,
} from './web-push';

/** RFC 8291 Lampiran A (spasi dalam nilai base64url dibuang). */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

describe('enkripsi aes128gcm (RFC 8291)', () => {
  it('cocok dengan vektor uji RFC 8291 Lampiran A', () => {
    const body = encryptPushPayload(
      Buffer.from(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      {
        salt: Buffer.from(RFC.salt, 'base64url'),
        serverPrivateKey: Buffer.from(RFC.asPrivate, 'base64url'),
      },
    );
    expect(body.subarray(0, 86).toString('base64url')).toBe(RFC.header);
    expect(body.subarray(86).toString('base64url')).toBe(RFC.ciphertext);
  });

  it('kunci browser yang rusak / bukan titik kurva ditolak', () => {
    expect(() => parseP256PublicKey('AAAA')).toThrow();
    const notOnCurve = Buffer.alloc(65, 1);
    notOnCurve[0] = 4;
    expect(() => parseP256PublicKey(notOnCurve.toString('base64url'))).toThrow();
    expect(() =>
      encryptPushPayload(Buffer.from('x'), { p256dh: RFC.uaPublic, auth: 'AAAA' }),
    ).toThrow();
  });
});

describe('VAPID (RFC 8292)', () => {
  it('JWT ES256 sah untuk kunci publiknya; aud = origin layanan push; exp ≤ 24 jam', () => {
    const keys = generateVapidKeys();
    const now = new Date('2026-11-17T10:00:00Z');
    const header = vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/abc',
      keys,
      'https://balesin.example',
      now,
    );
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match!;
    expect(k).toBe(keys.publicKey);
    const payload = JSON.parse(Buffer.from(claims!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Math.floor(now.getTime() / 1000) + 12 * 3600,
      sub: 'https://balesin.example',
    });
    const publicKey = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: publicKey.subarray(1, 33).toString('base64url'),
        y: publicKey.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${head!}.${claims!}`),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature!, 'base64url'),
      ),
    ).toBe(true);
  });
});

describe('alamat layanan push (cegah SSRF)', () => {
  it('hanya HTTPS ke host layanan push yang dikenal', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://web.push.apple.com/QGuQ',
      'https://wns2-sg2p.notify.windows.com/w/?token=x',
    ]) {
      expect(checkPushEndpoint(ok), ok).not.toBeNull();
    }
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://evil.example/fcm.googleapis.com',
      'https://fcm.googleapis.com.evil.example/x',
      'https://push.services.mozilla.com.evil.example/x',
      'https://notify.windows.com/x',
      'https://169.254.169.254/latest',
      'https://127.0.0.1/x',
      'file:///etc/passwd',
      'bukan url',
      `https://fcm.googleapis.com/${'a'.repeat(1100)}`,
    ]) {
      expect(checkPushEndpoint(bad), bad).toBeNull();
    }
    expect(
      checkPushEndpoint('http://127.0.0.1:4321/p/1', ['http://127.0.0.1:4321']),
    ).not.toBeNull();
  });
});

describe('sendWebPush', () => {
  it('mengirim terenkripsi ke server tiruan; 410 = gone; redirect tidak diikuti; alamat asing tidak dihubungi', async () => {
    const browser = createECDH('prime256v1');
    browser.generateKeys();
    const keys = {
      p256dh: browser.getPublicKey().toString('base64url'),
      auth: Buffer.alloc(16, 7).toString('base64url'),
    };
    const seen: { url: string; headers: Record<string, unknown>; bytes: number }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.push({
          url: request.url ?? '',
          headers: request.headers,
          bytes: Buffer.concat(chunks).length,
        });
        if (request.url === '/gone') response.writeHead(410).end();
        else if (request.url === '/redirect')
          response.writeHead(302, { location: 'http://127.0.0.1:1/' }).end();
        else response.writeHead(201).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    try {
      const base = {
        keys,
        payload: Buffer.from('{"title":"Tes"}'),
        vapid: generateVapidKeys(),
        subject: 'https://balesin.example',
        ttlSeconds: 3600,
        urgency: 'high' as const,
        topic: 'c018f00000000700080000000000000a',
        extraOrigins: [origin],
      };
      expect(await sendWebPush({ ...base, endpoint: `${origin}/ok` })).toEqual({
        status: 'sent',
        httpStatus: 201,
      });
      expect(seen[0]?.headers).toMatchObject({
        'content-encoding': 'aes128gcm',
        ttl: '3600',
        urgency: 'high',
        topic: 'c018f00000000700080000000000000a',
      });
      expect(String(seen[0]?.headers.authorization)).toMatch(/^vapid t=.+, k=.+$/);
      expect(seen[0]?.bytes).toBe(86 + 15 + 1 + 16);
      expect(await sendWebPush({ ...base, endpoint: `${origin}/gone` })).toEqual({
        status: 'gone',
        httpStatus: 410,
      });
      expect(await sendWebPush({ ...base, endpoint: `${origin}/redirect` })).toMatchObject({
        status: 'rejected',
        httpStatus: 302,
      });
      expect(await sendWebPush({ ...base, endpoint: 'https://evil.example/x' })).toEqual({
        status: 'unreachable',
        reason: 'endpoint',
      });
      expect(seen).toHaveLength(3);
    } finally {
      server.close();
    }
  });
});
