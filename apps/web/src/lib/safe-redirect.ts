/** Tujuan bawaan setelah masuk. */
export const DEFAULT_AFTER_LOGIN = '/inbox';

/**
 * Halaman di luar aplikasi yang tidak masuk akal dijadikan tujuan setelah masuk (termasuk
 * layar pendaftaran 2FA wajib, yang hanya untuk sesi terbatas).
 */
const PUBLIC_PREFIXES = ['/masuk', '/setup', '/verifikasi-dua-langkah'];

/**
 * Tujuan setelah masuk yang aman: hanya path internal aplikasi (diawali satu `/`).
 * Cegah open redirect — `//evil.com`, `/\evil.com`, `https://…`, `javascript:…`, karakter
 * kendali, dan path yang setelah dinormalkan browser keluar dari origin ini ditolak.
 */
export function safeRedirectTarget(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_AFTER_LOGIN;
  const value = raw.trim();
  if (value.length === 0 || value.length > 2048) return DEFAULT_AFTER_LOGIN;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return DEFAULT_AFTER_LOGIN;
  }
  // Karakter kendali (termasuk tab/baris baru yang dibuang parser URL) dan backslash.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return DEFAULT_AFTER_LOGIN;

  const base = 'http://balesin.invalid';
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
  if (url.origin !== base) return DEFAULT_AFTER_LOGIN;

  const target = `${url.pathname}${url.search}${url.hash}`;
  // `/..//host` dinormalkan menjadi `//host` (alamat luar tanpa skema).
  if (target.startsWith('//')) return DEFAULT_AFTER_LOGIN;
  if (
    PUBLIC_PREFIXES.some(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    )
  ) {
    return DEFAULT_AFTER_LOGIN;
  }
  return target;
}
