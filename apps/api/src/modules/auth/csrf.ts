import { constantTimeEqual, deriveKey, hmacSha256, type Secret } from '@balesin/core';

/**
 * Token CSRF terikat sesi (SECURITY.md §1, catatan F.4 review Fase 0).
 *
 * Token = HMAC-SHA256(kunci turunan `SESSION_SECRET`, hash token sesi). Web menerimanya di
 * badan respons login / `GET /auth/me`, lalu mengirimnya balik di header `X-CSRF-Token` pada
 * setiap permintaan yang mengubah data. Server menghitung ulang dari cookie sesi yang datang
 * bersama permintaan itu dan membandingkannya (waktu-konstan).
 *
 * Kenapa bukan double-submit "cookie polos = header": situs di subdomain lain bisa menulis
 * cookie untuk domain induk, sehingga cookie CSRF polos bisa dipalsukan. Token ini tidak bisa
 * dibuat tanpa `SESSION_SECRET` dan hanya cocok untuk SATU sesi; halaman lintas situs tidak bisa
 * membacanya (CORS hanya mengizinkan origin aplikasi) maupun menyetel header khusus tanpa
 * preflight. `SameSite=Lax` dan pemeriksaan `Origin` tetap ada sebagai lapis tambahan.
 */
export interface CsrfProtection {
  tokenFor(sessionTokenHash: string): string;
  verify(sessionTokenHash: string, presented: unknown): boolean;
}

export function createCsrfProtection(sessionSecret: Secret<string>): CsrfProtection {
  const key = deriveKey(sessionSecret.reveal(), 'balesin/csrf/v1');
  const tokenFor = (sessionTokenHash: string) => hmacSha256(key, `csrf|${sessionTokenHash}`);

  return {
    tokenFor,
    verify(sessionTokenHash, presented) {
      if (typeof presented !== 'string' || presented.length === 0 || presented.length > 128) {
        return false;
      }
      return constantTimeEqual(presented, tokenFor(sessionTokenHash));
    },
  };
}
