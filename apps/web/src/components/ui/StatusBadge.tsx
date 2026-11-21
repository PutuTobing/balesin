import { cx } from '../../lib/cx';
import styles from './StatusBadge.module.css';

export type StatusTone = 'success' | 'danger' | 'warning' | 'neutral';

/** Titik berwarna + label. Warna status hanya di titik; teks memakai varian `-ink`. */
export function StatusBadge({
  tone,
  label,
  className,
}: {
  tone: StatusTone;
  label: string;
  className?: string;
}) {
  return (
    <span className={cx(styles.badge, styles[tone], className)}>
      <span className={styles.dot} aria-hidden="true" />
      {label}
    </span>
  );
}
