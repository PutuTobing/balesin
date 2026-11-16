import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';

/**
 * Web Push standar (Fase 2 butir 10, docs/KONTRAK-API-NOTIFIKASI.md) — implementasi kecil sendiri,
 * tanpa dependensi (DECISIONS 2026-11-17):
 *  - enkripsi isi `aes128gcm` (RFC 8291 + RFC 8188), diverifikasi dengan vektor uji RFC 8291;
 *  - identitas server VAPID (RFC 8292): JWT ES256 di header `Authorization: vapid t=…, k=…`;
 *  - pengiriman lewat `fetch` TANPA mengikuti redirect, dengan batas waktu, HANYA ke host layanan
 *    push yang dikenal (cegah SSRF lewat alamat langganan dari browser).
 */

const CURVE = 'prime256v1';
const RECORD_SIZE = 4096;
/** Batas isi polos yang kita kirim (layanan push menerima ±4 KB terenkripsi termasuk header). */
export const PUSH_PAYLOAD_MAX_BYTES = 3_000;
const KEY_INFO = Buffer.from('WebPush: info\0', 'latin1');
const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'latin1');
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'latin1');

/** Kunci langganan dari browser (`PushSubscription.toJSON().keys`), base64url. */
export interface PushSubscriptionKeys {
  /** Kunci publik ECDH P-256 browser (65 byte, tak terkompresi). */
  p256dh: string;
  /** Rahasia autentikasi (16 byte). */
  auth: string;
}

/** Pasangan kunci VAPID: publik = titik P-256 tak terkompresi (65 byte), privat = skalar 32 byte. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export class PushKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushKeyError';
  }
}

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new PushKeyError('Bukan base64url');
  return Buffer.from(value.replace(/=+$/, ''), 'base64url');
}

/** Kunci publik P-256 tak terkompresi yang SAH (titik di kurva), atau melempar `PushKeyError`. */
export function parseP256PublicKey(value: string): Buffer {
  const key = decode(value);
  if (key.length !== 65 || key[0] !== 0x04) throw new PushKeyError('Kunci publik tidak valid');
  try {
    // Menghitung rahasia dengan kunci sementara memaksa Node memeriksa titiknya ada di kurva.
    const probe = createECDH(CURVE);
    probe.generateKeys();
    probe.computeSecret(key);
  } catch {
    throw new PushKeyError('Kunci publik bukan titik P-256');
  }
  return key;
}

export function parseAuthSecret(value: string): Buffer {
  const secret = decode(value);
  if (secret.length !== 16) throw new PushKeyError('Rahasia autentikasi harus 16 byte');
  return secret;
}

/** Pasangan kunci VAPID baru. */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH(CURVE);
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
}

function signingKey(keys: VapidKeys): KeyObject {
  const publicKey = decode(keys.publicKey);
  const d = decode(keys.privateKey);
  if (publicKey.length !== 65 || d.length !== 32) throw new PushKeyError('Kunci VAPID tidak valid');
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: publicKey.subarray(1, 33).toString('base64url'),
      y: publicKey.subarray(33, 65).toString('base64url'),
      d: d.toString('base64url'),
    },
    format: 'jwk',
  });
}

/**
 * Header `Authorization` VAPID (RFC 8292): JWT ES256 dengan `aud` = origin layanan push, `exp` ≤ 24
 * jam (kita pakai 12 jam), `sub` = URL aplikasi atau `mailto:`.
 */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now: Date = new Date(),
): string {
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(now.getTime() / 1000) + 12 * 60 * 60,
      sub: subject,
    }),
  ).toString('base64url');
  const input = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(input), {
    key: signingKey(keys),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `vapid t=${input}.${signature}, k=${keys.publicKey}`;
}

/**
 * Enkripsi isi push `aes128gcm` (RFC 8291 §3–4) dalam SATU rekaman (tanpa padding tambahan).
 * `salt`/`serverPrivateKey` hanya untuk tes (vektor RFC) — produksi selalu acak.
 */
export function encryptPushPayload(
  plaintext: Buffer,
  keys: PushSubscriptionKeys,
  options: { salt?: Buffer; serverPrivateKey?: Buffer } = {},
): Buffer {
  const uaPublic = parseP256PublicKey(keys.p256dh);
  const authSecret = parseAuthSecret(keys.auth);
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new PushKeyError('Isi push terlalu besar');

  const ecdh = createECDH(CURVE);
  if (options.serverPrivateKey) ecdh.setPrivateKey(options.serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  const ikm = Buffer.from(
    hkdfSync('sha256', ecdhSecret, authSecret, Buffer.concat([KEY_INFO, uaPublic, asPublic]), 32),
  );
  const salt = options.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, CEK_INFO, 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, NONCE_INFO, 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed]);
}

