import type { IdentityConfirmation, MailAccountAccessResponse } from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { FormActions } from '../../components/ui/FormActions';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { isConfirmationError, needsConfirmation } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { GrantsEditor } from './GrantsEditor';
import { accessLoosens, draftsFromAccess } from './mail-access';
import { mailAccessQuery, mailKeys, useRequireCode } from './mail-queries';
import { grantRequests, type GrantDraft } from './wizard-state';
import styles from './MailAccounts.module.css';

const a = t.mail.access;

function sameGrants(x: readonly GrantDraft[], y: readonly GrantDraft[]): boolean {
  return (
    x.length === y.length &&
    x.every((grant) => y.some((item) => item.id === grant.id && item.level === grant.level))
  );
}

/**
 * Kartu "Akses" akun bersama (Pengaturan → Akun email → [akun]): siapa boleh membaca / mengirim /
 * mengelola. Ubah = `mail.accounts.manage` (Owner/Admin); pemegang Kelola lain hanya melihat.
 */
export function MailAccessCard({ accountId }: { accountId: string }) {
  const access = useQuery(mailAccessQuery(accountId));
  const [done, setDone] = useState(false);
  return (
    <section className={styles.card} aria-labelledby="akun-email-akses" id="akses">
      <div className={styles.cardHead}>
        <h2 id="akun-email-akses" className={styles.cardTitle}>
          {a.title}
        </h2>
        <p className={styles.cardHint}>{a.hint}</p>
      </div>
      {access.data ? (
        <AccessForm
          key={JSON.stringify(access.data.grants)}
          accountId={accountId}
          access={access.data}
          done={done}
          onDone={setDone}
        />
      ) : access.isPending ? (
        <SkeletonRegion className={styles.skeleton}>
          <Skeleton className={styles.skeletonField} />
          <Skeleton className={styles.skeletonField} />
        </SkeletonRegion>
      ) : (
        <Notice
          tone="danger"
          title={a.loadFailed}
          actions={<Button onClick={() => void access.refetch()}>{t.common.retry}</Button>}
        >
          {isApiError(access.error) ? access.error.message : t.api.network}
        </Notice>
      )}
    </section>
  );
}

function AccessForm({
  accountId,
  access,
  done,
  onDone,
}: {
  accountId: string;
  access: MailAccountAccessResponse;
  done: boolean;
  onDone: (done: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const requireCode = useRequireCode();
  const [saved] = useState(() => draftsFromAccess(access));
  const [grants, setGrants] = useState<GrantDraft[]>(saved);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  // Pengguna nonaktif ditolak server: dilepas dari isian (tampil di daftar tersimpan saja).
  const dirty = !sameGrants(grants, saved);

  /** Tanpa `useMutation`: permintaan berkonfirmasi tidak boleh tersimpan di cache mutasi. */
  const send = async (confirmation?: IdentityConfirmation) => {
    const response = await endpoints.mail.updateAccess(accountId, {
      grants: grantRequests(grants.filter((grant) => !grant.inactive)),
      ...(confirmation ? { confirmation } : {}),
    });
    onDone(true);
    queryClient.setQueryData(mailKeys.access(accountId), response);
    void queryClient.invalidateQueries({ queryKey: mailKeys.teamAccess('').slice(0, 2) });
  };

  const submit = async () => {
    if (!dirty) return;
    setError(null);
    onDone(false);
    if (accessLoosens(saved, grants)) {
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
        <GrantsEditor
          grants={grants}
          onChange={(next) => {
            setGrants(next);
            onDone(false);
          }}
          disabled={pending}
          readOnly={!access.editable}
        />
        {access.editable ? null : <p className={styles.cardHint}>{a.readOnly}</p>}
        {error ? (
          <Notice tone="danger" role="alert">
            {isApiError(error) ? error.message : t.api.network}
          </Notice>
        ) : done && !dirty ? (
          <Notice tone="success" role="status">
            {a.saved}
          </Notice>
        ) : null}
        {access.editable ? (
          <FormActions meta={dirty ? a.unsaved : undefined}>
            {dirty ? (
              <Button disabled={pending} onClick={() => setGrants(saved)}>
                {a.reset}
              </Button>
            ) : null}
            <Button
              ref={saveRef}
              type="submit"
              variant="primary"
              loading={pending}
              disabled={!dirty}
            >
              {pending ? a.saving : a.save}
            </Button>
          </FormActions>
        ) : null}
      </form>
      {/* Di luar `<form>`: Enter di dialog tidak mengirim form akses. */}
      <IdentityDialog
        open={confirming}
        title={a.confirmTitle}
        body={a.confirmBody}
        confirmLabel={a.save}
        pendingLabel={a.saving}
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
