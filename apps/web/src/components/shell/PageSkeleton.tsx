import { Skeleton, SkeletonRegion } from '../ui/Skeleton';
import styles from './PageSkeleton.module.css';

const ROWS = 6;

/** Kerangka memuat untuk halaman satu kolom: tampil saat isi halaman belum siap. */
export function PageSkeleton() {
  return (
    <SkeletonRegion className={styles.page}>
      <div className={styles.header}>
        <Skeleton className={styles.title} />
      </div>
      <div className={styles.body}>
        <div className={styles.card}>
          {Array.from({ length: ROWS }, (_, index) => (
            <div key={index} className={styles.row}>
              <Skeleton className={styles.avatar} />
              <div className={styles.lines}>
                <Skeleton className={styles.lineShort} />
                <Skeleton className={styles.lineLong} />
              </div>
              <Skeleton className={styles.meta} />
            </div>
          ))}
        </div>
      </div>
    </SkeletonRegion>
  );
}
