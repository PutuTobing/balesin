import {
  BACKUP_CODE_COUNT,
  USER_ROLE_LABELS,
  type BackupCodes,
  type TwoFactorStatusResponse,
} from '@balesin/shared';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { t } from '../../i18n/id';
import { endpoints } from '../../lib/api/endpoints';
import { queryKeys, twoFactorStatusQuery } from '../../lib/api/queries';
import { formatDate } from '../../lib/format';
import { useSession } from '../auth/session';
import { BackupCodesPanel } from '../two-factor/BackupCodesPanel';
import { BACKUP_CODES_LOW } from '../two-factor/constants';
import { ReauthForm } from './ReauthForm';
import { TwoFactorBadge } from './TwoFactorBadge';
import styles from './Security.module.css';

const copy = t.security;
const TWO_FACTOR_HEADING_ID = 'keamanan-2fa';
const BACKUP_HEADING_ID = 'keamanan-kode-cadangan';

/**
 * Pengaturan → Keamanan akun (semua peran): status 2FA, sisa kode cadangan, buat ulang kode
 * cadangan, dan menonaktifkan 2FA bagi peran yang tidak wajib. Status sudah dimuat loader rute.
 */
export function SecurityPage() {
  const session = useSession();
  const { data: status } = useSuspenseQuery(twoFactorStatusQuery);
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.twoFactorStatus });

  return (
    <Page>
      <div className={styles.content}>
        {notice ? (
          <Notice tone="success" role="status">
            {notice}
          </Notice>
        ) : null}
        <TwoFactorCard
          status={status}
          roleLabel={session ? USER_ROLE_LABELS[session.user.role] : ''}
          onDisabled={() => {
            setNotice(copy.disable.done);
            void refresh();
          }}
        />
        {status.enabled ? (
          <BackupCodesCard
            status={status}
            email={session?.user.email ?? ''}
            onRegenerated={() => {
              setNotice(null);
              void refresh();
            }}
          />
        ) : null}
      </div>
    </Page>
  );
}

function TwoFactorCard({
  status,
  roleLabel,
  onDisabled,
}: {
  status: TwoFactorStatusResponse;
  roleLabel: string;
  onDisabled: () => void;
}) {
  const [disabling, setDisabling] = useState(false);
  const canDisable = status.enabled && !status.required;

  return (
    <section className={styles.card} aria-labelledby={TWO_FACTOR_HEADING_ID}>
      <div className={styles.cardHead}>
        <div className={styles.titleRow}>
          <h2 id={TWO_FACTOR_HEADING_ID} className={styles.cardTitle}>
            {copy.twoFactor.title}
          </h2>
          <TwoFactorBadge enabled={status.enabled} />
        </div>
        <p className={styles.text}>{copy.twoFactor.body}</p>
        {status.enabled && status.enabledAt ? (
          <p className={styles.meta}>{copy.twoFactor.since(formatDate(status.enabledAt))}</p>
        ) : null}
      </div>

      {status.required ? (
        // Peran wajib: penjelasan, bukan tombol mati.
        <p className={styles.explain}>
          <Icon icon={ShieldCheck} size={20} className={styles.explainIcon} />
          <span>{copy.twoFactor.required(roleLabel)}</span>
        </p>
      ) : !status.enabled ? (
        <>
          <p className={styles.text}>{copy.twoFactor.recommended}</p>
          <div className={styles.actions}>
            <Button asChild variant="primary" size="lg">
              <Link to="/pengaturan/keamanan/aktifkan">{copy.twoFactor.enable}</Link>
            </Button>
          </div>
        </>
      ) : null}

      {canDisable ? (
        disabling ? (
          <ReauthForm
            title={copy.disable.title}
            body={copy.disable.body}
            submitLabel={copy.disable.action}
            pendingLabel={copy.disable.submitting}
            onSubmit={async (body) => {
              await endpoints.twoFactor.disable(body);
              setDisabling(false);
              onDisabled();
            }}
            onCancel={() => setDisabling(false)}
          />
        ) : (
          <div className={styles.actions}>
            <Button onClick={() => setDisabling(true)}>{copy.disable.title}</Button>
          </div>
        )
      ) : null}
    </section>
  );
}

function BackupCodesCard({
  status,
  email,
  onRegenerated,
}: {
  status: TwoFactorStatusResponse;
  email: string;
  onRegenerated: () => void;
}) {
  const [regenerating, setRegenerating] = useState(false);
  // Kode baru hanya di state kartu ini; hilang begitu panel ditutup atau halaman ditinggalkan.
  const [codes, setCodes] = useState<BackupCodes | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [returnFocus, setReturnFocus] = useState(0);
  const remaining = status.backupCodesRemaining;
  const low = remaining <= BACKUP_CODES_LOW;

  useEffect(() => {
    if (returnFocus > 0) headingRef.current?.focus();
  }, [returnFocus]);

  if (codes) {
    return (
      <section className={styles.card} aria-label={copy.backupCodes.title}>
        <BackupCodesPanel
          codes={codes}
          email={email}
          variant="regenerated"
          headingLevel={2}
          continueLabel={t.twoFactor.backupCodes.done}
          onDone={() => {
            setCodes(null);
            setReturnFocus((tick) => tick + 1);
          }}
        />
      </section>
    );
  }

  return (
    <section className={styles.card} aria-labelledby={BACKUP_HEADING_ID}>
      <div className={styles.cardHead}>
        <h2 id={BACKUP_HEADING_ID} ref={headingRef} tabIndex={-1} className={styles.cardTitle}>
          {copy.backupCodes.title}
        </h2>
        <p className={styles.text}>{copy.backupCodes.body}</p>
      </div>
      <div className={styles.stat}>
        <span className={styles.statValue} data-low={low ? '' : undefined}>
          {copy.backupCodes.remaining(remaining, BACKUP_CODE_COUNT)}
        </span>
        {status.backupCodesGeneratedAt ? (
          <span className={styles.meta}>
            {copy.backupCodes.generated(formatDate(status.backupCodesGeneratedAt))}
          </span>
        ) : null}
      </div>
      {low ? (
        // Angkanya sudah tampil besar di atas; judul hanya bila sudah habis.
        <Notice
          tone={remaining === 0 ? 'danger' : 'warning'}
          title={remaining === 0 ? copy.backupCodes.emptyTitle : undefined}
        >
          {copy.backupCodes.lowBody}
        </Notice>
      ) : null}
      {regenerating ? (
        <ReauthForm
          title={copy.backupCodes.regenerateTitle}
          body={copy.backupCodes.regenerateBody}
          submitLabel={copy.backupCodes.regenerate}
          pendingLabel={copy.backupCodes.regenerating}
          onSubmit={async (body) => {
            const result = await endpoints.twoFactor.regenerateBackupCodes(body);
            setRegenerating(false);
            setCodes(result);
            onRegenerated();
          }}
          onCancel={() => setRegenerating(false)}
        />
      ) : (
        <div className={styles.actions}>
          <Button variant={low ? 'primary' : 'secondary'} onClick={() => setRegenerating(true)}>
            {copy.backupCodes.regenerate}
          </Button>
        </div>
      )}
    </section>
  );
}
