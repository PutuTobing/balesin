import {
  AUDIT_TARGET_TYPES,
  AUDIT_TARGET_TYPE_LABELS,
  USER_ROLE_LABELS,
  auditActionLabel,
  type AuditLogEntry,
  type AuditTargetType,
} from '@balesin/shared';
import { Skeleton } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { formatDateTime } from '../../lib/format';
import { metadataLabel, metadataValue } from './audit-metadata';
import styles from './Audit.module.css';

const copy = t.audit;

function targetTypeLabel(type: string): string {
  return (AUDIT_TARGET_TYPES as readonly string[]).includes(type)
    ? AUDIT_TARGET_TYPE_LABELS[type as AuditTargetType]
    : type;
}

/** Satu entri audit log: tabel di desktop (kolom), kartu bertumpuk di HP. */
export function AuditEntryItem({ entry }: { entry: AuditLogEntry }) {
  const label = auditActionLabel(entry.action);
  const metadata = Object.entries(entry.metadata);
  const known = label !== entry.action;
  return (
    <li className={styles.entry}>
      <div className={styles.cellTime}>
        <span className="sr-only">{copy.columns.time}: </span>
        <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
      </div>
      <div className={styles.cellAction}>
        <span className={styles.cellLabel}>
          {copy.columns.action}
          <span className="sr-only">:</span>{' '}
        </span>
        <span className={known ? styles.actionLabel : styles.actionCode}>{label}</span>
      </div>
      <div className={styles.cellActor}>
        <span className={styles.cellLabel}>
          {copy.columns.actor}
          <span className="sr-only">:</span>{' '}
        </span>
        <span className={styles.values}>
          {entry.actor ? (
            <>
              <span className={styles.primaryText}>{entry.actor.name}</span>
              <span className={styles.secondaryText}>{USER_ROLE_LABELS[entry.actor.role]}</span>
            </>
          ) : (
            <span className={styles.secondaryText}>{copy.system}</span>
          )}
        </span>
      </div>
      <div className={styles.cellTarget}>
        <span className={styles.cellLabel}>
          {copy.columns.target}
          <span className="sr-only">:</span>{' '}
        </span>
        <span className={styles.values}>
          {entry.target ? (
            <>
              <span className={styles.secondaryText}>{targetTypeLabel(entry.target.type)}</span>
              {entry.target.name ? (
                <span className={styles.primaryText}>{entry.target.name}</span>
              ) : entry.target.id ? (
                <span className={`${styles.mono} ${styles.targetId}`} title={entry.target.id}>
                  {entry.target.id}
                </span>
              ) : null}
            </>
          ) : (
            <span className={styles.secondaryText}>{copy.unknownTarget}</span>
          )}
        </span>
      </div>
      <div className={styles.cellOrigin}>
        <span className={styles.cellLabel}>
          {copy.columns.origin}
          <span className="sr-only">:</span>{' '}
        </span>
        <span className={styles.values}>
          {entry.ipAddress || entry.device ? (
            <>
              {entry.ipAddress ? <span className={styles.mono}>{entry.ipAddress}</span> : null}
              {entry.device ? <span className={styles.secondaryText}>{entry.device}</span> : null}
            </>
          ) : (
            <span className={styles.secondaryText}>{copy.noOrigin}</span>
          )}
        </span>
      </div>
      {metadata.length > 0 ? (
        <details className={styles.details}>
          <summary className={styles.summary}>{copy.details}</summary>
          <dl className={styles.metadata}>
            {metadata.map(([key, value]) => (
              <div key={key} className={styles.metadataRow}>
                <dt className={styles.metadataKey}>{metadataLabel(key)}</dt>
                <dd className={styles.metadataValue}>{metadataValue(value)}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </li>
  );
}

/** Kerangka baris entri (ukuran sama dengan baris jadi). */
export function AuditEntrySkeleton() {
  return (
    <div className={styles.entry}>
      <div className={styles.cellTime}>
        <Skeleton className={styles.skeletonShort} />
      </div>
      <div className={styles.cellAction}>
        <Skeleton className={styles.skeletonLong} />
      </div>
      <div className={styles.cellActor}>
        <Skeleton className={styles.skeletonMedium} />
        <Skeleton className={styles.skeletonShort} />
      </div>
      <div className={styles.cellTarget}>
        <Skeleton className={styles.skeletonShort} />
        <Skeleton className={styles.skeletonMedium} />
      </div>
      <div className={styles.cellOrigin}>
        <Skeleton className={styles.skeletonMedium} />
        <Skeleton className={styles.skeletonShort} />
      </div>
    </div>
  );
}
