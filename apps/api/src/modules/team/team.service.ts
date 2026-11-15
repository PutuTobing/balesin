import { AppError } from '@balesin/core';
import type { Database, DbExecutor } from '@balesin/db';
import {
  INVITE_PERMISSIONS,
  MANAGE_PERMISSIONS,
  USER_ROLE_LABELS,
  assignableRoles,
  canManageRole,
  isTwoFactorRequired,
  type ActiveSessionListResponse,
  type ChangeUserRoleRequest,
  type IdentityConfirmation,
  type InvitableRole,
  type TeamUser,
  type TeamUserActionResponse,
  type TeamUserListResponse,
  type UserRole,
} from '@balesin/shared';
import type { FastifyBaseLogger } from 'fastify';

import type { ClientInfo } from '../../http/client-info';
import type { EmailNotifier } from '../../queues/email-queue';
import { revokeLiveAccountTokens } from '../account-tokens/account-tokens.repo';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { ACCESS_RULES, forbidByRule, type AccessDeniedRecorder } from '../auth/access-denied';
import {
  countActiveSessionsByUser,
  listActiveSessions,
  revokeSessionOfUser,
} from '../auth/session.repo';
import type { AuthContext, SessionService } from '../auth/session.service';
import { revokeInvitationsIssuedBy } from '../invitations/invitations.repo';
import { revokeInvitationsOnRecovery } from '../invitations/session-revocation';
import { toActiveSession } from '../sessions/session-view';
import { SESSION_NOT_FOUND_MESSAGE } from '../sessions/sessions.service';
import { deleteBackupCodes, deleteChallenges } from '../two-factor/two-factor.repo';
import type { TwoFactorService } from '../two-factor/two-factor.service';
import type { LockInspector } from './lock-state';
import {
  clearLockedUntil,
  countOtherActiveOwners,
  disableUser,
  enableUser,
  findActiveOwners,
  findTeamUser,
  listTeamUsers,
  lockActor,
  lockTarget,
  lockTeamChanges,
  reopenTwoFactorEnrollment,
  resetUserTwoFactor,
  updateUserRole,
  type TeamUserRow,
} from './team.repo';

/**
 * Manajemen pengguna (PRD §4 "Undang/nonaktifkan pengguna", SECURITY.md §1–2). Alur & error per
 * kasus: docs/KONTRAK-API-AUTH.md bagian "Manajemen pengguna & sesi".
 *
 * Lapisan pemeriksaan untuk setiap aksi terhadap pengguna lain:
 *  1. Izin rute `team.manage` (hook auth).
 *  2. Pengguna sasaran di organisasi yang sama (selain itu 404 — tidak membuka keberadaannya).
 *  3. Bukan diri sendiri (`team.manage.self`) dan peran sasaran boleh dikelola pemanggil
 *     (`MANAGE_PERMISSIONS`, `team.manage.role`); peran baru boleh diberikan pemanggil
 *     (`assignableRoles`, `team.manage.assign_role`). Semua 403 lewat `forbidByRule` (diaudit).
 *  4. Konfirmasi ulang identitas pelaku (password + kode 2FA) untuk setiap aksi yang mengubah
 *     wewenang/akses — kecuali mengeluarkan SATU sesi (aksi defensif ringan).
 *  5. Di dalam transaksi: wewenang pelaku diperiksa ulang dari database (baris dikunci), Owner aktif
 *     tidak boleh habis (diserialkan), dan perubahan bersyarat pada keadaan yang diharapkan.
 *
 * Efek samping wajib (review 2FA S2/I.11, review undangan R2.2): ganti peran / nonaktifkan / atur
 * ulang 2FA mencabut SEMUA sesi + tantangan 2FA pengguna itu; ganti peran dan nonaktifkan
 * membatalkan undangan terbuka terbitannya yang tidak lagi boleh ia terbitkan; nonaktifkan juga
 * membatalkan tautan atur ulang password / verifikasi email yang masih hidup.
 */

export interface TeamContext {
  client: ClientInfo;
  log: FastifyBaseLogger;
  presentedDeviceToken?: string;
}

