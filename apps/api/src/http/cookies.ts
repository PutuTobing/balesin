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
 * Mengambil token sesi dari header `Cookie`. Bila nama yang sama muncul lebih dari sekali
 * (tanda ada yang mencoba menyisipkan cookie), tidak satu pun dipercaya.
 */
export function readSessionToken(
  cookieHeader: string | undefined,
  secure: boolean,
): string | undefined {
  if (!cookieHeader || cookieHeader.length > 8_192) return undefined;
  const name = sessionCookieName(secure);

  let found: string | undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    if (found !== undefined) return undefined;
    found = part.slice(separator + 1).trim();
  }
  return found !== undefined && SESSION_TOKEN_PATTERN.test(found) ? found : undefined;
}

function attributes(secure: boolean, maxAgeSeconds: number): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

/** Nilai header `Set-Cookie` untuk memasang sesi. */
export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return `${sessionCookieName(secure)}=${token}; ${attributes(secure, maxAgeSeconds)}`;
}

/** Nilai header `Set-Cookie` untuk menghapus cookie sesi di browser. */
export function clearedSessionCookie(secure: boolean): string {
  return `${sessionCookieName(secure)}=; ${attributes(secure, 0)}`;
}
