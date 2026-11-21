import { BrandLogo } from '../../brand/BrandLogo';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { usePageTitle } from '../../lib/use-page-title';
import styles from './Setup.module.css';

/** Kerangka wizard: daftar langkah di kiri (desktop), kartu langkah dengan dua kolom isian. */
export function SetupSkeleton() {
  usePageTitle(t.setup.documentTitle);
  return (
    <SkeletonRegion className={styles.screen}>
      <aside className={styles.sidebar}>
        <BrandLogo className={styles.logo} />
        <div className={styles.sidebarIntro}>
          <Skeleton className={styles.skeletonShort} />
          <Skeleton className={styles.skeletonLine} />
          <Skeleton className={styles.skeletonLine} />
        </div>
        <div className={styles.steps}>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div key={index} className={styles.skeletonStep}>
              <Skeleton className={styles.skeletonMarker} />
              <Skeleton className={styles.skeletonShort} />
            </div>
          ))}
        </div>
      </aside>
      <header className={styles.topbar}>
        <BrandLogo className={styles.topLogo} />
        <Skeleton className={styles.skeletonShort} />
      </header>
      <div className={styles.main}>
        <div className={styles.form}>
          <div className={styles.content}>
            <div className={styles.stepHead}>
              <Skeleton className={styles.skeletonShort} />
              <Skeleton className={styles.skeletonTitle} />
              <Skeleton className={styles.skeletonLine} />
            </div>
            {[0, 1].map((index) => (
              <div key={index} className={styles.skeletonField}>
                <Skeleton className={styles.skeletonShort} />
                <Skeleton className={styles.skeletonInput} />
              </div>
            ))}
          </div>
          <div className={styles.actions}>
            <span className={styles.spacer} />
            <Skeleton className={styles.skeletonButton} />
          </div>
        </div>
      </div>
    </SkeletonRegion>
  );
}
