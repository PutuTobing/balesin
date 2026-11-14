import { BrandLogo } from '../../brand/BrandLogo';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { usePageTitle } from '../../lib/use-page-title';
import styles from './TwoFactor.module.css';

/** Kerangka layar pendaftaran wajib: bilah atas, judul, lalu tiga langkah di posisi jadi. */
export function EnrollmentSkeleton() {
  usePageTitle(t.twoFactor.enroll.title);
  return (
    <div className={styles.screen}>
      <header className={styles.topbar}>
        <BrandLogo className={styles.topLogo} />
      </header>
      <SkeletonRegion className={styles.main}>
        <div className={styles.card}>
          <div className={styles.intro}>
            <Skeleton className={styles.skeletonLabel} />
            <Skeleton className={styles.skeletonTitle} />
            <Skeleton className={styles.skeletonLine} />
            <Skeleton className={styles.skeletonLine} />
          </div>
          <div className={styles.steps}>
            {[0, 1, 2].map((index) => (
              <div key={index} className={styles.step}>
                <Skeleton className={styles.marker} />
                <div className={styles.stepBody}>
                  <Skeleton className={styles.skeletonLabel} />
                  <Skeleton className={styles.skeletonLine} />
                  {index === 1 ? <Skeleton className={styles.qrSkeleton} /> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      </SkeletonRegion>
    </div>
  );
}
