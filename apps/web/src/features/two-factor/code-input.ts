/** Kode TOTP: hanya angka, paling banyak 6. Tempelan "123 456" atau "123-456" ikut rapi. */
export function sanitizeTotpInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6);
}
