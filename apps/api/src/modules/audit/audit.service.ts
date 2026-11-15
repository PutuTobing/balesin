import { AppError } from '@balesin/core';
import { auditLogs, type Database } from '@balesin/db';
import {
  AUDIT_ACTIONS,
  AUDIT_LOG_EXPORT_MAX_ROWS,
  AUDIT_LOG_PAGE_DEFAULT,
  CHANNEL_CHANGE_AUDIT_ACTIONS,
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
import { and, eq, gte, inArray, or, sql, type SQL } from 'drizzle-orm';

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

/**
 * Aksi channel yang tercatat sebagai `channel_changed` (selain profil bisnis, yang punya jenisnya
 * sendiri). Hanya baris bermetadata `change` (ditulis modul channels) yang dihitung.
 */
const CHANNEL_EVENT_ACTIONS: readonly string[] = Object.values(CHANNEL_CHANGE_AUDIT_ACTIONS).filter(
  (action) => action !== AUDIT_ACTIONS.channelBusinessProfileUpdated,
);

const HAS_CHANGE = sql`${auditLogs.metadata} ? 'change'`;
const OWNERS_NOTIFIED = sql`${auditLogs.metadata} ->> 'ownersNotified' = 'true'`;

/** Kondisi SQL per jenis kejadian keamanan (sama dengan `kindOf` di bawah). */
const SECURITY_EVENT_CONDITIONS: Readonly<Record<SecurityEventKind, SQL>> = {
  // Juga perubahan oleh Owner (review akhir Fase 1 T2): `ownersNotified` = jalur kirim berubah.
  email_sender_changed: sql`(${auditLogs.action} = ${AUDIT_ACTIONS.emailSettingsUpdated} and ${OWNERS_NOTIFIED})`,
  two_factor_reset: sql`${auditLogs.action} = ${AUDIT_ACTIONS.userTwoFactorReset}`,
  two_factor_enrollment_reopened: sql`${auditLogs.action} = ${AUDIT_ACTIONS.userTwoFactorEnrollmentReopened}`,
  password_reset_without_two_factor: sql`(${auditLogs.action} = ${AUDIT_ACTIONS.passwordResetCompleted} and ${auditLogs.metadata} ->> 'twoFactorEnrollmentPending' = 'true')`,
  account_locked: sql`(${auditLogs.action} = ${AUDIT_ACTIONS.accountLocked} and ${auditLogs.targetType} = 'user')`,
  role_changed: sql`${auditLogs.action} = ${AUDIT_ACTIONS.userRoleChanged}`,
  user_disabled: sql`${auditLogs.action} = ${AUDIT_ACTIONS.userDisabled}`,
  // Juga oleh Owner (`info`); oleh selain Owner `warning` (review akhir Fase 1 S1).
  channel_changed: sql`(${inArray(auditLogs.action, [...CHANNEL_EVENT_ACTIONS])} and ${HAS_CHANGE})`,
  business_profile_changed: sql`(${auditLogs.action} = ${AUDIT_ACTIONS.channelBusinessProfileUpdated} and ${HAS_CHANGE})`,
  member_joined: sql`${auditLogs.action} = ${AUDIT_ACTIONS.invitationAccepted}`,
  password_reset_burst: sql`${auditLogs.action} = ${AUDIT_ACTIONS.passwordResetBurst}`,
};

/** Baris `account_locked` maksimal di `events` ringkasan keamanan (review akhir R2). */
const LOCK_EVENTS_MAX = 5;

/** Kunci yang hanya bisa dipicu pemegang password/perangkat korban → `warning` (review akhir R2). */
const SERIOUS_LOCK_SCOPES = ['account', 'device', 'two_factor'] as const;

/**
 * Jenis yang keparahannya bergantung pada baris: `warning` bila syarat ini terpenuhi, selain itu
 * `info`. SQL dan fungsi harus sepadan (dipakai `latestWarningAt` dan `events[].severity`).
 *  - ubah peran / nonaktifkan oleh SELAIN Owner (review butir 6 Info 6; baris lama tanpa
 *    `actorRole` tetap `info`);
 *  - channel / profil bisnis oleh SELAIN Owner (yang oleh Owner tetap tercatat, `info`);
 *  - kunci per akun, per perangkat dikenal, dan langkah kedua. Kunci per email+jaringan
 *    (`source`) bisa dipicu siapa pun tanpa akun dari banyak IP — `info` supaya tidak membanjiri
 *    banner Owner (review akhir R2).
 */
const WARNING_WHEN: Partial<
  Record<SecurityEventKind, { sql: SQL; test: (metadata: Record<string, unknown>) => boolean }>
> = {
  role_changed: {
    sql: sql`(${auditLogs.metadata} ->> 'actorRole' is not null and ${auditLogs.metadata} ->> 'actorRole' <> 'owner')`,
    test: (metadata) => typeof metadata.actorRole === 'string' && metadata.actorRole !== 'owner',
  },
  user_disabled: {
    sql: sql`(${auditLogs.metadata} ->> 'actorRole' is not null and ${auditLogs.metadata} ->> 'actorRole' <> 'owner')`,
    test: (metadata) => typeof metadata.actorRole === 'string' && metadata.actorRole !== 'owner',
  },
  channel_changed: { sql: OWNERS_NOTIFIED, test: (metadata) => metadata.ownersNotified === true },
  business_profile_changed: {
    sql: OWNERS_NOTIFIED,
    test: (metadata) => metadata.ownersNotified === true,
  },
  account_locked: {
    sql: sql`coalesce(${auditLogs.metadata} ->> 'scope', 'account') in ('account', 'device', 'two_factor')`,
    test: (metadata) =>
      (SERIOUS_LOCK_SCOPES as readonly unknown[]).includes(metadata.scope ?? 'account'),
  },
};

function severityOf(kind: SecurityEventKind, row: AuditRow): 'warning' | 'info' {
  const when = WARNING_WHEN[kind];
  if (when) return when.test(row.metadata) ? 'warning' : 'info';
  return SECURITY_EVENT_SEVERITY[kind];
}

/** Kondisi SQL "kejadian ini `warning`" — padanan `severityOf`. */
function warningCondition(): SQL {
  const conditions = SECURITY_EVENT_KINDS.map((kind) => {
    const when = WARNING_WHEN[kind];
    if (when) return and(SECURITY_EVENT_CONDITIONS[kind], when.sql);
    return SECURITY_EVENT_SEVERITY[kind] === 'warning'
      ? SECURITY_EVENT_CONDITIONS[kind]
      : undefined;
  }).filter((condition): condition is SQL => condition !== undefined);
  return or(...conditions) as SQL;
}

function kindOf(row: AuditRow): SecurityEventKind | undefined {
  const hasChange = Object.hasOwn(row.metadata, 'change');
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
    case AUDIT_ACTIONS.channelCreated:
    case AUDIT_ACTIONS.channelUpdated:
    case AUDIT_ACTIONS.channelDisabled:
    case AUDIT_ACTIONS.channelEnabled:
    case AUDIT_ACTIONS.channelDeleted:
    case AUDIT_ACTIONS.channelVerifyTokenRotated:
      return hasChange ? 'channel_changed' : undefined;
    case AUDIT_ACTIONS.channelBusinessProfileUpdated:
      return hasChange ? 'business_profile_changed' : undefined;
    case AUDIT_ACTIONS.invitationAccepted:
      return 'member_joined';
    case AUDIT_ACTIONS.passwordResetBurst:
      return 'password_reset_burst';
    default:
      return undefined;
  }
}

