import {
  BACKUP_CODE_COUNT,
  USER_ROLE_LABELS,
  isTwoFactorRequired,
  type BackupCodes,
  type TwoFactorStatusResponse,
} from '@balesin/shared';
import { Link } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { endpoints } from '../../lib/api/endpoints';
import { formatDate } from '../../lib/format';
import { useSession } from '../auth/session';
import { BackupCodesPanel } from '../two-factor/BackupCodesPanel';
import { BACKUP_CODES_LOW } from '../two-factor/constants';
import { EmailCardSkeleton } from './EmailCardSkeleton';
import { IdentityDialog } from '../identity/IdentityDialog';
import { TwoFactorBadge } from './TwoFactorBadge';
import styles from './Security.module.css';

/*
 * Kartu Keamanan akun yang dipakai bersama halaman jadi (`SecurityPage`, dimuat terpisah) dan
 * kerangka memuatnya (`SecuritySkeleton`, ikut bundel utama). Dipisah supaya kerangka tidak
 * mengimpor halaman itu sendiri (lazy loading tetap bekerja) dan kartunya tetap satu sumber:
 * kerangka = kartu yang sama dengan `status: null`, jadi tidak ada lompatan saat data tiba.
 */

const copy = t.security;
const TWO_FACTOR_HEADING_ID = 'keamanan-2fa';
const BACKUP_HEADING_ID = 'keamanan-kode-cadangan';

/**
 * Isi kerangka memuat: kartu yang sama dengan layar jadi, sesuai peran (peran wajib = 2FA aktif,
 * dua kartu; peran lain = keadaan paling umum, belum aktif, satu kartu). Teks yang tidak butuh
 * data tampil asli; hanya lencana, tanggal, angka, dan tombol yang berupa balok.
 */
export function SecurityCardsSkeleton() {
  const session = useSession();
  const role = session?.user.role ?? 'owner';
  const required = isTwoFactorRequired(role);
  return (
    <div className={styles.content}>
      <TwoFactorCard status={null} required={required} roleLabel={USER_ROLE_LABELS[role]} />
      {required ? <BackupCodesCard status={null} email="" /> : null}
      <EmailCardSkeleton />
      {/*
        Tanpa kartu "Sesi aktif": tinggi kartu Email bergantung data (terverifikasi / belum / tanpa
        pengirim), jadi kartu di bawahnya baru tampil setelah data tiba (kritikus butir 6 W1).
      */}
    </div>
  );
}

export function TwoFactorCard({
  status,
  required = status?.required ?? false,
  roleLabel,
  onDisabled,
}: {
  /** `null` = kerangka memuat. */
  status: TwoFactorStatusResponse | null;
  required?: boolean;
  roleLabel: string;
  onDisabled?: () => void;
}) {
  const [disabling, setDisabling] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const loading = status === null;
  const enabled = loading ? required : status.enabled;
  const canDisable = !loading && status.enabled && !status.required;

  return (
    <section className={styles.card} aria-labelledby={TWO_FACTOR_HEADING_ID}>
      <div className={styles.cardHead}>
        <div className={styles.titleRow}>
          <h2 id={TWO_FACTOR_HEADING_ID} className={styles.cardTitle}>
            {copy.twoFactor.title}
          </h2>
          {loading ? (
            <Skeleton className={styles.skeletonBadge} />
          ) : (
            <TwoFactorBadge enabled={status.enabled} />
          )}
        </div>
        <p className={styles.text}>{copy.twoFactor.body}</p>
        {loading && enabled ? (
          <Skeleton className={styles.skeletonMeta} />
        ) : status?.enabled && status.enabledAt ? (
          <p className={styles.meta}>{copy.twoFactor.since(formatDate(status.enabledAt))}</p>
        ) : null}
      </div>

      {required ? (
        // Peran wajib: penjelasan, bukan tombol mati.
        <p className={styles.explain}>
          <Icon icon={ShieldCheck} size={20} className={styles.explainIcon} />
          <span>{copy.twoFactor.required(roleLabel)}</span>
        </p>
      ) : !enabled ? (
        <>
          <p className={styles.description}>{copy.twoFactor.recommended}</p>
          <div className={styles.actions}>
            {loading ? (
              <Skeleton className={styles.skeletonButtonLg} />
            ) : (
              <Button asChild variant="primary" size="lg">
                <Link to="/pengaturan/keamanan/aktifkan">{copy.twoFactor.enable}</Link>
              </Button>
            )}
          </div>
        </>
      ) : null}

      {canDisable ? (
        <>
          <div className={styles.actions}>
            <Button ref={triggerRef} onClick={() => setDisabling(true)}>
              {copy.disable.title}
            </Button>
          </div>
          {/* Konfirmasi identitas: dialog yang sama dengan semua aksi sensitif lain. */}
          <IdentityDialog
            open={disabling}
            title={copy.disable.dialogTitle}
            body={copy.disable.body}
            confirmLabel={copy.disable.action}
            pendingLabel={copy.disable.submitting}
            variant="danger"
            requireCode
            returnFocusRef={triggerRef}
            onCancel={() => setDisabling(false)}
            onConfirm={async (identity) => {
              // `requireCode`: dialog sudah memastikan kode terisi.
              await endpoints.twoFactor.disable({ ...identity, code: identity.code ?? '' });
              setDisabling(false);
              onDisabled?.();
            }}
          />
        </>
      ) : null}
    </section>
  );
}

