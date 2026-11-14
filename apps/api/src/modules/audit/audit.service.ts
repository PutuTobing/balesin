import { AppError } from '@balesin/core';
import { auditLogs, type Database } from '@balesin/db';
import {
  AUDIT_ACTIONS,
  AUDIT_LOG_EXPORT_MAX_ROWS,
  AUDIT_LOG_PAGE_DEFAULT,
  SECURITY_EVENT_KINDS,
  SECURITY_EVENT_SEVERITY,
  SECURITY_SUMMARY_DAYS,
  SECURITY_SUMMARY_MAX_EVENTS,
  type AuditLogFilter,
  type AuditLogListQuery,
  type AuditLogListResponse,
  type SecurityEvent,
  type SecurityEventKind,
  type SecuritySummaryResponse,
} from '@balesin/shared';
import { and, eq, gte, or, sql, type SQL } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import type { AuthContext } from '../auth/session.service';
import { recordAudit } from './audit';
import {
  auditFilterCondition,
  countAuditRowsMatching,
  decodeAuditCursor,
  encodeAuditCursor,
  selectAuditRows,
  type AuditRow,
} from './audit.repo';
import { AUDIT_CSV_HEADER, auditCsvRow, csvRow, publicMetadata, toAuditEntry } from './audit-view';

/**
 * Audit log untuk Owner/Admin (izin `audit.view`). Alur & error: docs/KONTRAK-API-AUTH.md bagian
 * "Audit log".
 *
 * - Daftar bersaring + kursor; selalu hanya organisasi pemanggil (IDOR → daftar kosong).
 * - Ekspor CSV dengan saringan yang sama, maks. `AUDIT_LOG_EXPORT_MAX_ROWS` baris terbaru, aman dari
 *   formula injection; setiap ekspor diaudit (`audit.exported`) dan dibatasi 10/jam per pengguna.
 * - Ringkasan kejadian keamanan 7 hari terakhir untuk banner peringatan (`SECURITY_EVENT_KINDS`).
 */

export interface AuditService {
  list(auth: AuthContext, query: AuditLogListQuery): Promise<AuditLogListResponse>;
  exportCsv(
    auth: AuthContext,
    filter: AuditLogFilter,
    client: ClientInfo,
  ): Promise<{ csv: string; rows: number; truncated: boolean }>;
  securitySummary(auth: AuthContext): Promise<SecuritySummaryResponse>;
}

/** Penanda urutan bita UTF-8 di awal berkas CSV. */
const UTF8_BOM = String.fromCharCode(0xfeff);

export const AUDIT_EXPORT_RULE: RateLimitRule = {
  name: 'audit-ekspor',
  limit: 10,
  windowSeconds: 60 * 60,
};

/** Kondisi SQL per jenis kejadian keamanan (sama dengan `kindOf` di bawah). */
const SECURITY_EVENT_CONDITIONS: Readonly<Record<SecurityEventKind, SQL>> = {
  email_sender_changed: sql`(${auditLogs.action} = ${AUDIT_ACTIONS.emailSettingsUpdated} and ${auditLogs.metadata} ->> 'ownersNotified' = 'true')`,
  two_factor_reset: sql`${auditLogs.action} = ${AUDIT_ACTIONS.userTwoFactorReset}`,
  two_factor_enrollment_reopened: sql`${auditLogs.action} = ${AUDIT_ACTIONS.userTwoFactorEnrollmentReopened}`,
  password_reset_without_two_factor: sql`(${auditLogs.action} = ${AUDIT_ACTIONS.passwordResetCompleted} and ${auditLogs.metadata} ->> 'twoFactorEnrollmentPending' = 'true')`,
  account_locked: sql`(${auditLogs.action} = ${AUDIT_ACTIONS.accountLocked} and ${auditLogs.targetType} = 'user')`,
  role_changed: sql`${auditLogs.action} = ${AUDIT_ACTIONS.userRoleChanged}`,
  user_disabled: sql`${auditLogs.action} = ${AUDIT_ACTIONS.userDisabled}`,
};

/**
 * Ubah peran / nonaktifkan oleh SELAIN Owner dinaikkan menjadi `warning` (review butir 6 Info 6).
 * Baris lama tanpa `actorRole` tetap `info`.
 */
const BY_NON_OWNER = sql`(${auditLogs.metadata} ->> 'actorRole' is not null and ${auditLogs.metadata} ->> 'actorRole' <> 'owner')`;

function severityOf(kind: SecurityEventKind, row: AuditRow): 'warning' | 'info' {
  if (kind === 'role_changed' || kind === 'user_disabled') {
    const actorRole = row.metadata.actorRole;
    return typeof actorRole === 'string' && actorRole !== 'owner'
      ? 'warning'
      : SECURITY_EVENT_SEVERITY[kind];
  }
  return SECURITY_EVENT_SEVERITY[kind];
}

/** Kondisi SQL "kejadian ini `warning`" — padanan `severityOf`. */
function warningCondition(): SQL {
  const conditions = SECURITY_EVENT_KINDS.map((kind) =>
    SECURITY_EVENT_SEVERITY[kind] === 'warning'
      ? SECURITY_EVENT_CONDITIONS[kind]
      : kind === 'role_changed' || kind === 'user_disabled'
        ? (and(SECURITY_EVENT_CONDITIONS[kind], BY_NON_OWNER) as SQL)
        : undefined,
  ).filter((condition): condition is SQL => condition !== undefined);
  return or(...conditions) as SQL;
}

