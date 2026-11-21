import { t } from '../../i18n/id';
import { usePageTitle } from '../../lib/use-page-title';
import { PageHeader } from '../ui/Page';
import { Skeleton, SkeletonRegion } from '../ui/Skeleton';
import { usePageMeta } from '../ui/page-meta';
import styles from './PageSkeleton.module.css';

const ROWS = 6;

/**
 * Kerangka memuat untuk halaman satu kolom: tampil saat isi halaman belum siap.
 * Header (judul, tombol kembali) sudah diketahui dari rute, jadi tampil apa adanya;
 * hanya isi halaman yang berupa kerangka.
 */
export function PageSkeleton() {
  const meta = usePageMeta();
  usePageTitle(meta?.title ?? t.common.loading);

  return (
    <div className={styles.page}>
      <PageHeader title={meta?.title} parent={meta?.parent} />
      <SkeletonRegion className={styles.body}>
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
      </SkeletonRegion>
    </div>
  );
}
