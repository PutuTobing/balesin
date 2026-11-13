import { PageHeader } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { media, useMediaQuery } from '../../lib/media';
import { usePageTitle } from '../../lib/use-page-title';
import { EmailGuide } from './EmailGuide';
import pageStyles from '../../components/ui/Page.module.css';
import styles from './EmailSettings.module.css';

/** Kerangka Pengaturan → Email pengirim: kartu status + form, sama bentuknya dengan layar jadi. */
export function EmailSettingsSkeleton() {
  usePageTitle(t.emailSettings.title);
  const isDesktop = useMediaQuery(media.desktop);
  return (
    <div className={pageStyles.page}>
      <PageHeader title={t.emailSettings.title} parent="settings" />
      <div className={pageStyles.body}>
        <div className={styles.layout}>
          <SkeletonRegion className={styles.main}>
            <div className={styles.statusCard}>
              {[0, 1, 2].map((index) => (
                <div key={index} className={styles.statusItem}>
                  <Skeleton className={styles.skeletonLabel} />
                  <Skeleton className={styles.skeletonValue} />
                </div>
              ))}
            </div>
            <div className={styles.card}>
              <div className={styles.skeletonPresets}>
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} className={styles.skeletonPreset} />
                ))}
              </div>
              <div className={styles.row}>
                {[0, 1].map((index) => (
                  <div key={index} className={styles.skeletonField}>
                    <Skeleton className={styles.skeletonLabel} />
                    <Skeleton className={styles.skeletonInput} />
                  </div>
                ))}
              </div>
              <div className={styles.hostRow}>
                {[0, 1].map((index) => (
                  <div key={index} className={styles.skeletonField}>
                    <Skeleton className={styles.skeletonLabel} />
                    <Skeleton className={styles.skeletonInput} />
                  </div>
                ))}
              </div>
            </div>
          </SkeletonRegion>
          {/* Panduan tidak butuh data: tampil apa adanya di posisi yang sama dengan layar jadi. */}
          <EmailGuide
            context="settings"
            preset="other"
            defaultOpen={isDesktop}
            className={styles.aside}
          />
        </div>
      </div>
    </div>
  );
}
