/**
 * Token setup dari fragment alamat (`/setup#token=…`). Fragment tidak dikirim browser ke
 * server, jadi token tidak tercatat di log. Setelah dibaca, wizard menghapusnya dari alamat.
 */
export function readSetupTokenFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const value = new URLSearchParams(raw).get('token')?.trim();
  return value && value.length <= 512 ? value : null;
}
