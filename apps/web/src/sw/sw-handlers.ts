import { isAppPath, parsePushPayload, resolveAppUrl } from './push-payload';

/**
 * Penangan service worker yang bisa dites tanpa browser: semua akses ke `self` lewat `SwScope`.
 * `sw.ts` hanya memasang penangan ini ke event-nya.
 */

export interface SwWindowClient {
  url: string;
  focused?: boolean;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}

export interface SwScope {
  origin: string;
  showNotification(title: string, options: NotificationOptions): Promise<void>;
  matchWindows(): Promise<readonly SwWindowClient[]>;
  openWindow(url: string): Promise<unknown>;
}

export interface SwText {
  fallbackTitle: string;
  fallbackBody: string;
}

/** Pesan service worker → halaman: buka path aplikasi tanpa memuat ulang (router SPA). */
export const NAVIGATE_MESSAGE = 'balesin:navigate';
/** Pesan halaman → service worker: pakai versi baru sekarang. */
export const SKIP_WAITING_MESSAGE = 'balesin:skip-waiting';

const ICON = '/icons/icon-192.png';
const FALLBACK_URL = '/inbox';

/**
 * `push`: tampilkan notifikasi dari isi yang valid. Isi tidak valid tetap menghasilkan notifikasi
 * umum (browser mewajibkan notifikasi untuk setiap push `userVisibleOnly`), tanpa teks dari push.
 * Data notifikasi hanya menyimpan path tujuan — bukan judul/isi.
 */
export async function handlePush(
  scope: SwScope,
  readJson: () => unknown,
  text: SwText,
): Promise<void> {
  let raw: unknown;
  try {
    raw = readJson();
  } catch {
    raw = null;
  }
  const payload = parsePushPayload(raw);
  if (!payload) {
    await scope.showNotification(text.fallbackTitle, {
      body: text.fallbackBody,
      tag: 'pembaruan-inbox',
      icon: ICON,
      data: { url: FALLBACK_URL },
    });
    return;
  }
  await scope.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    icon: ICON,
    badge: ICON,
    data: { url: payload.url },
  });
}

/**
 * `notificationclick`: fokus ke tab aplikasi yang sudah terbuka lalu minta router membuka path-nya;
 * tanpa tab → buka jendela baru. Path diperiksa ulang (data notifikasi bisa saja dari versi lama).
 */
export async function handleNotificationClick(scope: SwScope, data: unknown): Promise<void> {
  const path =
    typeof data === 'object' && data !== null && isAppPath((data as { url?: unknown }).url)
      ? (data as { url: string }).url
      : FALLBACK_URL;
  const target = resolveAppUrl(path, scope.origin) ?? `${scope.origin}${FALLBACK_URL}`;
  const windows = (await scope.matchWindows()).filter((client) => {
    try {
      return new URL(client.url).origin === scope.origin;
    } catch {
      return false;
    }
  });
  const client =
    windows.find((item) => item.focused) ??
    windows.find((item) => new URL(item.url).pathname.startsWith('/inbox')) ??
    windows[0];
  if (client) {
    await client.focus();
    client.postMessage({
      type: NAVIGATE_MESSAGE,
      url: new URL(target).pathname + new URL(target).search,
    });
    return;
  }
  await scope.openWindow(target);
}

/**
 * Strategi `fetch`: HANYA aset statis hasil build (daftar precache) yang dilayani dari cache.
 * API, WebSocket, unggahan, dan media pelanggan tidak pernah disimpan. Navigasi = jaringan dulu;
 * halaman aplikasi dari cache hanya saat jaringan putus.
 */
export function fetchStrategy(
  request: { method: string; url: string; mode: string },
  origin: string,
  precache: ReadonlySet<string>,
): 'cache-first' | 'network-first-shell' | 'network' {
  if (request.method !== 'GET' || precache.size === 0) return 'network';
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return 'network';
  }
  if (url.origin !== origin || url.pathname.startsWith('/api/')) return 'network';
  if (request.mode === 'navigate') return 'network-first-shell';
  return precache.has(url.pathname) && url.search === '' ? 'cache-first' : 'network';
}
