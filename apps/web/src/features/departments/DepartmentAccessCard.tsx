import {
  DEPARTMENT_RESTRICTABLE_ROLES,
  type DepartmentAccess,
  type IdentityConfirmation,
  type TeamUser,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { IdentityDialog } from '../identity/IdentityDialog';
import { isConfirmationError, needsConfirmation } from '../identity/confirmation-error';
import { departmentAccessQuery, departmentKeys, departmentsQuery } from './department-queries';
import { isLoosening } from './department-access';
import styles from './Departments.module.css';

const d = t.departments;

/**
 * Pengaturan → Tim → anggota → Departemen (`settings.workspace.manage`): departemen pengguna + tanda
 * "hanya departemen sendiri" (Supervisor & CS). Melonggarkan akses = konfirmasi identitas;
 * menyempitkan langsung tersimpan.
 */
export function DepartmentAccessCard({
  user,
  cardClassName,
  headClassName,
  titleClassName,
}: {
  user: TeamUser;
  cardClassName: string;
  headClassName: string;
  titleClassName: string;
}) {
  const departments = useQuery(departmentsQuery);
  const access = useQuery(departmentAccessQuery(user.id));
  return (
    <section className={cardClassName} aria-labelledby="anggota-departemen">
      <div className={headClassName}>
        <h2 id="anggota-departemen" className={titleClassName}>
          {d.accessTitle}
        </h2>
        <p className={styles.hint}>{d.accessHint}</p>
      </div>
      {departments.isPending || access.isPending ? (
        <SkeletonRegion className={styles.access}>
          <Skeleton className={styles.skeletonLine} />
          <Skeleton className={styles.skeletonLine} />
        </SkeletonRegion>
      ) : departments.isError || access.isError ? (
        <Notice tone="danger">
          {d.accessFailed}
          <Button
            variant="ghost"
            onClick={() => {
              void departments.refetch();
              void access.refetch();
            }}
          >
            {t.common.retry}
          </Button>
        </Notice>
      ) : departments.data.departments.length === 0 ? (
        <p className={styles.hint}>{d.accessNone}</p>
      ) : (
        <AccessForm
          key={user.id}
          user={user}
          access={access.data.access}
          departments={departments.data.departments}
        />
      )}
    </section>
  );
}

function AccessForm({
  user,
  access,
  departments,
}: {
  user: TeamUser;
  access: DepartmentAccess;
  departments: readonly { id: string; name: string }[];
}) {
  const queryClient = useQueryClient();
  const restrictable = (DEPARTMENT_RESTRICTABLE_ROLES as readonly string[]).includes(user.role);
  const [selected, setSelected] = useState<string[]>(access.departmentIds);
  const [restricted, setRestricted] = useState(access.restricted && restrictable);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: true } | { error: unknown } | null>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const next = { departmentIds: selected, restricted: restrictable && restricted };
  const changed =
    next.restricted !== access.restricted ||
    next.departmentIds.length !== access.departmentIds.length ||
    next.departmentIds.some((id) => !access.departmentIds.includes(id));

  const send = async (confirmation?: IdentityConfirmation) => {
    const response = await endpoints.departments.updateAccess(user.id, {
      ...next,
      ...(confirmation ? { confirmation } : {}),
    });
    queryClient.setQueryData(departmentKeys.access(user.id), response);
    void queryClient.invalidateQueries({ queryKey: departmentKeys.all });
    setResult({ ok: true });
  };

  const save = async () => {
    setResult(null);
    if (isLoosening(access, next)) {
      setConfirming(true);
      return;
    }
    setPending(true);
    try {
      await send();
    } catch (caught) {
      if (needsConfirmation(caught)) setConfirming(true);
      else setResult({ error: caught });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={styles.access}>
      <fieldset className={styles.fieldset}>
        <legend className="sr-only">{d.accessTitle}</legend>
        {departments.map((department) => (
          <Checkbox
            key={department.id}
            checked={selected.includes(department.id)}
            onChange={(event) =>
              setSelected((current) =>
                event.target.checked
                  ? [...current, department.id]
                  : current.filter((id) => id !== department.id),
              )
            }
          >
            {department.name}
          </Checkbox>
        ))}
      </fieldset>
      <div className={styles.accessLimit}>
        <h3 className={styles.accessLimitTitle}>{d.accessLimitTitle}</h3>
        {restrictable ? (
          <>
            <Checkbox
              checked={restricted}
              onChange={(event) => setRestricted(event.target.checked)}
            >
              {d.restrictedLabel}
            </Checkbox>
            <p className={styles.hint}>{d.restrictedHint}</p>
          </>
        ) : (
          <p className={styles.hint}>{d.restrictedRoleNote}</p>
        )}
      </div>
      {result ? (
        'ok' in result ? (
          <Notice tone="success" role="status">
            {d.accessSaved}
          </Notice>
        ) : (
          <Notice tone="danger" role="alert">
            {isApiError(result.error) ? result.error.message : t.api.network}
          </Notice>
        )
      ) : null}
      <div className={styles.accessActions}>
        <Button
          ref={saveRef}
          variant={changed ? 'primary' : 'secondary'}
          disabled={!changed}
          loading={pending}
          onClick={() => void save()}
        >
          {pending ? d.saving : d.accessSave}
        </Button>
      </div>
      <IdentityDialog
        open={confirming}
        title={d.loosenTitle}
        body={d.loosenBody}
        confirmLabel={d.loosenConfirm}
        pendingLabel={d.loosening}
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
            setResult({ error: caught });
          }
        }}
      />
    </div>
  );
}
