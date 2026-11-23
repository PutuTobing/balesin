import {
  MAIL_CACHE_RETENTION_DAYS,
  mailSettingsSchema,
  type IdentityConfirmation,
  type MailAccount,
  type MailSettings,
  type MailSettingsAccountListResponse,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { DropdownMenu } from 'radix-ui';
import { Ellipsis, Lock, Plus, UsersRound } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  LoadFailedIllustration,
  MailboxIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { CreateButton } from '../../components/ui/CreateButton';
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
import { zodFieldErrors, type FieldErrors } from '../../lib/form';
import { useSession } from '../auth/session';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { AccountMark } from './AccountMark';
import { AddAccountWizard } from './AddAccountWizard';
import {
  PROVIDER_ICONS,
  WINDOW_OPTIONS,
  parseWindow,
  relativeTime,
  syncStateLabel,
  syncTone,
  windowValue,
} from './mail-format';
import {
  mailKeys,
  mailSettingsAccountsQuery,
  mailSettingsQuery,
  refreshMailAccounts,
  storeMailAccount,
  clearAccountsFlash,
  peekAccountsFlash,
  useRequireCode,
} from './mail-queries';
import { useMailStream } from './use-mail-stream';
import styles from './MailAccounts.module.css';

const m = t.mail;
const c = t.mail.accounts;
const routeApi = getRouteApi('/_app/pengaturan/akun-email');

interface Flash {
  tone: NoticeTone;
  lines: string[];
}

/**
 * Pengaturan → Akun email (PRD §4.1): daftar akun (status sinkron, terakhir sinkron, galat) dengan
 * aksi Sinkron sekarang / Jeda / Lanjutkan / Putuskan, wizard hubungkan akun (`?tambah=`), dan —
 * untuk `mail.accounts.manage` — pengaturan retensi & jendela sinkron bawaan.
 */
export function MailAccountsPage() {
  useMailStream();
  const search = routeApi.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const list = useQuery(mailSettingsAccountsQuery);
  const [flash, setFlash] = useState<Flash | null>(() => {
    const message = peekAccountsFlash();
    return message ? { tone: 'success', lines: [message] } : null;
  });
  const flashRef = useRef<HTMLDivElement>(null);
  useEffect(() => clearAccountsFlash(), []);
  const data = list.data;
  const canConnect = data ? data.canConnectPersonal || data.canManageShared : false;

  const showFlash = (next: Flash) => {
    setFlash(next);
    requestAnimationFrame(() => flashRef.current?.focus());
  };
  const openWizard = () =>
    void navigate({ to: '/pengaturan/akun-email', search: { tambah: 'baru' } });
  const closeWizard = () =>
    void navigate({ to: '/pengaturan/akun-email', search: {}, replace: true });

  const created = (account: MailAccount, warning: string | null) => {
    refreshMailAccounts(queryClient);
    closeWizard();
    showFlash(
      warning
        ? { tone: 'warning', lines: [c.done.created(account.displayName), warning] }
        : { tone: 'success', lines: [c.done.created(account.displayName)] },
    );
  };

  return (
    <Page
      actions={
        data && data.accounts.length > 0 && canConnect ? (
          <CreateButton label={c.connect} shortLabel={c.connectShort} onClick={openWizard} />
        ) : undefined
      }
    >
      <div className={styles.content}>
        <p className={styles.intro}>{c.intro}</p>
        {flash ? (
          <div ref={flashRef} tabIndex={-1} className={styles.flash}>
            <Notice tone={flash.tone} role="status">
              {flash.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </Notice>
          </div>
        ) : null}
        {data ? (
          data.accounts.length === 0 ? (
            <EmptyState
              column
              illustration={<MailboxIllustration />}
              title={c.emptyTitle}
              body={
                data.canManageShared
                  ? c.emptyBody
                  : data.canConnectPersonal
                    ? c.emptyBodyPersonal
                    : c.emptyBodyNone
              }
              actions={
                canConnect ? (
                  <Button variant="primary" onClick={openWizard}>
                    <Icon icon={Plus} size={16} />
                    {c.connect}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <AccountsCard data={data} onFlash={showFlash} />
          )
        ) : list.isPending ? (
          <AccountsSkeleton />
        ) : (
          <EmptyState
            column
            illustration={<LoadFailedIllustration />}
            title={c.loadFailedTitle}
            body={isApiError(list.error) ? list.error.message : t.api.network}
            actions={
              <Button variant="primary" onClick={() => void list.refetch()}>
                {t.common.retry}
              </Button>
            }
          />
        )}
        {data?.canManageShared ? <MailSettingsCard /> : null}
      </div>
      {search.tambah && data && canConnect ? (
        <AddAccountWizard
          initialProvider={search.tambah === 'baru' ? null : search.tambah}
          canShared={data.canManageShared}
          canPersonal={data.canConnectPersonal}
          onClose={closeWizard}
          onCreated={created}
        />
      ) : null}
    </Page>
  );
}

function AccountsSkeleton() {
  return (
    <section className={styles.card} aria-label={c.listTitle}>
      <SkeletonRegion className={styles.skeleton}>
        {[0, 1, 2].map((key) => (
          <div key={key} className={styles.skeletonRow}>
            <Skeleton className={styles.skeletonDot} />
            <div className={styles.skeletonLines}>
              <Skeleton className={styles.skeletonName} />
              <Skeleton className={styles.skeletonAddress} />
            </div>
            <Skeleton className={styles.skeletonStatus} />
          </div>
        ))}
      </SkeletonRegion>
    </section>
  );
}

type AnyAccount = MailSettingsAccountListResponse['accounts'][number];

function AccountsCard({
  data,
  onFlash,
}: {
  data: MailSettingsAccountListResponse;
  onFlash: (flash: Flash) => void;
}) {
  const queryClient = useQueryClient();
  const session = useSession();
  const [disconnecting, setDisconnecting] = useState<AnyAccount | null>(null);
  const menuRefs = useRef(new Map<string, HTMLButtonElement | null>());
  /** Tombol menu akun yang sedang diputus: fokus kembali ke sana bila dibatalkan. */
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const myId = session?.user.id;
  const requireCode = useRequireCode();
  // Bersama dulu, lalu pribadi milikku, lalu metadata pribadi orang lain.
  const accounts = [...data.accounts].sort((a, b) => rank(a, myId) - rank(b, myId));

  const run = async (account: MailAccount, action: 'sync' | 'pause' | 'resume') => {
    try {
      if (action === 'sync') {
        await endpoints.mail.sync(account.id);
        void queryClient.invalidateQueries({ queryKey: mailKeys.account(account.id) });
        onFlash({ tone: 'success', lines: [c.done.syncQueued(account.displayName)] });
      } else {
        const response =
          action === 'pause'
            ? await endpoints.mail.pause(account.id)
            : await endpoints.mail.resume(account.id);
        storeMailAccount(queryClient, response.account);
        onFlash({
          tone: 'success',
          lines: [
            action === 'pause'
              ? c.done.paused(account.displayName)
              : c.done.resumed(account.displayName),
          ],
        });
      }
    } catch (caught) {
      onFlash({
        tone: 'danger',
        lines: [isApiError(caught) ? caught.message : t.api.network],
      });
    }
  };

  const disconnect = async (confirmation: IdentityConfirmation) => {
    if (!disconnecting) return;
    try {
      await endpoints.mail.remove(disconnecting.id, confirmation);
      const name = disconnecting.displayName;
      setDisconnecting(null);
      refreshMailAccounts(queryClient);
      onFlash({ tone: 'success', lines: [c.done.disconnected(name)] });
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setDisconnecting(null);
      onFlash({ tone: 'danger', lines: [isApiError(caught) ? caught.message : t.api.network] });
    }
  };

  return (
    <section className={styles.card} aria-labelledby="akun-email-daftar">
      <h2 id="akun-email-daftar" className="sr-only">
        {c.listTitle}
      </h2>
      <div className={styles.tableHead} aria-hidden="true">
        <span>{c.columns.account}</span>
        <span>{c.columns.provider}</span>
        <span>{c.columns.kind}</span>
        <span>{c.columns.status}</span>
        <span />
      </div>
      <ul className={styles.rows}>
        {accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            myId={myId}
            canManageShared={data.canManageShared}
            menuRef={(element) => menuRefs.current.set(account.id, element)}
            onRun={(full, action) => void run(full, action)}
            onDisconnect={() => {
              returnFocusRef.current = menuRefs.current.get(account.id) ?? null;
              setDisconnecting(account);
            }}
          />
        ))}
      </ul>
      <IdentityDialog
        open={disconnecting !== null}
        title={c.disconnectTitle(disconnecting?.displayName ?? '')}
        body={c.disconnectBody}
        confirmLabel={c.disconnectConfirm}
        pendingLabel={c.disconnecting}
        variant="danger"
        requireCode={requireCode}
        returnFocusRef={returnFocusRef}
        onCancel={() => setDisconnecting(null)}
        onConfirm={disconnect}
      />
    </section>
  );
}

function rank(account: AnyAccount, myId: string | undefined): number {
  if (account.kind === 'shared') return 0;
  if (!account.redacted && account.owner?.id === myId) return 1;
  return 2;
}

/** Jenis akun untuk kolom "Jenis". */
function kindLabel(account: AnyAccount, myId: string | undefined, canManageShared: boolean) {
  if (account.redacted) {
    return `${c.personalOf(account.owner.name)}${account.owner.active ? '' : ` (${c.ownerInactiveTag})`}`;
  }
  if (account.kind === 'personal') {
    return account.owner?.id === myId ? c.personalMine : c.personalOf(account.owner?.name ?? '');
  }
  if (canManageShared || !account.myLevel) return c.sharedManaged;
  return c.sharedLevel(m.levels[account.myLevel] ?? account.myLevel);
}

/**
 * Satu baris keterangan di bawah lencana status. Galat (`auth_failed`/`error`) sengaja tanpa pesan
 * lengkap — lencana + tautan ke halaman akun cukup, pesannya di sana (review 9A P5: pesan panjang
 * membuat baris dua kali lebih tinggi).
 */
function statusDetail(account: AnyAccount): string | null {
  const { sync } = account;
  const progress = account.redacted ? null : account.sync.initialProgress;
  if (sync.state === 'initial_sync' && progress) {
    return m.initialProgress(progress.done, progress.total);
  }
  if (sync.state === 'paused') return m.pausedHint;
  if (sync.state === 'owner_inactive') return m.ownerInactiveHint;
  if (sync.state === 'auth_failed' || sync.state === 'error') return null;
  if (!sync.lastSyncedAt) return null;
  const when = relativeTime(sync.lastSyncedAt);
  // "Terakhir baru saja" janggal: cukup "Baru saja".
  return when === m.time.justNow ? m.lastSyncJustNow : m.lastSyncLine(when);
}

function AccountRow({
  account,
  myId,
  canManageShared,
  menuRef,
  onRun,
  onDisconnect,
}: {
  account: AnyAccount;
  myId: string | undefined;
  canManageShared: boolean;
  menuRef: (element: HTMLButtonElement | null) => void;
  onRun: (account: MailAccount, action: 'sync' | 'pause' | 'resume') => void;
  onDisconnect: () => void;
}) {
  const full: MailAccount | null = account.redacted ? null : account;
  const manage = full?.myLevel === 'manage';
  const ownsPersonal = full?.kind === 'personal' && full.owner?.id === myId;
  const canDisconnect = account.redacted
    ? canManageShared && !account.owner.active
    : full?.kind === 'shared'
      ? canManageShared
      : ownsPersonal;
  /** Sama dengan `administer` di halaman akun: bersama = Owner/Admin, pribadi = pemiliknya. */
  const canEditServer = full ? (full.kind === 'shared' ? canManageShared : ownsPersonal) : false;
  const state = account.sync.state;
  const fixesPassword = state === 'auth_failed' && canEditServer;
  const detail = statusDetail(account);
  const ProviderIcon = PROVIDER_ICONS[account.provider];
  const personal = account.kind === 'personal';
  const showMenu = (manage || canDisconnect) && state !== 'deleting';

  return (
    <li className={styles.row}>
      <span className={styles.accountCell}>
        <AccountMark account={account} variant={account.avatarUrl ? 'avatar' : 'dot'} size="sm" />
        <span className={styles.accountText}>
          {full ? (
            <Link
              to="/pengaturan/akun-email/$accountId"
              params={{ accountId: account.id }}
              className={styles.accountName}
            >
              {account.displayName}
            </Link>
          ) : (
            <span className={styles.accountName}>{account.displayName}</span>
          )}
          <span className={styles.address}>{account.emailAddress}</span>
        </span>
      </span>
      <span className={styles.meta}>
        <Icon icon={ProviderIcon} size={16} className={styles.metaIcon} />
        {m.providers[account.provider]}
      </span>
      <span className={styles.meta}>
        <Icon icon={personal ? Lock : UsersRound} size={16} className={styles.metaIcon} />
        {kindLabel(account, myId, canManageShared)}
      </span>
      <span className={styles.status}>
        <StatusBadge tone={syncTone(state)} label={syncStateLabel(state)} />
        {detail ? <span className={styles.statusDetail}>{detail}</span> : null}
        {account.redacted ? <span className={styles.statusDetail}>{c.redactedNote}</span> : null}
        {full && (state === 'auth_failed' || state === 'error') ? (
          // Password ditolak + berhak mengubah server → langsung dialog Ubah server
          // (`?ubah=server`); selain itu ke halaman akun untuk membaca pesannya.
          <Link
            to="/pengaturan/akun-email/$accountId"
            params={{ accountId: account.id }}
            search={fixesPassword ? { ubah: 'server' } : {}}
            className={styles.fixLink}
          >
            {fixesPassword ? c.fixPassword : c.viewProblem}
          </Link>
        ) : null}
      </span>
      <span className={styles.actions}>
        {showMenu ? (
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button
                ref={menuRef}
                type="button"
                className={styles.menuTrigger}
                aria-label={c.actionsFor(account.displayName)}
              >
                <Icon icon={Ellipsis} size={20} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className={styles.menu}
                align="end"
                sideOffset={4}
                collisionPadding={8}
              >
                {full ? (
                  <DropdownMenu.Item className={styles.menuItem} asChild>
                    <Link to="/pengaturan/akun-email/$accountId" params={{ accountId: account.id }}>
                      {c.open}
                    </Link>
                  </DropdownMenu.Item>
                ) : null}
                {full && manage && state !== 'paused' && state !== 'owner_inactive' ? (
                  <DropdownMenu.Item
                    className={styles.menuItem}
                    onSelect={() => onRun(full, 'sync')}
                  >
                    {c.syncNow}
                  </DropdownMenu.Item>
                ) : null}
                {full && manage && state !== 'paused' && state !== 'owner_inactive' ? (
                  <DropdownMenu.Item
                    className={styles.menuItem}
                    onSelect={() => onRun(full, 'pause')}
                  >
                    {c.pause}
                  </DropdownMenu.Item>
                ) : null}
                {full && manage && state === 'paused' ? (
                  <DropdownMenu.Item
                    className={styles.menuItem}
                    onSelect={() => onRun(full, 'resume')}
                  >
                    {c.resume}
                  </DropdownMenu.Item>
                ) : null}
                {canDisconnect ? (
                  <>
                    <DropdownMenu.Separator className={styles.menuSeparator} />
                    <DropdownMenu.Item className={styles.menuItemDanger} onSelect={onDisconnect}>
                      {c.disconnect}
                    </DropdownMenu.Item>
                  </>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}
      </span>
    </li>
  );
}

/** Pengaturan email organisasi (`mail.accounts.manage`): retensi cache & jendela sinkron bawaan. */
function MailSettingsCard() {
  const settings = useQuery(mailSettingsQuery);
  return (
    <section className={styles.card} aria-labelledby="pengaturan-email-organisasi">
      <div className={styles.cardHead}>
        <h2 id="pengaturan-email-organisasi" className={styles.cardTitle}>
          {m.settings.title}
        </h2>
        <p className={styles.cardHint}>{m.settings.hint}</p>
      </div>
      {settings.data ? (
        <SettingsForm key={JSON.stringify(settings.data.settings)} saved={settings.data.settings} />
      ) : settings.isPending ? (
        <SkeletonRegion className={styles.settingsSkeleton}>
          <Skeleton className={styles.skeletonField} />
          <Skeleton className={styles.skeletonField} />
        </SkeletonRegion>
      ) : (
        <Notice
          tone="danger"
          actions={<Button onClick={() => void settings.refetch()}>{t.common.retry}</Button>}
        >
          {m.settings.loadFailed}
        </Notice>
      )}
    </section>
  );
}

function SettingsForm({ saved }: { saved: MailSettings }) {
  const queryClient = useQueryClient();
  const [retention, setRetention] = useState(String(saved.cacheRetentionDays));
  const [syncWindow, setSyncWindow] = useState(windowValue(saved.defaultSyncWindowDays));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<'saved' | { error: unknown } | null>(null);
  const dirty =
    retention.trim() !== String(saved.cacheRetentionDays) ||
    syncWindow !== windowValue(saved.defaultSyncWindowDays);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setResult(null);
    const body = {
      cacheRetentionDays: /^\d+$/.test(retention.trim()) ? Number(retention.trim()) : Number.NaN,
      defaultSyncWindowDays: parseWindow(syncWindow),
    };
    const parsed = mailSettingsSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const response = await endpoints.mail.updateSettings(parsed.data);
      queryClient.setQueryData(mailKeys.settings, response);
      setResult('saved');
    } catch (caught) {
      setResult({ error: caught });
    } finally {
      setPending(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      <div className={styles.formRow}>
        <TextField
          label={m.settings.retention}
          hint={m.settings.retentionHint}
          value={retention}
          onChange={(event) => {
            setRetention(event.target.value);
            setResult(null);
          }}
          error={errors.cacheRetentionDays}
          inputMode="numeric"
          maxLength={4}
          trailing={<span className={styles.unit}>{m.settings.retentionUnit}</span>}
          min={MAIL_CACHE_RETENTION_DAYS.min}
          max={MAIL_CACHE_RETENTION_DAYS.max}
        />
        <SelectField
          label={m.settings.defaultWindow}
          hint={m.settings.defaultWindowHint}
          value={syncWindow}
          onChange={(event) => {
            setSyncWindow(event.target.value);
            setResult(null);
          }}
          options={WINDOW_OPTIONS}
        />
      </div>
      {result === 'saved' ? (
        <Notice tone="success" role="status">
          {m.settings.saved}
        </Notice>
      ) : result ? (
        <Notice tone="danger" role="alert">
          {isApiError(result.error) ? result.error.message : t.api.network}
        </Notice>
      ) : null}
      <FormActions>
        <Button type="submit" variant="primary" loading={pending} disabled={!dirty}>
          {pending ? m.settings.saving : m.settings.save}
        </Button>
      </FormActions>
    </form>
  );
}
