import {
  USER_ROLE_LABELS,
  auditActionLabel,
  isTwoFactorRequired,
  type ActiveSession,
  type ActiveSessionListResponse,
  type IdentityConfirmation,
  type InvitableRole,
  type TeamUser,
  type TeamUserActionResponse,
  type UserRole,
} from '@balesin/shared';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Avatar } from '../../components/shell/UserMenu';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { SelectField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import {
  queryKeys,
  storeTeamUser,
  teamUserQuery,
  userAuditQuery,
  userSessionsQuery,
} from '../../lib/api/queries';
import { formatDate, formatDateTime, formatDateTimeInline, formatTime } from '../../lib/format';
import { useCan, useSession } from '../auth/session';
import { IdentityDialog } from '../identity/IdentityDialog';
import { SessionList, SessionListSkeleton } from '../sessions/SessionList';
import { memberBadges, viewOnlyReason } from '../team/member-status';
import { roleChoices } from './role-choices';
import { TeamUserCardsSkeleton } from './TeamUserSkeleton';
import styles from './TeamUser.module.css';

const routeApi = getRouteApi('/_app/pengaturan/tim/$userId');
const copy = t.teamUser;

/** Aksi kelola yang wajib konfirmasi ulang identitas pelaku. */
type ActionKind = 'role' | 'disable' | 'enable' | 'reset2fa' | 'reopen' | 'unlock' | 'revokeAll';

interface PendingAction {
  kind: ActionKind;
  /** Peran baru (hanya `role`). */
  role?: InvitableRole;
  /** Tombol pembuka; fokus kembali ke sini bila dibatalkan. */
  trigger: RefObject<HTMLButtonElement | null>;
}

/**
 * Detail anggota (izin `team.manage`): profil & status, lalu — hanya bila `canManage` — ubah peran,
 * 2FA (atur ulang / buka lagi pendaftaran), buka kunci, sesi aktif, dan nonaktif/aktifkan. Anggota
 * yang tidak bisa dikelola hanya dilihat, dengan penjelasan singkat kenapa (tanpa tombol mati).
 * Riwayat aktivitas (audit `?userId=`) untuk pemegang `audit.view`.
 */
export function TeamUserPage() {
  const { userId } = routeApi.useParams();
  const queryClient = useQueryClient();
  const user = useQuery(teamUserQuery(userId, queryClient));

  return (
    <Page>
      {user.data ? (
        <TeamUserScreen key={user.data.id} user={user.data} />
      ) : user.isPending ? (
        <SkeletonRegion>
          <TeamUserCardsSkeleton />
        </SkeletonRegion>
      ) : isApiError(user.error) && user.error.status === 404 ? (
        <EmptyState
          title={copy.notFoundTitle}
          body={copy.notFoundBody}
          actions={
            <Button asChild variant="primary">
              <Link to="/pengaturan/tim">{copy.backToTeam}</Link>
            </Button>
          }
        />
      ) : (
        <EmptyState
          title={copy.loadFailedTitle}
          body={isApiError(user.error) ? user.error.message : t.api.network}
          actions={
            <Button variant="primary" onClick={() => void user.refetch()}>
              {t.common.retry}
            </Button>
          }
        />
      )}
    </Page>
  );
}

function TeamUserScreen({ user }: { user: TeamUser }) {
  const queryClient = useQueryClient();
  const session = useSession();
  const canAudit = useCan('audit.view');
  const [action, setAction] = useState<PendingAction | null>(null);
  const [result, setResult] = useState<{ lines: string[]; warning: boolean } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const [resultTick, setResultTick] = useState(0);
  /*
   * Buka kunci ditolak kunci 2FA harian (review butir 6 Info 2): kotak "terkunci" yang sama berganti
   * isi dan aksinya jadi "Atur ulang 2FA" (kritikus butir 6 W4). Berlaku sampai halaman dimuat ulang.
   */
  const [dailyLock, setDailyLock] = useState(false);
  const lockRef = useRef<HTMLDivElement>(null);
  const [lockTick, setLockTick] = useState(0);

  useEffect(() => {
    if (resultTick > 0) resultRef.current?.focus();
  }, [resultTick]);
  useEffect(() => {
    if (lockTick > 0) lockRef.current?.focus();
  }, [lockTick]);

  const reason = viewOnlyReason(user, session?.user.role);

  const showResult = (lines: string[], warning = false) => {
    setResult({ lines, warning });
    setResultTick((tick) => tick + 1);
  };

  /** Hasil aksi: data pengguna sesudahnya ke cache, sesi pengguna itu dimuat ulang. */
  const applied = (response: TeamUserActionResponse, message: string, warning = false) => {
    storeTeamUser(queryClient, response.user);
    void queryClient.invalidateQueries({ queryKey: queryKeys.userSessions(user.id) });
    const lines = [message];
    if (response.revokedInvitations > 0) {
      lines.push(copy.done.invitationsRevoked(response.revokedInvitations));
    }
    showResult(lines, warning);
  };

  const run = async (pending: PendingAction, identity: IdentityConfirmation) => {
    try {
      await perform(pending, identity);
    } catch (caught) {
      // Data berubah di tempat lain (409) atau pengguna hilang (404): muat ulang di belakang
      // dialog, pesannya tetap ditampilkan di dialog.
      if (isApiError(caught) && (caught.status === 404 || caught.status === 409)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.teamUser(user.id) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.teamUsers, exact: true });
      }
      // 403 yang tidak diduga (peran pelaku baru saja diturunkan): klien API sudah memuat ulang
      // /auth/me lewat `onForbidden`; pesan aturan dari server tetap tampil di dialog.
      throw caught;
    }
  };

  const perform = async (pending: PendingAction, identity: IdentityConfirmation) => {
    const { name } = user;
    switch (pending.kind) {
      case 'role': {
        const role = pending.role ?? 'cs';
        const response = await endpoints.team.changeRole(user.id, role, identity);
        setAction(null);
        applied(
          response,
          copy.done.role(name, USER_ROLE_LABELS[response.user.role], response.revokedSessions),
        );
        return;
      }
      case 'disable': {
        const response = await endpoints.team.disable(user.id, identity);
        setAction(null);
        applied(response, copy.done.disabled(name));
        return;
      }
      case 'enable': {
        const response = await endpoints.team.enable(user.id, identity);
        setAction(null);
        applied(response, copy.done.enabled(name));
        return;
      }
      case 'reset2fa': {
        const response = await endpoints.team.resetTwoFactor(user.id, identity);
        setAction(null);
        applied(response, copy.done.twoFactorReset(name, isTwoFactorRequired(response.user.role)));
        return;
      }
      case 'reopen': {
        const response = await endpoints.team.reopenTwoFactorEnrollment(user.id, identity);
        setAction(null);
        applied(response, copy.done.reopened(name));
        return;
      }
      case 'unlock': {
        const response = await endpoints.team.unlock(user.id, identity);
        setAction(null);
        if (response.user.status === 'locked') {
          // Kunci 2FA harian tidak ikut dibuka: tanpa kotak terpisah, kotak terkunci berganti isi.
          storeTeamUser(queryClient, response.user);
          setResult(null);
          setDailyLock(true);
          setLockTick((tick) => tick + 1);
          return;
        }
        applied(response, copy.done.unlocked(name));
        return;
      }
      case 'revokeAll': {
        const response = await endpoints.team.revokeAllSessions(user.id, identity);
        setAction(null);
        queryClient.setQueryData<ActiveSessionListResponse>(queryKeys.userSessions(user.id), {
          sessions: [],
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.teamUsers, exact: true });
        void queryClient.invalidateQueries({ queryKey: queryKeys.teamUser(user.id), exact: true });
        void queryClient.invalidateQueries({ queryKey: queryKeys.userAudit(user.id) });
        showResult([copy.done.sessionsRevoked(name, response.revokedSessions)]);
        return;
      }
    }
  };

  const request = (pending: PendingAction) => {
    setResult(null);
    setAction(pending);
  };

  const dialog = action ? dialogCopy(action, user) : null;

  return (
    <div className={styles.content}>
      {result ? (
        <div ref={resultRef} tabIndex={-1} className={styles.result}>
          <Notice tone={result.warning ? 'warning' : 'success'} role="status">
            {result.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </Notice>
        </div>
      ) : null}
      <ProfileCard
        user={user}
        reason={reason}
        onRequest={request}
        dailyLock={dailyLock}
        lockRef={lockRef}
      />
      {user.canManage ? (
        <>
          <RoleCard user={user} onRequest={request} />
          <TwoFactorCard user={user} onRequest={request} />
          <UserSessionsCard user={user} onRequest={request} />
          {/* Akun nonaktif: "Aktifkan lagi" ada di kotak "Akun nonaktif" (satu aksi, satu tempat). */}
          {user.status !== 'disabled' ? <AccessCard onRequest={request} /> : null}
        </>
      ) : null}
      {canAudit ? <ActivityCard user={user} /> : null}
      <IdentityDialog
        open={action !== null}
        title={dialog?.title ?? ''}
        body={dialog?.body ?? ''}
        confirmLabel={dialog?.confirm ?? ''}
        pendingLabel={dialog?.pending ?? ''}
        variant={dialog?.danger ? 'danger' : 'primary'}
        // Pemegang `team.manage` selalu peran wajib 2FA dengan 2FA aktif.
        requireCode
        returnFocusRef={action?.trigger}
        onCancel={() => setAction(null)}
        onConfirm={(identity) => (action ? run(action, identity) : Promise.resolve())}
      />
    </div>
  );
}

