import { users, type DbExecutor, type User } from '@balesin/db';
import { and, eq, sql } from 'drizzle-orm';

import { LOGIN_LOCK_INTERVAL } from './login-rules';

export type LoginUser = Pick<
  User,
  | 'id'
  | 'organizationId'
  | 'email'
  | 'name'
  | 'role'
  | 'passwordHash'
  | 'disabledAt'
  | 'totpEnabledAt'
  | 'passwordChangedAt'
>;

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
      totpEnabledAt: users.totpEnabledAt,
      passwordChangedAt: users.passwordChangedAt,
    })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.email, email)))
    .limit(1);
  return row;
}

/**
 * Mencatat kunci akun (lingkup `account`) selama `LOGIN_LOCK_INTERVAL` di `users.locked_until`.
 * Kolom ini hanya CATATAN untuk tampilan admin; keputusan login memakai penanda Redis, supaya
 * jawaban untuk akun sungguhan dan email tidak terdaftar tetap sama (temuan R1).
 */
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

/**
 * Login berhasil: catat waktunya dan (bila diberikan) perbarui hash password. `locked_until`
 * tidak disentuh: login dari perangkat dikenal tidak mengakhiri kunci untuk perangkat lain.
 */
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
      ...(newPasswordHash === undefined ? {} : { passwordHash: newPasswordHash }),
    })
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)));
}

/** Memperbarui hash password (parameter argon2 lama) tanpa menandai login selesai. */
export async function updatePasswordHash(
  db: DbExecutor,
  organizationId: string,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db
    .update(users)
    .set({ passwordHash })
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)));
}
