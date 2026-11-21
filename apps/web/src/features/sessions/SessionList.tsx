import type { ActiveSession } from '@balesin/shared';
import { Monitor, Smartphone } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { formatDateTimeInline } from '../../lib/format';
import { isMobileDevice, revokeSessionButtonId } from './session-device';
import styles from './Sessions.module.css';

const copy = t.sessions;

interface SessionListProps {
  sessions: readonly ActiveSession[];
  /**
   * Keluarkan satu sesi. Kosong = daftar hanya dilihat. Sesi yang sedang dipakai (`current`)
   * tidak pernah diberi tombol: keluar dari sesi ini lewat tombol Keluar.
   */
  onRevoke?: (session: ActiveSession) => void;
  busyId?: string | null;
  error?: { id: string; message: string } | null;
  /** Nama aksesibel daftar (bawaan "Daftar sesi aktif"). */
  label?: string;
}

/** Daftar sesi aktif: perangkat ringkas, IP tersamar dari server, waktu masuk & terakhir aktif. */
export function SessionList({
  sessions,
  onRevoke,
  busyId = null,
  error = null,
  label,
}: SessionListProps) {
  return (
    <ul className={styles.list} aria-label={label ?? copy.listLabel}>
      {sessions.map((session) => (
        <li key={session.id} className={styles.row}>
          <span className={styles.icon}>
            <Icon icon={isMobileDevice(session.device) ? Smartphone : Monitor} size={20} />
          </span>
          <div className={styles.main}>
            <p className={styles.device}>
              <span className={styles.deviceName}>{session.device}</span>
              {session.current ? <span className={styles.tag}>{copy.current}</span> : null}
              {session.limited ? <span className={styles.tagMuted}>{copy.limited}</span> : null}
            </p>
            <p className={styles.meta}>
              <span className={styles.segment}>
                {session.ipAddress ? copy.ip(session.ipAddress) : copy.unknownIp}
                <span aria-hidden="true">{' ·'}</span>
                <span className="sr-only">.</span>
              </span>{' '}
              <span className={styles.segment}>
                {copy.signedIn(formatDateTimeInline(session.createdAt))}
                <span aria-hidden="true">{' ·'}</span>
                <span className="sr-only">.</span>
              </span>{' '}
              <span className={styles.segment}>
                {copy.lastSeen(formatDateTimeInline(session.lastSeenAt))}
              </span>
            </p>
          </div>
          {onRevoke && !session.current ? (
            <Button
              id={revokeSessionButtonId(session.id)}
              variant="ghost"
              className={styles.revoke}
              aria-label={copy.revokeLabel(session.device)}
              onClick={() => onRevoke(session)}
              loading={busyId === session.id}
              disabled={busyId !== null}
            >
              {busyId === session.id ? copy.revoking : copy.revoke}
            </Button>
          ) : null}
          {error?.id === session.id ? (
            <Notice tone="danger" role="alert" className={styles.rowError}>
              {error.message}
            </Notice>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Kerangka daftar sesi: baris dengan ikon, nama perangkat, dan keterangan berupa balok. */
export function SessionListSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className={styles.list}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={styles.row}>
          <Skeleton className={styles.skeletonIcon} />
          <div className={styles.main}>
            <Skeleton className={styles.skeletonDevice} />
            <Skeleton className={styles.skeletonMeta} />
          </div>
        </div>
      ))}
    </div>
  );
}
