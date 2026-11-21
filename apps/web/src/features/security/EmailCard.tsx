import { type EmailVerificationStatusResponse } from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { FormErrorNotice } from '../../components/ui/FormErrorNotice';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { emailVerificationQuery, queryKeys } from '../../lib/api/queries';
import { formatDate } from '../../lib/format';
import { useLock } from '../../lib/use-lock';
import { useCan, useSession } from '../auth/session';
import styles from './Security.module.css';

const copy = t.security.email;
const HEADING_ID = 'keamanan-email';

/**
 * Kartu "Email akun" di Keamanan akun: alamat email, status verifikasi, dan tombol "Kirim email
 * verifikasi" (bila belum terverifikasi dan email pengirim sudah diatur). Status ini hanya
 * petunjuk; tidak ada fitur yang diblokir.
 */
export function EmailCard() {
  const session = useSession();
  const canSetUpSender = useCan('settings.email.manage');
  const status = useQuery(emailVerificationQuery);

  return (
    <section className={styles.card} aria-labelledby={HEADING_ID}>
      <div className={styles.cardHead}>
        <div className={styles.titleRow}>
          <h2 id={HEADING_ID} className={styles.cardTitle}>
            {copy.title}
          </h2>
          {status.data ? (
            <StatusBadge
              tone={status.data.verified ? 'success' : 'neutral'}
              label={status.data.verified ? copy.verified : copy.unverified}
            />
          ) : status.isPending ? (
            <Skeleton className={styles.skeletonBadge} />
          ) : null}
        </div>
        <p className={styles.emailAddress}>{status.data?.email ?? session?.user.email}</p>
        {status.data?.verified && status.data.verifiedAt ? (
          <p className={styles.meta}>{copy.verifiedAt(formatDate(status.data.verifiedAt))}</p>
        ) : status.isPending ? (
          <Skeleton className={styles.skeletonMeta} />
        ) : null}
      </div>
      {status.data && !status.data.verified ? (
        <Unverified status={status.data} canSetUpSender={canSetUpSender} />
      ) : null}
      {status.isError ? (
        <Notice
          tone="danger"
          role="alert"
          actions={<Button onClick={() => void status.refetch()}>{t.common.retry}</Button>}
        >
          {isApiError(status.error) ? status.error.message : t.api.network}
        </Notice>
      ) : null}
    </section>
  );
}

function Unverified({
  status,
  canSetUpSender,
}: {
  status: EmailVerificationStatusResponse;
  /** Boleh mengatur email pengirim sendiri (`settings.email.manage`): tampilkan tautannya. */
  canSetUpSender: boolean;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useLock();

  if (!status.canSend) {
    return canSetUpSender ? (
      <>
        <p className={styles.description}>{copy.noSenderCanSetUp}</p>
        {/* Satu-satunya aksi kartu: tombol (44 px di HP), bukan tautan sebaris (P5). */}
        <div className={styles.actions}>
          <Button asChild variant="secondary">
            <Link to="/pengaturan/email">{copy.setUpSender}</Link>
          </Button>
        </div>
      </>
    ) : (
      <p className={styles.description}>{copy.noSender}</p>
    );
  }

  const send = async () => {
    if (pending || lock.locked) return;
    setPending(true);
    setError(null);
    setSent(false);
    try {
      await endpoints.emailVerification.send();
      setSent(true);
    } catch (caught) {
      // Ternyata sudah terverifikasi (mis. lewat tab lain): muat ulang statusnya.
      if (isApiError(caught) && caught.status === 409) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.emailVerification });
        return;
      }
      if (isApiError(caught) && caught.status === 429 && caught.retryAfterSeconds) {
        lock.lockFor(caught.retryAfterSeconds);
      }
      setError(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <p className={styles.description}>{copy.unverifiedBody}</p>
      <div className={styles.actions}>
        <SubmitButton
          type="button"
          size="md"
          variant="secondary"
          onClick={() => void send()}
          pending={pending}
          pendingLabel={copy.sending}
          lock={lock}
        >
          {sent ? copy.resend : copy.send}
        </SubmitButton>
      </div>
      {sent ? (
        <Notice tone="success" role="status">
          {copy.sent(status.email)}
        </Notice>
      ) : error ? (
        <FormErrorNotice error={error} lock={lock} lockedTitle={copy.lockedTitle} />
      ) : null}
    </>
  );
}
