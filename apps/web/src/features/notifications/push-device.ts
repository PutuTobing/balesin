import { createPushSubscriptionRequestSchema } from '@balesin/shared';
import { endpoints } from '../../lib/api/endpoints';
import { readyRegistration } from '../../pwa/service-worker';

/**
 * Web Push di perangkat ini (docs/KONTRAK-API-NOTIFIKASI.md "Alur"). Izin browser diminta HANYA
 * dari klik pengguna (`enablePush`). Langganan terikat sesi di server; saat keluar dilepas di
 * kedua sisi (`releasePush`).
 */

export type PushSupport = 'supported' | 'ios-install' | 'unsupported';
export type PushPermission = NotificationPermission;

export class PushSetupError extends Error {
  constructor(
    readonly reason: 'dismissed' | 'denied' | 'worker' | 'subscribe',
    options?: { cause?: unknown },
  ) {
    super(reason, options);
    this.name = 'PushSetupError';
  }
}

function isIos(): boolean {
  const { userAgent, maxTouchPoints } = navigator;
  // iPadOS 13+ mengaku "Macintosh"; bedanya ada layar sentuh.
  return /iP(hone|ad|od)/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function pushSupport(): PushSupport {
  const supported =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (supported) return 'supported';
  // iOS/iPadOS 16.4+: Web Push hanya untuk aplikasi yang dipasang ke Layar Utama.
  return isIos() && !isStandalone() ? 'ios-install' : 'unsupported';
}

export function pushPermission(): PushPermission {
  return 'Notification' in window ? Notification.permission : 'denied';
}

/** Kunci VAPID base64url → byte untuk `applicationServerKey`. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((byte, index) => byte === key[index]);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null;
  try {
    const registration = await readyRegistration(3_000);
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** Minta izin (dari klik), berlangganan di browser, lalu daftarkan ke server. */
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission === 'denied') throw new PushSetupError('denied');
  if (permission !== 'granted') throw new PushSetupError('dismissed');

  let registration: ServiceWorkerRegistration;
  try {
    registration = await readyRegistration();
  } catch (cause) {
    throw new PushSetupError('worker', { cause });
  }
  // Galat API (mis. 503 tanpa master key) diteruskan apa adanya: pesannya dari server.
  const { publicKey } = await endpoints.notifications.vapidPublicKey();
  const key = base64UrlToBytes(publicKey);

  let subscription = await registration.pushManager.getSubscription();
  // Kunci VAPID organisasi berganti: langganan lama tidak bisa dipakai lagi.
  if (subscription && !sameKey(subscription, key)) {
    await subscription.unsubscribe().catch(() => false);
    subscription = null;
  }
  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
    } catch (cause) {
      throw new PushSetupError('subscribe', { cause });
    }
  }
  const body = createPushSubscriptionRequestSchema.safeParse(subscription.toJSON());
  if (!body.success) throw new PushSetupError('subscribe', { cause: body.error });
  await endpoints.notifications.subscribe(body.data);
}

/**
 * Lepas perangkat ini. `server: true` = hapus juga di server (butuh sesi + CSRF); saat sesi sudah
 * berakhir cukup lepas di browser (server menghapus langganan milik sesi itu sendiri).
 */
export async function releasePush({ server }: { server: boolean }): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  if (server) {
    try {
      await endpoints.notifications.unsubscribe(subscription.endpoint);
    } catch {
      // Tetap dilepas di browser: server juga membersihkan langganan per sesi.
    }
  }
  await subscription.unsubscribe().catch(() => false);
}
