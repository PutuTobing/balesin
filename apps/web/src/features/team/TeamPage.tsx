import {
  EMAIL_DELIVERY_LABELS,
  USER_ROLE_LABELS,
  createInvitationRequestSchema,
  type EmailDeliveryStatus,
  type Invitation,
  type InvitationIssuedResponse,
  type InvitationListResponse,
  type InvitableRole,
} from '@balesin/shared';
import { useQueryClient, useSuspenseQuery, type QueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { SelectField, TextField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { StatusBadge, type StatusTone } from '../../components/ui/StatusBadge';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { invitationsQuery, queryKeys, teamUsersQuery } from '../../lib/api/queries';
import { formatTime } from '../../lib/format';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { useLock } from '../../lib/use-lock';
import { useCan, useSession } from '../auth/session';
import { defaultInviteRole, inviteRoleOptions } from './invite-roles';
import { LinkDialog, type IssuedLink } from './LinkDialog';
import { MembersCard } from './MembersCard';
import styles from './Team.module.css';

const copy = t.team;
const INVITE_HEADING_ID = 'tim-undang';
const LIST_HEADING_ID = 'tim-undangan';

/**
 * Pengaturan → Tim (Owner & Admin): undang anggota tim, daftar undangan terbuka (menunggu,
 * kedaluwarsa, status email), kirim ulang, dan batalkan (`team.invite`); lalu daftar anggota
 * (`team.manage`) yang tiap barisnya membuka detail anggota. Urutan sengaja: form dan undangan
 * (tinggi pasti) di atas, daftar anggota yang panjangnya tak tentu di bawah — kerangka memuat
 * tidak membuat kartu lain melompat.
 *
 * Tautan undangan sekali tampil (tanpa email pengirim) TIDAK lewat `useMutation` dan tidak masuk
 * cache Query: permintaan buat/kirim ulang dipanggil langsung, hanya data undangannya yang disimpan
 * ke cache, tautannya hanya di state dialog.
 */
export function TeamPage() {
  const canInvite = useCan('team.invite');
  const canManage = useCan('team.manage');
  return (
    <Page>
      <div className={styles.content}>
        {canInvite ? <InvitationSection /> : null}
        {canManage ? <MembersSection /> : null}
      </div>
    </Page>
  );
}

function InvitationSection() {
  const { data } = useSuspenseQuery(invitationsQuery);
  return <TeamScreen data={data} />;
}

function MembersSection() {
  const { data } = useSuspenseQuery(teamUsersQuery);
  return <MembersCard users={data.users} />;
}

type ReturnFocus = () => HTMLElement | null;
/** Hasil buat/kirim ulang + ke mana fokus kembali setelah dialog tautan (bila ada) ditutup. */
type OnIssued = (response: InvitationIssuedResponse, returnTo: ReturnFocus) => void;

/** Simpan undangan yang baru dibuat/dikirim ulang ke daftar di cache (tanpa tautannya). */
function upsertInvitation(queryClient: QueryClient, invitation: Invitation): void {
  queryClient.setQueryData<InvitationListResponse>(queryKeys.invitations, (old) =>
    old
      ? {
          ...old,
          invitations: [
            invitation,
            ...old.invitations.filter(
              (item) => item.id !== invitation.id && item.email !== invitation.email,
            ),
          ],
        }
      : old,
  );
}

function TeamScreen({ data }: { data: InvitationListResponse }) {
  const queryClient = useQueryClient();
  const session = useSession();
  const canSetUpEmail = useCan('settings.email.manage');
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  // Setelah dialog tautan ditutup, fokus kembali ke asal aksinya (isian email / tombol kirim
  // ulang baris itu), bukan ke <body> (tombol kirimnya sempat nonaktif selama memproses).
  const returnFocus = useRef<ReturnFocus | null>(null);

  /** Hasil buat/kirim ulang: undangan ke cache, tautan (bila ada) HANYA ke dialog. */
  const onIssued: OnIssued = (response, returnTo) => {
    upsertInvitation(queryClient, response.invitation);
    void queryClient.invalidateQueries({ queryKey: queryKeys.invitations });
    if (response.link) {
      returnFocus.current = returnTo;
      setIssued({
        link: response.link,
        email: response.invitation.email,
        role: response.invitation.role,
      });
    }
  };

  return (
    <>
      <InviteCard
        data={data}
        canSetUpEmail={canSetUpEmail}
        actorRole={session?.user.role ?? 'cs'}
        onIssued={onIssued}
      />
      <InvitationsCard invitations={data.invitations} onIssued={onIssued} />
      <LinkDialog
        issued={issued}
        onClose={() => {
          setIssued(null);
          const target = returnFocus.current;
          requestAnimationFrame(() => target?.()?.focus());
        }}
      />
    </>
  );
}

// ── Form undangan ───────────────────────────────────────────────────────────

function InviteCard({
  data,
  canSetUpEmail,
  actorRole,
  onIssued,
}: {
  data: InvitationListResponse;
  /** Boleh membuka Pengaturan → Email pengirim (`settings.email.manage`). */
  canSetUpEmail: boolean;
  actorRole: NonNullable<ReturnType<typeof useSession>>['user']['role'];
  onIssued: OnIssued;
}) {
  const options = inviteRoleOptions(actorRole, data.invitableRoles);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InvitableRole | ''>(() => defaultInviteRole(options));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const lock = useLock();
  const formRef = useRef<HTMLFormElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  // Naik setiap isian ditolak → fokus ke isian pertama yang salah (setelah isian aktif lagi).
  const [invalidTick, setInvalidTick] = useState(0);
  const [refocusTick, setRefocusTick] = useState(0);

  useEffect(() => {
    if (invalidTick === 0) return;
    const field = formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]');
    field?.focus();
    field?.select();
  }, [invalidTick]);

  useEffect(() => {
    if (refocusTick > 0) emailRef.current?.focus();
  }, [refocusTick]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || lock.locked) return;
    const parsed = createInvitationRequestSchema.safeParse({ email, role });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      setDone(null);
      setInvalidTick((tick) => tick + 1);
      return;
    }
    setErrors({});
    setError(null);
    setDone(null);
    setPending(true);
    try {
      const response = await endpoints.invitations.create(parsed.data);
      setPending(false);
      setEmail('');
      setDone(
        response.link
          ? copy.invite.created(response.invitation.email)
          : copy.invite.sent(response.invitation.email),
      );
      onIssued(response, () => emailRef.current);
      if (!response.link) setRefocusTick((tick) => tick + 1);
    } catch (caught) {
      setPending(false);
      if (
        isApiError(caught) &&
        caught.details.some((detail) => Object.hasOwn(fieldNames, detail.field))
      ) {
        setErrors(apiFieldErrors(caught.details));
        setInvalidTick((tick) => tick + 1);
        return;
      }
      if (isApiError(caught) && caught.status === 429 && caught.retryAfterSeconds) {
        lock.lockFor(caught.retryAfterSeconds);
      }
      setError(caught);
      setRefocusTick((tick) => tick + 1);
    }
  };

  const viaEmail = data.emailDelivery;

  return (
    <section className={styles.card} aria-labelledby={INVITE_HEADING_ID}>
      <div className={styles.cardHead}>
        <h2 id={INVITE_HEADING_ID} className={styles.cardTitle}>
          {copy.invite.title}
        </h2>
        <p className={styles.cardHint}>
          {viaEmail ? copy.invite.viaEmail : copy.invite.viaLink}
          {!viaEmail && canSetUpEmail ? (
            <>
              {' '}
              <Link to="/pengaturan/email" className={styles.inlineLink}>
                {copy.invite.setUpEmail}
              </Link>
            </>
          ) : null}
        </p>
      </div>
      <form
        ref={formRef}
        className={styles.form}
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <div className={styles.inviteRow}>
          <TextField
            ref={emailRef}
            label={copy.invite.email}
            type="email"
            inputMode="email"
            name="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={copy.invite.emailPlaceholder}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setDone(null);
              if (errors.email) setErrors(({ email: _email, ...rest }) => rest);
            }}
            error={errors.email}
            disabled={pending}
          />
          <SelectField
            label={copy.invite.role}
            name="role"
            value={role}
            onChange={(event) => {
              setRole(event.target.value as InvitableRole);
              if (errors.role) setErrors(({ role: _role, ...rest }) => rest);
            }}
            options={options.map((value) => ({ value, label: USER_ROLE_LABELS[value] }))}
            error={errors.role}
            hint={role ? copy.invite.roleHints[role] : undefined}
            disabled={pending}
          />
        </div>
        <div className={styles.formFooter}>
          <SubmitButton
            size="md"
            pending={pending}
            pendingLabel={copy.invite.submitting}
            lock={lock}
            className={styles.submit}
          >
            {viaEmail ? copy.invite.submitEmail : copy.invite.submitLink}
          </SubmitButton>
        </div>
        {/* Pesan hasil di bawah tombol: isian dan tombol tidak bergeser. */}
        {error ? (
          <Notice
            tone={lock.locked ? 'warning' : 'danger'}
            role="alert"
            title={lock.locked ? copy.invite.lockedTitle : undefined}
          >
            {isApiError(error) ? error.message : t.api.network}
          </Notice>
        ) : done ? (
          <Notice tone="success" role="status">
            {done}
          </Notice>
        ) : null}
      </form>
    </section>
  );
}