function dialogCopy(action: PendingAction, user: TeamUser) {
  const { name } = user;
  switch (action.kind) {
    case 'role': {
      const role = action.role ?? 'cs';
      const needs2fa = isTwoFactorRequired(role) && !user.twoFactor.enabled;
      return {
        title: copy.role.dialogTitle(USER_ROLE_LABELS[role]),
        body: needs2fa ? copy.role.dialogBody2fa(name) : copy.role.dialogBody(name),
        confirm: copy.role.confirm,
        pending: copy.role.pending,
        danger: false,
      };
    }
    case 'disable':
      return {
        title: copy.access.disableTitle,
        body: copy.access.disableBody(name),
        confirm: copy.access.disableConfirm,
        pending: copy.access.disablePending,
        danger: true,
      };
    case 'enable':
      return {
        title: copy.access.enableTitle,
        body: copy.access.enableBody(name),
        confirm: copy.access.enableConfirm,
        pending: copy.access.enablePending,
        danger: false,
      };
    case 'reset2fa':
      return {
        title: copy.twoFactor.resetTitle,
        body: copy.twoFactor.resetBody(name),
        confirm: copy.twoFactor.resetConfirm,
        pending: copy.twoFactor.resetPending,
        danger: true,
      };
    case 'reopen':
      return {
        title: copy.expired.dialogTitle,
        body: copy.expired.dialogBody(name),
        confirm: copy.expired.confirm,
        pending: copy.expired.pending,
        danger: false,
      };
    case 'unlock':
      return {
        title: copy.locked.dialogTitle,
        body: copy.locked.dialogBody(name),
        confirm: copy.locked.confirm,
        pending: copy.locked.pending,
        danger: false,
      };
    case 'revokeAll':
      return {
        title: copy.sessions.revokeAllTitle,
        body: copy.sessions.revokeAllBody(name),
        confirm: copy.sessions.revokeAllConfirm,
        pending: copy.sessions.revokeAllPending,
        danger: true,
      };
  }
}

