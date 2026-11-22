import {
  USER_ROLE_LABELS,
  channelAccessLoosens,
  type ChannelAccess,
  type IdentityConfirmation,
  type ChannelAccessMode,
  type DepartmentSummary,
  type TeamUser,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RadioGroup } from 'radix-ui';
import { useId, useRef, useState } from 'react';
import { isConfirmationError, needsConfirmation } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { FormActions } from '../../components/ui/FormActions';
import { Notice } from '../../components/ui/Notice';
import { SearchField } from '../../components/ui/SearchField';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { teamUsersQuery } from '../../lib/api/queries';
import { departmentsQuery } from '../departments/department-queries';
import styles from './ChannelAccess.module.css';
import {
  accessBody,
  accessSummary,
  initialDraft,
  sameDraft,
  selectableUsers,
  toggleId,
  channelAccessKey,
  type AccessDraft,
} from './channel-access-form';

const a = t.channels.teamAccess;
/** Lebih dari ini → kolom cari pengguna. */
const SEARCH_FROM = 8;

/**
 * Tahap 9.0 — "Akses tim" di halaman channel (semua jenis): "Semua tim" atau hanya departemen/
 * pengguna tertentu. Owner/Admin selalu melihat semua channel. `PUT` mengganti seluruh aturan.
 */
export function ChannelAccessCard({ channelId, id }: { channelId: string; id?: string }) {
  const access = useQuery({
    queryKey: channelAccessKey(channelId),
    queryFn: ({ signal }) => endpoints.channelAccess.get(channelId, signal),
  });
  // Di kartu (bukan form): form dipasang ulang dari keadaan server setelah disimpan.
  /** Pesan sukses terakhir (`null` = tidak ada); bertahan saat form dipasang ulang. */
  const [done, setDone] = useState<string | null>(null);
  return (
    <section id={id} className={styles.card} aria-labelledby="channel-akses-tim">
      <div>
        <h2 id="channel-akses-tim" className={styles.title}>
          {a.title}
        </h2>
        <p className={styles.hint}>{a.hint}</p>
      </div>
      {access.data ? (
        <AccessForm
          // Keadaan server berubah (disimpan di tab lain/dimuat ulang) → form mulai dari sana lagi.
          key={JSON.stringify(access.data.access)}
          channelId={channelId}
          access={access.data.access}
          done={done}
          onDoneChange={setDone}
        />
      ) : access.isPending ? (
        <SkeletonRegion className={styles.skeleton}>
          <Skeleton className={styles.skeletonRow} />
          <Skeleton className={styles.skeletonRow} />
        </SkeletonRegion>
      ) : (
        <Notice
          tone="danger"
          title={a.loadFailed}
          actions={
            <Button onClick={() => void access.refetch()} loading={access.isFetching}>
              {t.common.retry}
            </Button>
          }
        >
          {isApiError(access.error) ? access.error.message : t.api.network}
        </Notice>
      )}
    </section>
  );
}

