import {
  CONVERSATION_STALE_AFTER_MS,
  CUSTOMER_SERVICE_WINDOW_MS,
  WINDOW_EXPIRING_SOON_MS,
  channelHasCustomerWindow,
  type ChannelType,
} from '@balesin/shared';
import { t } from '../../i18n/id';

/**
 * Waktu di Inbox: jendela layanan 24 jam (hitung mundur sesi) dan cap waktu daftar/pesan.
 * Zona waktu = perangkat (sama dengan `lib/format.ts`).
 */

export type WindowState =
  /** Belum pernah ada pesan masuk (mis. percakapan dari broadcast). */
  | { kind: 'none' }
  /** Sisa lebih dari 2 jam. */
  | { kind: 'open'; remainingMs: number }
  /** Sisa ≤ 2 jam (`WINDOW_EXPIRING_SOON_MS`) — sama dengan saringan `expiring` server. */
  | { kind: 'expiring'; remainingMs: number }
  | { kind: 'expired' };

/**
 * Pesan biasa boleh dikirim sekarang: channel tanpa jendela 24 jam (Telegram, Email —
 * `windowApplies: false`) selalu boleh; selainnya selama jendela terbuka.
 */
export function replyWindowOpen(
  conversation: { windowApplies?: boolean; windowExpiresAt: string | null },
  now: number,
): boolean {
  if (conversation.windowApplies === false) return true;
  const state = windowState(conversation.windowExpiresAt, now);
  return state.kind === 'open' || state.kind === 'expiring';
}

/**
 * Chat selesai yang "dingin": pelanggan tidak menghubungi dalam 24 jam terakhir (channel Meta:
 * jendela 24 jam sudah tertutup; Email/Telegram: pesan masuk terakhir ≥ 24 jam). Membukanya lagi =
 * memulai percakapan, jadi tanpa `inbox.initiate` server menolak (403, audit akhir A1). Sama dengan
 * aturan `reopen` di server; bila jam berbeda sedikit, pesan server tetap tampil apa adanya.
 */
export function reopenIsStale(
  conversation: {
    channel: { type: ChannelType };
    windowExpiresAt: string | null;
    lastInboundAt: string | null;
  },
  now: number,
): boolean {
  if (channelHasCustomerWindow(conversation.channel.type)) {
    const end = conversation.windowExpiresAt ? Date.parse(conversation.windowExpiresAt) : NaN;
    return Number.isNaN(end) || end <= now;
  }
  const last = conversation.lastInboundAt ? Date.parse(conversation.lastInboundAt) : NaN;
  return Number.isNaN(last) || last <= now - CUSTOMER_SERVICE_WINDOW_MS;
}

/**
 * Percakapan TERBUKA yang "dingin": pelanggan tidak mengirim pesan selama
 * `CONVERSATION_STALE_AFTER_MS` (7 hari; termasuk belum pernah). Template, atau pesan apa pun di
 * Email/Telegram, ke percakapan ini = memulai percakapan (`inbox.initiate`, audit akhir P2-R2) —
 * sama dengan aturan server; bila jam berbeda sedikit, pesan server tetap tampil apa adanya.
 */
export function conversationIsCold(
  conversation: { lastInboundAt: string | null },
  now: number,
): boolean {
  const last = conversation.lastInboundAt ? Date.parse(conversation.lastInboundAt) : NaN;
  return Number.isNaN(last) || last <= now - CONVERSATION_STALE_AFTER_MS;
}

/** Hitung mundur hanya untuk channel berjendela 24 jam. */
export function windowExpiry(conversation: {
  windowApplies?: boolean;
  windowExpiresAt: string | null;
}): string | null {
  return conversation.windowApplies === false ? null : conversation.windowExpiresAt;
}

export function windowState(expiresAt: string | null, now: number): WindowState {
  if (expiresAt === null) return { kind: 'none' };
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end)) return { kind: 'none' };
  const remainingMs = end - now;
  if (remainingMs <= 0) return { kind: 'expired' };
  if (remainingMs <= WINDOW_EXPIRING_SOON_MS) return { kind: 'expiring', remainingMs };
  return { kind: 'open', remainingMs };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Sisa waktu: versi ringkas untuk baris daftar ("21 jam", "1 jam 12 mnt", "45 mnt", "< 1 mnt")
 * dan versi lengkap untuk pembaca layar. Dibulatkan ke bawah per menit: tampilan tidak pernah
 * menjanjikan waktu yang lebih panjang dari sebenarnya. Di atas 2 jam cukup jam saja.
 */
export function formatRemaining(remainingMs: number): { short: string; long: string } {
  const w = t.inbox.window;
  const totalMinutes = Math.floor(Math.max(0, remainingMs) / MINUTE);
  if (totalMinutes < 1) return { short: w.underMinute, long: w.underMinuteLong };
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return { short: w.minutes(minutes), long: w.minutesLong(minutes) };
  if (remainingMs > WINDOW_EXPIRING_SOON_MS || minutes === 0) {
    return { short: w.hours(hours), long: w.hoursLong(hours) };
  }
  return { short: w.hoursMinutes(hours, minutes), long: w.hoursMinutesLong(hours, minutes) };
}

/** Milidetik sampai tampilan hitung mundur berikutnya berubah (awal menit berikutnya). */
export function msUntilNextMinute(now: number): number {
  return MINUTE - (now % MINUTE) || MINUTE;
}

export { HOUR as HOUR_MS, MINUTE as MINUTE_MS };

// ── Cap waktu ───────────────────────────────────────────────────────────────

const clock = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat('id-ID', { weekday: 'long' });
const dayMonth = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short' });
const dayMonthYear = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const fullDate = new Intl.DateTimeFormat('id-ID', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Selisih hari kalender (0 = hari ini, 1 = kemarin). */
function daysAgo(date: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(date)) / (24 * HOUR));
}

/** Jam saja: "14.05". */
export function formatClockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : clock.format(date);
}

/**
 * Cap waktu ringkas di baris daftar chat: hari ini "14.05", kemarin "Kemarin", minggu ini nama
 * hari ("Senin"), tahun ini "12 Nov", tahun lain "12 Nov 2025".
 */
export function formatListTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const days = daysAgo(date, now);
  if (days <= 0) return clock.format(date);
  if (days === 1) return t.inbox.time.yesterday;
  if (days < 7) return weekday.format(date);
  if (date.getFullYear() === now.getFullYear()) return dayMonth.format(date);
  return dayMonthYear.format(date);
}

/** Pemisah hari di riwayat pesan: "Hari ini", "Kemarin", "Senin, 10 November 2026". */
export function formatDayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const days = daysAgo(date, now);
  if (days <= 0) return t.inbox.time.today;
  if (days === 1) return t.inbox.time.yesterday;
  return fullDate.format(date);
}

/** Kunci hari kalender lokal (untuk mengelompokkan pesan per hari). */
export function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
