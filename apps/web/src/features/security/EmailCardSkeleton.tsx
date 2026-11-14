import { Skeleton } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { useSession } from '../auth/session';
import styles from './Security.module.css';

const copy = t.security.email;

/** Kerangka kartu Email akun: judul dan alamat email (dari sesi) asli, status berupa balok. */
export function EmailCardSkeleton() {
  const session = useSession();
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <div className={styles.titleRow}>
          <h2 className={styles.cardTitle}>{copy.title}</h2>
          <Skeleton className={styles.skeletonBadge} />
        </div>
        <p className={styles.emailAddress}>{session?.user.email}</p>
        <Skeleton className={styles.skeletonMeta} />
      </div>
    </section>
  );
}
