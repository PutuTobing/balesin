import { emailAddressSchema, type EmailTestResult } from '@balesin/shared';
import { PlugZap, Send } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { formatTime } from '../../lib/format';
import { apiFieldErrors, type FieldErrors } from '../../lib/form';
import styles from './EmailSettings.module.css';

export type EmailTestKind = 'connection' | 'send';

/** `null` = isian form belum valid (form sendiri yang menandai isiannya). */
export type RunEmailTest = (kind: EmailTestKind, to?: string) => Promise<EmailTestResult | null>;

interface Outcome {
  kind: EmailTestKind;
  to?: string;
  result?: EmailTestResult;
  /** Permintaan ditolak (batas permintaan, server sibuk, dll.): pesan server apa adanya. */
  error?: string;
}

interface EmailTestPanelProps {
  defaultRecipient: string;
  run: RunEmailTest;
  disabled?: boolean;
  /** Keterangan tambahan di bawah judul (mis. tes memakai isian yang belum disimpan). */
  note?: string;
  size?: 'md' | 'lg';
  /** Dipanggil setiap ada hasil tes (wizard mencatat hasilnya untuk ringkasan). */
  onResult?: (kind: EmailTestKind, result: EmailTestResult) => void;
  /**
   * Server menolak isian (400 `VALIDATION_ERROR`, mis. `settings.port`): pesan per isian,
   * kunci tanpa awalan `settings.` (sama dengan nama isian form). Dipakai wizard dan Pengaturan.
   */
  onFieldErrors: (errors: FieldErrors) => void;
}

/** "Tes koneksi" dan "Kirim email tes" dengan hasil berbahasa Indonesia dari server. */
export function EmailTestPanel({
  defaultRecipient,
  run,
  disabled = false,
  note,
  size = 'md',
  onResult,
  onFieldErrors,
}: EmailTestPanelProps) {
  const headingId = useId();
  const [recipient, setRecipient] = useState(defaultRecipient);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [pending, setPending] = useState<EmailTestKind | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const start = async (kind: EmailTestKind) => {
    let to: string | undefined;
    if (kind === 'send') {
      const parsed = emailAddressSchema.safeParse(recipient);
      if (!parsed.success) {
        setRecipientError(parsed.error.issues[0]?.message ?? null);
        return;
      }
      setRecipientError(null);
      to = parsed.data;
    }
    setPending(kind);
    setOutcome(null);
    try {
      const result = await run(kind, to);
      if (result) {
        setOutcome({ kind, to, result });
        onResult?.(kind, result);
      }
    } catch (error) {
      if (isApiError(error) && error.code === 'VALIDATION_ERROR' && error.details.length > 0) {
        // Pesannya tampil di isian yang ditolak; tidak perlu kotak hasil tes.
        onFieldErrors(apiFieldErrors(error.details, 'settings.'));
        return;
      }
      setOutcome({ kind, error: isApiError(error) ? error.message : t.api.network });
    } finally {
      setPending(null);
    }
  };

  return (
    <section className={styles.testPanel} aria-labelledby={headingId}>
      <div className={styles.testHead}>
        <h3 id={headingId} className={styles.testTitle}>
          {t.emailSettings.testTitle}
        </h3>
        <p className={styles.testBody}>{note ?? t.emailSettings.testBody}</p>
      </div>
      <div className={styles.testActions}>
        <Button
          size={size}
          onClick={() => void start('connection')}
          loading={pending === 'connection'}
          disabled={disabled || pending !== null}
          className={styles.testButton}
        >
          {pending === 'connection' ? null : <Icon icon={PlugZap} size={16} />}
          {pending === 'connection'
            ? t.emailSettings.testingConnection
            : t.emailSettings.testConnection}
        </Button>
        <div className={styles.sendRow}>
          <TextField
            size={size}
            type="email"
            inputMode="email"
            label={t.emailSettings.sendTestTo}
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            error={recipientError}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            disabled={disabled}
            className={styles.sendField}
          />
          <Button
            size={size}
            onClick={() => void start('send')}
            loading={pending === 'send'}
            disabled={disabled || pending !== null}
            className={styles.sendButton}
          >
            {pending === 'send' ? null : <Icon icon={Send} size={16} />}
            {pending === 'send' ? t.emailSettings.sendingTest : t.emailSettings.sendTest}
          </Button>
        </div>
      </div>
      <div aria-live="polite">{outcome ? <TestOutcome outcome={outcome} /> : null}</div>
    </section>
  );
}

function TestOutcome({ outcome }: { outcome: Outcome }) {
  if (outcome.error) {
    return <Notice tone="danger">{outcome.error}</Notice>;
  }
  const result = outcome.result;
  if (!result) return null;
  const message =
    result.ok && outcome.kind === 'send' && outcome.to
      ? t.emailSettings.sendTestOk(outcome.to)
      : result.message;
  return (
    <Notice tone={result.ok ? 'success' : 'danger'}>
      <p>{message}</p>
      <p className={styles.testedAt}>{t.emailSettings.testedAt(formatTime(result.testedAt))}</p>
    </Notice>
  );
}
