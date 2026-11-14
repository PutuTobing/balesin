import { PageHeader } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { usePageMeta } from '../../components/ui/page-meta';
import pageStyles from '../../components/shell/PageSkeleton.module.css';
import { t } from '../../i18n/id';
import { usePageTitle } from '../../lib/use-page-title';
import styles from './Security.module.css';

/** Kerangka Keamanan akun: dua kartu dengan judul, status, teks, dan tombol di posisi jadi. */
export function SecuritySkeleton() {
  const meta = usePageMeta();
  usePageTitle(meta?.title ?? t.security.title);
  return (
    <div className={pageStyles.page}>
      <PageHeader title={meta?.title} parent={meta?.parent} />
      <SkeletonRegion className={pageStyles.body}>
        <div className={styles.content}>
          <div className={styles.card}>
            <div className={styles.cardHead}>
              <div className={styles.titleRow}>
                <Skeleton className={styles.skeletonTitle} />
                <Skeleton className={styles.skeletonBadge} />
              </div>
              <Skeleton className={styles.skeletonLine} />
              <Skeleton className={styles.skeletonShort} />
            </div>
            <Skeleton className={styles.skeletonButton} />
          </div>
          <div className={styles.card}>
            <div className={styles.cardHead}>
              <Skeleton className={styles.skeletonTitle} />
              <Skeleton className={styles.skeletonLine} />
            </div>
            <Skeleton className={styles.skeletonStat} />
            <Skeleton className={styles.skeletonButton} />
          </div>
        </div>
      </SkeletonRegion>
    </div>
  );
}
