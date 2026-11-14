/** Tujuan bawaan setelah masuk. */
export const DEFAULT_AFTER_LOGIN = '/inbox';

/** Halaman publik yang bisa dibuka tanpa sesi (tamu): masuk, setup, dan halaman tautan email. */
const GUEST_PAGES = [
  '/masuk',
  '/setup',
  '/undangan',
  '/lupa-password',
  '/atur-ulang-password',
  '/verifikasi-email',
];

/**
 * Halaman di luar aplikasi yang tidak masuk akal dijadikan tujuan setelah masuk (termasuk
 * layar pendaftaran 2FA wajib, yang hanya untuk sesi terbatas, dan halaman tautan email).
 */
const PUBLIC_PREFIXES = [...GUEST_PAGES, '/verifikasi-dua-langkah'];

function matchesPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Halaman untuk tamu: 401 dari API di sini (mis. pemeriksaan sesi latar `/auth/me` untuk tamu)
 * bukan "sesi berakhir" dan tidak boleh memindahkan pengguna ke halaman masuk.
 */
export function isGuestPage(pathname: string): boolean {
  return matchesPrefix(pathname, GUEST_PAGES);
}

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
  if (matchesPrefix(url.pathname, PUBLIC_PREFIXES)) return DEFAULT_AFTER_LOGIN;
  return target;
}
