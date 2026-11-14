import type { BackupCodes } from '@balesin/shared';
import { CircleCheck, Download } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useBrand } from '../../brand/brand';
import { Button } from '../../components/ui/Button';
import { CopyButton } from '../../components/ui/CopyButton';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { describedBy } from '../../lib/form';
import { backupCodesFileContent, backupCodesFileName, downloadTextFile } from './backup-file';
import styles from './TwoFactor.module.css';

const copy = t.twoFactor.backupCodes;

interface BackupCodesPanelProps {
  codes: BackupCodes;
  /** Email akun (dicetak di berkas unduhan). */
  email: string;
  /** `enrolled`: tepat setelah 2FA aktif. `regenerated`: kode baru dari Keamanan akun. */
  variant: 'enrolled' | 'regenerated';
  /** Level judul: 1 di layar sendiri, 2 di dalam halaman Keamanan akun. */
  headingLevel: 1 | 2;
  /** Label tombol lanjut (mis. "Lanjut ke Inbox", "Selesai"). */
  continueLabel: string;
  /** Dipanggil setelah pengguna menyatakan kode sudah disimpan. */
  onDone: () => void;
}

/**
 * Kode cadangan yang hanya ditampilkan SEKALI. Kode hanya ada di props/state (tidak di cache
 * Query atau penyimpanan browser) dan hilang begitu panel ditutup. Pengguna diminta menyalin
 * atau mengunduhnya dan mencentang "sudah disimpan" sebelum lanjut; menutup/memuat ulang tab
 * sebelum itu meminta konfirmasi browser.
 */
export function BackupCodesPanel({
  codes,
  email,
  variant,
  headingLevel,
  continueLabel,
  onDone,
}: BackupCodesPanelProps) {
  const { productName } = useBrand();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const checkboxRef = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkboxId = useId();
  const errorId = `${checkboxId}-galat`;
  const Heading = headingLevel === 1 ? 'h1' : 'h2';

  // Layar baru: fokus ke judul supaya pembaca layar mulai dari atas.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Kode belum dinyatakan tersimpan: tutup tab / muat ulang minta konfirmasi.
  useEffect(() => {
    if (saved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saved]);

  const allCodes = codes.codes.join('\n');

  const download = () => {
    downloadTextFile(
      backupCodesFileName(productName),
      backupCodesFileContent({
        productName,
        email,
        codes: codes.codes,
        generatedAt: codes.generatedAt,
      }),
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!saved) {
      setError(copy.confirmRequired);
      checkboxRef.current?.focus();
      return;
    }
    onDone();
  };

  return (
    <form className={styles.codesPanel} onSubmit={submit} noValidate>
      <div className={styles.sectionHead}>
        {variant === 'enrolled' ? (
          <p className={styles.successEyebrow}>
            <Icon icon={CircleCheck} size={16} />
            {copy.eyebrow}
          </p>
        ) : null}
        <Heading
          ref={headingRef}
          tabIndex={-1}
          className={cx(styles.panelTitle, headingLevel === 2 && styles.panelTitleSmall)}
        >
          {variant === 'enrolled' ? copy.title : copy.newTitle}
        </Heading>
        <p className={styles.stepText}>{copy.body}</p>
      </div>
      <Notice tone="warning" title={copy.onlyOnce}>
        {variant === 'enrolled' ? copy.onlyOnceBody : copy.replacedBody}
      </Notice>
      <ol className={styles.codes} aria-label={copy.listLabel}>
        {codes.codes.map((code, index) => (
          <li key={code} className={styles.code}>
            <span className={styles.codeIndex} aria-hidden="true">
              {index + 1}
            </span>
            <code className={styles.codeText}>{code}</code>
          </li>
        ))}
      </ol>
      <div className={styles.codeActions}>
        <CopyButton
          text={allCodes}
          label={copy.copyAll}
          copiedLabel={copy.copied}
          announcement={copy.copiedAnnouncement}
        />
        <Button onClick={download}>
          <Icon icon={Download} size={16} />
          {copy.download}
        </Button>
      </div>
      <div className={styles.check}>
        <label
          htmlFor={checkboxId}
          className={styles.checkLabel}
          data-invalid={error ? '' : undefined}
        >
          <input
            ref={checkboxRef}
            id={checkboxId}
            type="checkbox"
            className={styles.checkbox}
            checked={saved}
            onChange={(event) => {
              setSaved(event.target.checked);
              if (event.target.checked) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(error ? errorId : undefined)}
          />
          <span>{copy.confirm}</span>
        </label>
        {error ? (
          <p id={errorId} className={styles.checkError}>
            {error}
          </p>
        ) : null}
      </div>
      <Button type="submit" variant="primary" size="lg" className={styles.codesSubmit}>
        {continueLabel}
      </Button>
    </form>
  );
}
