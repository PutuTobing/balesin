import {
  MAIL_PERIODIC_SYNC_MINUTES,
  updateMailAccountRequestSchema,
  type IdentityConfirmation,
  type MailAccount,
  type MailAccountColor,
  type TestMailAccountResponse,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { Inbox, Lock, Pause, Play, PlugZap, RefreshCw, Send, UsersRound } from 'lucide-react';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  LoadFailedIllustration,
  NotFoundIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { SelectField, TextField } from '../../components/ui/Field';
import { FormActions } from '../../components/ui/FormActions';
import { Icon } from '../../components/ui/Icon';
import { Notice, type NoticeTone } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTime } from '../../lib/format';
import { zodFieldErrors, type FieldErrors } from '../../lib/form';
import { useCan, useSession } from '../auth/session';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { AccountMark } from './AccountMark';
import { AvatarPicker } from './AvatarPicker';
import { EditServerDialog } from './EditServerDialog';
import { MailAccessCard } from './MailAccessCard';
import { ColorPicker } from './MailControls';
import { TestResults } from './TestResults';
import {
  PROVIDER_ICONS,
  WINDOW_OPTIONS,
  formatBytes,
  needsAttention,
  parseWindow,
  syncErrorMessage,
  syncStateLabel,
  syncTone,
  syncedAt,
  windowValue,
} from './mail-format';
import {
  mailAccountQuery,
  refreshMailAccounts,
  setAccountsFlash,
  storeMailAccount,
  useRequireCode,
} from './mail-queries';
import { testPassed } from './wizard-state';
import { useMailStream } from './use-mail-stream';
import styles from './MailAccounts.module.css';

const m = t.mail;
const d = t.mail.detail;
const c = t.mail.accounts;
const routeApi = getRouteApi('/_app/pengaturan/akun-email/$accountId');

/**
 * Pengaturan → Akun email → satu akun: status sinkron & aksi, tampilan & sinkron, foto, server &
 * password, akses (akun bersama), putuskan. Akun pribadi orang lain = 404 (hanya metadata di
 * daftar).
 */
export function MailAccountPage() {
  useMailStream();
  const { accountId } = routeApi.useParams();
  const account = useQuery(mailAccountQuery(accountId));
  return (
    <Page title={account.data?.account.displayName}>
      {account.data ? (
        <AccountScreen key={account.data.account.id} account={account.data.account} />
      ) : account.isPending ? (
        <SkeletonRegion className={styles.content}>
          <div className={styles.card}>
            <Skeleton className={styles.skeletonName} />
            <Skeleton className={styles.skeletonAddress} />
            <Skeleton className={styles.skeletonField} />
          </div>
          <div className={styles.card}>
            <Skeleton className={styles.skeletonField} />
            <Skeleton className={styles.skeletonField} />
          </div>
        </SkeletonRegion>
      ) : isApiError(account.error) && account.error.status === 404 ? (
        <EmptyState
          column
          illustration={<NotFoundIllustration />}
          title={d.notFoundTitle}
          body={d.notFoundBody}
          actions={
            <Button variant="primary" asChild>
              <Link to="/pengaturan/akun-email">{d.backToList}</Link>
            </Button>
          }
        />
      ) : (
        <EmptyState
          column
          illustration={<LoadFailedIllustration />}
          title={d.loadFailedTitle}
          body={isApiError(account.error) ? account.error.message : t.api.network}
          actions={
            <Button variant="primary" onClick={() => void account.refetch()}>
              {t.common.retry}
            </Button>
          }
        />
      )}
    </Page>
  );
}

interface Flash {
  tone: NoticeTone;
  text: string;
}

