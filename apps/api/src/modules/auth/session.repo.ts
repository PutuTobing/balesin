import { TWO_FACTOR_ENROLLMENT_SESSION_MINUTES, type UserRole } from '@balesin/shared';
import { organizations, userSessions, users, type DbExecutor, type SessionKind } from '@balesin/db';
import { and, desc, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';

/**
 * Query sesi login (SECURITY.md §1). Semua batas waktu memakai jam DATABASE (`now()`), jadi
 * tidak bergantung pada jam tiap proses API.
 *
 * Pencarian berdasarkan hash token adalah satu-satunya query yang belum tahu organisasinya
 * (memang itu yang sedang dicari); hasilnya membawa `organization_id` yang dipakai semua query
 * berikutnya.
 */

export const SESSION_IDLE_INTERVAL = sql`interval '12 hours'`;
export const SESSION_ABSOLUTE_INTERVAL = sql`interval '30 days'`;
/** Umur cookie = batas mutlak sesi. */
export const SESSION_ABSOLUTE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Sesi terbatas "wajib mendaftar 2FA" (Owner/Admin/Supervisor tanpa 2FA aktif): batas idle
 * dan mutlaknya sama-sama pendek. Setelah 2FA aktif, sesi penuh yang baru diterbitkan.
 */
export const ENROLLMENT_SESSION_INTERVAL = sql.raw(
  `interval '${TWO_FACTOR_ENROLLMENT_SESSION_MINUTES} minutes'`,
);
export const ENROLLMENT_SESSION_SECONDS = TWO_FACTOR_ENROLLMENT_SESSION_MINUTES * 60;

/** `standard` = sesi biasa; `two_factor_enrollment` = sesi terbatas berumur pendek. */
export type { SessionKind };

/** `last_seen_at`/`idle_expires_at` paling sering diperbarui sekali per menit per sesi. */
const TOUCH_INTERVAL = sql`interval '1 minute'`;

export interface ActiveSession {
  /** `user_sessions.id` — pengenal baris, bukan rahasia. Di log pakai nama `sessionRef`. */
  id: string;
  organizationId: string;
  tokenHash: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  needsTouch: boolean;
  user: { id: string; name: string; email: string; role: UserRole };
  organization: { id: string; name: string; timezone: string };
  /** 2FA pengguna sedang aktif. */
  twoFactorEnabled: boolean;
  /** Sesi ini dibuat setelah langkah kedua berhasil. */
  twoFactorVerified: boolean;
  /** Jenis sesi saat dibuat (tidak pernah berubah). */
  kind: SessionKind;
}

/**
 * Sesi yang masih berlaku untuk hash token ini: belum dicabut, belum lewat batas idle maupun
 * batas mutlak, penggunanya tidak dinonaktifkan (menonaktifkan akun langsung mematikan semua
 * sesinya), DAN — bila 2FA pengguna aktif — sesi itu dibuat setelah langkah kedua berhasil.
 * Syarat terakhir menutup sesi "hanya password" yang tersisa dari sebelum 2FA diaktifkan.
 */
export async function findActiveSession(
  db: DbExecutor,
  tokenHash: string,
): Promise<ActiveSession | undefined> {
  const [row] = await db
    .select({
      id: userSessions.id,
      organizationId: userSessions.organizationId,
      tokenHash: userSessions.tokenHash,
      idleExpiresAt: userSessions.idleExpiresAt,
      absoluteExpiresAt: userSessions.absoluteExpiresAt,
      needsTouch: sql<boolean>`${userSessions.lastSeenAt} < now() - ${TOUCH_INTERVAL}`,
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
      userRole: users.role,
      organizationName: organizations.name,
      organizationTimezone: organizations.timezone,
      twoFactorEnabled: sql<boolean>`${users.totpEnabledAt} is not null`,
      twoFactorVerified: sql<boolean>`${userSessions.twoFactorVerifiedAt} is not null`,
      kind: userSessions.kind,
    })
    .from(userSessions)
    .innerJoin(
      users,
      and(eq(users.organizationId, userSessions.organizationId), eq(users.id, userSessions.userId)),
    )
    .innerJoin(organizations, eq(organizations.id, userSessions.organizationId))
    .where(
      and(
        eq(userSessions.tokenHash, tokenHash),
        isNull(userSessions.revokedAt),
        sql`${userSessions.idleExpiresAt} > now()`,
        sql`${userSessions.absoluteExpiresAt} > now()`,
        isNull(users.disabledAt),
        or(isNull(users.totpEnabledAt), isNotNull(userSessions.twoFactorVerifiedAt)),
      ),
    )
    .limit(1);
  if (!row) return undefined;

  return {
    id: row.id,
    organizationId: row.organizationId,
    tokenHash: row.tokenHash,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    needsTouch: row.needsTouch,
    user: { id: row.userId, name: row.userName, email: row.userEmail, role: row.userRole },
    organization: {
      id: row.organizationId,
      name: row.organizationName,
      timezone: row.organizationTimezone,
    },
    twoFactorEnabled: row.twoFactorEnabled,
    twoFactorVerified: row.twoFactorVerified,
    kind: row.kind,
  };
}

/** Menggeser batas idle (tidak pernah melewati batas mutlak). Mengembalikan batas idle yang baru. */
export async function touchSession(
  db: DbExecutor,
  organizationId: string,
  sessionId: string,
): Promise<Date | undefined> {
  const [row] = await db
    .update(userSessions)
    .set({
      lastSeenAt: sql`now()`,
      idleExpiresAt: sql`least(now() + ${SESSION_IDLE_INTERVAL}, ${userSessions.absoluteExpiresAt})`,
    })
    .where(
      and(
        eq(userSessions.organizationId, organizationId),
        eq(userSessions.id, sessionId),
        isNull(userSessions.revokedAt),
      ),
    )
    .returning({ idleExpiresAt: userSessions.idleExpiresAt });
  return row?.idleExpiresAt;
}

export interface NewSessionInput {
  organizationId: string;
  userId: string;
  tokenHash: string;
  client: ClientInfo;
  kind: SessionKind;
  /** `true` = langkah kedua (2FA) baru saja berhasil untuk sesi ini. */
  twoFactorVerified: boolean;
}

export async function insertSession(
  db: DbExecutor,
  input: NewSessionInput,
): Promise<{ id: string; idleExpiresAt: Date; absoluteExpiresAt: Date }> {
  const [row] = await db
    .insert(userSessions)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      tokenHash: input.tokenHash,
      ipAddress: input.client.ip,
      userAgent: input.client.userAgent,
      kind: input.kind,
      idleExpiresAt:
        input.kind === 'two_factor_enrollment'
          ? sql`now() + ${ENROLLMENT_SESSION_INTERVAL}`
          : sql`now() + ${SESSION_IDLE_INTERVAL}`,
      absoluteExpiresAt:
        input.kind === 'two_factor_enrollment'
          ? sql`now() + ${ENROLLMENT_SESSION_INTERVAL}`
          : sql`now() + ${SESSION_ABSOLUTE_INTERVAL}`,
      twoFactorVerifiedAt: input.twoFactorVerified ? sql`now()` : null,
    })
    .returning({
      id: userSessions.id,
      idleExpiresAt: userSessions.idleExpiresAt,
      absoluteExpiresAt: userSessions.absoluteExpiresAt,
    });
  if (!row) throw new Error('Sesi baru tidak tersimpan');
  return row;
}

