import { t } from '../../i18n/id';
import { AuditEntrySkeleton } from './AuditEntryItem';
import styles from './Audit.module.css';

const copy = t.audit;

/** Kerangka daftar: kepala kolom asli dan lima baris balok. */
export function AuditListSkeleton() {
  return (
    <div className={styles.listCard}>
      <div className={styles.listHead}>
        <span>{copy.columns.time}</span>
        <span>{copy.columns.action}</span>
        <span>{copy.columns.actor}</span>
        <span>{copy.columns.target}</span>
        <span>{copy.columns.origin}</span>
      </div>
      <div className={styles.list}>
        {[0, 1, 2, 3, 4].map((index) => (
          <AuditEntrySkeleton key={index} />
        ))}
      </div>
    </div>
  );
}