/** Rincian yang berguna untuk banner (subset metadata, tanpa rahasia). */
const DETAIL_KEYS: Readonly<Record<SecurityEventKind, readonly string[]>> = {
  email_sender_changed: ['previousHost', 'host', 'port', 'fromAddress', 'actorRole'],
  two_factor_reset: ['role'],
  two_factor_enrollment_reopened: ['role', 'dueAt'],
  password_reset_without_two_factor: [],
  account_locked: ['scope', 'lockedUntil'],
  role_changed: ['from', 'to', 'actorRole'],
  user_disabled: ['role', 'actorRole'],
  channel_changed: ['change', 'name', 'phoneNumberId', 'changedFields', 'actorRole'],
  // Nilai lama/baru (`previous`/`next`) ada di Audit log; banner cukup menyebut isiannya.
  business_profile_changed: ['name', 'phoneNumberId', 'changedFields', 'actorRole'],
  member_joined: ['role', 'issuerRole'],
  password_reset_burst: ['accounts', 'windowMinutes'],
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
        // Tanpa durasi: web menampilkan hitung mundur dari `Retry-After`.
        () => `Batas ekspor audit log (${AUDIT_EXPORT_RULE.limit} kali per jam) sudah tercapai.`,
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
      // `account_locked` bisa dipicu siapa pun tanpa akun: paling banyak `LOCK_EVENTS_MAX` baris
      // di daftar, supaya kejadian lain tidak tergeser (`counts` tetap menghitung semuanya).
      const otherKinds = or(
        ...SECURITY_EVENT_KINDS.filter((kind) => kind !== 'account_locked').map(
          (kind) => SECURITY_EVENT_CONDITIONS[kind],
        ),
      );
      const [otherRows, lockRows, counts, latestWarning] = await Promise.all([
        selectAuditRows(db, auth.organizationId, and(inRange, otherKinds) as SQL, {
          limit: SECURITY_SUMMARY_MAX_EVENTS,
        }),
        selectAuditRows(
          db,
          auth.organizationId,
          and(inRange, SECURITY_EVENT_CONDITIONS.account_locked) as SQL,
          { limit: LOCK_EVENTS_MAX },
        ),
        countAuditRowsMatching(db, inRange, SECURITY_EVENT_CONDITIONS),
        selectAuditRows(db, auth.organizationId, and(inRange, warningCondition()) as SQL, {
          limit: 1,
        }),
      ]);

      const rows = [...otherRows, ...lockRows]
        .sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
        )
        .slice(0, SECURITY_SUMMARY_MAX_EVENTS);
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
