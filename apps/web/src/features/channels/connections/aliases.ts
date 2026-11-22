import { EMAIL_CHANNEL_MAX_ALIASES } from '@balesin/shared';
import { normalizeAddress, splitAddressInput } from '../../inbox/email-recipients';

export type AliasRejectReason = 'invalid' | 'primary' | 'limit';

export interface AliasAddResult {
  aliases: string[];
  rejected: { address: string; reason: AliasRejectReason }[];
}

/**
 * Tahap 9.0 — tambah alias channel Email dari ketikan (aturan server: huruf kecil, duplikat & alamat
 * utama dibuang, maks. 20). Duplikat dibuang diam-diam; alamat utama & batas diberi penjelasan.
 */
export function addAliases(
  current: readonly string[],
  raw: string,
  primary: string,
  max = EMAIL_CHANNEL_MAX_ALIASES,
): AliasAddResult {
  const aliases = [...current];
  const rejected: AliasAddResult['rejected'] = [];
  const main = primary.toLowerCase();
  for (const token of splitAddressInput(raw)) {
    const address = normalizeAddress(token);
    if (!address) {
      rejected.push({ address: token, reason: 'invalid' });
      continue;
    }
    if (aliases.includes(address)) continue;
    if (address === main) {
      rejected.push({ address, reason: 'primary' });
      continue;
    }
    if (aliases.length >= max) {
      rejected.push({ address, reason: 'limit' });
      continue;
    }
    aliases.push(address);
  }
  return { aliases, rejected };
}

/** Daftar sama (urutan diabaikan) → tidak ada yang perlu disimpan. */
export function sameAliases(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((item) => set.has(item));
}
