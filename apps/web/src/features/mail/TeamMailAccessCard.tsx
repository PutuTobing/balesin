import {
  isMailImplicitManager,
  type IdentityConfirmation,
  type MailAccessLevel,
  type TeamMailAccessResponse,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Info } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { FormActions } from '../../components/ui/FormActions';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { refetchSession } from '../../lib/api/queries';
import { useSession } from '../auth/session';
import { isConfirmationError, needsConfirmation } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { AccountMark } from './AccountMark';
import { directChanges, teamAccessLoosens } from './mail-access';
import { syncStateLabel, syncTone } from './mail-format';
import { mailKeys, teamMailAccessQuery, useRequireCode } from './mail-queries';
import styles from './TeamMailAccess.module.css';

const m = t.mail;
const tm = t.mail.team;

/**
 * Pengaturan → Tim → [pengguna] → Akses email (`mail.accounts.manage`, kontrak §5): akun bersama
 * yang bisa dibuka pengguna ini — hak langsung bisa diubah di sini; hak lewat departemen & peran
 * ditampilkan sebagai sumber. Akun pribadi miliknya hanya alamat & status.
 */
export function TeamMailAccessCard({
  userId,
  cardClassName,
  headClassName,
  titleClassName,
}: {
  userId: string;
  cardClassName: string;
  headClassName: string;
  titleClassName: string;
}) {
  const access = useQuery(teamMailAccessQuery(userId));
  const [saved, setSaved] = useState(false);
  return (
    <section className={cardClassName} aria-labelledby="anggota-akses-email" id="akses-email">
      <div className={headClassName}>
        <h2 id="anggota-akses-email" className={titleClassName}>
          {tm.title}
        </h2>
        <p className={styles.hint}>{tm.hint}</p>
      </div>
      {access.data ? (
        <AccessForm
          key={JSON.stringify(access.data.accounts.map((item) => item.directLevel))}
          data={access.data}
          saved={saved}
          onSaved={setSaved}
        />
      ) : access.isPending ? (
        <SkeletonRegion className={styles.skeleton}>
          <Skeleton className={styles.skeletonRow} />
          <Skeleton className={styles.skeletonRow} />
        </SkeletonRegion>
      ) : (
        <Notice
          tone="danger"
          title={tm.loadFailed}
          actions={<Button onClick={() => void access.refetch()}>{t.common.retry}</Button>}
        >
          {isApiError(access.error) ? access.error.message : t.api.network}
        </Notice>
      )}
    </section>
  );
}

