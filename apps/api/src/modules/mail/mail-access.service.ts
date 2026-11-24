import { AppError, type MailEventPublisher } from '@balesin/core';
import {
  accessibleMailAccountsOf,
  departments,
  mailAccessUsersOf,
  mailAccountAccess,
  mailAccounts,
  mailGrantsOf,
  users,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  MAIL_ACCESS_GRANTS_PER_ACCOUNT_MAX,
  MAIL_SHARED_IMPLICIT_MANAGE_ROLES,
  hasPermission,
  isMailImplicitManager,
  mailLevelAtLeast,
  mailMenuVisible,
  resolveMailAccess,
  type MailAccessGrantRequest,
  type MailAccessLevel,
  type MailAccountAccessResponse,
  type MailAccountColor,
  type MailAccountKind,
  type MailSyncState,
  type TeamMailAccessResponse,
  type UpdateMailAccountAccessRequest,
  type UpdateTeamMailAccessRequest,
} from '@balesin/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { EmailNotifier } from '../../queues/email-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { ACCESS_RULES, forbidByRule, type AccessDeniedRecorder } from '../auth/access-denied';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { findActiveOwners } from '../team/team.repo';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorService } from '../two-factor/two-factor.service';
import { isUuid, levelOf, loadAccountRow, mailNotFound, viewerOf } from './mail.repo';
import { usersOfPrincipals, type MailContext } from './mail.service';

/**
 * Akses akun Email bersama (KONTRAK-API-EMAIL §5): dua tempat, satu sumber (`mail_account_access`).
 * Mengubah = `mail.accounts.manage` (Owner/Admin) — pemegang "Kelola" yang bukan Owner/Admin TIDAK
 * bisa menambah orang. Menambah principal / menaikkan tingkat = melonggarkan → konfirmasi identitas;
 * mengurangi tidak. Grant untuk Owner/Admin → 400 (sudah otomatis Kelola); akun pribadi → 400.
 * Setelah commit: `mail.access.changed` ke pengguna yang terdampak; perluasan oleh Admin → email Owner.
 */

const CONFIRM_LOOSEN =
  'Masukkan password-mu (dan kode verifikasi dua langkah) untuk memberi atau menaikkan akses akun email.';
const RACE_MESSAGE = 'Akses akun ini baru saja diubah orang lain. Muat ulang lalu coba lagi.';

function validation(field: string, message: string, reason: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [{ location: 'body', field, message, reason }],
  });
}

interface GrantRow {
  principalType: 'user' | 'department';
  userId: string | null;
  departmentId: string | null;
  level: MailAccessLevel;
}

const keyOf = (grant: {
  principalType: string;
  userId?: string | null;
  departmentId?: string | null;
}) =>
  grant.principalType === 'user' ? `u:${grant.userId ?? ''}` : `d:${grant.departmentId ?? ''}`;

const RANK: Record<MailAccessLevel, number> = { read: 1, send: 2, manage: 3 };

/** Perbandingan sebelum → sesudah (ID principal saja). */
export function diffGrants(before: readonly GrantRow[], after: readonly GrantRow[]) {
  const beforeMap = new Map(before.map((grant) => [keyOf(grant), grant]));
  const afterMap = new Map(after.map((grant) => [keyOf(grant), grant]));
  const added = after.filter((grant) => !beforeMap.has(keyOf(grant)));
  const removed = before.filter((grant) => !afterMap.has(keyOf(grant)));
  const changed = after.flatMap((grant) => {
    const previous = beforeMap.get(keyOf(grant));
    return previous && previous.level !== grant.level ? [{ grant, from: previous.level }] : [];
  });
  const loosened =
    added.length > 0 || changed.some((entry) => RANK[entry.grant.level] > RANK[entry.from]);
  return { added, removed, changed, loosened };
}

const principalRef = (grant: GrantRow) =>
  grant.principalType === 'user'
    ? { type: 'user', id: grant.userId }
    : { type: 'department', id: grant.departmentId };

