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
        {/* Bentuk kepala sama dengan halaman jadi: tempat tombol menu (tablet/HP) + judul dan
            ringkasan sebagai balok, jadi judul tidak bergeser atau berganti teks saat data tiba. */}
        <header className={styles.listHead}>
          <h1 className="sr-only">{m.title}</h1>
          <span className={cx(styles.menuButton, styles.menuPlaceholder)} aria-hidden="true" />
          <div className={styles.listHeading} aria-hidden="true">
            <Skeleton className={styles.skeletonHeadTitle} />
            <Skeleton className={styles.skeletonHeadSub} />
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