function AccessForm({
  data,
  saved,
  onSaved,
}: {
  data: TeamMailAccessResponse;
  saved: boolean;
  onSaved: (saved: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const session = useSession();
  const requireCode = useRequireCode();
  const initial = Object.fromEntries(
    data.accounts.map((item) => [item.account.id, item.directLevel]),
  ) as Record<string, MailAccessLevel | null>;
  const [levels, setLevels] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  const implicit = isMailImplicitManager(data.user.role);
  const changes = directChanges(initial, levels);
  const dirty = changes.length > 0;

  /** Tanpa `useMutation`: permintaan berkonfirmasi tidak boleh tersimpan di cache mutasi. */
  const send = async (confirmation?: IdentityConfirmation) => {
    const response = await endpoints.mail.updateTeamAccess(data.user.id, {
      grants: changes,
      ...(confirmation ? { confirmation } : {}),
    });
    queryClient.setQueryData(mailKeys.teamAccess(data.user.id), response);
    // Daftar akses per akun ikut berubah.
    void queryClient.invalidateQueries({ queryKey: ['mail', 'access'] });
    // Mengubah akses diri sendiri (Admin): menu Email bisa berubah.
    if (data.user.id === session?.user.id) void refetchSession(queryClient).catch(() => undefined);
    onSaved(true);
  };

  const submit = async () => {
    if (!dirty) return;
    setError(null);
    onSaved(false);
    if (teamAccessLoosens(initial, levels)) {
      setConfirming(true);
      return;
    }
    setPending(true);
    try {
      await send();
    } catch (caught) {
      if (needsConfirmation(caught)) setConfirming(true);
      else setError(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <form
        className={styles.form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className={styles.menuState} data-visible={data.menuVisible ? '' : undefined}>
          <Icon
            icon={data.menuVisible ? CircleCheck : Info}
            size={16}
            className={styles.menuIcon}
          />
          {data.menuVisible ? tm.menuVisible : tm.menuHidden}
        </p>
        {implicit ? <p className={styles.hint}>{tm.roleManaged}</p> : null}
        {data.accounts.length === 0 ? (
          <p className={styles.hint}>{tm.noShared}</p>
        ) : (
          <ul className={styles.rows}>
            {data.accounts.map((item) => {
              const departmentSources = item.sources.filter(
                (source) => source.type === 'department',
              );
              const roleSource = item.sources.some((source) => source.type === 'role');
              const effective = item.effectiveLevel;
              return (
                <li key={item.account.id} className={styles.row}>
                  <span className={styles.account}>
                    <AccountMark account={{ ...item.account, avatarUrl: null }} />
                    <span className={styles.accountText}>
                      <span className={styles.accountName}>{item.account.displayName}</span>
                      <span className={styles.accountAddress}>{item.account.emailAddress}</span>
                      <span className={styles.sources}>
                        {roleSource ? <span>{tm.viaRole}</span> : null}
                        {departmentSources.map((source) => (
                          <span key={source.department?.id ?? source.level}>
                            {tm.viaDepartment(
                              source.department?.name ?? '',
                              m.levels[source.level] ?? source.level,
                            )}
                          </span>
                        ))}
                        <span className={styles.effective}>
                          {effective ? (
                            <>
                              {tm.effectiveLabel}{' '}
                              <span className={styles.effectiveValue}>
                                {m.levels[effective] ?? effective}
                              </span>
                            </>
                          ) : (
                            <span className={styles.effectiveValue}>{tm.noEffective}</span>
                          )}
                        </span>
                      </span>
                    </span>
                  </span>
                  {implicit ? null : (
                    <select
                      className={styles.select}
                      value={levels[item.account.id] ?? ''}
                      aria-label={tm.levelFor(item.account.displayName)}
                      disabled={pending}
                      onChange={(event) => {
                        const value = event.target.value;
                        setLevels((current) => ({
                          ...current,
                          [item.account.id]: value === '' ? null : (value as MailAccessLevel),
                        }));
                        onSaved(false);
                      }}
                    >
                      <option value="">{tm.noneOption}</option>
                      {(['read', 'send', 'manage'] as const).map((level) => (
                        <option key={level} value={level}>
                          {m.levels[level]}
                        </option>
                      ))}
                    </select>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {data.personalAccounts.length > 0 ? (
          <div className={styles.personal}>
            <h3 className={styles.subTitle}>{tm.personalTitle}</h3>
            <p className={styles.hint}>{tm.personalHint}</p>
            <ul className={styles.personalList}>
              {data.personalAccounts.map((account) => (
                <li key={account.id} className={styles.personalRow}>
                  <span className={styles.accountAddress}>{account.emailAddress}</span>
                  <StatusBadge
                    tone={syncTone(account.syncState)}
                    label={syncStateLabel(account.syncState)}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {error ? (
          <Notice tone="danger" role="alert">
            {isApiError(error) ? error.message : t.api.network}
          </Notice>
        ) : saved && !dirty ? (
          <Notice tone="success" role="status">
            {tm.saved}
          </Notice>
        ) : null}
        {implicit || data.accounts.length === 0 ? null : (
          <FormActions meta={dirty ? tm.unsaved : undefined}>
            {dirty ? (
              <Button disabled={pending} onClick={() => setLevels(initial)}>
                {tm.reset}
              </Button>
            ) : null}
            <Button
              ref={saveRef}
              type="submit"
              variant="primary"
              loading={pending}
              disabled={!dirty}
            >
              {pending ? tm.saving : tm.save}
            </Button>
          </FormActions>
        )}
      </form>
      <IdentityDialog
        open={confirming}
        title={tm.confirmTitle}
        body={tm.confirmBody}
        confirmLabel={tm.save}
        pendingLabel={tm.saving}
        requireCode={requireCode}
        returnFocusRef={saveRef}
        onCancel={() => setConfirming(false)}
        onConfirm={async (confirmation) => {
          try {
            await send(confirmation);
            setConfirming(false);
          } catch (caught) {
            if (isConfirmationError(caught)) throw caught;
            setConfirming(false);
            setError(caught);
          }
        }}
      />
    </>
  );
}