// ── Alamat layanan push yang dikenal (cegah SSRF) ───────────────────────────

/**
 * Host layanan push browser utama. Alamat langganan datang dari BROWSER (input tidak tepercaya):
 * hanya HTTPS port bawaan ke host-host ini yang diterima dan dikirimi.
 *  - Chrome/Edge(Chromium)/Opera/Samsung: FCM;
 *  - Firefox: autopush Mozilla;
 *  - Safari (macOS/iOS 16.4+ PWA): Apple;
 *  - Edge lama/Windows: WNS.
 */
export const PUSH_SERVICE_HOSTS: { exact: readonly string[]; suffix: readonly string[] } = {
  exact: ['fcm.googleapis.com', 'android.googleapis.com', 'web.push.apple.com'],
  suffix: ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'],
};

export const PUSH_ENDPOINT_MAX_LENGTH = 1_024;

/**
 * URL langganan yang boleh dipakai, atau `null`. `extraOrigins` HANYA untuk server push tiruan di
 * tes/dev (origin persis, mis. `http://127.0.0.1:4321`).
 */
export function checkPushEndpoint(raw: string, extraOrigins: readonly string[] = []): URL | null {
  if (raw.length === 0 || raw.length > PUSH_ENDPOINT_MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') return null;
  if (extraOrigins.includes(url.origin)) return url;
  if (url.protocol !== 'https:' || url.port !== '') return null;
  const host = url.hostname.toLowerCase();
  const known =
    PUSH_SERVICE_HOSTS.exact.includes(host) ||
    PUSH_SERVICE_HOSTS.suffix.some(
      (suffix) => host.endsWith(suffix) && host.length > suffix.length,
    );
  return known ? url : null;
}

// ── Pengiriman ──────────────────────────────────────────────────────────────

export interface WebPushRequest {
  endpoint: string;
  keys: PushSubscriptionKeys;
  /** Isi polos (JSON kecil), maks. `PUSH_PAYLOAD_MAX_BYTES`. */
  payload: Buffer;
  vapid: VapidKeys;
  /** `sub` VAPID: URL aplikasi (https) atau `mailto:`. */
  subject: string;
  ttlSeconds: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  /** Pengganti pesan tertunda yang sama (≤ 32 karakter base64url). */
  topic?: string;
  extraOrigins?: readonly string[];
  timeoutMs?: number;
  now?: Date;
  fetch?: typeof fetch;
}

export type WebPushResult =
  | { status: 'sent'; httpStatus: number }
  /** Langganan tidak berlaku lagi (404/410) — hapus. */
  | { status: 'gone'; httpStatus: number }
  /** Ditolak (400/401/403/413/429/5xx) — catat, jangan hapus. */
  | { status: 'rejected'; httpStatus: number }
  /** Tidak terjangkau / batas waktu / alamat tidak dikenal. */
  | { status: 'unreachable'; reason: 'endpoint' | 'network' | 'timeout' };

export async function sendWebPush(request: WebPushRequest): Promise<WebPushResult> {
  const url = checkPushEndpoint(request.endpoint, request.extraOrigins);
  if (!url) return { status: 'unreachable', reason: 'endpoint' };
  if (request.payload.length > PUSH_PAYLOAD_MAX_BYTES) {
    throw new PushKeyError('Isi push terlalu besar');
  }
  const body = encryptPushPayload(request.payload, request.keys);
  const headers: Record<string, string> = {
    TTL: String(Math.max(0, Math.floor(request.ttlSeconds))),
    Urgency: request.urgency,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: vapidAuthorization(url.href, request.vapid, request.subject, request.now),
  };
  if (request.topic && /^[A-Za-z0-9_-]{1,32}$/.test(request.topic)) headers.Topic = request.topic;
  const doFetch = request.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url.href, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(request.timeoutMs ?? 10_000),
    });
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'TimeoutError';
    return { status: 'unreachable', reason: timeout ? 'timeout' : 'network' };
  }
  // Isi jawaban tidak dibaca (bisa memuat apa saja); cukup kode statusnya.
  await response.body?.cancel().catch(() => undefined);
  const httpStatus = response.status;
  if (httpStatus >= 200 && httpStatus < 300) return { status: 'sent', httpStatus };
  if (httpStatus === 404 || httpStatus === 410) return { status: 'gone', httpStatus };
  return { status: 'rejected', httpStatus };
}