/** Mencabut satu sesi. `true` bila sesi itu memang masih aktif. */
export async function revokeSession(
  db: DbExecutor,
  organizationId: string,
  sessionId: string,
): Promise<boolean> {
  const rows = await db
    .update(userSessions)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(userSessions.organizationId, organizationId),
        eq(userSessions.id, sessionId),
        isNull(userSessions.revokedAt),
      ),
    )
    .returning({ id: userSessions.id });
  return rows.length > 0;
}

/**
 * Mencabut semua sesi aktif seorang pengguna, kecuali `exceptSessionId` bila diberikan.
 * Dipakai saat password/peran berubah atau akun dinonaktifkan. Mengembalikan ID sesi yang dicabut.
 */
export async function revokeUserSessions(
  db: DbExecutor,
  organizationId: string,
  userId: string,
  exceptSessionId?: string,
): Promise<string[]> {
  const rows = await db
    .update(userSessions)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(userSessions.organizationId, organizationId),
        eq(userSessions.userId, userId),
        isNull(userSessions.revokedAt),
        exceptSessionId === undefined ? undefined : ne(userSessions.id, exceptSessionId),
      ),
    )
    .returning({ id: userSessions.id });
  return rows.map((row) => row.id);
}

/** Satu sesi yang masih berlaku, untuk daftar "sesi aktif" (tanpa token/hash). */
export interface ActiveSessionRow {
  id: string;
  userId: string;
  kind: SessionKind;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}