type OnRequest = (action: PendingAction) => void;

// ── Profil ──────────────────────────────────────────────────────────────────

function twoFactorFact(user: TeamUser): string {
  const { twoFactor } = user;
  const facts = copy.facts;
  if (twoFactor.enabled) {
    return twoFactor.enabledAt
      ? facts.twoFactorSince(formatDate(twoFactor.enabledAt))
      : t.team.badges.twoFactorOn;
  }
  if (!twoFactor.required) return facts.twoFactorOff;
  if (twoFactor.enrollmentExpired) return facts.twoFactorExpired;
  if (twoFactor.enrollmentDueAt)
    return facts.twoFactorDue(formatDateTimeInline(twoFactor.enrollmentDueAt));
  return facts.twoFactorRequiredNoDue;
}

function ProfileCard({
  user,
  reason,
  onRequest,
  dailyLock,
  lockRef,
}: {
  user: TeamUser;
  reason: ReturnType<typeof viewOnlyReason>;
  onRequest: OnRequest;
  /** Kunci 2FA harian (buka kunci tidak melepasnya): aksinya atur ulang 2FA. */
  dailyLock: boolean;
  lockRef: RefObject<HTMLDivElement | null>;
}) {
  const unlockRef = useRef<HTMLButtonElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const enableRef = useRef<HTMLButtonElement>(null);
  const badges = memberBadges(user);
  const daily = dailyLock && user.twoFactor.enabled;
  return (
    <section className={styles.card} aria-labelledby="anggota-nama">
      <div className={styles.profile}>
        <Avatar name={user.name} className={styles.avatar} />
        <div className={styles.identity}>
          <h2 id="anggota-nama" className={styles.name}>
            {user.name}
          </h2>
          <p className={styles.email}>{user.email}</p>
          <p className={styles.badges}>
            <span className={styles.role}>{USER_ROLE_LABELS[user.role]}</span>
            {badges.map((badge) => (
              <StatusBadge
                key={badge.label}
                tone={badge.tone}
                label={badge.label}
                className={styles.badge}
              />
            ))}
          </p>
        </div>
      </div>
      {user.status === 'locked' && user.lockedUntil ? (
        <div ref={lockRef} tabIndex={-1} className={styles.result}>
          <Notice
            tone="warning"
            title={daily ? copy.locked.dailyTitle : copy.locked.title}
            role={daily ? 'status' : undefined}
            actions={
              !user.canManage ? undefined : daily ? (
                <Button
                  ref={resetRef}
                  variant="secondary"
                  onClick={() => onRequest({ kind: 'reset2fa', trigger: resetRef })}
                >
                  {copy.locked.dailyAction}
                </Button>
              ) : (
                <Button
                  ref={unlockRef}
                  variant="secondary"
                  onClick={() => onRequest({ kind: 'unlock', trigger: unlockRef })}
                >
                  {copy.locked.action}
                </Button>
              )
            }
          >
            {daily
              ? copy.locked.dailyBody(formatTime(user.lockedUntil))
              : copy.locked.body(formatTime(user.lockedUntil))}
          </Notice>
        </div>
      ) : null}
      {user.status === 'disabled' && user.disabledAt ? (
        <Notice
          tone="info"
          title={copy.disabledNotice.title}
          actions={
            user.canManage ? (
              <Button
                ref={enableRef}
                variant="secondary"
                onClick={() => onRequest({ kind: 'enable', trigger: enableRef })}
              >
                {copy.access.enable}
              </Button>
            ) : undefined
          }
        >
          {copy.disabledNotice.body(formatDateTimeInline(user.disabledAt))}
        </Notice>
      ) : null}
      <dl className={styles.facts}>
        <Fact label={copy.facts.joined}>{formatDate(user.createdAt)}</Fact>
        <Fact label={copy.facts.lastLogin}>
          {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : copy.facts.never}
        </Fact>
        <Fact label={copy.facts.twoFactor}>{twoFactorFact(user)}</Fact>
        <Fact label={copy.facts.email}>
          {user.emailVerified ? copy.facts.emailVerified : copy.facts.emailUnverified}
        </Fact>
      </dl>
      {reason ? (
        <Notice tone="info">
          {reason === 'self' ? (
            <>
              {copy.viewOnly.self}{' '}
              <Link to="/pengaturan/keamanan" className={styles.inlineLink}>
                {copy.viewOnly.selfLink}
              </Link>
            </>
          ) : (
            copy.viewOnly[reason]
          )}
        </Notice>
      ) : null}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt className={styles.factLabel}>{label}</dt>
      <dd className={styles.factValue}>{children}</dd>
    </div>
  );
}