function kindOf(row: AuditRow): SecurityEventKind | undefined {
  switch (row.action) {
    case AUDIT_ACTIONS.emailSettingsUpdated:
      return row.metadata.ownersNotified === true ? 'email_sender_changed' : undefined;
    case AUDIT_ACTIONS.userTwoFactorReset:
      return 'two_factor_reset';
    case AUDIT_ACTIONS.userTwoFactorEnrollmentReopened:
      return 'two_factor_enrollment_reopened';
    case AUDIT_ACTIONS.passwordResetCompleted:
      return row.metadata.twoFactorEnrollmentPending === true
        ? 'password_reset_without_two_factor'
        : undefined;
    case AUDIT_ACTIONS.accountLocked:
      return row.targetType === 'user' ? 'account_locked' : undefined;
    case AUDIT_ACTIONS.userRoleChanged:
      return 'role_changed';
    case AUDIT_ACTIONS.userDisabled:
      return 'user_disabled';
    default:
      return undefined;
  }
}

/** Rincian yang berguna untuk banner (subset metadata, tanpa rahasia). */
const DETAIL_KEYS: Readonly<Record<SecurityEventKind, readonly string[]>> = {
  email_sender_changed: ['previousHost', 'host', 'port', 'fromAddress'],
  two_factor_reset: ['role'],
  two_factor_enrollment_reopened: ['role', 'dueAt'],
  password_reset_without_two_factor: [],
  account_locked: ['scope', 'lockedUntil'],
  role_changed: ['from', 'to', 'actorRole'],
  user_disabled: ['role', 'actorRole'],
};

export function createAuditService(deps: { db: Database; limiter: RateLimiter }): AuditService {
  const { db, limiter } = deps;

  return {
    async list(auth, query) {
      const limit = query.limit ?? AUDIT_LOG_PAGE_DEFAULT;
      const cursor = query.cursor === undefined ? undefined : decodeAuditCursor(query.cursor);
      if (query.cursor !== undefined && !cursor) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'Kursor halaman tidak valid. Muat ulang daftar dari awal.',
          details: [{ location: 'query', field: 'cursor', message: 'Kursor halaman tidak valid.' }],
        });
      }
      const rows = await selectAuditRows(
        db,
        auth.organizationId,
        auditFilterCondition(auth.organizationId, query),
        { limit: limit + 1, cursor },
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        entries: page.map(toAuditEntry),
        nextCursor:
          rows.length > limit && last
            ? encodeAuditCursor({ createdAtExact: last.createdAtExact, id: last.id })
            : null,
      };
    },

    async exportCsv(auth, filter, client) {
      await enforceRateLimit(
        limiter,
        AUDIT_EXPORT_RULE,
        auth.user.id,
        (wait) => `Terlalu sering mengekspor audit log. Coba lagi dalam ${wait}.`,
      );
      const rows = await selectAuditRows(
        db,
        auth.organizationId,
        auditFilterCondition(auth.organizationId, filter),
        { limit: AUDIT_LOG_EXPORT_MAX_ROWS + 1 },
      );
      const truncated = rows.length > AUDIT_LOG_EXPORT_MAX_ROWS;
      const exported = rows.slice(0, AUDIT_LOG_EXPORT_MAX_ROWS);
      // BOM UTF-8: Excel membaca huruf non-ASCII (nama, keterangan) dengan benar.
      let csv = `${UTF8_BOM}${csvRow(AUDIT_CSV_HEADER)}`;
      for (const row of exported) csv += auditCsvRow(row, auth.organization.timezone);
      await recordAudit(db, {
        organizationId: auth.organizationId,
        actorUserId: auth.user.id,
        action: AUDIT_ACTIONS.auditExported,
        targetType: 'audit_log',
        metadata: {
          rows: exported.length,
          truncated,
          // Saringan yang dipakai (nilai tanpa rahasia: ID, nama aksi, rentang waktu).
          ...Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined)),
        },
        client,
      });
      return { csv, rows: exported.length, truncated };
    },

    async securitySummary(auth) {
      const since = new Date(Date.now() - SECURITY_SUMMARY_DAYS * 24 * 60 * 60 * 1000);
      const inRange = and(
        eq(auditLogs.organizationId, auth.organizationId),
        gte(auditLogs.createdAt, since),
      ) as SQL;
      const anyKind = or(...SECURITY_EVENT_KINDS.map((kind) => SECURITY_EVENT_CONDITIONS[kind]));
      const [rows, counts, latestWarning] = await Promise.all([
        selectAuditRows(db, auth.organizationId, and(inRange, anyKind) as SQL, {
          limit: SECURITY_SUMMARY_MAX_EVENTS,
        }),
        countAuditRowsMatching(db, inRange, SECURITY_EVENT_CONDITIONS),
        selectAuditRows(db, auth.organizationId, and(inRange, warningCondition()) as SQL, {
          limit: 1,
        }),
      ]);

      const events: SecurityEvent[] = [];
      for (const row of rows) {
        const kind = kindOf(row);
        if (!kind) continue;
        const metadata = publicMetadata(row.metadata);
        events.push({
          id: row.id,
          kind,
          severity: severityOf(kind, row),
          occurredAt: row.createdAt.toISOString(),
          actor: row.actor,
          subject:
            row.targetType === 'user' && row.targetId && row.targetUser
              ? { id: row.targetId, name: row.targetUser.name, role: row.targetUser.role }
              : null,
          details: Object.fromEntries(
            DETAIL_KEYS[kind].filter((key) => key in metadata).map((key) => [key, metadata[key]!]),
          ),
        });
      }
      return {
        since: since.toISOString(),
        events,
        counts,
        latestWarningAt: latestWarning[0]?.createdAt.toISOString() ?? null,
      };
    },
  };
}
