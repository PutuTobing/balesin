import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

/**
 * Allowlist host URL lampiran email per API key (tahap 9.1, §2): host persis, wildcard satu tingkat
 * `*.domain` (semua subdomain, BUKAN domain induknya), atau IP literal. Dinormalisasi: huruf kecil,
 * IDN → punycode, tanpa titik di ujung. `null` = tidak sah.
 */
export function normalizeAttachmentHost(value: string): string | null {
  const raw = value.trim().toLowerCase().replace(/\.$/, '');
  if (raw === '' || raw.length > 253) return null;
  const bare = raw.replace(/^\[|\]$/g, '');
  if (isIP(bare) !== 0) return bare;
  const wildcard = raw.startsWith('*.');
  const host = wildcard ? raw.slice(2) : raw;
  if (host.includes('*')) return null;
  const ascii = domainToASCII(host);
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split('.');
  // Minimal dua label (`*.example` saja = seluruh TLD, ditolak).
  if (labels.length < 2) return null;
  if (!labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return wildcard ? `*.${ascii}` : ascii;
}