function AccessForm({
  channelId,
  access,
  done,
  onDoneChange: setDone,
}: {
  channelId: string;
  access: ChannelAccess;
  /** Baru saja disimpan (pemberitahuan sukses). */
  done: string | null;
  onDoneChange: (done: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [{ draft: saved, droppedInactive }] = useState(() => initialDraft(access));
  const [draft, setDraft] = useState<AccessDraft>(saved);
  const restricted = draft.mode === 'restricted';
  const departments = useQuery({ ...departmentsQuery, enabled: restricted });
  const users = useQuery({ ...teamUsersQuery, enabled: restricted });
  const dirty = !sameDraft(draft, saved) || droppedInactive > 0;
  const id = useId();

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  // Melonggarkan (terbatas → semua tim, atau menambah departemen/pengguna) = konfirmasi identitas.
  const loosens = channelAccessLoosens(
    {
      mode: access.mode,
      departmentIds: access.departments.map((department) => department.id),
      userIds: access.users.map((user) => user.id),
    },
    draft,
  );

  /** Tanpa `useMutation`: permintaan berkonfirmasi tidak boleh tersimpan di cache mutasi. */
  const send = async (confirmation?: IdentityConfirmation) => {
    const response = await endpoints.channelAccess.update(channelId, {
      ...accessBody(draft),
      ...(confirmation ? { confirmation } : {}),
    });
    setDone(
      response.releasedConversations > 0
        ? `${a.saved} ${a.released(response.releasedConversations)}`
        : a.saved,
    );
    queryClient.setQueryData(channelAccessKey(channelId), { access: response.access });
    // Daftar channel & agen inbox ikut berubah bagi yang dibatasi (Owner/Admin tidak); percakapan
    // yang dilepas kembali ke antrian.
    void queryClient.invalidateQueries({ queryKey: ['inbox'] });
  };

  const submit = async () => {
    if (!dirty) return;
    setError(null);
    setDone(null);
    if (loosens) {
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

  const change = (next: AccessDraft) => {
    setDraft(next);
    setDone(null);
  };

  // Departemen/pengguna tersimpan yang tidak ada di daftar pilihan tetap tampil (mis. daftar belum
  // dimuat), supaya tidak hilang diam-diam dari isian.
  const departmentOptions = mergeDepartments(departments.data?.departments, access);
  const userOptions = mergeUsers(users.data?.users, access);
  const summary = accessSummary(draft, departmentOptions);
  const loadingOptions = restricted && (departments.isPending || users.isPending);
  const optionsFailed = restricted && (departments.isError || users.isError);

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
        <RadioGroup.Root
          className={styles.modes}
          value={draft.mode}
          onValueChange={(value) => change({ ...draft, mode: value as ChannelAccessMode })}
          aria-label={a.modeLabel}
          disabled={pending}
        >
          {(
            [
              ['all', a.modeAll, a.modeAllHint],
              ['restricted', a.modeRestricted, a.modeRestrictedHint],
            ] as const
          ).map(([value, label, hint]) => (
            <RadioGroup.Item key={value} value={value} className={styles.mode}>
              <span className={styles.radio}>
                <RadioGroup.Indicator className={styles.radioDot} />
              </span>
              <span className={styles.modeText}>
                <span className={styles.modeLabel}>{label}</span>
                <span className={styles.modeHint}>{hint}</span>
              </span>
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>

        {restricted ? (
          loadingOptions ? (
            <SkeletonRegion className={styles.skeleton}>
              <Skeleton className={styles.skeletonRow} />
              <Skeleton className={styles.skeletonRow} />
              <Skeleton className={styles.skeletonRow} />
            </SkeletonRegion>
          ) : (
            <div className={styles.pickers}>
              {optionsFailed ? (
                <Notice
                  tone="danger"
                  actions={
                    <Button
                      onClick={() => {
                        void departments.refetch();
                        void users.refetch();
                      }}
                    >
                      {t.common.retry}
                    </Button>
                  }
                >
                  {a.optionsFailed}
                </Notice>
              ) : null}
              <fieldset className={styles.group} disabled={pending}>
                <legend className={styles.legend}>
                  {a.departments}
                  {draft.departmentIds.length > 0 ? (
                    <span className={styles.count}>{a.selected(draft.departmentIds.length)}</span>
                  ) : null}
                </legend>
                {departmentOptions.length === 0 ? (
                  <p className={styles.hint}>{a.noDepartments}</p>
                ) : (
                  <div className={styles.options}>
                    {departmentOptions.map((department) => (
                      <Checkbox
                        key={department.id}
                        className={styles.option}
                        checked={draft.departmentIds.includes(department.id)}
                        onChange={(event) =>
                          change({
                            ...draft,
                            departmentIds: toggleId(
                              draft.departmentIds,
                              department.id,
                              event.target.checked,
                            ),
                          })
                        }
                      >
                        <span className={styles.optionText}>
                          <span className={styles.optionName}>{department.name}</span>
                          <span className={styles.optionMeta}>
                            {a.departmentMembers(department.memberCount)}
                          </span>
                        </span>
                      </Checkbox>
                    ))}
                  </div>
                )}
              </fieldset>
              <UserPicker
                users={userOptions}
                selected={draft.userIds}
                disabled={pending}
                hintId={`${id}-pengguna`}
                onToggle={(userId, on) =>
                  change({ ...draft, userIds: toggleId(draft.userIds, userId, on) })
                }
              />
            </div>
          )
        ) : null}

        <div className={styles.summary}>
          <p className={styles.summaryTitle}>{a.summaryTitle}</p>
          <p className={styles.summaryBody}>
            {restricted
              ? [
                  a.summaryOwners,
                  summary.departments > 0
                    ? a.summaryDepartments(summary.departments, summary.members)
                    : null,
                  summary.users > 0 ? a.summaryUsers(summary.users) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : a.summaryAll}
          </p>
          <p className={styles.hint}>{a.exempt}</p>
        </div>
        {summary.ownersOnly ? (
          <Notice tone="warning" title={a.onlyOwners}>
            {a.onlyOwnersHint}
          </Notice>
        ) : null}
        {droppedInactive > 0 ? (
          <Notice tone="info">{a.droppedInactive(droppedInactive)}</Notice>
        ) : null}

        {error ? (
          <Notice tone="danger" role="alert">
            {isApiError(error) ? error.message : t.api.network}
          </Notice>
        ) : done && !dirty ? (
          <Notice tone="success" role="status">
            {done}
          </Notice>
        ) : null}
        <FormActions meta={dirty ? a.unsaved : undefined}>
          {dirty && droppedInactive === 0 ? (
            <Button
              disabled={pending}
              onClick={() => {
                setDraft(saved);
                setError(null);
              }}
            >
              {a.reset}
            </Button>
          ) : null}
          <Button ref={saveRef} type="submit" variant="primary" loading={pending} disabled={!dirty}>
            {pending ? a.saving : a.save}
          </Button>
        </FormActions>
      </form>
      {/* Di luar `<form>`: Enter di dialog tidak mengirim form akses. */}
      <IdentityDialog
        open={confirming}
        title={a.confirmTitle}
        body={a.confirmBody}
        confirmLabel={a.save}
        pendingLabel={a.saving}
        requireCode
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

interface UserOption {
  id: string;
  name: string;
  role: TeamUser['role'];
  active: boolean;
}

function UserPicker({
  users,
  selected,
  disabled,
  hintId,
  onToggle,
}: {
  users: UserOption[];
  selected: readonly string[];
  disabled: boolean;
  hintId: string;
  onToggle: (userId: string, on: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  const needle = search.trim().toLocaleLowerCase('id');
  const shown = needle
    ? users.filter((user) => user.name.toLocaleLowerCase('id').includes(needle))
    : users;
  return (
    <fieldset className={styles.group} disabled={disabled} aria-describedby={hintId}>
      <legend className={styles.legend}>
        {a.users}
        {selected.length > 0 ? (
          <span className={styles.count}>{a.selected(selected.length)}</span>
        ) : null}
      </legend>
      <p id={hintId} className={styles.hint}>
        {a.usersHint}
      </p>
      {users.length > SEARCH_FROM ? (
        <SearchField
          value={search}
          onChange={setSearch}
          label={a.searchUsers}
          placeholder={a.searchPlaceholder}
          clearLabel={a.clearSearch}
        />
      ) : null}
      {users.length === 0 ? (
        <p className={styles.hint}>{a.noUsers}</p>
      ) : shown.length === 0 ? (
        <p className={styles.hint}>{a.noMatch(search.trim())}</p>
      ) : (
        <div className={styles.options} data-scroll={users.length > SEARCH_FROM ? '' : undefined}>
          {shown.map((user) => (
            <Checkbox
              key={user.id}
              className={styles.option}
              checked={selected.includes(user.id)}
              disabled={!user.active && !selected.includes(user.id)}
              onChange={(event) => onToggle(user.id, event.target.checked)}
            >
              <span className={styles.optionText}>
                <span className={styles.optionName}>{user.name}</span>
                <span className={styles.optionMeta}>
                  {USER_ROLE_LABELS[user.role]}
                  {user.active ? null : ` · ${a.inactive}`}
                </span>
              </span>
            </Checkbox>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function mergeDepartments(
  list: readonly DepartmentSummary[] | undefined,
  access: ChannelAccess,
): Pick<DepartmentSummary, 'id' | 'name' | 'memberCount'>[] {
  const result: Pick<DepartmentSummary, 'id' | 'name' | 'memberCount'>[] = [...(list ?? [])];
  for (const department of access.departments) {
    if (!result.some((item) => item.id === department.id)) result.push(department);
  }
  return result.sort((x, y) => x.name.localeCompare(y.name, 'id'));
}

function mergeUsers(list: readonly TeamUser[] | undefined, access: ChannelAccess): UserOption[] {
  const result: UserOption[] = selectableUsers(list ?? []).map((user) => ({
    id: user.id,
    name: user.name,
    role: user.role,
    active: true,
  }));
  for (const user of access.users) {
    if (!result.some((item) => item.id === user.id)) result.push(user);
  }
  return result.sort((x, y) => x.name.localeCompare(y.name, 'id'));
}
