/**
 * Review keamanan Fase 2 butir 10 — Web Push buatan sendiri
 * (docs/security-reviews/2026-11-18-fase2-notifikasi-push.md). Penjaga regresi: dekripsi sisi
 * penerima (RFC 8291) untuk keluaran ACAK, tidak ada pemakaian ulang salt/kunci efemeral, titik kurva
 * tidak sah, VAPID tidak bisa dipalsukan kunci lain, dan daftar host push tahan bypass.
 */
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  checkPushEndpoint,
  encryptPushPayload,
  generateVapidKeys,
  parseP256PublicKey,
  PushKeyError,
  vapidAuthorization,
} from './web-push';

/** Dekripsi sebagai BROWSER (RFC 8291 §3–4, RFC 8188) — implementasi independen untuk tes. */
function decryptAsBrowser(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  expect(recordSize).toBeGreaterThanOrEqual(record.length);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const shared = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12),
  );
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  // Rekaman terakhir: isi + 0x02 + nol opsional.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  expect(padded[end]).toBe(0x02);
  return padded.subarray(0, end);
}

function browserKeys() {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  return {
    uaPrivate: ua.getPrivateKey(),
    uaPublic: ua.getPublicKey(),
    auth,
    keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
}

describe('aes128gcm keluaran produksi (acak)', () => {
  it('bisa didekripsi browser; salt & kunci efemeral berbeda tiap pesan', () => {
    const browser = browserKeys();
    const plaintext = Buffer.from(JSON.stringify({ v: 1, title: 'Pesan baru dari Budi' }));
    const first = encryptPushPayload(plaintext, browser.keys);
    const second = encryptPushPayload(plaintext, browser.keys);
    expect(
      decryptAsBrowser(first, browser.uaPrivate, browser.uaPublic, browser.auth).equals(plaintext),
    ).toBe(true);
    expect(
      decryptAsBrowser(second, browser.uaPrivate, browser.uaPublic, browser.auth).equals(plaintext),
    ).toBe(true);
    // Salt (16 byte pertama) dan kunci publik efemeral (65 byte setelah header) tidak dipakai ulang.
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false);
    expect(first.subarray(21, 86).equals(second.subarray(21, 86))).toBe(false);
    expect(first.subarray(86).equals(second.subarray(86))).toBe(false);
  });

  it('auth secret lain / kunci browser lain tidak bisa membuka isinya', () => {
    const browser = browserKeys();
    const other = browserKeys();
    const body = encryptPushPayload(Buffer.from('rahasia'), browser.keys);
    expect(() =>
      decryptAsBrowser(body, browser.uaPrivate, browser.uaPublic, Buffer.from('fedcba9876543210')),
    ).toThrow();
    expect(() => decryptAsBrowser(body, other.uaPrivate, other.uaPublic, other.auth)).toThrow();
  });

  it('titik di luar kurva, titik terkompresi, dan titik tak hingga ditolak', () => {
    const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]).toString(
      'base64url',
    );
    const compressed = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 7)]).toString(
      'base64url',
    );
    for (const value of [offCurve, compressed, Buffer.from([0x00]).toString('base64url'), '!!']) {
      expect(() => parseP256PublicKey(value)).toThrow(PushKeyError);
    }
  });
});

describe('VAPID', () => {
  it('tanda tangan tidak sah untuk kunci publik lain; aud tanpa path/kredensial', () => {
    const keys = generateVapidKeys();
    const other = generateVapidKeys();
    const header = vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/abc?x=1',
      keys,
      'https://balesin.contoh.co.id',
    );
    const [, head, claims, signature] =
      /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header) ?? [];
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({
      typ: 'JWT',
      alg: 'ES256',
    });
    const payload = JSON.parse(Buffer.from(claims!, 'base64url').toString()) as { aud: string };
    expect(payload.aud).toBe('https://fcm.googleapis.com');
    const publicKey = Buffer.from(other.publicKey, 'base64url');
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
    ).toBe(false);
  });
});

describe('daftar host layanan push (bypass SSRF)', () => {
  it('menolak host mirip, userinfo, port, http, IP, titik di ujung, IDN, dan sufiks telanjang', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com.evil.test/fcm/send/x',
      'https://evilfcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com@evil.test/x',
      'https://evil.test#@fcm.googleapis.com',
      'https://evil.test\\@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'http://fcm.googleapis.com/x',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://fcm.googleapis.com./x',
      'https://fcm.googleapis.cοm/x',
      'https://push.apple.com/x',
      'https://evilpush.apple.com/x',
      'https://updates.push.services.mozilla.com.evil.test/x',
      'https://notify.windows.com.evil.test/x',
      'ftp://fcm.googleapis.com/x',
      `https://fcm.googleapis.com/${'a'.repeat(1_100)}`,
    ]) {
      expect(checkPushEndpoint(endpoint), endpoint).toBeNull();
    }
  });

  it('menerima alamat layanan push asli (huruf besar dinormalkan, port 443 tersirat)', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://FCM.GOOGLEAPIS.COM/fcm/send/abc',
      'https://fcm.googleapis.com:443/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QGabc',
      'https://wns2-sg2p.notify.windows.com/w/?token=abc',
    ]) {
      expect(checkPushEndpoint(endpoint), endpoint).not.toBeNull();
    }
  });
});
