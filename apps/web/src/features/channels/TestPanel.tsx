import type { ChannelTestResult } from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { FormErrorNotice } from '../../components/ui/FormErrorNotice';
import { Notice } from '../../components/ui/Notice';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { useLock } from '../../lib/use-lock';
import { applyTestResult } from './channel-cache';
import styles from './Channels.module.css';
import { NumberFacts } from './NumberFacts';

const copy = t.channels.test;

/**
 * Tombol "Tes koneksi" + hasilnya. Server memakai kredensial TERSIMPAN; hasil gagal tetap 200
 * (`ok: false`) dengan `message` siap tampil. 429 (10 tes per 5 menit) → tombol terkunci dengan
 * hitung mundur dari `Retry-After`. Satu tes paling lama ±25 detik, jadi selama itu ada keterangan
 * proses di samping tombol.
 */
export function TestPanel({
  channelId,
  result,
  onResult,
  showNumber = false,
  failedHint,
  variant = 'primary',
}: {
  channelId: string;
  /** Hasil terakhir yang ditampilkan (dikendalikan pemanggil supaya tetap ada saat maju-mundur). */
  result: ChannelTestResult | null;
  onResult: (result: ChannelTestResult) => void;
  /** Tampilkan data nomor + peringatan dari hasil (wizard). Halaman nomor sudah punya ringkasannya. */
  showNumber?: boolean;
  failedHint?: string;
  variant?: 'primary' | 'secondary';
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useLock();
  const resultRef = useRef<HTMLDivElement>(null);
  const [resultTick, setResultTick] = useState(0);

  useEffect(() => {
    if (resultTick > 0) resultRef.current?.scrollIntoView({ block: 'nearest' });
  }, [resultTick]);

  const run = async () => {
    if (pending || lock.locked) return;
    setPending(true);
    setError(null);
    try {
      const next = await endpoints.channels.test(channelId);
      applyTestResult(queryClient, channelId, next);
      onResult(next);
      setResultTick((tick) => tick + 1);
    } catch (caught) {
      if (isApiError(caught) && caught.status === 429 && caught.retryAfterSeconds) {
        lock.lockFor(caught.retryAfterSeconds);
      }
      setError(caught);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={styles.form}>
      <div className={styles.actions}>
        <SubmitButton
          type="button"
          size="md"
          variant={variant}
          pending={pending}
          pendingLabel={copy.pending}
          lock={lock}
          onClick={() => void run()}
        >
          {copy.action}
        </SubmitButton>
        {pending ? (
          <span className={styles.hint} role="status">
            {copy.pendingNote}
          </span>
        ) : null}
      </div>
      {error ? <FormErrorNotice error={error} lock={lock} lockedTitle={copy.lockedTitle} /> : null}
      {result && !pending ? (
        <div ref={resultRef} className={styles.form}>
          <Notice
            tone={result.ok ? 'success' : 'danger'}
            role="status"
            // Pesan berhasil dari server sudah diawali "Koneksi berhasil.": tanpa judul ganda.
            title={result.ok ? undefined : copy.failedTitle}
          >
            <div className={styles.paragraphs}>
              <p>{result.message}</p>
              {!result.ok && failedHint ? <p>{failedHint}</p> : null}
            </div>
          </Notice>
          {showNumber && result.number ? <NumberFacts number={result.number} /> : null}
          {showNumber && result.warnings.length > 0 ? (
            <ul className={styles.warnings} aria-label={copy.warningsTitle}>
              {result.warnings.map((warning) => (
                <li key={warning.code}>
                  <Notice tone="warning">{warning.message}</Notice>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
