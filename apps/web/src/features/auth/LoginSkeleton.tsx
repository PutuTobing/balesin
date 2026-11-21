import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { usePageTitle } from '../../lib/use-page-title';
import styles from './Login.module.css';
import skeleton from './LoginSkeleton.module.css';

/** Kerangka halaman masuk: posisi logo, judul, dua kolom, dan tombol sama dengan layar jadi. */
export function LoginSkeleton() {
  usePageTitle(t.auth.login.title);
  return (
    <div className={styles.screen}>
      <SkeletonRegion className={styles.pane}>
        <div className={styles.inner}>
          <Skeleton className={skeleton.logo} />
          <div className={styles.head}>
            <Skeleton className={skeleton.title} />
            <Skeleton className={skeleton.line} />
          </div>
          <div className={styles.form}>
            {[0, 1].map((index) => (
              <div key={index} className={skeleton.field}>
                <Skeleton className={skeleton.label} />
                <Skeleton className={skeleton.input} />
              </div>
            ))}
            <Skeleton className={skeleton.button} />
          </div>
        </div>
      </SkeletonRegion>
      <div className={styles.hero} />
    </div>
  );
}
