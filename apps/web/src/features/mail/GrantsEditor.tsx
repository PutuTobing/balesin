import type { MailAccessLevel } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { Building2, UserPlus, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { initialsOf } from '../../components/shell/initials';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { SearchField } from '../../components/ui/SearchField';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { teamUsersQuery } from '../../lib/api/queries';
import { departmentsQuery } from '../departments/department-queries';
import { LEVEL_OPTIONS, departmentDraft, grantableUsers, userDraft } from './mail-access';
import type { GrantDraft } from './wizard-state';
import styles from './Access.module.css';

const a = t.mail.access;
const m = t.mail;

/**
 * Daftar penerima akses satu akun bersama (PRD §5): orang & departemen dengan hak Baca · Baca &
 * kirim · Kelola, plus pemilih "Tambah orang atau departemen". Owner/Admin tidak ditawarkan
 * (otomatis Kelola; server menolak grant untuk mereka).
 */
export function GrantsEditor({
  grants,
  onChange,
  disabled = false,
  readOnly = false,
}: {
  grants: readonly GrantDraft[];
  onChange: (grants: GrantDraft[]) => void;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const listId = useId();
  const update = (id: string, level: MailAccessLevel) =>
    onChange(grants.map((grant) => (grant.id === id ? { ...grant, level } : grant)));
  const remove = (id: string) => onChange(grants.filter((grant) => grant.id !== id));

  return (
    <div className={styles.editor}>
      <p className={styles.implicit}>{a.implicit}</p>
      {grants.length === 0 ? (
        <p className={styles.none}>{a.none}</p>
      ) : (
        <ul className={styles.rows} aria-label={a.listLabel} id={listId}>
          {grants.map((grant) => (
            <li key={grant.id} className={styles.row}>
              <PrincipalAvatar grant={grant} />
              <span className={styles.rowText}>
                <span className={styles.rowName}>{grant.name}</span>
                <span className={styles.rowMeta}>
                  {grant.meta}
                  {grant.inactive ? ` · ${a.inactive}` : null}
                </span>
              </span>
              {readOnly ? (
                <span className={styles.levelText}>{m.levels[grant.level]}</span>
              ) : (
                <>
                  <span className={styles.levelControl}>
                    <select
                      className={styles.levelSelect}
                      value={grant.level}
                      aria-label={a.levelFor(grant.name)}
                      disabled={disabled}
                      onChange={(event) => update(grant.id, event.target.value as MailAccessLevel)}
                    >
                      {LEVEL_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </span>
                  <IconButton
                    label={a.remove(grant.name)}
                    icon={X}
                    className={styles.remove}
                    disabled={disabled}
                    onClick={() => remove(grant.id)}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {readOnly ? null : picking ? (
        <PrincipalPicker
          grants={grants}
          disabled={disabled}
          onAdd={(grant) => onChange([...grants, grant])}
          onDone={() => setPicking(false)}
        />
      ) : (
        <Button
          variant="ghost"
          className={styles.addButton}
          disabled={disabled}
          onClick={() => setPicking(true)}
        >
          <Icon icon={UserPlus} size={16} />
          {a.add}
        </Button>
      )}
    </div>
  );
}

function PrincipalAvatar({ grant }: { grant: GrantDraft }) {
  if (grant.principalType === 'department') {
    return (
      <span className={styles.avatar} data-kind="department" aria-hidden="true">
        <Icon icon={Building2} size={16} />
      </span>
    );
  }
  return (
    <span className={styles.avatar} aria-hidden="true">
      {initialsOf(grant.name)}
    </span>
  );
}

/** Pemilih orang & departemen (cari + daftar), menambah dengan hak bawaan "Baca & kirim". */
function PrincipalPicker({
  grants,
  disabled,
  onAdd,
  onDone,
}: {
  grants: readonly GrantDraft[];
  disabled: boolean;
  onAdd: (grant: GrantDraft) => void;
  onDone: () => void;
}) {
  const departments = useQuery(departmentsQuery);
  const users = useQuery(teamUsersQuery);
  const [search, setSearch] = useState('');
  const needle = search.trim().toLocaleLowerCase('id');
  const taken = new Set(grants.map((grant) => grant.id));
  const match = (name: string) => !needle || name.toLocaleLowerCase('id').includes(needle);
  const departmentOptions = (departments.data?.departments ?? [])
    .filter((department) => !taken.has(department.id) && match(department.name))
    .sort((x, y) => x.name.localeCompare(y.name, 'id'));
  const userOptions = grantableUsers(users.data?.users ?? []).filter(
    (user) => !taken.has(user.id) && match(user.name),
  );
  const loading = departments.isPending || users.isPending;
  const failed = departments.isError || users.isError;
  const nothingLeft =
    !needle && !loading && departmentOptions.length === 0 && userOptions.length === 0;

  return (
    <div className={styles.picker}>
      <SearchField
        value={search}
        onChange={setSearch}
        label={a.searchLabel}
        placeholder={a.searchPlaceholder}
        clearLabel={a.clearSearch}
      />
      {failed ? (
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
      ) : loading ? (
        <SkeletonRegion className={styles.pickerSkeleton}>
          <Skeleton className={styles.skeletonRow} />
          <Skeleton className={styles.skeletonRow} />
        </SkeletonRegion>
      ) : nothingLeft ? (
        <p className={styles.none}>{a.allAdded}</p>
      ) : departmentOptions.length === 0 && userOptions.length === 0 ? (
        <p className={styles.none}>{a.noMatch(search.trim())}</p>
      ) : (
        <div className={styles.options}>
          {departmentOptions.length > 0 ? (
            <OptionGroup title={a.departments}>
              {departmentOptions.map((department) => (
                <OptionButton
                  key={department.id}
                  draft={departmentDraft(department, 'send')}
                  disabled={disabled}
                  onAdd={onAdd}
                />
              ))}
            </OptionGroup>
          ) : null}
          {userOptions.length > 0 ? (
            <OptionGroup title={a.people}>
              {userOptions.map((user) => (
                <OptionButton
                  key={user.id}
                  draft={userDraft(user, 'send')}
                  disabled={disabled}
                  onAdd={onAdd}
                />
              ))}
            </OptionGroup>
          ) : null}
        </div>
      )}
      <div className={styles.pickerActions}>
        <Button onClick={onDone}>{a.addDone}</Button>
      </div>
    </div>
  );
}

function OptionGroup({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className={styles.optionGroup}>
      <p id={id} className={styles.optionTitle}>
        {title}
      </p>
      <ul className={styles.optionList}>{children}</ul>
    </div>
  );
}

function OptionButton({
  draft,
  disabled,
  onAdd,
}: {
  draft: GrantDraft;
  disabled: boolean;
  onAdd: (grant: GrantDraft) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={styles.option}
        disabled={disabled}
        aria-label={a.addPrincipal(draft.name)}
        onClick={() => onAdd(draft)}
      >
        <PrincipalAvatar grant={draft} />
        <span className={styles.rowText}>
          <span className={styles.rowName}>{draft.name}</span>
          <span className={styles.rowMeta}>{draft.meta}</span>
        </span>
        <Icon icon={UserPlus} size={16} className={styles.optionIcon} />
      </button>
    </li>
  );
}
