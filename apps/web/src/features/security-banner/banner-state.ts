import type { SecurityEvent, SecuritySummaryResponse } from '@balesin/shared';
import { deviceKey, readDeviceValue } from '../../lib/device-storage';
import { SECURITY_EVENT_FILTERS, toDateInput, type AuditSearch } from '../audit/audit-search';

/** Kunci "terakhir ditutup" per pengguna (perangkat ini saja; server tidak menyimpannya). */
export function bannerSeenKey(userId: string): string {
  return deviceKey(`peringatan-keamanan.${userId}`);
}

/** Waktu terakhir ditutup (ms), atau 0 bila belum pernah / penyimpanan tidak bisa dibaca. */
export function readSeenAt(userId: string): number {
  const value = readDeviceValue(bannerSeenKey(userId));
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time) ? 0 : time;
}

/** Kejadian `warning` yang lebih baru dari "terakhir ditutup", terbaru dulu. */
export function unseenWarnings(summary: SecuritySummaryResponse, seenAt: number): SecurityEvent[] {
  if (!summary.latestWarningAt || Date.parse(summary.latestWarningAt) <= seenAt) return [];
  return summary.events.filter(
    (event) => event.severity === 'warning' && Date.parse(event.occurredAt) > seenAt,
  );
}

/** Tautan Audit log tersaring untuk kejadian yang belum dilihat. */
export function auditSearchFor(events: readonly SecurityEvent[], since: string): AuditSearch {
  const kinds = new Set(events.map((event) => event.kind));
  const oldest = events.at(-1)?.occurredAt ?? since;
  const search: AuditSearch = { from: toDateInput(new Date(oldest)) };
  const [only] = kinds;
  const filter = kinds.size === 1 && only ? SECURITY_EVENT_FILTERS[only] : undefined;
  return { ...search, ...filter };
}
