import {
  EMAIL_OUTBOUND_STATUSES,
  type EmailOutboundListQuery,
  type EmailOutboundStatus,
} from '@balesin/shared';
import { isValidDate } from '../audit/audit-search';

/**
 * Saringan Pengaturan → API key → Email terkirim di parameter URL (`?apiKeyId=…&status=failed`),
 * supaya tautan "Email terkirim" dari kartu key langsung membuka daftar tersaring dan tombol Back
 * bekerja. Tanggal `YYYY-MM-DD` (zona waktu perangkat).
 */
export interface EmailOutboundSearch {
  apiKeyId?: string;
  senderId?: string;
  status?: EmailOutboundStatus;
  from?: string;
  to?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENDER = /^(chn|acc)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const match = (value: unknown, pattern: RegExp) =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;
const date = (value: unknown) =>
  typeof value === 'string' && isValidDate(value) ? value : undefined;

/** Nilai tak dikenal dibuang (bukan membuat halaman gagal); semua kunci selalu ada. */
export function parseEmailOutboundSearch(search: Record<string, unknown>): EmailOutboundSearch {
  return {
    apiKeyId: match(search.apiKeyId, UUID),
    senderId: match(search.senderId, SENDER),
    status: EMAIL_OUTBOUND_STATUSES.find((status) => status === search.status),
    from: date(search.from),
    to: date(search.to),
  };
}

export function emailOutboundRangeInvalid(search: EmailOutboundSearch): boolean {
  return Boolean(search.from && search.to && search.to < search.from);
}

function startOfLocalDay(value: string, addDays = 0): string {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day + addDays).toISOString();
}

/**
 * Saringan untuk API (tanpa kursor). "Sampai tanggal" inklusif di layar → awal hari berikutnya.
 * Rentang terbalik tidak dikirim (layar menampilkan pesannya).
 */
export function emailOutboundQuery(search: EmailOutboundSearch): EmailOutboundListQuery {
  const query: EmailOutboundListQuery = {};
  if (search.apiKeyId) query.apiKeyId = search.apiKeyId;
  if (search.senderId) query.senderId = search.senderId;
  if (search.status) query.status = search.status;
  if (!emailOutboundRangeInvalid(search)) {
    if (search.from) query.from = startOfLocalDay(search.from);
    if (search.to) query.to = startOfLocalDay(search.to, 1);
  }
  return query;
}

export function hasEmailOutboundFilters(search: EmailOutboundSearch): boolean {
  return Object.values(search).some((value) => value !== undefined && value !== '');
}
