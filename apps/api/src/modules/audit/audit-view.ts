import { describeUserAgent, formatLocalTime, redactSecrets } from '@balesin/core';
import {
  AUDIT_TARGET_TYPE_LABELS,
  USER_ROLE_LABELS,
  auditActionLabel,
  type AuditLogEntry,
  type AuditTargetType,
} from '@balesin/shared';

import type { AuditRow } from './audit.repo';

/**
 * Bentuk audit untuk dikirim ke web dan CSV. Metadata sudah disaring saat DITULIS (`recordAudit`),
 * tetapi disaring LAGI di sini (`redactSecrets`) — baris lama atau penulis yang lupa tidak boleh
 * membuat rahasia sampai ke browser — lalu dibuat datar: nilai bersarang menjadi teks JSON,
 * teks dipotong.
 */

const METADATA_TEXT_MAX = 500;
const METADATA_KEYS_MAX = 40;

function clip(text: string): string {
  return text.length > METADATA_TEXT_MAX ? `${text.slice(0, METADATA_TEXT_MAX)}…` : text;
}

export function publicMetadata(
  metadata: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const redacted = redactSecrets(metadata) as Record<string, unknown>;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(redacted).slice(0, METADATA_KEYS_MAX)) {
    if (value === null || typeof value === 'boolean') result[key] = value;
    else if (typeof value === 'number') result[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === 'string') result[key] = clip(value);
    else if (value === undefined) continue;
    else result[key] = clip(JSON.stringify(value) ?? '');
  }
  return result;
}

export function toAuditEntry(row: AuditRow): AuditLogEntry {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    action: row.action,
    actor: row.actor,
    target:
      row.targetType === null
        ? null
        : {
            type: row.targetType,
            id: row.targetId,
            name: row.targetType === 'user' ? (row.targetUser?.name ?? null) : null,
          },
    metadata: publicMetadata(row.metadata),
    ipAddress: row.ipAddress,
    device: row.userAgent === null ? null : describeUserAgent(row.userAgent),
  };
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/**
 * Satu sel CSV (RFC 4180) yang aman dibuka di Excel/Google Sheets/LibreOffice:
 *  - Formula injection (OWASP "CSV Injection"): teks yang diawali `=`, `+`, `-`, `@`, tab, atau CR
 *    — juga setelah spasi/kutip di depannya — diberi awalan `'` sehingga dibaca sebagai teks, bukan
 *    rumus. Data audit memuat isian pengguna (nama, email, user agent).
 *  - Selalu dikutip; `"` digandakan; karakter kendali selain baris baru dibuang.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '""';
  // eslint-disable-next-line no-control-regex
  let text = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (/^[\s"']*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(values: ReadonlyArray<string | number | boolean | null | undefined>) {
  return `${values.map(csvCell).join(',')}\r\n`;
}

export const AUDIT_CSV_HEADER = [
  'Waktu (UTC)',
  'Waktu setempat',
  'Aksi',
  'Kode aksi',
  'Pelaku',
  'Email pelaku',
  'Peran pelaku',
  'Jenis target',
  'ID target',
  'Nama target',
  'Alamat IP',
  'Perangkat',
  'Rincian',
] as const;

function targetTypeLabel(type: string | null): string | null {
  if (type === null) return null;
  return Object.hasOwn(AUDIT_TARGET_TYPE_LABELS, type)
    ? AUDIT_TARGET_TYPE_LABELS[type as AuditTargetType]
    : type;
}

/** Satu baris CSV untuk satu entri audit (kolom = `AUDIT_CSV_HEADER`). */
export function auditCsvRow(row: AuditRow, timeZone: string): string {
  const entry = toAuditEntry(row);
  const details = Object.entries(entry.metadata)
    .map(([key, value]) => `${key}=${value === null ? '' : String(value)}`)
    .join('; ');
  return csvRow([
    entry.createdAt,
    formatLocalTime(row.createdAt, timeZone),
    auditActionLabel(entry.action),
    entry.action,
    entry.actor?.name ?? 'Sistem',
    entry.actor?.email ?? null,
    entry.actor ? USER_ROLE_LABELS[entry.actor.role] : null,
    targetTypeLabel(entry.target?.type ?? null),
    entry.target?.id ?? null,
    entry.target?.name ?? null,
    entry.ipAddress,
    entry.device,
    details,
  ]);
}
