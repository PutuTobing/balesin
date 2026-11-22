import {
  isMailImplicitManager,
  resolveMailAccess,
  type MailAccessGrantInput,
  type MailAccessLevel,
  type MailAccessUser,
  type MailAccountKind,
  type MailPrincipalType,
} from '@balesin/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import type { DbExecutor } from './client';
import { lockAdvisoryKeys } from './locks';
import { departmentMembers } from './schema/departments';
import { mailAccountAccess, mailAccounts } from './schema/mail';
import { users } from './schema/users';

/**
 * Pemuat data untuk `resolveMailAccess` (`@balesin/shared`) — SATU sumber hak per akun Email untuk
 * api (rute), hub WebSocket (event `mail.*`), dan worker (penerima notifikasi). Semua query
 * terfilter organisasi; data dibaca SEGAR (tanpa cache) supaya pencabutan grant/keluar departemen/
 * turun peran berlaku seketika (kontrak §2).
 */

export interface MailAccessAccountRow {
  id: string;
  kind: MailAccountKind;
  ownerUserId: string | null;
  deletedAt: Date | null;
}

/** Pengguna organisasi (aktif/nonaktif) + departemennya. ID asing tidak ada di peta. */
export async function mailAccessUsersOf(
  db: DbExecutor,
  organizationId: string,
  userIds: readonly string[],
): Promise<Map<string, MailAccessUser>> {
  const ids = [...new Set(userIds)];
  const result = new Map<string, MailAccessUser>();
  if (ids.length === 0) return result;
  const rows = await db
    .select({ id: users.id, role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), inArray(users.id, ids)));
  const memberships = await db
    .select({ userId: departmentMembers.userId, departmentId: departmentMembers.departmentId })
    .from(departmentMembers)
    .where(
      and(
        eq(departmentMembers.organizationId, organizationId),
        inArray(departmentMembers.userId, ids),
      ),
    );
  const departmentsByUser = new Map<string, string[]>();
  for (const row of memberships) {
    const list = departmentsByUser.get(row.userId) ?? [];
    list.push(row.departmentId);
    departmentsByUser.set(row.userId, list);
  }
  for (const row of rows) {
    result.set(row.id, {
      id: row.id,
      role: row.role,
      active: row.disabledAt === null,
      departmentIds: departmentsByUser.get(row.id) ?? [],
    });
  }
  return result;
}

/** Semua grant akun-akun ini (akun organisasi lain tidak pernah terbaca). */
export async function mailGrantsOf(
  db: DbExecutor,
  organizationId: string,
  accountIds: readonly string[],
): Promise<Map<string, MailAccessGrantInput[]>> {
  const ids = [...new Set(accountIds)];
  const result = new Map<string, MailAccessGrantInput[]>();
  if (ids.length === 0) return result;
  const rows = await db
    .select({
      accountId: mailAccountAccess.accountId,
      principalType: mailAccountAccess.principalType,
      userId: mailAccountAccess.userId,
      departmentId: mailAccountAccess.departmentId,
      level: mailAccountAccess.level,
    })
    .from(mailAccountAccess)
    .where(
      and(
        eq(mailAccountAccess.organizationId, organizationId),
        inArray(mailAccountAccess.accountId, ids),
      ),
    );
  for (const row of rows) {
    const list = result.get(row.accountId) ?? [];
    list.push({
      principalType: row.principalType as MailPrincipalType,
      userId: row.userId,
      departmentId: row.departmentId,
      level: row.level as MailAccessLevel,
    });
    result.set(row.accountId, list);
  }
  return result;
}

/** Akun hidup organisasi (tanpa yang sedang diputus), opsional disaring ID. */
export async function liveMailAccountsOf(
  db: DbExecutor,
  organizationId: string,
  accountIds?: readonly string[],
): Promise<MailAccessAccountRow[]> {
  if (accountIds !== undefined && accountIds.length === 0) return [];
  const rows = await db
    .select({
      id: mailAccounts.id,
      kind: mailAccounts.kind,
      ownerUserId: mailAccounts.ownerUserId,
      deletedAt: mailAccounts.deletedAt,
    })
    .from(mailAccounts)
    .where(
      and(
        eq(mailAccounts.organizationId, organizationId),
        isNull(mailAccounts.deletedAt),
        accountIds ? inArray(mailAccounts.id, [...new Set(accountIds)]) : undefined,
      ),
    );
  return rows.map((row) => ({ ...row, kind: row.kind as MailAccountKind }));
}