export function BackupCodesCard({
  status,
  email,
  onRegenerated,
}: {
  /** `null` = kerangka memuat. */
  status: TwoFactorStatusResponse | null;
  email: string;
  onRegenerated?: () => void;
}) {
  const [regenerating, setRegenerating] = useState(false);
  // Kode baru hanya di state kartu ini; hilang begitu panel ditutup atau halaman ditinggalkan.
  const [codes, setCodes] = useState<BackupCodes | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Panel kode baru ditutup → fokus ke judul kartu (tombolnya baru muncul lagi).
  const [returnFocus, setReturnFocus] = useState<{ tick: number; to: 'heading' | 'trigger' }>({
    tick: 0,
    to: 'heading',
  });
  const remaining = status?.backupCodesRemaining ?? BACKUP_CODE_COUNT;
  const low = status !== null && remaining <= BACKUP_CODES_LOW;

  useEffect(() => {
    if (returnFocus.tick === 0) return;
    (returnFocus.to === 'heading' ? headingRef : triggerRef).current?.focus();
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
            setReturnFocus((value) => ({ tick: value.tick + 1, to: 'heading' }));
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
        {status === null ? (
          <>
            <Skeleton className={styles.skeletonStat} />
            <Skeleton className={styles.skeletonMeta} />
          </>
        ) : (
          <>
            <span className={styles.statValue} data-low={low ? '' : undefined}>
              {copy.backupCodes.remaining(remaining, BACKUP_CODE_COUNT)}
            </span>
            {status.backupCodesGeneratedAt ? (
              <span className={styles.meta}>
                {copy.backupCodes.generated(formatDate(status.backupCodesGeneratedAt))}
              </span>
            ) : null}
          </>
        )}
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
      {status === null ? (
        <div className={styles.actions}>
          <Skeleton className={styles.skeletonButton} />
        </div>
      ) : (
        <div className={styles.actions}>
          <Button
            ref={triggerRef}
            variant={low ? 'primary' : 'secondary'}
            onClick={() => setRegenerating(true)}
          >
            {copy.backupCodes.regenerate}
          </Button>
        </div>
      )}
      {status !== null ? (
        <IdentityDialog
          open={regenerating}
          title={copy.backupCodes.regenerateTitle}
          body={copy.backupCodes.regenerateBody}
          confirmLabel={copy.backupCodes.regenerate}
          pendingLabel={copy.backupCodes.regenerating}
          variant="primary"
          requireCode
          returnFocusRef={triggerRef}
          onCancel={() => setRegenerating(false)}
          onConfirm={async (identity) => {
            const result = await endpoints.twoFactor.regenerateBackupCodes({
              ...identity,
              code: identity.code ?? '',
            });
            setRegenerating(false);
            setCodes(result);
            onRegenerated?.();
          }}
        />
      ) : null}
    </section>
  );
}
