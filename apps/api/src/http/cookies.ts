/**
 * Cookie sesi (SECURITY.md §1).
 *
 * - `HttpOnly; SameSite=Lax; Path=/`, tanpa `Domain` (terikat ke satu host).
 * - Lewat HTTPS: `Secure` + nama berawalan `__Host-`. Browser hanya menerima cookie `__Host-`
 *   bila `Secure`, `Path=/`, dan tanpa `Domain` — subdomain lain tidak bisa menimpanya.
 * - Lewat http://localhost (pengembangan lokal): browser menolak cookie `__Host-`/`Secure`
 *   dari HTTP biasa, jadi dipakai nama polos tanpa `Secure`. Mode ini hanya aktif bila
 *   `APP_URL` berskema http, yang di production hanya diterima untuk localhost.
 *
 * Sengaja ditulis sendiri (±40 baris) alih-alih menambah dependensi: yang dibutuhkan hanya
 * membaca SATU cookie dan menulis SATU cookie dengan atribut tetap.
 */

const SECURE_COOKIE_NAME = '__Host-balesin_session';
const PLAIN_COOKIE_NAME = 'balesin_session';

export function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_COOKIE_NAME : PLAIN_COOKIE_NAME;
}

/** Token sesi: 32 byte acak dalam base64url = tepat 43 karakter. Bentuk lain langsung diabaikan. */
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Nilai satu cookie bernama `name` dari header `Cookie`, bila cocok `pattern`. Bila nama yang
 * sama muncul lebih dari sekali (tanda ada yang mencoba menyisipkan cookie), tidak satu pun
 * dipercaya.
 */
function readCookie(
  cookieHeader: string | undefined,
  name: string,
  pattern: RegExp,
): string | undefined {
  if (!cookieHeader || cookieHeader.length > 8_192) return undefined;

  let found: string | undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    if (found !== undefined) return undefined;
    found = part.slice(separator + 1).trim();
  }
  return found !== undefined && pattern.test(found) ? found : undefined;
}

/** Mengambil token sesi dari header `Cookie`. */
export function readSessionToken(
  cookieHeader: string | undefined,
  secure: boolean,
): string | undefined {
  return readCookie(cookieHeader, sessionCookieName(secure), SESSION_TOKEN_PATTERN);
}

function attributes(
  secure: boolean,
  maxAgeSeconds: number,
  sameSite: 'Lax' | 'Strict' = 'Lax',
): string {
  return `Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

/** Nilai header `Set-Cookie` untuk memasang sesi. */
export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return `${sessionCookieName(secure)}=${token}; ${attributes(secure, maxAgeSeconds)}`;
}

/** Nilai header `Set-Cookie` untuk menghapus cookie sesi di browser. */
export function clearedSessionCookie(secure: boolean): string {
  return `${sessionCookieName(secure)}=; ${attributes(secure, 0)}`;
}

// ── Cookie "perangkat dikenal" (modules/auth/trusted-device.ts) ─────────────
//
// Atribut sama dengan cookie sesi, tetapi `SameSite=Strict` (hanya dibaca saat login, yang
// selalu dipanggil dari halaman aplikasi sendiri) dan TIDAK dihapus saat logout.

const SECURE_DEVICE_COOKIE_NAME = '__Host-balesin_device';
const PLAIN_DEVICE_COOKIE_NAME = 'balesin_device';
const DEVICE_TOKEN_PATTERN = /^v1\.[0-9a-f-]{36}\.\d{1,12}\.[A-Za-z0-9_-]{43}$/;

export function deviceCookieName(secure: boolean): string {
  return secure ? SECURE_DEVICE_COOKIE_NAME : PLAIN_DEVICE_COOKIE_NAME;
}

export function readDeviceToken(
  cookieHeader: string | undefined,
  secure: boolean,
): string | undefined {
  return readCookie(cookieHeader, deviceCookieName(secure), DEVICE_TOKEN_PATTERN);
}

export function deviceCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return `${deviceCookieName(secure)}=${token}; ${attributes(secure, maxAgeSeconds, 'Strict')}`;
}
