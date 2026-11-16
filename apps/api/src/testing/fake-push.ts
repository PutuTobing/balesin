import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Layanan push TIRUAN (tes saja) — menggantikan FCM/Mozilla/Apple. Setiap "perangkat" punya
 * pasangan kunci browser sendiri sehingga isi push yang diterima bisa DIDEKRIPSI di tes (RFC 8291),
 * persis seperti service worker di browser. Jawaban per perangkat bisa diatur (201 / 410 / …).
 */

export interface FakeDevice {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Isi push yang diterima perangkat ini (sudah didekripsi, JSON). */
  received: Array<Record<string, unknown>>;
  /** Header permintaan terakhir. */
  headers: Array<Record<string, string | string[] | undefined>>;
  /** Kode jawaban berikutnya (bawaan 201). */
  respondWith: number;
}

export interface FakePush {
  origin: string;
  device(): FakeDevice;
  close(): Promise<void>;
}

function decrypt(body: Buffer, uaPrivate: Buffer, uaPublic: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const sealed = body.subarray(21 + idLength);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12),
  );
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]);
  // Buang pembatas 0x02 (+ padding nol bila ada).
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end -= 1;
  return plain.subarray(0, end);
}

export async function startFakePush(): Promise<FakePush> {
  const devices = new Map<
    string,
    FakeDevice & { uaPrivate: Buffer; uaPublic: Buffer; auth: Buffer }
  >();
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const device = devices.get(request.url ?? '');
      if (!device) {
        response.writeHead(404).end();
        return;
      }
      device.headers.push(request.headers);
      if (device.respondWith >= 200 && device.respondWith < 300) {
        const plain = decrypt(
          Buffer.concat(chunks),
          device.uaPrivate,
          device.uaPublic,
          device.auth,
        );
        device.received.push(JSON.parse(plain.toString('utf8')) as Record<string, unknown>);
      }
      response.writeHead(device.respondWith).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    origin,
    device() {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      const auth = randomBytes(16);
      const path = `/push/${randomBytes(12).toString('hex')}`;
      const device = {
        endpoint: `${origin}${path}`,
        keys: {
          p256dh: ecdh.getPublicKey().toString('base64url'),
          auth: auth.toString('base64url'),
        },
        received: [],
        headers: [],
        respondWith: 201,
        uaPrivate: ecdh.getPrivateKey(),
        uaPublic: ecdh.getPublicKey(),
        auth,
      };
      devices.set(path, device);
      return device;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