export interface TeamService {
  list(auth: AuthContext): Promise<TeamUserListResponse>;
  get(auth: AuthContext, userId: string): Promise<TeamUser>;
  changeRole(
    auth: AuthContext,
    userId: string,
    input: ChangeUserRoleRequest,
    context: TeamContext,
  ): Promise<TeamUserActionResponse>;
  disable(
    auth: AuthContext,
    userId: string,
    input: IdentityConfirmation,
    context: TeamContext,
  ): Promise<TeamUserActionResponse>;
  enable(
    auth: AuthContext,
    userId: string,
    input: IdentityConfirmation,
    context: TeamContext,
  ): Promise<TeamUserActionResponse>;
  resetTwoFactor(
    auth: AuthContext,
    userId: string,
    input: IdentityConfirmation,
    context: TeamContext,
  ): Promise<TeamUserActionResponse>;
  reopenTwoFactorEnrollment(
    auth: AuthContext,
    userId: string,
    input: IdentityConfirmation,
    context: TeamContext,
  ): Promise<TeamUserActionResponse>;
  unlock(
    auth: AuthContext,
    userId: string,
    input: IdentityConfirmation,
    context: TeamContext,
  ): Promise<TeamUserActionResponse>;
  sessions(
    auth: AuthContext,
    userId: string,
    context: TeamContext,
  ): Promise<ActiveSessionListResponse>;
  revokeSession(
    auth: AuthContext,
    userId: string,
    sessionId: string,
    context: TeamContext,
  ): Promise<void>;
  revokeAllSessions(
    auth: AuthContext,
    userId: string,
    input: IdentityConfirmation,
    context: TeamContext,
  ): Promise<number>;
}

export interface TeamServiceDeps {
  db: Database;
  sessions: SessionService;
  twoFactor: TwoFactorService;
  notifier: EmailNotifier;
  accessDenied: AccessDeniedRecorder;
  locks: LockInspector;
}

/** Operasi untuk metadata audit penolakan. */
type TeamOperation =
  | 'view_sessions'
  | 'revoke_session'
  | 'revoke_all_sessions'
  | 'change_role'
  | 'disable'
  | 'enable'
  | 'reset_two_factor'
  | 'reopen_two_factor_enrollment'
  | 'unlock';

const NOT_FOUND_MESSAGE = 'Pengguna tidak ditemukan.';
const CHANGED_MESSAGE =
  'Data pengguna ini baru saja berubah. Muat ulang halaman Tim, lalu coba lagi.';

function conflict(message: string): AppError {
  return new AppError('CONFLICT', { message });
}

function assignRoleMessage(actor: UserRole): string {
  return actor === 'admin'
    ? 'Admin hanya bisa memberi peran Supervisor, CS, atau Teknisi.'
    : 'Peran ini tidak bisa diberikan lewat ubah peran.';
}

function manageRoleMessage(actor: UserRole): string {
  return actor === 'admin'
    ? 'Admin hanya bisa mengelola Supervisor, CS, dan Teknisi. Owner dan Admin lain hanya bisa dikelola Owner.'
    : 'Peranmu tidak bisa mengelola pengguna ini.';
}

