/**
 * Tautan di email (undangan, atur ulang password, verifikasi email).
 *
 * Token sekali pakai SELALU berada di FRAGMENT URL (`…/undangan#token=…`), tidak pernah di path
 * atau query string:
 *  - fragment tidak dikirim browser ke server, jadi tidak tercatat di log akses web/proxy/API
 *    (sensor log API tidak menangkap rahasia di segmen path);
 *  - fragment tidak ikut header `Referer`;
 *  - fragment tetap tersimpan di riwayat browser — halaman web WAJIB langsung membuangnya
 *    (`history.replaceState`) setelah membaca token ke memori, lalu mengirim token di BODY.
 *
 * Tautan disusun server dari `APP_URL` (konfigurasi), tidak pernah dari header `Host` permintaan.
 */

/** Halaman web tujuan tautan email (alamat halaman berbahasa Indonesia). */
export const EMAIL_LINK_PATHS = {
  invitation: '/undangan',
  passwordReset: '/atur-ulang-password',
  emailVerification: '/verifikasi-email',
} as const;
export type EmailLinkKind = keyof typeof EMAIL_LINK_PATHS;

/** Nama parameter token di fragment: `#token=…`. */
export const LINK_TOKEN_PARAM = 'token';

/** Halaman web "lupa password" (formulir minta tautan atur ulang). */
export const FORGOT_PASSWORD_PATH = '/lupa-password';

/**
 * `https://app.contoh.co.id` + `invitation` + token → `https://app.contoh.co.id/undangan#token=…`.
 * Path dasar di `APP_URL` (mis. `https://contoh.co.id/balesin`) dipertahankan.
 */
export function buildTokenLink(appUrl: string, kind: EmailLinkKind, token: string): string {
  // `APP_URL` sudah divalidasi saat start (http(s), tanpa query); query/fragment tetap dibuang.
  const base = (appUrl.split('#')[0] ?? '').split('?')[0]?.replace(/\/+$/, '') ?? '';
  if (!/^https?:\/\/[^/]+/i.test(base)) throw new Error('APP_URL tidak valid untuk tautan email');
  return `${base}${EMAIL_LINK_PATHS[kind]}#${LINK_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

/** Token dari fragment `location.hash` (`#token=…`), atau `null` bila tidak ada. */
export function readTokenFromFragment(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of fragment.split('&')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator) !== LINK_TOKEN_PARAM) continue;
    try {
      const token = decodeURIComponent(part.slice(separator + 1));
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }
  return null;
}
