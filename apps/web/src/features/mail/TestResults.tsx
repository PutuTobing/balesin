import type { TestMailAccountResponse } from '@balesin/shared';
import {
  Check,
  CircleAlert,
  Info,
  LoaderCircle,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { testRows, type Row, type Tone } from './test-rows';
import styles from './Wizard.module.css';

const w = t.mail.wizard;

const TONE_ICONS: Record<Tone, LucideIcon> = {
  ok: Check,
  fail: CircleAlert,
  warn: TriangleAlert,
  info: Info,
  pending: LoaderCircle,
};

/** Daftar hasil tes (atau baris "sedang dites" saat menunggu). */
export function TestResults({
  result,
  pending,
  emailAddress,
}: {
  result: TestMailAccountResponse | null;
  pending: boolean;
  emailAddress: string;
}) {
  const rows: Row[] = pending
    ? [
        { key: 'incoming', tone: 'pending', title: w.incomingTitle, body: w.testingTitle },
        { key: 'outgoing', tone: 'pending', title: w.outgoingTitle, body: w.testingTitle },
      ]
    : result
      ? testRows(result, emailAddress)
      : [];
  if (rows.length === 0) return null;
  return (
    <ul className={styles.results} aria-busy={pending || undefined}>
      {rows.map((row) => (
        <li key={row.key} className={styles.result} data-tone={row.tone}>
          <span className={styles.resultIcon} aria-hidden="true">
            <Icon
              icon={TONE_ICONS[row.tone]}
              size={16}
              className={cx(row.tone === 'pending' && styles.spin)}
            />
          </span>
          <span className={styles.resultText}>
            <span className={styles.resultTitle}>{row.title}</span>
            <span className={styles.resultBody}>{row.body}</span>
          </span>
          {row.durationMs ? (
            <span className={styles.resultTime}>{w.seconds(row.durationMs)}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
