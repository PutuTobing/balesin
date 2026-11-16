/**
 * Service worker aplikasi (dibangun terpisah sebagai skrip klasik `/sw.js` oleh
 * `vite/service-worker-plugin.ts`):
 *  - precache aset statis hasil build (bukan API, bukan data pelanggan); versi baru menunggu
 *    sampai pengguna menekan "Muat ulang" (pesan `SKIP_WAITING_MESSAGE`);
 *  - Web Push: tampilkan notifikasi dari isi yang valid, klik → buka path aplikasi.
 * Di dev server daftar precache kosong: tidak ada yang di-cache, hanya push.
 */
import { t } from '../i18n/id';
import {
  SKIP_WAITING_MESSAGE,
  fetchStrategy,
  handleNotificationClick,
  handlePush,
  type SwScope,
} from './sw-handlers';

declare const __PRECACHE__: readonly string[];
declare const __SW_VERSION__: string;

// Tipe minimal ServiceWorkerGlobalScope (lib "WebWorker" tidak dipakai di tsconfig web).
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}
interface PushEvent extends ExtendableEvent {
  data: { json(): unknown } | null;
}
interface NotificationEvent extends ExtendableEvent {
  notification: Notification;
}
interface MessageEventLike extends ExtendableEvent {
  data: unknown;
}
interface WindowClientLike {
  url: string;
  focused: boolean;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}
interface ServiceWorkerScopeLike {
  location: Location;
  registration: ServiceWorkerRegistration;
  clients: {
    matchAll(options: {
      type: 'window';
      includeUncontrolled: boolean;
    }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'push', listener: (event: PushEvent) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: NotificationEvent) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
}

const sw = self as unknown as ServiceWorkerScopeLike;
const CACHE_PREFIX = 'aset-statis-';
const CACHE = `${CACHE_PREFIX}${__SW_VERSION__}`;
const PRECACHE = new Set(__PRECACHE__);
const SHELL = '/index.html';

const scope: SwScope = {
  origin: sw.location.origin,
  showNotification: (title, options) => sw.registration.showNotification(title, options),
  matchWindows: () => sw.clients.matchAll({ type: 'window', includeUncontrolled: true }),
  openWindow: (url) => sw.clients.openWindow(url),
};

sw.addEventListener('install', (event) => {
  if (PRECACHE.size === 0) return;
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...PRECACHE])));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener('message', (event) => {
  const data = event.data as { type?: unknown } | null;
  if (data?.type === SKIP_WAITING_MESSAGE) event.waitUntil(sw.skipWaiting());
});

// Tanpa daftar precache (dev server) TIDAK ada penangan fetch sama sekali: semua permintaan
// langsung ke jaringan (juga tidak mengganggu mock `page.route` di tes Playwright).
if (PRECACHE.size > 0)
  sw.addEventListener('fetch', (event) => {
    const strategy = fetchStrategy(event.request, scope.origin, PRECACHE);
    if (strategy === 'network') return;
    if (strategy === 'cache-first') {
      event.respondWith(
        caches
          .open(CACHE)
          .then((cache) => cache.match(event.request))
          .then((cached) => cached ?? fetch(event.request)),
      );
      return;
    }
    // Navigasi: jaringan dulu; kerangka aplikasi dari cache hanya saat offline.
    event.respondWith(
      fetch(event.request).catch(() =>
        caches
          .open(CACHE)
          .then((cache) => cache.match(SHELL))
          .then((cached) => cached ?? Response.error()),
      ),
    );
  });

sw.addEventListener('push', (event) => {
  event.waitUntil(
    handlePush(scope, () => event.data?.json() ?? null, {
      fallbackTitle: t.pwa.fallbackTitle,
      fallbackBody: t.pwa.fallbackBody,
    }),
  );
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(scope, event.notification.data));
});
