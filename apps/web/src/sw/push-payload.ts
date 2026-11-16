/**
 * Logika murni service worker untuk Web Push (docs/KONTRAK-API-NOTIFIKASI.md "Isi push"). Sengaja
 * TANPA Zod/`@balesin/shared` supaya service worker kecil; kesesuaiannya dengan
 * `pushNotificationPayloadSchema` dijaga oleh tes (`push-payload.test.ts`).
 *
 * Isi push datang dari server kita, tetapi tetap divalidasi ketat: hanya path RELATIF aplikasi
 * yang boleh dibuka saat notifikasi diklik (tidak pernah URL lain / origin lain).
 */

export interface PushPayload {
  v: 1;
  title: string;
  body: string;
  /** Path relatif aplikasi, diawali satu `/`. */
  url: string;
  tag: string;
  conversationId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Diawali tepat satu `/` (bukan `//host` atau `/\host`), tanpa karakter kontrol. */
// eslint-disable-next-line no-control-regex -- justru menolak karakter kontrol
const APP_PATH = /^\/(?![/\\])[^\u0000-\u001f\u007f]*$/;
/** Batas tampilan (notifikasi panjang dipotong browser juga; ini penjaga ukuran). */
const TITLE_MAX = 120;
const BODY_MAX = 240;
const TAG_MAX = 80;

/** Path relatif aplikasi yang aman dibuka (lihat `resolveAppUrl` untuk pemeriksaan origin). */
export function isAppPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && APP_PATH.test(value);
}

/** Validasi isi push (bentuk `pushNotificationPayloadSchema`); selain itu `null`. */
export function parsePushPayload(raw: unknown): PushPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.v !== 1) return null;
  if (typeof value.title !== 'string' || typeof value.body !== 'string') return null;
  if (typeof value.tag !== 'string' || !isAppPath(value.url)) return null;
  const conversationId = value.conversationId;
  if (
    conversationId !== null &&
    !(typeof conversationId === 'string' && UUID.test(conversationId))
  ) {
    return null;
  }
  return {
    v: 1,
    title: value.title.slice(0, TITLE_MAX),
    body: value.body.slice(0, BODY_MAX),
    url: value.url,
    tag: value.tag.slice(0, TAG_MAX),
    conversationId,
  };
}

/**
 * URL lengkap untuk path aplikasi di origin service worker. `null` bila bukan path aplikasi atau
 * hasilnya keluar dari origin (mis. `/\evil.example` yang ditafsirkan browser sebagai host).
 */
export function resolveAppUrl(path: unknown, origin: string): string | null {
  if (!isAppPath(path)) return null;
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  // Normalisasi URL bisa mengubah `/.%2e//host` menjadi `//host` (review PWA R1): path seperti itu
  // ditafsirkan sebagai host lain begitu dipakai ulang sebagai path relatif.
  if (url.pathname.startsWith('//') || url.pathname.includes('\\')) return null;
  return `${origin}${url.pathname}${url.search}`;
}