/** Isian form undangan yang bisa ditandai dari detail error server. */
const fieldNames = { email: true, role: true } as const;

// ── Daftar undangan ─────────────────────────────────────────────────────────

const DELIVERY_TONE: Record<EmailDeliveryStatus, StatusTone> = {
  queued: 'neutral',
  sent: 'success',
  failed: 'danger',
  skipped: 'warning',
  link: 'neutral',
};

type RowAction = 'resend' | 'revoke';

function InvitationsCard({
  invitations,
  onIssued,
}: {
  invitations: Invitation[];
  onIssued: OnIssued;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<{ id: string; action: RowAction } | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [focusHeading, setFocusHeading] = useState(0);

  useEffect(() => {
    if (focusHeading > 0) headingRef.current?.focus();
  }, [focusHeading]);

  const fail = (invitation: Invitation, caught: unknown) => {
    setRowError({
      id: invitation.id,
      message: isApiError(caught) ? caught.message : t.api.network,
    });
    // Undangan sudah diterima/dibatalkan di tempat lain, atau baru saja berubah: muat ulang.
    if (isApiError(caught) && (caught.status === 404 || caught.status === 409)) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.invitations });
    }
  };

  const resend = async (invitation: Invitation) => {
    setBusy({ id: invitation.id, action: 'resend' });
    setRowError(null);
    setNotice(null);
    try {
      const response = await endpoints.invitations.resend(invitation.id);
      setNotice(
        response.link ? copy.list.reissued(invitation.email) : copy.list.resent(invitation.email),
      );
      onIssued(response, () => document.getElementById(resendButtonId(invitation.id)));
    } catch (caught) {
      fail(invitation, caught);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (invitation: Invitation) => {
    setRevoking(null);
    setBusy({ id: invitation.id, action: 'revoke' });
    setRowError(null);
    setNotice(null);
    try {
      await endpoints.invitations.revoke(invitation.id);
      queryClient.setQueryData<InvitationListResponse>(queryKeys.invitations, (old) =>
        old
          ? { ...old, invitations: old.invitations.filter((item) => item.id !== invitation.id) }
          : old,
      );
      setNotice(copy.list.revoked(invitation.email));
      // Barisnya hilang: fokus ke judul daftar (bukan <body>).
      setFocusHeading((tick) => tick + 1);
    } catch (caught) {
      fail(invitation, caught);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={styles.card} aria-labelledby={LIST_HEADING_ID}>
      <div className={styles.cardHead}>
        <h2 id={LIST_HEADING_ID} ref={headingRef} tabIndex={-1} className={styles.cardTitle}>
          {copy.list.title}
          {invitations.length > 0 ? (
            <span className={styles.count}>{invitations.length}</span>
          ) : null}
        </h2>
        {invitations.length > 0 ? <p className={styles.cardHint}>{copy.list.hint}</p> : null}
      </div>
      {notice ? (
        <Notice tone="success" role="status">
          {notice}
        </Notice>
      ) : null}
      {invitations.length === 0 ? (
        <EmptyState
          compact
          align="top"
          headingLevel={3}
          title={copy.list.emptyTitle}
          body={copy.list.emptyBody}
          className={styles.empty}
        />
      ) : (
        <ul className={styles.list}>
          {invitations.map((invitation) => (
            <InvitationRow
              key={invitation.id}
              invitation={invitation}
              busy={busy?.id === invitation.id ? busy.action : null}
              anyBusy={busy !== null}
              error={rowError?.id === invitation.id ? rowError.message : null}
              onResend={() => void resend(invitation)}
              onRevoke={() => setRevoking(invitation)}
            />
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={revoking !== null}
        title={copy.list.revokeTitle}
        body={revoking ? copy.list.revokeBody(revoking.email) : ''}
        cancelLabel={copy.list.keep}
        confirmLabel={copy.list.revokeConfirm}
        confirmVariant="danger"
        onCancel={() => {
          const target = revoking;
          setRevoking(null);
          // Batal → fokus kembali ke tombol "Batalkan" baris itu.
          if (target) {
            requestAnimationFrame(() =>
              document.getElementById(revokeButtonId(target.id))?.focus(),
            );
          }
        }}
        onConfirm={() => {
          if (revoking) void revoke(revoking);
        }}
      />
    </section>
  );
}

const revokeButtonId = (id: string) => `batalkan-${id}`;
const resendButtonId = (id: string) => `kirim-ulang-${id}`;

function InvitationRow({
  invitation,
  busy,
  anyBusy,
  error,
  onResend,
  onRevoke,
}: {
  invitation: Invitation;
  busy: RowAction | null;
  anyBusy: boolean;
  error: string | null;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const expired = invitation.status === 'expired';
  const delivery = invitation.deliveryStatus;
  const hint =
    delivery === 'failed' || delivery === 'skipped' ? copy.list.deliveryHint[delivery] : null;

  return (
    <li className={styles.row} aria-label={copy.list.actionsFor(invitation.email)}>
      <div className={styles.rowMain}>
        <p className={styles.rowEmail}>{invitation.email}</p>
        <p className={styles.rowMeta}>
          <span className={styles.role}>{USER_ROLE_LABELS[invitation.role]}</span>
          <span className={styles.separator} aria-hidden="true">
            ·
          </span>
          {expired ? (
            <StatusBadge tone="warning" label={copy.list.expired} className={styles.badge} />
          ) : (
            <StatusBadge
              tone={DELIVERY_TONE[delivery]}
              label={EMAIL_DELIVERY_LABELS[delivery]}
              className={styles.badge}
            />
          )}
        </p>
        <p className={styles.rowDetail}>
          {/* Pemisah ikut bagian pertama: baris kedua tidak diawali "·". */}
          <span className={styles.segment}>
            {copy.list.invitedBy(invitation.invitedBy.name)}
            <span className={styles.separator} aria-hidden="true">
              {' ·'}
            </span>
            <span className="sr-only">.</span>
          </span>{' '}
          <span className={styles.segment}>
            {expired
              ? copy.list.expiredAt(formatTime(invitation.expiresAt))
              : copy.list.expiresAt(formatTime(invitation.expiresAt))}
          </span>
        </p>
        {hint && !expired ? <p className={styles.rowHint}>{hint}</p> : null}
        {!invitation.canManage ? (
          <p className={styles.rowHint}>{copy.list.managedByOwner}</p>
        ) : null}
      </div>
      {invitation.canManage ? (
        <div className={styles.rowActions}>
          <Button
            id={resendButtonId(invitation.id)}
            variant={expired ? 'primary' : 'secondary'}
            onClick={onResend}
            loading={busy === 'resend'}
            disabled={anyBusy}
          >
            {busy === 'resend' ? copy.list.resending : copy.list.resend}
          </Button>
          <Button
            id={revokeButtonId(invitation.id)}
            variant="ghost"
            className={styles.revoke}
            onClick={onRevoke}
            loading={busy === 'revoke'}
            disabled={anyBusy}
          >
            {copy.list.revoke}
          </Button>
        </div>
      ) : null}
      {error ? (
        <Notice tone="danger" role="alert" className={styles.rowError}>
          {error}
        </Notice>
      ) : null}
    </li>
  );
}
