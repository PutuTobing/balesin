import { users, type DbExecutor, type User } from '@balesin/db';
import { and, eq, sql } from 'drizzle-orm';

import { LOGIN_LOCK_INTERVAL } from './login-rules';

export type LoginUser = Pick<
  User,
  'id' | 'organizationId' | 'email' | 'name' | 'role' | 'passwordHash' | 'disabledAt'
> & {
  /** Sisa kunci akun dalam detik menurut jam database; 0 bila tidak terkunci. */
  lockedForSeconds: number;
};

/** Pengguna untuk proses login, berdasarkan email BAKU di dalam satu organisasi. */
export async function findUserForLogin(
  db: DbExecutor,
  organizationId: string,
  email: string,
): Promise<LoginUser | undefined> {
  const [row] = await db
    .select({
      id: users.id,
      organizationId: users.organizationId,
      email: users.email,
      name: users.name,
      role: users.role,
      passwordHash: users.passwordHash,
      disabledAt: users.disabledAt,
      lockedForSeconds: sql<number>`greatest(0, ceil(extract(epoch from (${users.lockedUntil} - now()))))::int`,
    })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.email, email)))
    .limit(1);
  if (!row) return undefined;
  return { ...row, lockedForSeconds: row.lockedForSeconds ?? 0 };
}

/** Mengunci akun selama `LOGIN_LOCK_INTERVAL`. Mengembalikan waktu kunci berakhir. */
export async function lockUser(
  db: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<Date | undefined> {
  const [row] = await db
    .update(users)
    .set({ lockedUntil: sql`now() + ${LOGIN_LOCK_INTERVAL}` })
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)))
    .returning({ lockedUntil: users.lockedUntil });
  return row?.lockedUntil ?? undefined;
}

/** Login berhasil: catat waktunya, buka kunci, dan (bila diberikan) perbarui hash password. */
export async function markLoginSucceeded(
  db: DbExecutor,
  organizationId: string,
  userId: string,
  newPasswordHash?: string,
): Promise<void> {
  await db
    .update(users)
    .set({
      lastLoginAt: sql`now()`,
      lockedUntil: null,
      ...(newPasswordHash === undefined ? {} : { passwordHash: newPasswordHash }),
    })
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)));
}
