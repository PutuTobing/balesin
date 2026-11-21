import { Download } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { LoadFailedIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { FormErrorNotice } from '../../components/ui/FormErrorNotice';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { fileNameFrom, saveBlob } from '../../lib/download';
import { formatClock } from '../../lib/format';
import { useLock } from '../../lib/use-lock';
import styles from './Reports.module.css';

const r = t.reports;

export interface ExportParams {
  kind: string;
  from?: string;
  to?: string;
  month?: string;
  channelId?: string;
}

/**
 * Unduh CSV laporan: `GET` ber-CSRF lewat `fetch` → Blob (bukan tautan langsung; server mengaudit).
 * 429 → tombol terkunci dengan hitung mundur.
 */
export function ExportButton({ params, what }: { params: ExportParams; what: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const lock = useLock();
  const run = async () => {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const { blob, headers } = await endpoints.reports.exportCsv(params);
      const period = params.month ?? `${params.from ?? ''}_${params.to ?? ''}`;
      saveBlob(blob, fileNameFrom(headers, r.exportFileName(params.kind, period)));
      setDone(true);
    } catch (caught) {
      if (isApiError(caught) && caught.status === 429 && caught.retryAfterSeconds) {
        lock.lockFor(caught.retryAfterSeconds);
      }
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.export}>
      <Button
        variant="ghost"
        loading={busy}
        disabled={lock.locked}
        aria-label={r.exportLabel(what)}
        onClick={() => void run()}
      >
        {busy ? null : <Icon icon={Download} size={16} />}
        {busy ? r.exporting : lock.locked ? r.retryIn(formatClock(lock.secondsLeft)) : r.exportCsv}
      </Button>
      {error ? (
        <FormErrorNotice error={error} lock={lock} lockedTitle={r.exportLockedTitle} />
      ) : done ? (
        <p className={styles.exportDone} role="status">
          {r.exported}
        </p>
      ) : null}
    </div>
  );
}

/** Gagal memuat laporan: 429 (hitung mundur), 503 (terlalu berat), selain itu umum. */
export function ReportError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const lock = useLock();
  const limited = isApiError(error) && error.status === 429;
  const seconds = isApiError(error) ? error.retryAfterSeconds : null;
  const { lockFor } = lock;
  useEffect(() => {
    if (limited && seconds) lockFor(seconds);
  }, [limited, seconds, lockFor]);
  if (isApiError(error) && error.status === 503) {
    return (
      <Notice
        tone="warning"
        role="alert"
        title={r.heavyTitle}
        actions={<Button onClick={onRetry}>{t.common.retry}</Button>}
      >
        {r.heavyBody}
      </Notice>
    );
  }
  if (limited) {
    return (
      <Notice
        tone="warning"
        role="alert"
        title={r.limitedTitle}
        actions={
          <Button onClick={onRetry} disabled={lock.locked}>
            {lock.locked ? r.retryIn(formatClock(lock.secondsLeft)) : t.common.retry}
          </Button>
        }
      >
        {r.limitedBody}
      </Notice>
    );
  }
  return (
    <EmptyState
      illustration={<LoadFailedIllustration />}
      title={r.loadFailedTitle}
      body={isApiError(error) ? error.message : t.api.network}
      actions={
        <Button variant="primary" onClick={onRetry}>
          {t.common.retry}
        </Button>
      }
    />
  );
}

/** Kartu bagian laporan: judul + aksi (ekspor) + isi. */
export function ReportSection({
  id,
  title,
  hint,
  actions,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={styles.card} aria-labelledby={id}>
      <div className={styles.cardHead}>
        <div className={styles.cardHeadText}>
          <h2 id={id} className={styles.cardTitle}>
            {title}
          </h2>
          {hint ? <p className={styles.hint}>{hint}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Ubin angka: label, nilai utama, keterangan. */
export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string | null;
}) {
  return (
    <div className={styles.tile}>
      <dt className={styles.tileLabel}>{label}</dt>
      <dd className={styles.tileValue}>{value}</dd>
      {detail ? <dd className={styles.tileDetail}>{detail}</dd> : null}
    </div>
  );
}