function AccountScreen({ account }: { account: MailAccount }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const session = useSession();
  const canManageShared = useCan('mail.accounts.manage');
  const requireCode = useRequireCode();
  const manage = account.myLevel === 'manage';
  /** Boleh mengubah server/kredensial/putuskan: bersama = Owner/Admin; pribadi = pemiliknya. */
  const administer =
    account.kind === 'shared' ? canManageShared : account.owner?.id === session?.user.id;
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busy, setBusy] = useState<'sync' | 'pause' | 'resume' | 'test' | null>(null);
  const [test, setTest] = useState<TestMailAccountResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const editRef = useRef<HTMLButtonElement>(null);
  const disconnectRef = useRef<HTMLButtonElement>(null);

  const run = async (action: 'sync' | 'pause' | 'resume' | 'test') => {
    setBusy(action);
    setFlash(null);
    try {
      if (action === 'sync') {
        await endpoints.mail.sync(account.id);
        setFlash({ tone: 'success', text: c.done.syncQueued(account.displayName) });
      } else if (action === 'test') {
        const result = await endpoints.mail.testSaved(account.id);
        setTest(result);
        void queryClient.invalidateQueries({ queryKey: ['mail', 'account', account.id] });
        setFlash(
          testPassed(result)
            ? { tone: 'success', text: d.testDoneOk }
            : { tone: 'danger', text: d.testDoneFailed },
        );
      } else {
        const response =
          action === 'pause'
            ? await endpoints.mail.pause(account.id)
            : await endpoints.mail.resume(account.id);
        storeMailAccount(queryClient, response.account);
        setFlash({
          tone: 'success',
          text:
            action === 'pause'
              ? c.done.paused(account.displayName)
              : c.done.resumed(account.displayName),
        });
      }
    } catch (caught) {
      setFlash({ tone: 'danger', text: isApiError(caught) ? caught.message : t.api.network });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (confirmation: IdentityConfirmation) => {
    try {
      await endpoints.mail.remove(account.id, confirmation);
      setDisconnecting(false);
      refreshMailAccounts(queryClient);
      setAccountsFlash(c.done.disconnected(account.displayName));
      void navigate({ to: '/pengaturan/akun-email', replace: true });
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setDisconnecting(false);
      setFlash({ tone: 'danger', text: isApiError(caught) ? caught.message : t.api.network });
    }
  };

  const state = account.sync.state;
  const error = needsAttention(state)
    ? state === 'owner_inactive'
      ? m.ownerInactiveHint
      : syncErrorMessage(account.sync.lastErrorCode, account.sync.lastErrorMessage)
    : null;
  const ProviderIcon = PROVIDER_ICONS[account.provider];
  const personal = account.kind === 'personal';

  return (
    <div className={styles.content}>
      <section className={styles.card} aria-labelledby="akun-email-ringkasan">
        <div className={styles.summary}>
          <AccountMark account={account} variant="avatar" size="lg" />
          <div className={styles.summaryText}>
            <h2 id="akun-email-ringkasan" className={styles.summaryName}>
              {account.displayName}
            </h2>
            <div className={styles.summaryMeta}>
              <span>{account.emailAddress}</span>
              <span className={styles.summaryMetaItem}>
                <Icon icon={ProviderIcon} size={16} />
                {m.providers[account.provider]}
              </span>
              <span className={styles.summaryMetaItem}>
                <Icon icon={personal ? Lock : UsersRound} size={16} />
                {personal ? c.personalMine : c.sharedManaged}
              </span>
            </div>
          </div>
          <StatusBadge tone={syncTone(state)} label={syncStateLabel(state)} />
        </div>
        {flash ? (
          <Notice tone={flash.tone} role={flash.tone === 'danger' ? 'alert' : 'status'}>
            {flash.text}
          </Notice>
        ) : null}
        {error ? (
          <Notice
            tone={state === 'auth_failed' ? 'danger' : 'warning'}
            title={syncStateLabel(state)}
          >
            <p>{error}</p>
            {account.sync.nextAttemptAt && state === 'error' ? (
              <p>{m.retryAt(formatDateTime(account.sync.nextAttemptAt))}</p>
            ) : null}
            {state === 'auth_failed' && administer ? <p>{m.authFailedHint}</p> : null}
          </Notice>
        ) : state === 'paused' ? (
          <Notice tone="info">{m.pausedHint}</Notice>
        ) : null}
        <dl className={styles.facts}>
          <Fact label={d.lastSynced}>{syncedAt(account.sync.lastSyncedAt)}</Fact>
          <Fact label={d.messages}>
            {state === 'initial_sync' && account.sync.initialProgress
              ? m.initialProgress(
                  account.sync.initialProgress.done,
                  account.sync.initialProgress.total,
                )
              : `${account.stats.messageCount.toLocaleString('id-ID')} · ${m.unreadLabel(account.stats.unreadCount)}`}
          </Fact>
          <Fact label={account.stats.quota ? d.quota : d.lastTest}>
            {account.stats.quota
              ? `${formatBytes(account.stats.quota.usedBytes)} / ${formatBytes(account.stats.quota.limitBytes)}`
              : account.sync.lastTest
                ? `${account.sync.lastTest.incomingOk && account.sync.lastTest.outgoingOk ? d.lastTestOk : d.lastTestFailed} · ${formatDateTime(account.sync.lastTest.testedAt)}`
                : d.never}
          </Fact>
        </dl>
        {manage ? (
          <div className={styles.summaryActions}>
            {state === 'paused' ? (
              <Button loading={busy === 'resume'} onClick={() => void run('resume')}>
                <Icon icon={Play} size={16} />
                {c.resume}
              </Button>
            ) : (
              <>
                <Button
                  loading={busy === 'sync'}
                  disabled={busy !== null || state === 'owner_inactive' || state === 'deleting'}
                  onClick={() => void run('sync')}
                >
                  <Icon icon={RefreshCw} size={16} />
                  {c.syncNow}
                </Button>
                <Button
                  loading={busy === 'pause'}
                  disabled={busy !== null || state === 'owner_inactive' || state === 'deleting'}
                  onClick={() => void run('pause')}
                >
                  <Icon icon={Pause} size={16} />
                  {c.pause}
                </Button>
              </>
            )}
            <Button
              loading={busy === 'test'}
              disabled={busy !== null && busy !== 'test'}
              onClick={() => void run('test')}
            >
              <Icon icon={PlugZap} size={16} />
              {busy === 'test' ? d.testing : d.testNow}
            </Button>
          </div>
        ) : null}
        {test ? (
          <TestResults result={test} pending={false} emailAddress={account.emailAddress} />
        ) : null}
      </section>

      <SettingsCard account={account} readOnly={!manage} />

      {manage ? <PhotoCard account={account} /> : null}

      {account.imap && account.smtp && administer ? (
        <section className={styles.card} aria-labelledby="akun-email-server" id="server">
          <div className={styles.cardHeadRow}>
            <div className={styles.cardHead}>
              <h2 id="akun-email-server" className={styles.cardTitle}>
                {d.serverTitle}
              </h2>
              <p className={styles.cardHint}>{d.serverHint}</p>
            </div>
          </div>
          <dl className={styles.serverList}>
            <ServerItem
              icon={Inbox}
              label={d.incoming}
              host={account.imap.host}
              meta={`${account.imap.port} · ${m.wizard.securityLabels[account.imap.security] ?? ''} · ${account.imap.username ?? ''}`}
              password={account.imap.password}
            />
            <ServerItem
              icon={Send}
              label={d.outgoing}
              host={account.smtp.host}
              meta={`${account.smtp.port} · ${m.wizard.securityLabels[account.smtp.security] ?? ''}`}
              password={account.smtp.sameCredentials ? null : account.smtp.password}
              note={account.smtp.sameCredentials ? d.sameCredentials : undefined}
            />
          </dl>
          <div>
            <Button ref={editRef} onClick={() => setEditing(true)}>
              {d.editServer}
            </Button>
          </div>
        </section>
      ) : null}

      {account.kind === 'shared' && (manage || canManageShared) ? (
        <MailAccessCard accountId={account.id} />
      ) : null}

      {administer ? (
        <FormActions
          danger={
            <Button
              ref={disconnectRef}
              variant="danger"
              disabled={state === 'deleting'}
              onClick={() => setDisconnecting(true)}
            >
              {c.disconnect}
            </Button>
          }
          meta={d.dangerHint}
        >
          {null}
        </FormActions>
      ) : null}

      {editing ? (
        <EditServerDialog
          account={account}
          onClose={() => {
            setEditing(false);
            requestAnimationFrame(() => editRef.current?.focus());
          }}
          onSaved={(saved) => {
            storeMailAccount(queryClient, saved);
            setEditing(false);
            setFlash({ tone: 'success', text: d.serverSaved });
          }}
        />
      ) : null}
      <IdentityDialog
        open={disconnecting}
        title={c.disconnectTitle(account.displayName)}
        body={c.disconnectBody}
        confirmLabel={c.disconnectConfirm}
        pendingLabel={c.disconnecting}
        variant="danger"
        requireCode={requireCode}
        returnFocusRef={disconnectRef}
        onCancel={() => setDisconnecting(false)}
        onConfirm={disconnect}
      />
    </div>
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

function ServerItem({
  icon,
  label,
  host,
  meta,
  password,
  note,
}: {
  icon: typeof Inbox;
  label: string;
  host: string;
  meta: string;
  password: string | null;
  note?: string;
}) {
  return (
    <div className={styles.serverItem}>
      <dt className={styles.summaryMetaItem}>
        <Icon icon={icon} size={16} />
        <span className={styles.factLabel}>{label}</span>
      </dt>
      <dd className={styles.serverHost}>{host}</dd>
      <dd className={styles.serverMeta}>{meta}</dd>
      {password ? <dd className={styles.serverMeta}>{d.passwordSaved(password)}</dd> : null}
      {note ? <dd className={styles.serverMeta}>{note}</dd> : null}
    </div>
  );
}

/** Nama, nama pengirim, warna, jendela & selang sinkron (level Kelola; tanpa konfirmasi). */
function SettingsCard({ account, readOnly }: { account: MailAccount; readOnly: boolean }) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(account.displayName);
  const [fromName, setFromName] = useState(account.fromName);
  const [color, setColor] = useState<MailAccountColor>(account.color);
  const [syncWindow, setSyncWindow] = useState(windowValue(account.syncWindowDays));
  const [intervalMinutes, setIntervalMinutes] = useState(String(account.periodicSyncMinutes));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<'saved' | { error: unknown } | null>(null);
  const changes = {
    ...(displayName !== account.displayName ? { displayName } : {}),
    ...(fromName !== account.fromName ? { fromName } : {}),
    ...(color !== account.color ? { color } : {}),
    ...(syncWindow !== windowValue(account.syncWindowDays)
      ? { syncWindowDays: parseWindow(syncWindow) }
      : {}),
    ...(intervalMinutes.trim() !== String(account.periodicSyncMinutes)
      ? {
          periodicSyncMinutes: /^\d+$/.test(intervalMinutes.trim())
            ? Number(intervalMinutes.trim())
            : Number.NaN,
        }
      : {}),
  };
  const dirty = Object.keys(changes).length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    setResult(null);
    const parsed = updateMailAccountRequestSchema.safeParse(changes);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const { account: saved } = await endpoints.mail.update(account.id, parsed.data);
      storeMailAccount(queryClient, saved);
      setResult('saved');
    } catch (caught) {
      setResult({ error: caught });
    } finally {
      setPending(false);
    }
  };

  const touch = () => setResult(null);

  return (
    <section className={styles.card} aria-labelledby="akun-email-tampilan">
      <div className={styles.cardHead}>
        <h2 id="akun-email-tampilan" className={styles.cardTitle}>
          {d.settingsTitle}
        </h2>
        <p className={styles.cardHint}>{readOnly ? d.readOnly : d.settingsHint}</p>
      </div>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <fieldset className={styles.fieldset} disabled={readOnly || pending}>
          <div className={styles.formRow}>
            <TextField
              label={m.wizard.displayName}
              hint={m.wizard.displayNameHint}
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
                touch();
              }}
              error={errors.displayName}
              maxLength={60}
            />
            <TextField
              label={m.wizard.fromName}
              hint={m.wizard.fromNameHint}
              value={fromName}
              onChange={(event) => {
                setFromName(event.target.value);
                touch();
              }}
              error={errors.fromName}
              maxLength={80}
            />
          </div>
          <ColorPicker
            label={m.wizard.colorLabel}
            hint={m.wizard.colorHint}
            value={color}
            onChange={(next) => {
              setColor(next);
              touch();
            }}
          />
          <div className={styles.formRow}>
            <SelectField
              label={m.wizard.windowLabel}
              hint={m.wizard.windowHint}
              value={syncWindow}
              onChange={(event) => {
                setSyncWindow(event.target.value);
                touch();
              }}
              options={WINDOW_OPTIONS}
            />
            <TextField
              label={d.interval}
              hint={d.intervalHint}
              value={intervalMinutes}
              onChange={(event) => {
                setIntervalMinutes(event.target.value);
                touch();
              }}
              error={errors.periodicSyncMinutes}
              inputMode="numeric"
              maxLength={2}
              min={MAIL_PERIODIC_SYNC_MINUTES.min}
              max={MAIL_PERIODIC_SYNC_MINUTES.max}
              trailing={<span className={styles.unit}>{d.minutes}</span>}
            />
          </div>
        </fieldset>
        {result === 'saved' ? (
          <Notice tone="success" role="status">
            {d.saved}
          </Notice>
        ) : result ? (
          <Notice tone="danger" role="alert">
            {isApiError(result.error) ? result.error.message : t.api.network}
          </Notice>
        ) : null}
        {readOnly ? null : (
          <FormActions>
            <Button type="submit" variant="primary" loading={pending} disabled={!dirty}>
              {pending ? d.saving : d.save}
            </Button>
          </FormActions>
        )}
      </form>
    </section>
  );
}