export function createTeamService(deps: TeamServiceDeps): TeamService {
  const { db, sessions, twoFactor, notifier, accessDenied, locks } = deps;

  function view(
    auth: AuthContext,
    row: TeamUserRow,
    extras: { lockedUntil?: Date | undefined; activeSessions: number },
  ): TeamUser {
    const isSelf = row.id === auth.user.id;
    const canManage = !isSelf && canManageRole(auth.user.role, row.role);
    const enabled = row.totpEnabledAt !== null;
    const required = isTwoFactorRequired(row.role);
    const lockedUntil = row.disabledAt === null ? (extras.lockedUntil ?? null) : null;
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      status: row.disabledAt !== null ? 'disabled' : lockedUntil ? 'locked' : 'active',
      disabledAt: row.disabledAt?.toISOString() ?? null,
      lockedUntil: lockedUntil?.toISOString() ?? null,
      emailVerified: row.emailVerifiedAt !== null,
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      twoFactor: {
        enabled,
        required,
        enabledAt: row.totpEnabledAt?.toISOString() ?? null,
        enrollmentDueAt:
          required && !enabled ? (row.twoFactorEnrollmentDueAt?.toISOString() ?? null) : null,
        enrollmentExpired: row.enrollmentClosed,
      },
      activeSessions: row.disabledAt === null ? extras.activeSessions : 0,
      isSelf,
      canManage,
      assignableRoles: canManage ? [...assignableRoles(auth.user.role)] : [],
    };
  }

  /** Satu pengguna dalam bentuk respons (dengan keadaan kunci + jumlah sesi terbaru). */
  async function viewOne(auth: AuthContext, userId: string): Promise<TeamUser> {
    const row = await findTeamUser(db, auth.organizationId, userId);
    if (!row) throw new AppError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
    const [lockMap, counts] = await Promise.all([
      locks.lockedUntil(auth.organizationId, [row]),
      countActiveSessionsByUser(db, auth.organizationId),
    ]);
    return view(auth, row, {
      lockedUntil: lockMap.get(row.id),
      activeSessions: counts.get(row.id) ?? 0,
    });
  }

  /**
   * Pengguna sasaran yang boleh dikelola pemanggil: 404 bila tidak ada di organisasi ini, 403
   * (+ audit) bila dirinya sendiri atau perannya di luar `MANAGE_PERMISSIONS` pemanggil.
   */
  async function loadManageable(
    auth: AuthContext,
    userId: string,
    operation: TeamOperation,
    context: TeamContext,
  ): Promise<TeamUserRow> {
    const target = await findTeamUser(db, auth.organizationId, userId);
    if (!target) throw new AppError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
    if (target.id === auth.user.id) {
      await forbidByRule(accessDenied, {
        auth,
        rule: ACCESS_RULES.teamManageSelf,
        client: context.client,
        details: { operation },
        message:
          'Akunmu sendiri tidak bisa dikelola dari halaman Tim. Pakai halaman Keamanan akun untuk sesi dan verifikasi dua langkah-mu.',
      });
    }
    if (!canManageRole(auth.user.role, target.role)) {
      await forbidByRule(accessDenied, {
        auth,
        rule: ACCESS_RULES.teamManageRole,
        client: context.client,
        details: { operation, targetRole: target.role },
        message: manageRoleMessage(auth.user.role),
      });
    }
    return target;
  }

  /**
   * WAJIB menjadi langkah PERTAMA setiap transaksi pengelolaan (review butir 6 R1/R2):
   *  1. kunci advisory organisasi — semua aksi kelola berurutan, urutan kunci selalu sama (tanpa
   *     deadlock), dan yang kalah melihat keadaan terbaru;
   *  2. baris pelaku (`FOR SHARE`) — masih aktif, dan perannya SEKARANG masih boleh mengelola peran
   *     sasaran SEKARANG dan (ubah peran) masih boleh memberi peran baru; selain itu 403 + audit;
   *  3. baris sasaran (`FOR UPDATE`) — peran/status/2FA-nya sama dengan yang dibaca sebelum
   *     transaksi; bila berubah (permintaan lain menang tipis) → 409.
   */
  async function lockManaged(
    tx: DbExecutor,
    auth: AuthContext,
    target: TeamUserRow,
    operation: TeamOperation,
    context: TeamContext,
    assignRole?: InvitableRole,
  ): Promise<void> {
    await lockTeamChanges(tx, auth.organizationId);
    const actor = await lockActor(tx, auth.organizationId, auth.user.id);
    const fresh = await lockTarget(tx, auth.organizationId, target.id);
    if (
      !fresh ||
      fresh.role !== target.role ||
      fresh.disabledAt?.getTime() !== target.disabledAt?.getTime() ||
      fresh.totpEnabledAt?.getTime() !== target.totpEnabledAt?.getTime()
    ) {
      throw conflict(CHANGED_MESSAGE);
    }
    if (!actor || actor.disabledAt !== null || !canManageRole(actor.role, fresh.role)) {
      await forbidByRule(accessDenied, {
        auth,
        rule: ACCESS_RULES.teamManageRole,
        client: context.client,
        details: { operation, targetRole: fresh.role, stage: 'recheck' },
        message: manageRoleMessage(actor?.role ?? 'cs'),
      });
      return;
    }
    if (assignRole !== undefined && !assignableRoles(actor.role).includes(assignRole)) {
      await forbidByRule(accessDenied, {
        auth,
        rule: ACCESS_RULES.teamAssignRole,
        client: context.client,
        details: { operation, targetRole: assignRole, stage: 'recheck' },
        message: assignRoleMessage(actor.role),
      });
    }
  }

  /**
   * Owner aktif tidak boleh habis: dipanggil (sesudah `lockManaged`, yang sudah memegang kunci
   * organisasi) sebelum menurunkan/menonaktifkan seorang Owner.
   */
  async function assertOwnerRemains(tx: DbExecutor, auth: AuthContext, target: TeamUserRow) {
    if ((await countOtherActiveOwners(tx, auth.organizationId, target.id)) === 0) {
      throw conflict(
        'Organisasi harus selalu punya minimal satu Owner aktif. Perubahan ini akan menghapus Owner terakhir.',
      );
    }
  }

  async function confirm(
    auth: AuthContext,
    input: IdentityConfirmation,
    action: string,
    context: TeamContext,
  ): Promise<string | null> {
    const { method } = await twoFactor.confirmIdentity(
      auth,
      { password: input.password, code: input.code },
      action,
      context,
    );
    return method;
  }

  /**
   * Membatalkan undangan terbuka terbitan pengguna ini yang tidak lagi boleh ia terbitkan
   * (`keepRoles` = peran yang masih boleh), satu audit per undangan.
   */
  async function revokeIssuedInvitations(
    tx: DbExecutor,
    auth: AuthContext,
    target: TeamUserRow,
    keepRoles: readonly InvitableRole[],
    reason: 'issuer_disabled' | 'issuer_role_changed',
    context: TeamContext,
  ): Promise<number> {
    const revoked = await revokeInvitationsIssuedBy(
      tx,
      auth.organizationId,
      target.id,
      auth.user.id,
      keepRoles,
    );
    for (const invitation of revoked) {
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.user.id,
        action: AUDIT_ACTIONS.invitationRevoked,
        targetType: 'invitation',
        targetId: invitation.id,
        metadata: { reason, role: invitation.role, issuerRef: target.id },
        client: context.client,
      });
    }
    return revoked.length;
  }

  /**
   * Pemulihan oleh Owner/Admin ("keluarkan sesi", "keluarkan semua sesi", atur ulang 2FA): undangan
   * terbuka terbitan sasaran ikut batal (review akhir Fase 1 putaran 2 N2). Bukan untuk ubah peran.
   */
  function cancelInvitationsOnRecovery(
    tx: DbExecutor,
    auth: AuthContext,
    userId: string,
    scope: { sessionIds: readonly string[] } | Record<string, never>,
    context: TeamContext,
  ) {
    return revokeInvitationsOnRecovery(tx, {
      organizationId: auth.organizationId,
      issuerUserId: userId,
      scope,
      actorUserId: auth.user.id,
      client: context.client,
    });
  }

  /** Semua sesi + tantangan langkah kedua pengguna ini dicabut (ia harus masuk lagi). */
  async function signOutEverywhere(tx: DbExecutor, auth: AuthContext, userId: string) {
    const revoked = await sessions.revokeAllForUser(tx, auth.organizationId, userId);
    await deleteChallenges(tx, auth.organizationId, userId);
    return revoked;
  }

  /**
   * Ubah peran / nonaktifkan oleh SELAIN Owner (Admin) → email ke semua Owner aktif (review butir 6
   * Info 6, pola review RBAC S1): Admin yang dibobol tidak bisa diam-diam merombak tim.
   */
  function notifyOwnersOfChange(
    auth: AuthContext,
    subjectUserId: string,
    event: 'role_changed' | 'user_disabled',
    auditLogId: string,
    context: TeamContext,
  ): void {
    if (auth.user.role === 'owner') return;
    const occurredAt = new Date().toISOString();
    warnOnFailure(
      findActiveOwners(db, auth.organizationId, [auth.user.id, subjectUserId]).then(
        async (owners) => {
          for (const recipientUserId of owners) {
            await notifier.securityNoticeAdmin({
              organizationId: auth.organizationId,
              recipientUserId,
              subjectUserId,
              event,
              occurredAt,
              auditLogId,
              actorUserId: auth.user.id,
            });
          }
        },
      ),
      context.log,
      subjectUserId,
    );
  }

  function warnOnFailure(promise: Promise<unknown>, log: FastifyBaseLogger, userId: string) {
    void promise.catch((err: unknown) => {
      log.warn({ err, userId }, 'Gagal mengantre email pemberitahuan manajemen pengguna');
    });
  }

  return {
    async list(auth) {
      const rows = await listTeamUsers(db, auth.organizationId);
      const [lockMap, counts] = await Promise.all([
        locks.lockedUntil(
          auth.organizationId,
          rows.filter((row) => row.disabledAt === null),
        ),
        countActiveSessionsByUser(db, auth.organizationId),
      ]);
      const users = rows.map((row) =>
        view(auth, row, {
          lockedUntil: lockMap.get(row.id),
          activeSessions: counts.get(row.id) ?? 0,
        }),
      );
      return { users, manageableRoles: [...MANAGE_PERMISSIONS[auth.user.role]] };
    },

    get: (auth, userId) => viewOne(auth, userId),

    async changeRole(auth, userId, input, context) {
      const target = await loadManageable(auth, userId, 'change_role', context);
      if (!assignableRoles(auth.user.role).includes(input.role)) {
        await forbidByRule(accessDenied, {
          auth,
          rule: ACCESS_RULES.teamAssignRole,
          client: context.client,
          details: { operation: 'change_role', targetRole: input.role },
          message: assignRoleMessage(auth.user.role),
        });
      }
      if (target.role === input.role) {
        throw conflict(`${target.name} sudah berperan ${USER_ROLE_LABELS[input.role]}.`);
      }
      const confirmedWith = await confirm(auth, input, 'change_role', context);

      const result = await db.transaction(async (tx) => {
        await lockManaged(tx, auth, target, 'change_role', context, input.role);
        if (target.role === 'owner') await assertOwnerRemains(tx, auth, target);
        const twoFactorEnabled = target.totpEnabledAt !== null;
        const updated = await updateUserRole(tx, {
          organizationId: auth.organizationId,
          userId: target.id,
          expectedRole: target.role,
          role: input.role,
          twoFactorEnabled,
        });
        if (!updated) throw conflict(CHANGED_MESSAGE);
        // Selalu: sesi lama membawa izin peran lama di web, dan peran wajib 2FA tanpa 2FA harus
        // masuk lagi dengan password untuk mendapat sesi pendaftaran (review 2FA S2/I.11).
        const revokedSessions = await signOutEverywhere(tx, auth, target.id);
        const revokedInvitations = await revokeIssuedInvitations(
          tx,
          auth,
          target,
          INVITE_PERMISSIONS[input.role],
          'issuer_role_changed',
          context,
        );
        const auditLogId = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.userRoleChanged,
          targetType: 'user',
          targetId: target.id,
          metadata: {
            from: target.role,
            to: input.role,
            revokedSessions,
            revokedInvitations,
            twoFactorEnrollmentRequired: isTwoFactorRequired(input.role) && !twoFactorEnabled,
            actorRole: auth.user.role,
            confirmedWith,
          },
          client: context.client,
        });
        return { revokedSessions, revokedInvitations, auditLogId };
      });
      context.log.info(
        { userId: target.id, from: target.role, to: input.role, ...result },
        'Peran pengguna diubah; sesinya dicabut',
      );
      notifyOwnersOfChange(auth, target.id, 'role_changed', result.auditLogId, context);
      return {
        user: await viewOne(auth, target.id),
        revokedSessions: result.revokedSessions,
        revokedInvitations: result.revokedInvitations,
      };
    },

    async disable(auth, userId, input, context) {
      const target = await loadManageable(auth, userId, 'disable', context);
      if (target.disabledAt !== null) throw conflict(`${target.name} sudah nonaktif.`);
      const confirmedWith = await confirm(auth, input, 'disable_user', context);

      const result = await db.transaction(async (tx) => {
        await lockManaged(tx, auth, target, 'disable', context);
        if (target.role === 'owner') await assertOwnerRemains(tx, auth, target);
        if (
          !(await disableUser(tx, {
            organizationId: auth.organizationId,
            userId: target.id,
            expectedRole: target.role,
          }))
        ) {
          throw conflict(CHANGED_MESSAGE);
        }
        const revokedSessions = await signOutEverywhere(tx, auth, target.id);
        const revokedTokens =
          (await revokeLiveAccountTokens(tx, auth.organizationId, target.id, 'password_reset')) +
          (await revokeLiveAccountTokens(tx, auth.organizationId, target.id, 'email_verification'));
        const revokedInvitations = await revokeIssuedInvitations(
          tx,
          auth,
          target,
          [],
          'issuer_disabled',
          context,
        );
        const auditLogId = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.userDisabled,
          targetType: 'user',
          targetId: target.id,
          metadata: {
            role: target.role,
            revokedSessions,
            revokedInvitations,
            // Tautan atur ulang password / verifikasi email (nama kunci tanpa "token": disensor).
            revokedAccountLinks: revokedTokens,
            actorRole: auth.user.role,
            confirmedWith,
          },
          client: context.client,
        });
        return { revokedSessions, revokedInvitations, auditLogId };
      });
      context.log.info({ userId: target.id, ...result }, 'Pengguna dinonaktifkan');
      notifyOwnersOfChange(auth, target.id, 'user_disabled', result.auditLogId, context);
      return {
        user: await viewOne(auth, target.id),
        revokedSessions: result.revokedSessions,
        revokedInvitations: result.revokedInvitations,
      };
    },

    async enable(auth, userId, input, context) {
      const target = await loadManageable(auth, userId, 'enable', context);
      if (target.disabledAt === null) throw conflict(`${target.name} sudah aktif.`);
      const confirmedWith = await confirm(auth, input, 'enable_user', context);

      await db.transaction(async (tx) => {
        await lockManaged(tx, auth, target, 'enable', context);
        const twoFactorEnabled = target.totpEnabledAt !== null;
        const enabled = await enableUser(tx, {
          organizationId: auth.organizationId,
          userId: target.id,
          role: target.role,
          twoFactorEnabled,
        });
        if (!enabled) throw conflict(CHANGED_MESSAGE);
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.userEnabled,
          targetType: 'user',
          targetId: target.id,
          metadata: {
            role: target.role,
            twoFactorEnrollmentRequired: isTwoFactorRequired(target.role) && !twoFactorEnabled,
            confirmedWith,
          },
          client: context.client,
        });
      });
      return { user: await viewOne(auth, target.id), revokedSessions: 0, revokedInvitations: 0 };
    },

    async resetTwoFactor(auth, userId, input, context) {
      const target = await loadManageable(auth, userId, 'reset_two_factor', context);
      if (target.totpEnabledAt === null) {
        throw conflict(
          isTwoFactorRequired(target.role)
            ? `${target.name} belum mendaftarkan verifikasi dua langkah. Kalau batas waktunya sudah lewat, pakai "Buka lagi pendaftaran".`
            : `${target.name} belum mengaktifkan verifikasi dua langkah.`,
        );
      }
      const confirmedWith = await confirm(auth, input, 'reset_user_two_factor', context);

      const { revokedSessions, auditLogId } = await db.transaction(async (tx) => {
        await lockManaged(tx, auth, target, 'reset_two_factor', context);
        const reset = await resetUserTwoFactor(tx, {
          organizationId: auth.organizationId,
          userId: target.id,
          role: target.role,
        });
        if (!reset) throw conflict(CHANGED_MESSAGE);
        await deleteBackupCodes(tx, auth.organizationId, target.id);
        const revoked = await signOutEverywhere(tx, auth, target.id);
        await cancelInvitationsOnRecovery(tx, auth, target.id, {}, context);
        const auditId = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.userTwoFactorReset,
          targetType: 'user',
          targetId: target.id,
          metadata: {
            role: target.role,
            revokedSessions: revoked,
            twoFactorEnrollmentRequired: isTwoFactorRequired(target.role),
            confirmedWith,
          },
          client: context.client,
        });
        return { revokedSessions: revoked, auditLogId: auditId };
      });
      // Kunci langkah kedua lama tidak relevan lagi untuk autentikator baru.
      try {
        await locks.unlockTwoFactor(target);
      } catch (err) {
        context.log.warn({ err, userId: target.id }, 'Kunci 2FA lama tidak bisa dilepas');
      }

      const occurredAt = new Date().toISOString();
      warnOnFailure(
        notifier.securityNotice({
          organizationId: auth.organizationId,
          userId: target.id,
          event: 'two_factor_reset',
          occurredAt,
          auditLogId,
          actorUserId: auth.user.id,
        }),
        context.log,
        target.id,
      );
      // Owner LAIN (bukan pelaku, bukan sasaran) diberi tahu: atur ulang 2FA adalah jalan yang bisa
      // dipakai akun Owner/Admin yang dibobol untuk mengambil alih akun lain.
      warnOnFailure(
        findActiveOwners(db, auth.organizationId, [auth.user.id, target.id]).then(
          async (owners) => {
            for (const recipientUserId of owners) {
              await notifier.securityNoticeAdmin({
                organizationId: auth.organizationId,
                recipientUserId,
                subjectUserId: target.id,
                event: 'two_factor_reset',
                occurredAt,
                auditLogId,
                actorUserId: auth.user.id,
              });
            }
          },
        ),
        context.log,
        target.id,
      );
      return { user: await viewOne(auth, target.id), revokedSessions, revokedInvitations: 0 };
    },

    async reopenTwoFactorEnrollment(auth, userId, input, context) {
      const target = await loadManageable(auth, userId, 'reopen_two_factor_enrollment', context);
      if (!isTwoFactorRequired(target.role)) {
        throw conflict(
          `Peran ${USER_ROLE_LABELS[target.role]} tidak wajib memakai verifikasi dua langkah, jadi tidak punya batas waktu pendaftaran.`,
        );
      }
      if (target.totpEnabledAt !== null) {
        throw conflict(`${target.name} sudah memakai verifikasi dua langkah.`);
      }
      const confirmedWith = await confirm(auth, input, 'reopen_two_factor_enrollment', context);

      await db.transaction(async (tx) => {
        await lockManaged(tx, auth, target, 'reopen_two_factor_enrollment', context);
        const dueAt = await reopenTwoFactorEnrollment(tx, {
          organizationId: auth.organizationId,
          userId: target.id,
          role: target.role,
        });
        if (!dueAt) throw conflict(CHANGED_MESSAGE);
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.userTwoFactorEnrollmentReopened,
          targetType: 'user',
          targetId: target.id,
          metadata: {
            role: target.role,
            previouslyExpired: target.enrollmentClosed,
            dueAt: dueAt.toISOString(),
            confirmedWith,
          },
          client: context.client,
        });
      });
      return { user: await viewOne(auth, target.id), revokedSessions: 0, revokedInvitations: 0 };
    },

    async unlock(auth, userId, input, context) {
      const target = await loadManageable(auth, userId, 'unlock', context);
      const confirmedWith = await confirm(auth, input, 'unlock_user', context);
      await db.transaction(async (tx) => {
        await lockManaged(tx, auth, target, 'unlock', context);
        // Kunci Redis dilepas SETELAH wewenang dipastikan ulang; galat Redis membatalkan transaksi.
        const cleared = await locks.unlock(auth.organizationId, target);
        await clearLockedUntil(tx, auth.organizationId, target.id);
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.userUnlocked,
          targetType: 'user',
          targetId: target.id,
          metadata: { cleared: cleared.join(',') || null, confirmedWith },
          client: context.client,
        });
      });
      return { user: await viewOne(auth, target.id), revokedSessions: 0, revokedInvitations: 0 };
    },

    async sessions(auth, userId, context) {
      const target = await loadManageable(auth, userId, 'view_sessions', context);
      const rows = await listActiveSessions(db, auth.organizationId, target.id);
      return { sessions: rows.map((row) => toActiveSession(row)) };
    },

    async revokeSession(auth, userId, sessionId, context) {
      const target = await loadManageable(auth, userId, 'revoke_session', context);
      await db.transaction(async (tx) => {
        await lockManaged(tx, auth, target, 'revoke_session', context);
        if (!(await revokeSessionOfUser(tx, auth.organizationId, target.id, sessionId))) {
          throw new AppError('NOT_FOUND', { message: SESSION_NOT_FOUND_MESSAGE });
        }
        await cancelInvitationsOnRecovery(
          tx,
          auth,
          target.id,
          { sessionIds: [sessionId] },
          context,
        );
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.sessionRevoked,
          targetType: 'session',
          targetId: sessionId,
          metadata: { by: 'administrator', userRef: target.id },
          client: context.client,
        });
      });
    },

    async revokeAllSessions(auth, userId, input, context) {
      const target = await loadManageable(auth, userId, 'revoke_all_sessions', context);
      const confirmedWith = await confirm(auth, input, 'revoke_user_sessions', context);
      return db.transaction(async (tx) => {
        await lockManaged(tx, auth, target, 'revoke_all_sessions', context);
        const revoked = await signOutEverywhere(tx, auth, target.id);
        await cancelInvitationsOnRecovery(tx, auth, target.id, {}, context);
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.sessionsRevokedAll,
          targetType: 'user',
          targetId: target.id,
          metadata: { by: 'administrator', revokedSessions: revoked, confirmedWith },
          client: context.client,
        });
        return revoked;
      });
    },
  };
}