// ── Peran ───────────────────────────────────────────────────────────────────

function RoleCard({ user, onRequest }: { user: TeamUser; onRequest: OnRequest }) {
  const [role, setRole] = useState<UserRole>(user.role);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const hints = t.team.invite.roleHints;
  const hint = role !== 'owner' ? hints[role] : undefined;

  if (user.assignableRoles.length === 0) return null;

  return (
    <section className={styles.card} aria-labelledby="anggota-peran">
      <div className={styles.cardHead}>
        <h2 id="anggota-peran" className={styles.cardTitle}>
          {copy.role.title}
        </h2>
        <p className={styles.hint}>{copy.role.hint}</p>
      </div>
      <form
        className={styles.roleForm}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (role === user.role || role === 'owner') {
            setError(copy.role.same);
            selectRef.current?.focus();
            return;
          }
          onRequest({ kind: 'role', role, trigger: triggerRef });
        }}
      >
        <SelectField
          ref={selectRef}
          className={styles.roleSelect}
          label={copy.role.label}
          name="role"
          value={role}
          onChange={(event) => {
            setRole(event.target.value as UserRole);
            setError(null);
          }}
          options={roleChoices(user)}
          hint={hint}
          error={error}
        />
        <div className={styles.actions}>
          {/* Biru hanya setelah peran lain dipilih: sebelum itu tombolnya belum berguna (T-S1). */}
          <Button
            ref={triggerRef}
            type="submit"
            variant={role !== user.role ? 'primary' : 'secondary'}
          >
            {copy.role.submit}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ── Verifikasi dua langkah ──────────────────────────────────────────────────