/** Foto/logo akun: langsung diunggah (`PUT …/avatar`) atau dihapus. */
function PhotoCard({ account }: { account: MailAccount }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const apply = (avatarUrl: string | null) =>
    storeMailAccount(queryClient, { ...account, avatarUrl });

  return (
    <section className={styles.card}>
      <AvatarPicker
        label={d.photoTitle}
        labelAsTitle
        hint={d.photoHint}
        displayName={account.displayName}
        color={account.color}
        value={account.avatarUrl}
        disabled={pending}
        onPick={(draft) => {
          setPending(true);
          setResult(null);
          const request = draft
            ? endpoints.mail.setAvatar(account.id, draft.base64)
            : endpoints.mail.removeAvatar(account.id);
          request
            .then((response) => {
              apply(response.avatarUrl);
              setResult({ tone: 'success', text: draft ? d.photoSaved : d.photoRemoved });
            })
            .catch((caught: unknown) =>
              setResult({
                tone: 'danger',
                text: isApiError(caught) ? caught.message : t.api.network,
              }),
            )
            .finally(() => setPending(false));
        }}
      />
      {result ? (
        <Notice tone={result.tone} role={result.tone === 'danger' ? 'alert' : 'status'}>
          {result.text}
        </Notice>
      ) : null}
    </section>
  );
}
