import { auditLogs, users, type DbExecutor } from '@balesin/db';
import type { AuditLogFilter, UserRole } from '@balesin/shared';
import { and, desc, eq, gte, lt, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

/**
 * Query audit log. SEMUA query memfilter `organization_id` dari sesi pemanggil; pelaku dan target
 * pengguna digabung dengan syarat organisasi yang sama (FK komposit menjamin pelaku, dan join ini
 * menjamin nama target tidak pernah diambil dari organisasi lain).
 *
 * Urutan: terbaru dulu (`created_at desc, id desc`). Kursor = waktu PERSIS (mikrodetik, sebagai teks
 * dari Postgres — `Date` JavaScript hanya milidetik dan akan melompati baris) + ID baris.
 */

const actor = alias(users, 'audit_actor');
const targetUser = alias(users, 'audit_target_user');

export interface AuditRow {
  id: string;
  /** `created_at` UTC dengan mikrodetik, mis. `2026-11-14T03:18:30.217123Z` (untuk kursor). */
  createdAtExact: string;
  createdAt: Date;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  actor: { id: string; name: string; email: string; role: UserRole } | null;
  /** Untuk target `user`: nama + peran SEKARANG pengguna itu. */
  targetUser: { name: string; role: UserRole } | null;
}

export interface AuditCursor {
  createdAtExact: string;
  id: string;
}

const CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(`${cursor.createdAtExact}|${cursor.id}`, 'utf8').toString('base64url');
}

/** `undefined` bila kursor rusak/dibuat-buat. */
export function decodeAuditCursor(value: string): AuditCursor | undefined {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  const match = CURSOR_PATTERN.exec(decoded);
  if (!match?.[1] || !match[2]) return undefined;
  return { createdAtExact: match[1], id: match[2] };
}

/** Kondisi saringan (tanpa kursor). */
export function auditFilterCondition(organizationId: string, filter: AuditLogFilter): SQL {
  const conditions: Array<SQL | undefined> = [eq(auditLogs.organizationId, organizationId)];
  if (filter.actorUserId) conditions.push(eq(auditLogs.actorUserId, filter.actorUserId));
  if (filter.userId) {
    conditions.push(
      or(
        eq(auditLogs.actorUserId, filter.userId),
        and(eq(auditLogs.targetType, 'user'), eq(auditLogs.targetId, filter.userId)),
      ),
    );
  }
  if (filter.action) conditions.push(eq(auditLogs.action, filter.action));
  if (filter.targetType) conditions.push(eq(auditLogs.targetType, filter.targetType));
  if (filter.targetId) conditions.push(eq(auditLogs.targetId, filter.targetId));
  if (filter.from) conditions.push(gte(auditLogs.createdAt, new Date(filter.from)));
  if (filter.to) conditions.push(lt(auditLogs.createdAt, new Date(filter.to)));
  return and(...conditions) as SQL;
}

/** Baris audit + pelaku + nama target pengguna, terbaru dulu. */
export async function selectAuditRows(
  db: DbExecutor,
  organizationId: string,
  where: SQL,
  options: { limit: number; cursor?: AuditCursor | undefined },
): Promise<AuditRow[]> {
  const cursorCondition = options.cursor
    ? sql`(${auditLogs.createdAt}, ${auditLogs.id}) < (${options.cursor.createdAtExact}::timestamptz, ${options.cursor.id}::uuid)`
    : undefined;
  const rows = await db
    .select({
      id: auditLogs.id,
      createdAtExact: sql<string>`to_char(${auditLogs.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      createdAt: auditLogs.createdAt,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      metadata: auditLogs.metadata,
      ipAddress: auditLogs.ipAddress,
      userAgent: auditLogs.userAgent,
      actorId: actor.id,
      actorName: actor.name,
      actorEmail: actor.email,
      actorRole: actor.role,
      targetUserName: targetUser.name,
      targetUserRole: targetUser.role,
    })
    .from(auditLogs)
    .leftJoin(
      actor,
      and(eq(actor.organizationId, auditLogs.organizationId), eq(actor.id, auditLogs.actorUserId)),
    )
    .leftJoin(
      targetUser,
      and(
        eq(targetUser.organizationId, auditLogs.organizationId),
        eq(auditLogs.targetType, 'user'),
        sql`${targetUser.id}::text = ${auditLogs.targetId}`,
      ),
    )
    .where(and(eq(auditLogs.organizationId, organizationId), where, cursorCondition))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(options.limit);
  return rows.map((row) => ({
    id: row.id,
    createdAtExact: row.createdAtExact,
    createdAt: row.createdAt,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: row.metadata,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    actor:
      row.actorId && row.actorName !== null && row.actorEmail !== null && row.actorRole !== null
        ? { id: row.actorId, name: row.actorName, email: row.actorEmail, role: row.actorRole }
        : null,
    targetUser:
      row.targetUserName !== null && row.targetUserRole !== null
        ? { name: row.targetUserName, role: row.targetUserRole }
        : null,
  }));
}

/**
 * Jumlah baris yang cocok dengan tiap kondisi (satu kueri, `count(*) filter (where …)` per kunci) —
 * untuk ringkasan kejadian keamanan.
 */
export async function countAuditRowsMatching<K extends string>(
  db: DbExecutor,
  where: SQL,
  conditions: Readonly<Record<K, SQL>>,
): Promise<Record<K, number>> {
  const keys = Object.keys(conditions) as K[];
  const selection = Object.fromEntries(
    keys.map((key) => [key, sql<number>`(count(*) filter (where ${conditions[key]}))::int`]),
  ) as Record<K, SQL<number>>;
  const [row] = (await db.select(selection).from(auditLogs).where(where)) as Array<
    Partial<Record<K, number>>
  >;
  return Object.fromEntries(keys.map((key) => [key, Number(row?.[key] ?? 0)])) as Record<K, number>;
}
