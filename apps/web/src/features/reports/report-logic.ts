import { REPORT_MAX_DAYS } from '@balesin/shared';
import { isApiError } from '../../lib/api/client';
import { t } from '../../i18n/id';
import { retryTransient } from '../inbox/inbox-queries';

export type RangePreset = '7' | '30' | 'bulan' | 'bulan-lalu' | 'kustom';
export const RANGE_PRESETS: readonly RangePreset[] = ['7', '30', 'bulan', 'bulan-lalu', 'kustom'];

export interface DateRange {
  from: string;
  to: string;
}

const DAY = 86_400_000;

/** Tanggal hari ini `YYYY-MM-DD` di zona waktu organisasi. */
export function todayIn(zone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts;
}

const toDate = (value: string) => new Date(`${value}T00:00:00Z`);
const toText = (date: Date) => date.toISOString().slice(0, 10);

export function addDays(value: string, days: number): string {
  return toText(new Date(toDate(value).getTime() + days * DAY));
}

/** Rentang preset (termasuk hari ini, zona organisasi). */
export function presetRange(preset: Exclude<RangePreset, 'kustom'>, today: string): DateRange {
  switch (preset) {
    case '7':
      return { from: addDays(today, -6), to: today };
    case '30':
      return { from: addDays(today, -29), to: today };
    case 'bulan':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'bulan-lalu': {
      const first = toDate(`${today.slice(0, 7)}-01`);
      const lastPrevious = new Date(first.getTime() - DAY);
      return { from: `${toText(lastPrevious).slice(0, 7)}-01`, to: toText(lastPrevious) };
    }
  }
}

/** Jumlah hari rentang (termasuk kedua ujung). */
export function rangeDays(range: DateRange): number {
  return Math.round((toDate(range.to).getTime() - toDate(range.from).getTime()) / DAY) + 1;
}

/** Galat rentang (sama dengan server): urutan & maksimal 92 hari. */
export function rangeError(range: DateRange): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(range.to)) {
    return t.reports.rangeOrder;
  }
  if (range.from > range.to) return t.reports.rangeOrder;
  if (rangeDays(range) > REPORT_MAX_DAYS) return t.reports.rangeTooLong(REPORT_MAX_DAYS);
  return null;
}

const shortDate = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const longDate = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatDay(value: string, withYear = false): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return value;
  return (withYear ? longDate : shortDate).format(date);
}

export function formatRange(range: DateRange): string {
  return t.reports.rangeText(formatDay(range.from, true), formatDay(range.to, true));
}

/** Detik → "45 dtk", "3 mnt 20 dtk", "2 jam 5 mnt", "3 hari 4 jam". `null` → "—". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} dtk`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const rest = total % 60;
    return rest > 0 && minutes < 10 ? `${minutes} mnt ${rest} dtk` : `${minutes} mnt`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours} jam ${rest} mnt` : `${hours} jam`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest > 0 ? `${days} hari ${rest} jam` : `${days} hari`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('id-ID');
}

/** Persen dari bagian/total ("62%"), `null` bila total 0. */
export function formatPercent(part: number, total: number): string | null {
  if (total <= 0) return null;
  return `${Math.round((part / total) * 100).toLocaleString('id-ID')}%`;
}

export function formatScore(value: number | null): string {
  if (value === null) return '—';
  return value.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Bulan `YYYY-MM` → "November 2026". */
export function formatMonth(month: string): string {
  const date = toDate(`${month}-01`);
  return new Intl.DateTimeFormat('id-ID', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** 12 bulan terakhir (terbaru dulu) dari hari ini. */
export function recentMonths(today: string, count = 12): string[] {
  const [year = 2026, month = 1] = today.split('-').map(Number);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1 - index, 1));
    return toText(date).slice(0, 7);
  });
}

/** Skala sumbu: batas atas "rapi" (1, 2, 5 × 10ⁿ) dan garis bantu. */
export function niceScale(max: number, ticks = 4): { top: number; step: number } {
  if (max <= 0) return { top: ticks, step: 1 };
  const rough = max / ticks;
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = [1, 2, 5, 10].find((factor) => factor * power >= rough) ?? 10;
  const step = Math.max(1, unit * power);
  return { top: Math.ceil(max / step) * step, step };
}

/**
 * Ulang otomatis laporan: gangguan sementara (seperti query lain), dan 429 SINGKAT dari gerbang
 * "laporan lain sedang diproses" (≤ 10 dtk, maks. 2×). 429 batas per menit (lebih lama) dan 503
 * "persempit rentang" tidak diulang: pengguna yang memutuskan.
 */
export function retryReport(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status === 429) {
    return failureCount < 2 && (error.retryAfterSeconds ?? 60) <= 10;
  }
  return retryTransient(failureCount, error);
}

export function reportRetryDelay(failureCount: number, error: unknown): number {
  if (isApiError(error) && error.status === 429 && error.retryAfterSeconds) {
    return error.retryAfterSeconds * 1000;
  }
  return Math.min(1000 * 2 ** failureCount, 8000);
}
