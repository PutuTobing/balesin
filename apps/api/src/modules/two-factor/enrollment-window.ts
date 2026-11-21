import { users, type DbExecutor } from '@balesin/db';
import {
  TWO_FACTOR_ENROLLMENT_WINDOW_HOURS,
  TWO_FACTOR_REQUIRED_ROLES,
  isTwoFactorRequired,
  type UserRole,
} from '@balesin/shared';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

/**
 * Batas waktu pendaftaran 2FA untuk peran wajib (review undangan R3 / review 2FA R5.3).
 *
 * Akun Owner/Admin/Supervisor yang belum mendaftar 2FA hanya mendapat sesi terbatas untuk
 * mendaftar. Siapa pun yang tahu password-nya (mis. lewat kotak masuk yang dibobol + atur ulang
 * password) bisa menjadi pemegang faktor keduanya — trust-on-first-use. Jendela itu dibatasi:
 * `users.two_factor_enrollment_due_at` diisi `now() + 72 jam` setiap kali akun masuk ke keadaan
 * "wajib tapi belum" (undangan diterima, peran dinaikkan, 2FA diatur ulang, akun diaktifkan
 * kembali, pendaftaran dibuka lagi). Lewat batas itu, masuk dengan password tidak lagi membuka
 * pendaftaran (403 `TWO_FACTOR_ENROLLMENT_EXPIRED`) sampai Owner/Admin membukanya lagi.
 *
 * Supaya instalasi tidak pernah terkunci dari dirinya sendiri:
 *  - Owner hasil wizard setup tidak diberi batas (`NULL`): wizard langsung memaksa pendaftaran di
 *    sesi yang sama, dan tidak ada orang lain yang bisa membukakan pendaftarannya.
 *  - Batas Owner (mis. setelah 2FA-nya diatur ulang Owner lain) hanya berlaku selama masih ada
 *    Owner aktif LAIN yang 2FA-nya aktif — orang yang bisa membukanya lagi.
 *
 * Semua perbandingan waktu memakai jam DATABASE.
 */

export const ENROLLMENT_WINDOW_INTERVAL = sql.raw(
  `interval '${TWO_FACTOR_ENROLLMENT_WINDOW_HOURS} hours'`,
);

/**
 * Nilai `two_factor_enrollment_due_at` untuk akun dengan peran + keadaan 2FA ini: jendela baru
 * 72 jam bila wajib dan belum aktif, selain itu `null`.
 */
export function enrollmentDueAtValue(role: UserRole, twoFactorEnabled: boolean): SQL | null {
  return isTwoFactorRequired(role) && !twoFactorEnabled
    ? sql`now() + ${ENROLLMENT_WINDOW_INTERVAL}`
    : null;
}

const OTHER_OWNER_ALIAS = 'enrollment_other_owner';
// Dalam templat `sql`, alias tabel hanya dirender sebagai namanya — klausa FROM ditulis sendiri.
const otherOwner = alias(users, OTHER_OWNER_ALIAS);

/**
 * Kondisi SQL "pendaftaran 2FA akun ini sudah ditutup" untuk baris `users`: peran wajib, 2FA
 * belum aktif, batas waktunya lewat, dan — untuk Owner — ada Owner aktif lain yang 2FA-nya aktif.
 */
export function enrollmentClosedCondition(): SQL {
  return sql`(
    ${inArray(users.role, [...TWO_FACTOR_REQUIRED_ROLES])}
    and ${users.totpEnabledAt} is null
    and ${users.twoFactorEnrollmentDueAt} is not null
    and ${users.twoFactorEnrollmentDueAt} <= now()
    and (
      ${users.role} <> 'owner'
      or exists (
        select 1 from ${users} as ${sql.identifier(OTHER_OWNER_ALIAS)}
        where ${otherOwner.organizationId} = ${users.organizationId}
          and ${otherOwner.id} <> ${users.id}
          and ${otherOwner.role} = 'owner'
          and ${otherOwner.disabledAt} is null
          and ${otherOwner.totpEnabledAt} is not null
      )
    )
  )`;
}

/** `true` bila akun ini tidak boleh lagi memulai pendaftaran 2FA lewat login biasa. */
export async function isEnrollmentClosed(
  db: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ closed: sql<boolean>`${enrollmentClosedCondition()}` })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)))
    .limit(1);
  return row?.closed === true;
}
