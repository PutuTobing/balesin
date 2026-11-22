import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import styles from './Mail.module.css';

const m = t.mail;

/**
 * Keadaan memuat menu Email: bentuk sama dengan layar jadi (kolom folder · daftar · panel baca;
 * di HP hanya daftar), jadi tidak ada lompatan saat data tiba. Berkas sendiri supaya router bisa
 * memakainya tanpa memuat kode halaman.
 */
export function MailSkeleton() {
  return (
    <div className={styles.mail}>
      <aside className={cx(styles.folders, styles.foldersStatic)} aria-label={m.foldersLabel}>
        <SkeletonRegion className={styles.skeletonFolders}>
          <Skeleton className={styles.skeletonTitle} />
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className={styles.skeletonRow} />
          ))}
          <Skeleton className={styles.skeletonLabel} />
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className={styles.skeletonRow} />
          ))}
        </SkeletonRegion>
      </aside>
      <section className={styles.list} aria-label={m.list.label}>
        <header className={styles.listHead}>
          <div className={styles.listHeading}>
            <h1 className={styles.listTitle}>{m.title}</h1>
          </div>
        </header>
        <SkeletonRegion className={styles.skeletonList}>
          {[0, 1, 2, 3, 4].map((key) => (
            <div key={key} className={styles.skeletonMail}>
              <Skeleton className={styles.skeletonAvatar} />
              <div className={styles.skeletonLines}>
                <Skeleton className={styles.skeletonLineShort} />
                <Skeleton className={styles.skeletonLine} />
                <Skeleton className={styles.skeletonLineLong} />
              </div>
            </div>
          ))}
        </SkeletonRegion>
      </section>
      <section className={styles.reading} aria-label={m.reading.label} />
    </div>
  );
}
