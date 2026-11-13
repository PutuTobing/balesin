import type { UserRole } from '@balesin/shared';
import { organizations, userSessions, users, type DbExecutor } from '@balesin/db';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';

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
}

/**
 * Sesi yang masih berlaku untuk hash token ini: belum dicabut, belum lewat batas idle maupun
 * batas mutlak, DAN penggunanya tidak dinonaktifkan (menonaktifkan akun langsung mematikan
 * semua sesinya).
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
      idleExpiresAt: sql`now() + ${SESSION_IDLE_INTERVAL}`,
      absoluteExpiresAt: sql`now() + ${SESSION_ABSOLUTE_INTERVAL}`,
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
 * Dipakai saat password/peran berubah atau akun dinonaktifkan. Mengembalikan jumlah sesi
 * yang dicabut.
 */
export async function revokeUserSessions(
  db: DbExecutor,
  organizationId: string,
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
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
  return rows.length;
}
