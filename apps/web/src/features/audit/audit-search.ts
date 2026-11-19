import {
  AUDIT_ACTION_NAMES,
  AUDIT_TARGET_TYPES,
  type AuditAction,
  type AuditLogFilter,
  type AuditTargetType,
  type SecurityEventKind,
} from '@balesin/shared';

/**
 * Saringan Audit log di parameter URL (`/pengaturan/audit?action=…&from=2026-11-07`), supaya
 * tautan dari banner keamanan / detail anggota langsung membuka daftar tersaring dan tombol
 * Back bekerja. Tanggal memakai `YYYY-MM-DD` (zona waktu perangkat), bukan ISO penuh.
 */
export interface AuditSearch {
  actorUserId?: string;
  userId?: string;
  action?: AuditAction;
  targetType?: AuditTargetType;
  targetId?: string;
  from?: string;
  to?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TARGET_ID = /^[A-Za-z0-9._:-]{1,100}$/;

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((item) => item === value);
}

function match(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

/** Tanggal `YYYY-MM-DD` yang benar-benar ada (bukan 2026-02-31). */
export function isValidDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/**
 * Validasi parameter URL: nilai tak dikenal dibuang (bukan membuat halaman gagal). Semua kunci
 * selalu dikembalikan karena router menggabungkan hasil ini di atas parameter mentah.
 */
export function parseAuditSearch(search: Record<string, unknown>): AuditSearch {
  const date = (value: unknown) => {
    const text = match(value, DATE);
    return text && isValidDate(text) ? text : undefined;
  };
  return {
    actorUserId: match(search.actorUserId, UUID),
    userId: match(search.userId, UUID),
    action: pick(search.action, AUDIT_ACTION_NAMES),
    targetType: pick(search.targetType, AUDIT_TARGET_TYPES),
    targetId: match(search.targetId, TARGET_ID),
    from: date(search.from),
    to: date(search.to),
  };
}

/** Awal hari lokal untuk `YYYY-MM-DD` sebagai ISO UTC. */
function startOfLocalDay(value: string, addDays = 0): string {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day + addDays).toISOString();
}

/** Rentang tanggal terbalik (akhir sebelum mulai). */
export function rangeInvalid(search: Pick<AuditSearch, 'from' | 'to'>): boolean {
  return Boolean(search.from && search.to && search.to < search.from);
}

/**
 * Saringan untuk API. "Sampai tanggal" inklusif di layar, jadi dikirim sebagai awal hari
 * berikutnya (`from ≤ waktu < to`). Rentang terbalik tidak dikirim (layar menampilkan pesannya).
 */
export function auditFilter(search: AuditSearch): AuditLogFilter {
  const filter: AuditLogFilter = {};
  if (search.actorUserId) filter.actorUserId = search.actorUserId;
  if (search.userId) filter.userId = search.userId;
  if (search.action) filter.action = search.action;
  if (search.targetType) filter.targetType = search.targetType;
  if (search.targetId) filter.targetId = search.targetId;
  if (!rangeInvalid(search)) {
    if (search.from) filter.from = startOfLocalDay(search.from);
    if (search.to) filter.to = startOfLocalDay(search.to, 1);
  }
  return filter;
}

/** Jumlah saringan yang sedang dipakai (penanda tombol Saringan di HP). */
export function activeFilterCount(search: AuditSearch): number {
  return Object.values(search).filter((value) => value !== undefined && value !== '').length;
}

/** `YYYY-MM-DD` dari tanggal (zona waktu perangkat). */
export function toDateInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Saringan Audit log untuk tiap jenis kejadian keamanan (tautan dari banner). Sebagian: jenis baru
 * dari server yang belum dikenal di sini cukup memakai saringan tanggal. Perubahan channel tercatat
 * dengan beberapa aksi (dibuat, diubah, dihapus, profil bisnis, …), jadi disaring menurut jenis
 * target.
 */
export const SECURITY_EVENT_FILTERS: Readonly<
  Partial<Record<SecurityEventKind, Pick<AuditSearch, 'action' | 'targetType'>>>
> = {
  email_sender_changed: { action: 'settings.email.updated' },
  two_factor_reset: { action: 'user.2fa.reset' },
  two_factor_enrollment_reopened: { action: 'user.2fa.enrollment_reopened' },
  password_reset_without_two_factor: { action: 'auth.password_reset.completed' },
  account_locked: { action: 'auth.account.locked' },
  role_changed: { action: 'user.role_changed' },
  user_disabled: { action: 'user.disabled' },
  channel_changed: { targetType: 'channel' },
  business_profile_changed: { targetType: 'channel' },
  member_joined: { action: 'user.invitation.accepted' },
  password_reset_burst: { action: 'auth.password_reset.burst' },
  webhook_signature_failed: {
    action: 'channel.webhook_signature_rejected',
    targetType: 'channel',
  },
  sending_paused: { action: 'sending.paused' },
  sending_limit_reached: { action: 'sending.limit_reached' },
  sending_limits_changed: { action: 'settings.sending_limits.updated' },
  inbox_bulk_action: { action: 'inbox.bulk_action' },
  quick_reply_risky: { targetType: 'quick_reply' },
  api_key_changed: { targetType: 'api_key' },
  webhook_changed: { targetType: 'webhook' },
  webhook_disabled: { action: 'webhook.auto_disabled' },
  bot_enabled: { action: 'channel.bot_updated' },
  auto_message_risky: { action: 'settings.workspace.updated' },
  owner_password_reset_server: { action: 'auth.password_reset.completed' },
  branding_changed: { action: 'settings.branding.updated' },
  bot_verified_sender_disabled: { action: 'channel.bot_updated' },
};
