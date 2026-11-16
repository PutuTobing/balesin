import { API_KEY_SCOPE_IMPLIES, type ApiKeyScope } from '@balesin/shared';

const DAY = 86_400_000;
const MAX_DAYS = 730;

export type Expiry = 'never' | 'd30' | 'd90' | 'd365' | 'custom';
const EXPIRY_DAYS: Record<Exclude<Expiry, 'never' | 'custom'>, number> = {
  d30: 30,
  d90: 90,
  d365: 365,
};

/** Scope yang ikut didapat dari pilihan (untuk ditampilkan tercentang & terkunci). */
export function impliedScopes(selected: ReadonlySet<ApiKeyScope>): Set<ApiKeyScope> {
  const implied = new Set<ApiKeyScope>();
  for (const scope of selected) {
    for (const extra of API_KEY_SCOPE_IMPLIES[scope]) if (!selected.has(extra)) implied.add(extra);
  }
  return implied;
}

/** Tanggal berakhir (ISO) dari pilihan masa berlaku; `undefined` = tidak sah. */
export function expiryFrom(
  expiry: Expiry,
  customDate: string,
  now = Date.now(),
): string | null | undefined {
  if (expiry === 'never') return null;
  if (expiry !== 'custom') return new Date(now + EXPIRY_DAYS[expiry] * DAY).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(customDate)) return undefined;
  // Akhir hari di zona waktu perangkat.
  const end = new Date(`${customDate}T23:59:59`);
  const time = end.getTime();
  if (Number.isNaN(time) || time <= now || time > now + MAX_DAYS * DAY) return undefined;
  return end.toISOString();
}