export function createMailAccessService(deps: {
  db: Database;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  notifier: Pick<EmailNotifier, 'securityNoticeAdmin'>;
  publisher: MailEventPublisher;
  accessDenied: AccessDeniedRecorder;
  now?: () => Date;
}) {
  const { db, twoFactor, publisher } = deps;
  const now = deps.now ?? (() => new Date());

  async function grantsOf(executor: DbExecutor, organizationId: string, accountId: string) {
    const rows = await executor
      .select({
        principalType: mailAccountAccess.principalType,
        userId: mailAccountAccess.userId,
        departmentId: mailAccountAccess.departmentId,
        level: mailAccountAccess.level,
      })
      .from(mailAccountAccess)
      .where(
        and(
          eq(mailAccountAccess.organizationId, organizationId),
          eq(mailAccountAccess.accountId, accountId),
        ),
      );
    return rows as GrantRow[];
  }

  async function validatePrincipals(
    executor: DbExecutor,
    organizationId: string,
    grants: readonly GrantRow[],
  ) {
    const userIds = grants.flatMap((grant) => (grant.userId ? [grant.userId] : []));
    const departmentIds = grants.flatMap((grant) =>
      grant.departmentId ? [grant.departmentId] : [],
    );
    if (userIds.length > 0) {
      const found = await executor
        .select({ id: users.id, role: users.role, disabledAt: users.disabledAt })
        .from(users)
        .where(and(eq(users.organizationId, organizationId), inArray(users.id, userIds)));
      const byId = new Map(found.map((row) => [row.id, row]));
      for (const id of userIds) {
        const row = byId.get(id);
        if (!row || row.disabledAt !== null) {
          throw validation(
            'grants',
            'Ada pengguna yang tidak ditemukan atau sudah nonaktif.',
            'principal_invalid',
          );
        }
        if (isMailImplicitManager(row.role)) {
          throw validation(
            'grants',
            'Owner dan Admin otomatis punya hak Kelola di semua akun bersama.',
            'grant_for_admin',
          );
        }
      }
    }
    if (departmentIds.length > 0) {
      const found = await executor
        .select({ id: departments.id })
        .from(departments)
        .where(
          and(
            eq(departments.organizationId, organizationId),
            inArray(departments.id, departmentIds),
          ),
        );
      if (found.length !== new Set(departmentIds).size) {
        throw validation('grants', 'Ada departemen yang tidak ditemukan.', 'principal_invalid');
      }
    }
  }

  async function loadShared(
    executor: DbExecutor,
    auth: AuthContext,
    accountId: string,
    forUpdate = false,
  ) {
    const row = await loadAccountRow(executor, auth.organizationId, accountId, { forUpdate });
    if (!row) throw mailNotFound();
    if (row.kind === 'personal') {
      // Akun pribadi orang lain tidak terbuka sama sekali.
      if (row.ownerUserId !== auth.user.id) throw mailNotFound();
      throw validation(
        'accountId',
        'Akun pribadi tidak bisa dibagikan.',
        'personal_account_no_access',
      );
    }
    return row;
  }

  /** Simpan daftar baru untuk satu akun (di transaksi pemanggil). */
  async function replace(
    tx: DbExecutor,
    auth: AuthContext,
    account: { id: string; emailAddress: string },
    before: readonly GrantRow[],
    after: readonly GrantRow[],
    context: MailContext,
  ) {
    const diff = diffGrants(before, after);
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0)
      return null;
    if (after.length > MAIL_ACCESS_GRANTS_PER_ACCOUNT_MAX) {
      throw validation(
        'grants',
        `Paling banyak ${String(MAIL_ACCESS_GRANTS_PER_ACCOUNT_MAX)} penerima akses per akun.`,
        'limit_reached',
      );
    }
    await tx
      .delete(mailAccountAccess)
      .where(
        and(
          eq(mailAccountAccess.organizationId, auth.organizationId),
          eq(mailAccountAccess.accountId, account.id),
        ),
      );
    if (after.length > 0) {
      await tx.insert(mailAccountAccess).values(
        after.map((grant) => ({
          organizationId: auth.organizationId,
          accountId: account.id,
          principalType: grant.principalType,
          userId: grant.userId,
          departmentId: grant.departmentId,
          level: grant.level,
          grantedByUserId: auth.user.id,
        })),
      );
    }
    const auditLogId = await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorUserId: auth.user.id,
      action: AUDIT_ACTIONS.mailAccessUpdated,
      targetType: 'mail_account',
      targetId: account.id,
      metadata: {
        accountId: account.id,
        address: account.emailAddress,
        added: diff.added
          .slice(0, 50)
          .map((grant) => ({ ...principalRef(grant), level: grant.level })),
        removed: diff.removed
          .slice(0, 50)
          .map((grant) => ({ ...principalRef(grant), level: grant.level })),
        changed: diff.changed.slice(0, 50).map((entry) => ({
          ...principalRef(entry.grant),
          from: entry.from,
          to: entry.grant.level,
        })),
        addedCount: diff.added.length,
        removedCount: diff.removed.length,
        loosened: diff.loosened,
        actorRole: auth.user.role,
      },
      client: context.client,
    });
    if (diff.loosened && auth.user.role !== 'owner') {
      const owners = await findActiveOwners(tx, auth.organizationId, [auth.user.id]);
      for (const recipientUserId of owners) {
        await deps.notifier
          .securityNoticeAdmin({
            organizationId: auth.organizationId,
            recipientUserId,
            subjectUserId: auth.user.id,
            event: 'mail_access_changed',
            occurredAt: now().toISOString(),
            auditLogId,
          })
          .catch(() => undefined);
      }
    }
    return diff;
  }

  async function publishChanged(organizationId: string, grants: readonly GrantRow[]) {
    const userIds = await usersOfPrincipals(
      db,
      organizationId,
      grants.map((grant) =>
        grant.principalType === 'user'
          ? { principalType: 'user' as const, userId: grant.userId ?? '' }
          : { principalType: 'department' as const, departmentId: grant.departmentId ?? '' },
      ),
    );
    if (userIds.length > 0) {
      await publisher.publish([
        { organizationId, userIds, event: { type: 'mail.access.changed' } },
      ]);
    }
  }

  const toRows = (grants: readonly MailAccessGrantRequest[]): GrantRow[] =>
    grants.map((grant) =>
      grant.principalType === 'user'
        ? {
            principalType: 'user',
            userId: grant.userId.toLowerCase(),
            departmentId: null,
            level: grant.level,
          }
        : {
            principalType: 'department',
            userId: null,
            departmentId: grant.departmentId.toLowerCase(),
            level: grant.level,
          },
    );

  return {
    /** `mail.accounts.manage`, atau level `manage` (baca saja). */
    async getForAccount(
      auth: AuthContext,
      accountId: string,
      context: MailContext,
    ): Promise<MailAccountAccessResponse> {
      const viewer = await viewerOf(db, auth);
      const row = await loadShared(db, auth, accountId);
      const manager = hasPermission(auth.user.role, 'mail.accounts.manage');
      if (!manager) {
        const level = await levelOf(db, viewer, auth.organizationId, row);
        if (!level) throw mailNotFound();
        if (!mailLevelAtLeast(level, 'manage')) {
          await forbidByRule(deps.accessDenied, {
            auth,
            rule: ACCESS_RULES.mailAccountLevel,
            client: context.client,
            details: { required: 'manage', level },
            message: 'Daftar akses hanya bisa dilihat pemegang hak Kelola.',
          });
        }
      }
      const rows = await db
        .select({
          principalType: mailAccountAccess.principalType,
          userId: mailAccountAccess.userId,
          departmentId: mailAccountAccess.departmentId,
          level: mailAccountAccess.level,
          grantedByUserId: mailAccountAccess.grantedByUserId,
          grantedAt: mailAccountAccess.createdAt,
          userName: users.name,
          userRole: users.role,
          userDisabledAt: users.disabledAt,
          departmentName: departments.name,
          memberCount: sql<number>`(select count(*)::int from department_members dm join users u on u.organization_id = dm.organization_id and u.id = dm.user_id where dm.organization_id = ${auth.organizationId} and dm.department_id = ${mailAccountAccess.departmentId} and u.disabled_at is null)`,
        })
        .from(mailAccountAccess)
        .leftJoin(
          users,
          and(
            eq(users.organizationId, mailAccountAccess.organizationId),
            eq(users.id, mailAccountAccess.userId),
          ),
        )
        .leftJoin(
          departments,
          and(
            eq(departments.organizationId, mailAccountAccess.organizationId),
            eq(departments.id, mailAccountAccess.departmentId),
          ),
        )
        .where(
          and(
            eq(mailAccountAccess.organizationId, auth.organizationId),
            eq(mailAccountAccess.accountId, row.id),
          ),
        );
      const granterIds = [
        ...new Set(rows.map((item) => item.grantedByUserId).filter((id): id is string => !!id)),
      ];
      const granters = granterIds.length
        ? await db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(
              and(eq(users.organizationId, auth.organizationId), inArray(users.id, granterIds)),
            )
        : [];
      const granterById = new Map(granters.map((item) => [item.id, item]));
      return {
        implicit: MAIL_SHARED_IMPLICIT_MANAGE_ROLES.map((role) => ({
          role,
          level: 'manage' as const,
        })),
        grants: rows.map((item) => ({
          principal:
            item.principalType === 'user'
              ? {
                  type: 'user' as const,
                  id: item.userId ?? '',
                  name: item.userName ?? '',
                  role: item.userRole ?? 'cs',
                  active: item.userDisabledAt === null,
                }
              : {
                  type: 'department' as const,
                  id: item.departmentId ?? '',
                  name: item.departmentName ?? '',
                  memberCount: item.memberCount,
                },
          level: item.level as MailAccessLevel,
          grantedBy: item.grantedByUserId ? (granterById.get(item.grantedByUserId) ?? null) : null,
          grantedAt: item.grantedAt.toISOString(),
        })),
        editable: manager,
      };
    },

    async updateForAccount(
      auth: AuthContext,
      accountId: string,
      input: UpdateMailAccountAccessRequest,
      context: MailContext,
    ): Promise<MailAccountAccessResponse> {
      const row = await loadShared(db, auth, accountId);
      const after = toRows(input.grants);
      await validatePrincipals(db, auth.organizationId, after);
      const before = await grantsOf(db, auth.organizationId, row.id);
      const loosened = diffGrants(before, after).loosened;
      if (loosened) {
        await requireIdentityConfirmation(
          twoFactor,
          auth,
          input.confirmation,
          'mail.access.loosen',
          context,
          CONFIRM_LOOSEN,
        );
      }
      let affected: GrantRow[] = [];
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'mail.accounts.manage', context.log);
        const locked = await loadShared(tx, auth, row.id, true);
        const current = await grantsOf(tx, auth.organizationId, locked.id);
        if (!loosened && diffGrants(current, after).loosened) {
          throw new AppError('CONFLICT', { message: RACE_MESSAGE });
        }
        await validatePrincipals(tx, auth.organizationId, after);
        await replace(tx, auth, locked, current, after, context);
        affected = [...current, ...after];
      });
      await publishChanged(auth.organizationId, affected);
      return this.getForAccount(auth, row.id, context);
    },

    /** Tab Akses email Pengaturan → Tim → [pengguna] (`mail.accounts.manage`). */
    async getForUser(auth: AuthContext, userId: string): Promise<TeamMailAccessResponse> {
      if (!isUuid(userId))
        throw new AppError('NOT_FOUND', { message: 'Pengguna tidak ditemukan.' });
      const [target] = await db
        .select({ id: users.id, name: users.name, role: users.role, disabledAt: users.disabledAt })
        .from(users)
        .where(and(eq(users.organizationId, auth.organizationId), eq(users.id, userId)))
        .limit(1);
      if (!target) throw new AppError('NOT_FOUND', { message: 'Pengguna tidak ditemukan.' });
      const subjects = await mailAccessUsersOf(db, auth.organizationId, [target.id]);
      const subject = subjects.get(target.id);
      const shared = await db
        .select()
        .from(mailAccounts)
        .where(
          and(
            eq(mailAccounts.organizationId, auth.organizationId),
            eq(mailAccounts.kind, 'shared'),
            isNull(mailAccounts.deletedAt),
          ),
        );
      const grants = await mailGrantsOf(
        db,
        auth.organizationId,
        shared.map((row) => row.id),
      );
      const departmentIds = subject?.departmentIds ?? [];
      const departmentNames = departmentIds.length
        ? new Map(
            (
              await db
                .select({ id: departments.id, name: departments.name })
                .from(departments)
                .where(
                  and(
                    eq(departments.organizationId, auth.organizationId),
                    inArray(departments.id, departmentIds),
                  ),
                )
            ).map((row) => [row.id, row.name]),
          )
        : new Map<string, string>();
      const accounts = shared
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'id', { sensitivity: 'base' }))
        .map((row) => {
          const list = grants.get(row.id) ?? [];
          const direct = list.find(
            (grant) => grant.principalType === 'user' && grant.userId === target.id,
          );
          const sources: TeamMailAccessResponse['accounts'][number]['sources'] = [];
          if (isMailImplicitManager(target.role)) {
            sources.push({ type: 'role', level: 'manage', department: null });
          }
          if (direct) sources.push({ type: 'user', level: direct.level, department: null });
          for (const grant of list) {
            if (
              grant.principalType === 'department' &&
              grant.departmentId &&
              departmentIds.includes(grant.departmentId)
            ) {
              sources.push({
                type: 'department',
                level: grant.level,
                department: {
                  id: grant.departmentId,
                  name: departmentNames.get(grant.departmentId) ?? '',
                },
              });
            }
          }
          return {
            account: {
              id: row.id,
              displayName: row.displayName,
              emailAddress: row.emailAddress,
              color: row.color as MailAccountColor,
            },
            effectiveLevel: subject
              ? resolveMailAccess(subject, { kind: 'shared', ownerUserId: null }, list)
              : null,
            directLevel: direct?.level ?? null,
            sources,
          };
        });
      const personal = await db
        .select({
          id: mailAccounts.id,
          emailAddress: mailAccounts.emailAddress,
          syncState: mailAccounts.syncState,
        })
        .from(mailAccounts)
        .where(
          and(
            eq(mailAccounts.organizationId, auth.organizationId),
            eq(mailAccounts.kind, 'personal'),
            eq(mailAccounts.ownerUserId, target.id),
            isNull(mailAccounts.deletedAt),
          ),
        );
      const accessible = await accessibleMailAccountsOf(db, auth.organizationId, target.id);
      return {
        user: {
          id: target.id,
          name: target.name,
          role: target.role,
          active: target.disabledAt === null,
        },
        menuVisible: target.disabledAt === null && mailMenuVisible(target.role, accessible.size),
        canConnectPersonal: hasPermission(target.role, 'mail.private.own'),
        accounts,
        personalAccounts: personal.map((row) => ({
          id: row.id,
          emailAddress: row.emailAddress,
          syncState: row.syncState as MailSyncState,
        })),
      };
    },

    async updateForUser(
      auth: AuthContext,
      userId: string,
      input: UpdateTeamMailAccessRequest,
      context: MailContext,
    ): Promise<TeamMailAccessResponse> {
      if (!isUuid(userId))
        throw new AppError('NOT_FOUND', { message: 'Pengguna tidak ditemukan.' });
      const [target] = await db
        .select({ id: users.id, role: users.role, disabledAt: users.disabledAt })
        .from(users)
        .where(and(eq(users.organizationId, auth.organizationId), eq(users.id, userId)))
        .limit(1);
      if (!target) throw new AppError('NOT_FOUND', { message: 'Pengguna tidak ditemukan.' });
      const wantsGrant = input.grants.some((grant) => grant.level !== null);
      if (wantsGrant && target.disabledAt !== null) {
        throw validation(
          'grants',
          'Pengguna ini nonaktif, jadi tidak bisa diberi akses.',
          'principal_invalid',
        );
      }
      if (wantsGrant && isMailImplicitManager(target.role)) {
        throw validation(
          'grants',
          'Owner dan Admin otomatis punya hak Kelola di semua akun bersama.',
          'grant_for_admin',
        );
      }
      const accountIds = input.grants.map((grant) => grant.accountId.toLowerCase());
      const accounts = accountIds.length
        ? await db
            .select({
              id: mailAccounts.id,
              kind: mailAccounts.kind,
              emailAddress: mailAccounts.emailAddress,
            })
            .from(mailAccounts)
            .where(
              and(
                eq(mailAccounts.organizationId, auth.organizationId),
                inArray(mailAccounts.id, accountIds),
                isNull(mailAccounts.deletedAt),
              ),
            )
        : [];
      const byId = new Map(accounts.map((row) => [row.id, row]));
      for (const grant of input.grants) {
        const account = byId.get(grant.accountId.toLowerCase());
        if (!account) {
          throw validation('grants', 'Ada akun email yang tidak ditemukan.', 'account_not_found');
        }
        if ((account.kind as MailAccountKind) === 'personal') {
          throw validation(
            'grants',
            'Akun pribadi tidak bisa dibagikan.',
            'personal_account_no_access',
          );
        }
      }
      const currentGrants = await mailGrantsOf(db, auth.organizationId, accountIds);
      const plan = input.grants.map((grant) => {
        const id = grant.accountId.toLowerCase();
        const before = (currentGrants.get(id) ?? []) as GrantRow[];
        const others = before.filter(
          (row) => !(row.principalType === 'user' && row.userId === target.id),
        );
        const after: GrantRow[] =
          grant.level === null
            ? others
            : [
                ...others,
                {
                  principalType: 'user',
                  userId: target.id,
                  departmentId: null,
                  level: grant.level,
                },
              ];
        return { id, before, after };
      });
      const loosened = plan.some((entry) => diffGrants(entry.before, entry.after).loosened);
      if (loosened) {
        await requireIdentityConfirmation(
          twoFactor,
          auth,
          input.confirmation,
          'mail.access.loosen',
          context,
          CONFIRM_LOOSEN,
        );
      }
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'mail.accounts.manage', context.log);
        if (wantsGrant) {
          // Review 9A-1 R6: peran/status target dicek ULANG dengan baris terkunci (bisa dipromosikan
          // jadi Admin atau dinonaktifkan di antara pemeriksaan awal & transaksi ini).
          const [lockedTarget] = await tx
            .select({ role: users.role, disabledAt: users.disabledAt })
            .from(users)
            .where(and(eq(users.organizationId, auth.organizationId), eq(users.id, target.id)))
            .for('update');
          if (!lockedTarget || lockedTarget.disabledAt !== null) {
            throw validation(
              'grants',
              'Pengguna ini nonaktif, jadi tidak bisa diberi akses.',
              'principal_invalid',
            );
          }
          if (isMailImplicitManager(lockedTarget.role)) {
            throw validation(
              'grants',
              'Owner dan Admin otomatis punya hak Kelola di semua akun bersama.',
              'grant_for_admin',
            );
          }
        }
        for (const entry of plan) {
          const locked = await loadAccountRow(tx, auth.organizationId, entry.id, {
            forUpdate: true,
          });
          if (!locked || locked.kind !== 'shared') throw mailNotFound();
          const current = await grantsOf(tx, auth.organizationId, entry.id);
          const others = current.filter(
            (row) => !(row.principalType === 'user' && row.userId === target.id),
          );
          const requested = input.grants.find(
            (grant) => grant.accountId.toLowerCase() === entry.id,
          );
          const after: GrantRow[] =
            !requested || requested.level === null
              ? others
              : [
                  ...others,
                  {
                    principalType: 'user',
                    userId: target.id,
                    departmentId: null,
                    level: requested.level,
                  },
                ];
          if (!loosened && diffGrants(current, after).loosened) {
            throw new AppError('CONFLICT', { message: RACE_MESSAGE });
          }
          await replace(tx, auth, locked, current, after, context);
        }
      });
      if (plan.length > 0) {
        await publisher.publish([
          {
            organizationId: auth.organizationId,
            userIds: [target.id],
            event: { type: 'mail.access.changed' },
          },
        ]);
      }
      return this.getForUser(auth, target.id);
    },
  };
}

export type MailAccessService = ReturnType<typeof createMailAccessService>;