/** Indeks hak: `levelOf(userId, accountId)` untuk sekumpulan pengguna × akun (event WS, notifikasi). */
export interface MailAccessIndex {
  levelOf(userId: string, accountId: string): MailAccessLevel | null;
}

export async function mailAccessIndexOf(
  db: DbExecutor,
  organizationId: string,
  userIds: readonly string[],
  accountIds: readonly string[],
): Promise<MailAccessIndex> {
  const [subjects, accounts, grants] = await Promise.all([
    mailAccessUsersOf(db, organizationId, userIds),
    liveMailAccountsOf(db, organizationId, accountIds),
    mailGrantsOf(db, organizationId, accountIds),
  ]);
  const byAccount = new Map(accounts.map((account) => [account.id, account]));
  const cache = new Map<string, MailAccessLevel | null>();
  return {
    levelOf(userId, accountId) {
      const key = `${userId}|${accountId}`;
      if (cache.has(key)) return cache.get(key) ?? null;
      const user = subjects.get(userId);
      const account = byAccount.get(accountId);
      const level =
        user && account ? resolveMailAccess(user, account, grants.get(accountId) ?? []) : null;
      cache.set(key, level);
      return level;
    },
  };
}

/**
 * Akun hidup yang bisa diakses SATU pengguna (≥ `read`) beserta levelnya. Akun pribadi orang lain
 * tidak pernah ikut. Dipakai daftar akun, sidebar, navigasi menu.
 */
export async function accessibleMailAccountsOf(
  db: DbExecutor,
  organizationId: string,
  userId: string,
): Promise<Map<string, MailAccessLevel>> {
  const subjects = await mailAccessUsersOf(db, organizationId, [userId]);
  const user = subjects.get(userId);
  const result = new Map<string, MailAccessLevel>();
  if (!user) return result;
  // Kandidat: akun bersama (semua bila pengelola implisit; selain itu hanya yang punya grant untuk
  // pengguna/departemennya) + akun pribadi miliknya.
  const departmentIds = user.departmentIds;
  const candidates = await db
    .select({
      id: mailAccounts.id,
      kind: mailAccounts.kind,
      ownerUserId: mailAccounts.ownerUserId,
      deletedAt: mailAccounts.deletedAt,
    })
    .from(mailAccounts)
    .where(
      and(
        eq(mailAccounts.organizationId, organizationId),
        isNull(mailAccounts.deletedAt),
        or(
          and(eq(mailAccounts.kind, 'personal'), eq(mailAccounts.ownerUserId, userId)),
          isMailImplicitManager(user.role)
            ? eq(mailAccounts.kind, 'shared')
            : and(
                eq(mailAccounts.kind, 'shared'),
                sql`exists (select 1 from ${mailAccountAccess} a where a.organization_id = ${mailAccounts.organizationId} and a.account_id = ${mailAccounts.id} and (a.user_id = ${userId}${
                  departmentIds.length > 0
                    ? sql` or a.department_id in (${sql.join(
                        departmentIds.map((id) => sql`${id}::uuid`),
                        sql`, `,
                      )})`
                    : sql``
                }))`,
              ),
        ),
      ),
    );
  const grants = await mailGrantsOf(
    db,
    organizationId,
    candidates.map((row) => row.id),
  );
  for (const row of candidates) {
    const level = resolveMailAccess(
      user,
      { kind: row.kind as MailAccountKind, ownerUserId: row.ownerUserId },
      grants.get(row.id) ?? [],
    );
    if (level) result.set(row.id, level);
  }
  return result;
}

/**
 * Advisory lock bersama larangan alamat ganda (kontrak §4.3): akun Email ↔ Channel Email memakai
 * kunci yang SAMA `email-address:<org>:<alamat>` di transaksinya, supaya dua permintaan bersamaan
 * tidak bisa sama-sama lolos pemeriksaan. Kunci diurutkan supaya tidak saling menunggu (deadlock).
 */
export async function lockEmailAddresses(
  tx: DbExecutor,
  organizationId: string,
  addresses: readonly string[],
): Promise<void> {
  const keys = [...new Set(addresses.map((address) => address.trim().toLowerCase()))]
    .filter((address) => address.length > 0)
    .sort()
    .map((address) => `email-address:${organizationId}:${address}`);
  await lockAdvisoryKeys(tx, keys);
}