/**
 * Kondisi "sesi ini masih bisa dipakai" — sama dengan `findActiveSession`: belum dicabut, belum
 * lewat batas idle/mutlak, penggunanya aktif, dan (bila 2FA aktif) dibuat setelah langkah kedua.
 * Dipakai bersama `innerJoin(users …)`.
 */
function usableSession() {
  return and(
    isNull(userSessions.revokedAt),
    sql`${userSessions.idleExpiresAt} > now()`,
    sql`${userSessions.absoluteExpiresAt} > now()`,
    isNull(users.disabledAt),
    or(isNull(users.totpEnabledAt), isNotNull(userSessions.twoFactorVerifiedAt)),
  );
}

/** Sesi yang masih berlaku milik satu pengguna, terakhir dipakai dulu. */
export async function listActiveSessions(
  db: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<ActiveSessionRow[]> {
  return db
    .select({
      id: userSessions.id,
      userId: userSessions.userId,
      kind: userSessions.kind,
      ipAddress: userSessions.ipAddress,
      userAgent: userSessions.userAgent,
      createdAt: userSessions.createdAt,
      lastSeenAt: userSessions.lastSeenAt,
    })
    .from(userSessions)
    .innerJoin(
      users,
      and(eq(users.organizationId, userSessions.organizationId), eq(users.id, userSessions.userId)),
    )
    .where(
      and(
        eq(userSessions.organizationId, organizationId),
        eq(userSessions.userId, userId),
        usableSession(),
      ),
    )
    .orderBy(desc(userSessions.lastSeenAt), desc(userSessions.id))
    .limit(200);
}

/** Jumlah sesi yang masih berlaku per pengguna organisasi (untuk daftar pengguna). */
export async function countActiveSessionsByUser(
  db: DbExecutor,
  organizationId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ userId: userSessions.userId, count: sql<number>`count(*)::int` })
    .from(userSessions)
    .innerJoin(
      users,
      and(eq(users.organizationId, userSessions.organizationId), eq(users.id, userSessions.userId)),
    )
    .where(and(eq(userSessions.organizationId, organizationId), usableSession()))
    .groupBy(userSessions.userId);
  return new Map(rows.map((row) => [row.userId, row.count]));
}

/**
 * Mencabut satu sesi MILIK pengguna tertentu (sesi pengguna lain/organisasi lain tidak tersentuh).
 * `true` bila sesi itu memang masih berlaku.
 */
export async function revokeSessionOfUser(
  db: DbExecutor,
  organizationId: string,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const rows = await db
    .update(userSessions)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(userSessions.organizationId, organizationId),
        eq(userSessions.userId, userId),
        eq(userSessions.id, sessionId),
        isNull(userSessions.revokedAt),
        sql`${userSessions.idleExpiresAt} > now()`,
        sql`${userSessions.absoluteExpiresAt} > now()`,
      ),
    )
    .returning({ id: userSessions.id });
  return rows.length > 0;
}
