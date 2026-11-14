import { users, type DbExecutor } from '@balesin/db';
import type { UserRole } from '@balesin/shared';
import { and, asc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';

import { enrollmentClosedCondition, enrollmentDueAtValue } from '../two-factor/enrollment-window';

/**
 * Query manajemen pengguna. SEMUA query memfilter `organization_id` dari sesi pemanggil (IDOR lintas
 * organisasi → tidak ditemukan). Perubahan bersyarat pada keadaan yang diharapkan (peran lama,
 * aktif/nonaktif), jadi dua permintaan bersamaan tidak bisa sama-sama berhasil.
 */

export interface TeamUserRow {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: UserRole;
  disabledAt: Date | null;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  totpEnabledAt: Date | null;
  twoFactorEnrollmentDueAt: Date | null;
  /** Batas waktu pendaftaran 2FA lewat (jam database, aturan `enrollment-window.ts`). */
  enrollmentClosed: boolean;
}

const teamUserColumns = {
  id: users.id,
  organizationId: users.organizationId,
  name: users.name,
  email: users.email,
  role: users.role,
  disabledAt: users.disabledAt,
  emailVerifiedAt: users.emailVerifiedAt,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  totpEnabledAt: users.totpEnabledAt,
  twoFactorEnrollmentDueAt: users.twoFactorEnrollmentDueAt,
  enrollmentClosed: sql<boolean>`${enrollmentClosedCondition()}`,
};

/** Urutan peran dari wewenang tertinggi (sama dengan `USER_ROLES`). */
const ROLE_RANK = sql`array_position(array['owner','admin','supervisor','cs','teknisi']::user_role[], ${users.role})`;

/** Semua pengguna organisasi: aktif dulu, lalu peran, lalu nama. */
export async function listTeamUsers(
  db: DbExecutor,
  organizationId: string,
): Promise<TeamUserRow[]> {
  return db
    .select(teamUserColumns)
    .from(users)
    .where(eq(users.organizationId, organizationId))
    .orderBy(sql`${users.disabledAt} is not null`, ROLE_RANK, asc(users.name), asc(users.id))
    .limit(1000);
}

export async function findTeamUser(
  db: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<TeamUserRow | undefined> {
  const [row] = await db
    .select(teamUserColumns)
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)))
    .limit(1);
  return row;
}

/**
 * Peran + status pelaku SEKARANG, dikunci baris (`FOR SHARE`) sampai transaksi selesai: wewenang
 * pelaku diperiksa ulang di dalam transaksi perubahan (pelaku yang baru saja diturunkan/dinonaktifkan
 * di permintaan lain tidak bisa menyelesaikan aksinya).
 */
export async function lockActor(
  tx: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<{ role: UserRole; disabledAt: Date | null } | undefined> {
  const [row] = await tx
    .select({ role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)))
    .for('share')
    .limit(1);
  return row;
}

/**
 * Menyerialkan perubahan yang bisa mengurangi jumlah Owner aktif di satu organisasi (turunkan /
 * nonaktifkan Owner), supaya dua Owner yang saling menurunkan bersamaan tidak menghabiskan Owner.
 */