function TwoFactorCard({ user, onRequest }: { user: TeamUser; onRequest: OnRequest }) {
  const resetRef = useRef<HTMLButtonElement>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const { twoFactor } = user;
  const hint = twoFactor.enabled
    ? copy.twoFactor.hintOn
    : twoFactor.enrollmentExpired
      ? copy.twoFactor.hintExpired
      : twoFactor.required
        ? copy.twoFactor.hintRequired
        : copy.twoFactor.hintOptional;
  return (
    <section className={styles.card} aria-labelledby="anggota-2fa">
      <div className={styles.cardHead}>
        <h2 id="anggota-2fa" className={styles.cardTitle}>
          {copy.twoFactor.title}
        </h2>
        <p className={styles.hint}>{hint}</p>
      </div>
      {twoFactor.enrollmentExpired ? (
        <Notice
          tone="warning"
          title={copy.expired.title}
          actions={
            <Button
              ref={reopenRef}
              variant="secondary"
              onClick={() => onRequest({ kind: 'reopen', trigger: reopenRef })}
            >
              {copy.expired.action}
            </Button>
          }
        >
          {copy.expired.body(user.name)}
        </Notice>
      ) : null}
      {twoFactor.enabled ? (
        <div className={styles.actions}>
          <Button
            ref={resetRef}
            className={styles.dangerText}
            onClick={() => onRequest({ kind: 'reset2fa', trigger: resetRef })}
          >
            {copy.twoFactor.reset}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

// ── Sesi aktif ──────────────────────────────────────────────────────────────

function UserSessionsCard({ user, onRequest }: { user: TeamUser; onRequest: OnRequest }) {
  const queryClient = useQueryClient();
  const sessions = useQuery(userSessionsQuery(user.id));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Sesi yang ternyata sudah berakhir (404): barisnya hilang, pesannya di kartu. */
  const [gone, setGone] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const revokeAllRef = useRef<HTMLButtonElement>(null);
  const [focusHeading, setFocusHeading] = useState(0);

  useEffect(() => {
    if (focusHeading > 0) headingRef.current?.focus();
  }, [focusHeading]);

  const revoke = async (session: ActiveSession) => {
    setBusyId(session.id);
    setRowError(null);
    setNotice(null);
    setGone(null);
    try {
      await endpoints.team.revokeSession(user.id, session.id);
      queryClient.setQueryData<ActiveSessionListResponse>(queryKeys.userSessions(user.id), (old) =>
        old ? { sessions: old.sessions.filter((item) => item.id !== session.id) } : old,
      );
      // Hanya daftar (jumlah sesi); sesi pengguna ini sudah diperbarui di atas.
      void queryClient.invalidateQueries({ queryKey: queryKeys.teamUsers, exact: true });
      setNotice(t.sessions.revoked(session.device));
      setFocusHeading((tick) => tick + 1);
    } catch (caught) {
      if (isApiError(caught) && caught.status === 404) {
        // Barisnya akan hilang: pesan di kartu, fokus ke judul kartu (bukan <body>).
        void queryClient.invalidateQueries({ queryKey: queryKeys.userSessions(user.id) });
        setGone(caught.message);
        setFocusHeading((tick) => tick + 1);
        return;
      }
      setRowError({ id: session.id, message: isApiError(caught) ? caught.message : t.api.network });
    } finally {
      setBusyId(null);
    }
  };

  const list = sessions.data?.sessions;
  return (
    <section className={styles.card} aria-labelledby="anggota-sesi">
      <div className={styles.cardHead}>
        <h2 id="anggota-sesi" ref={headingRef} tabIndex={-1} className={styles.cardTitle}>
          {copy.sessions.title}
        </h2>
        <p className={styles.hint}>{copy.sessions.hint(user.name)}</p>
      </div>
      {notice ? (
        <Notice tone="success" role="status">
          {notice}
        </Notice>
      ) : null}
      {gone ? (
        <Notice tone="warning" role="alert">
          {gone}
        </Notice>
      ) : null}
      {list ? (
        list.length > 0 ? (
          <>
            <SessionList
              sessions={list}
              onRevoke={(session) => void revoke(session)}
              busyId={busyId}
              error={rowError}
            />
            <div className={styles.actions}>
              <Button
                ref={revokeAllRef}
                className={styles.dangerText}
                disabled={busyId !== null}
                onClick={() => {
                  setNotice(null);
                  setGone(null);
                  onRequest({ kind: 'revokeAll', trigger: revokeAllRef });
                }}
              >
                {copy.sessions.revokeAll}
              </Button>
            </div>
          </>
        ) : (
          <p className={styles.hint}>{copy.sessions.empty}</p>
        )
      ) : sessions.isPending ? (
        <SessionListSkeleton rows={1} />
      ) : (
        <Notice
          tone="danger"
          role="alert"
          actions={<Button onClick={() => void sessions.refetch()}>{t.common.retry}</Button>}
        >
          {isApiError(sessions.error) ? sessions.error.message : copy.sessions.loadFailed}
        </Notice>
      )}
    </section>
  );
}

// ── Akses akun ──────────────────────────────────────────────────────────────

/** Akses akun (akun aktif): nonaktifkan. Akun nonaktif diaktifkan lagi dari kotak di kartu profil. */
function AccessCard({ onRequest }: { onRequest: OnRequest }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <section className={styles.card} aria-labelledby="anggota-akses">
      <div className={styles.cardHead}>
        <h2 id="anggota-akses" className={styles.cardTitle}>
          {copy.access.title}
        </h2>
        <p className={styles.hint}>{copy.access.disableHint}</p>
      </div>
      <div className={styles.actions}>
        <Button
          ref={triggerRef}
          className={styles.dangerText}
          onClick={() => onRequest({ kind: 'disable', trigger: triggerRef })}
        >
          {copy.access.disable}
        </Button>
      </div>
    </section>
  );
}

// ── Riwayat aktivitas ───────────────────────────────────────────────────────

function ActivityCard({ user }: { user: TeamUser }) {
  const activity = useInfiniteQuery(userAuditQuery(user.id));
  const entries = activity.data?.pages.flatMap((page) => page.entries) ?? [];
  const listRef = useRef<HTMLOListElement>(null);

  /** "Muat lagi": fokus ke entri pertama yang baru (tombolnya hilang di halaman terakhir). */
  const loadMore = async () => {
    const firstNew = entries.length;
    const result = await activity.fetchNextPage();
    if (result.isError) return;
    requestAnimationFrame(() => {
      const item = listRef.current?.children.item(firstNew);
      if (item instanceof HTMLElement) item.focus();
    });
  };
  return (
    <section className={styles.card} aria-labelledby="anggota-aktivitas">
      <div className={styles.cardHead}>
        <h2 id="anggota-aktivitas" className={styles.cardTitle}>
          {copy.activity.title}
        </h2>
        <p className={styles.hint}>{copy.activity.hint}</p>
      </div>
      {activity.data ? (
        entries.length > 0 ? (
          <ol ref={listRef} className={styles.activity} aria-label={copy.activity.title}>
            {entries.map((entry) => (
              <li key={entry.id} className={styles.activityItem} tabIndex={-1}>
                <span className={styles.activityAction}>{auditActionLabel(entry.action)}</span>
                <span className={styles.activityMeta}>
                  {[
                    entry.actor
                      ? `${entry.actor.name} (${USER_ROLE_LABELS[entry.actor.role]})`
                      : t.audit.system,
                    formatDateTimeInline(entry.createdAt),
                  ].join(' · ')}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.hint}>{copy.activity.empty}</p>
        )
      ) : activity.isPending ? (
        <SessionListSkeleton rows={2} />
      ) : (
        <Notice
          tone="danger"
          role="alert"
          actions={<Button onClick={() => void activity.refetch()}>{t.common.retry}</Button>}
        >
          {isApiError(activity.error) ? activity.error.message : copy.activity.loadFailed}
        </Notice>
      )}
      {activity.data && entries.length > 0 ? (
        <div className={styles.activityFooter}>
          {activity.hasNextPage ? (
            <Button onClick={() => void loadMore()} loading={activity.isFetchingNextPage}>
              {activity.isFetchingNextPage ? t.audit.loadingMore : t.audit.loadMore}
            </Button>
          ) : (
            <span />
          )}
          {/* Satu-satunya aksi baris kaki: tombol (44 px di HP), bukan tautan sebaris (T-S3). */}
          <Button asChild variant="ghost" className={styles.footerLink}>
            <Link to="/pengaturan/audit" search={{ userId: user.id }}>
              {copy.activity.openAll}
            </Link>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
