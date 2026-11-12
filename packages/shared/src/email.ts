/**
 * Bentuk baku alamat email: tanpa spasi di tepi dan huruf kecil semua.
 * Database menolak email yang tidak baku (lihat `users` di `@balesin/db`), sehingga
 * `Budi@Contoh.com` dan `budi@contoh.com` selalu dianggap akun yang sama.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