export async function lockOwnerChanges(tx: DbExecutor, organizationId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`team-owner|${organizationId}`}, 0))`,
  );
}

/** Jumlah Owner aktif selain `exceptUserId`. */
export async function countOtherActiveOwners(
  tx: DbExecutor,
  organizationId: string,
  exceptUserId: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(
        eq(users.organizationId, organizationId),
        ne(users.id, exceptUserId),
        eq(users.role, 'owner'),
        isNull(users.disabledAt),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Ubah peran, bersyarat peran lama masih `expectedRole`. Batas waktu pendaftaran 2FA diatur ulang
 * untuk peran baru (wajib + belum aktif → 72 jam lagi; selain itu kosong) dan pendaftaran 2FA yang
 * sedang berjalan dibuang (rahasianya terikat ke sesi lama yang ikut dicabut).
 */
export async function updateUserRole(
  tx: DbExecutor,
  input: {
    organizationId: string;
    userId: string;
    expectedRole: UserRole;
    role: UserRole;
    twoFactorEnabled: boolean;
  },
): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({
      role: input.role,
      twoFactorEnrollmentDueAt: enrollmentDueAtValue(input.role, input.twoFactorEnabled),
      totpPendingSecretEncrypted: null,
      totpPendingCreatedAt: null,
      totpPendingIssuedAt: null,
    })
    .where(
      and(
        eq(users.organizationId, input.organizationId),
        eq(users.id, input.userId),
        eq(users.role, input.expectedRole),
      ),
    )
    .returning({ id: users.id });
  return rows.length > 0;
}

/** Nonaktifkan (bersyarat masih aktif). Pendaftaran 2FA yang sedang berjalan dibuang. */
export async function disableUser(
  tx: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({
      disabledAt: sql`now()`,
      totpPendingSecretEncrypted: null,
      totpPendingCreatedAt: null,
      totpPendingIssuedAt: null,
    })
    .where(
      and(eq(users.organizationId, organizationId), eq(users.id, userId), isNull(users.disabledAt)),
    )
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * Aktifkan kembali (bersyarat sedang nonaktif). Peran wajib yang belum mendaftar 2FA mendapat
 * jendela pendaftaran baru 72 jam (Owner/Admin baru saja memutuskan akun ini boleh dipakai lagi).
 */
export async function enableUser(
  tx: DbExecutor,
  input: { organizationId: string; userId: string; role: UserRole; twoFactorEnabled: boolean },
): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({
      disabledAt: null,
      lockedUntil: null,
      twoFactorEnrollmentDueAt: enrollmentDueAtValue(input.role, input.twoFactorEnabled),
    })
    .where(
      and(
        eq(users.organizationId, input.organizationId),
        eq(users.id, input.userId),
        isNotNull(users.disabledAt),
      ),
    )
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * Atur ulang 2FA: rahasia aktif + pendaftaran dibuang (bersyarat 2FA masih aktif), langkah TOTP
 * terakhir dikosongkan, dan peran wajib mendapat jendela pendaftaran 72 jam.
 */
export async function resetUserTwoFactor(
  tx: DbExecutor,
  input: { organizationId: string; userId: string; role: UserRole },
): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({
      totpSecretEncrypted: null,
      totpEnabledAt: null,
      totpLastUsedStep: null,
      totpPendingSecretEncrypted: null,
      totpPendingCreatedAt: null,
      totpPendingIssuedAt: null,
      twoFactorEnrollmentDueAt: enrollmentDueAtValue(input.role, false),
    })
    .where(
      and(
        eq(users.organizationId, input.organizationId),
        eq(users.id, input.userId),
        isNotNull(users.totpEnabledAt),
      ),
    )
    .returning({ id: users.id });
  return rows.length > 0;
}

/** Buka lagi jendela pendaftaran 2FA (72 jam dari sekarang), bersyarat 2FA belum aktif. */
export async function reopenTwoFactorEnrollment(
  tx: DbExecutor,
  input: { organizationId: string; userId: string; role: UserRole },
): Promise<Date | undefined> {
  const dueAt = enrollmentDueAtValue(input.role, false);
  if (!dueAt) return undefined;
  const [row] = await tx
    .update(users)
    .set({ twoFactorEnrollmentDueAt: dueAt })
    .where(
      and(
        eq(users.organizationId, input.organizationId),
        eq(users.id, input.userId),
        isNull(users.totpEnabledAt),
      ),
    )
    .returning({ dueAt: users.twoFactorEnrollmentDueAt });
  return row?.dueAt ?? undefined;
}

/** Catatan kunci untuk tampilan (`users.locked_until`) dikosongkan setelah kunci dibuka. */
export async function clearLockedUntil(
  tx: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<void> {
  await tx
    .update(users)
    .set({ lockedUntil: null })
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)));
}

/** Owner aktif selain yang dikecualikan (penerima pemberitahuan "2FA diatur ulang"). */
export async function findActiveOwners(
  db: DbExecutor,
  organizationId: string,
  exceptUserIds: readonly string[],
): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, organizationId),
        eq(users.role, 'owner'),
        isNull(users.disabledAt),
      ),
    );
  return rows.map((row) => row.id).filter((id) => !exceptUserIds.includes(id));
}
