import { isIP } from 'node:net';

import { describeUserAgent } from '@balesin/core';
import type { ActiveSession } from '@balesin/shared';

import type { ActiveSessionRow } from '../auth/session.repo';

/**
 * Bentuk satu sesi untuk daftar "sesi aktif" (SECURITY.md §10: data seperlunya). IP disamarkan
 * sebagian — cukup untuk mengenali jaringan ("kantor", "rumah"), tidak membuka alamat lengkap;
 * user agent diringkas menjadi peramban + sistem operasi. Token dan hash sesi tidak pernah ikut.
 */
export function toActiveSession(
  row: ActiveSessionRow,
  currentSessionRef?: string,
  currentCreatedAt?: Date,
): ActiveSession {
  return {
    id: row.id,
    device: describeUserAgent(row.userAgent),
    ipAddress: maskIpAddress(row.ipAddress),
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    current: row.id === currentSessionRef,
    limited: row.kind === 'two_factor_enrollment',
    confirmationRequired: requiresConfirmation(row, currentSessionRef, currentCreatedAt),
  };
}

/**
 * Mengeluarkan sesi SENDIRI yang dibuat pada/sesudah sesi pemanggil wajib konfirmasi identitas
 * (review butir 6 R4). Seri (waktu sama) dianggap "lebih baru" — lebih aman.
 */
export function requiresConfirmation(
  row: Pick<ActiveSessionRow, 'id' | 'createdAt'>,
  currentSessionRef: string | undefined,
  currentCreatedAt: Date | undefined,
): boolean {
  if (currentSessionRef === undefined || currentCreatedAt === undefined) return false;
  if (row.id === currentSessionRef) return false;
  return row.createdAt.getTime() >= currentCreatedAt.getTime();
}

/** Delapan grup heksadesimal alamat IPv6 (tanpa zona), atau `undefined` bila tidak sah. */
function ipv6Groups(address: string): string[] | undefined {
  const plain = address.split('%')[0] ?? '';
  if (isIP(plain) !== 6) return undefined;
  const [head = '', tail] = plain.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
  return [...headGroups, ...Array<string>(Math.max(0, missing)).fill('0'), ...tailGroups].map(
    (group) => group.toLowerCase().replace(/^0+(?=.)/, ''),
  );
}

/**
 * `203.0.113.45` → `203.0.113.*`; `2001:db8:85a3::8a2e:370:7334` → `2001:db8:85a3:*`;
 * `::ffff:198.51.100.7` → `198.51.100.*`. Nilai yang bukan IP → `null`.
 */
export function maskIpAddress(ip: string | null): string | null {
  if (ip === null) return null;
  // Kolom `inet` bisa mengembalikan awalan (`/32`) bila disimpan dengan awalan.
  const address = ip.split('/')[0] ?? '';
  if (isIP(address) === 4) return `${address.split('.').slice(0, 3).join('.')}.*`;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  if (mapped) return maskIpAddress(mapped);
  const groups = ipv6Groups(address);
  if (!groups) return null;
  return `${groups.slice(0, 3).join(':')}:*`;
}
