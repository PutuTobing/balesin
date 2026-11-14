import { PageHeader } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { usePageTitle } from '../../lib/use-page-title';
import pageStyles from '../../components/ui/Page.module.css';
import styles from './Team.module.css';

/**
 * Kerangka Pengaturan → Tim: header asli, lalu kartu undangan dan kartu daftar di posisi layar
 * jadi. Teks yang tidak bergantung data (judul kartu, label isian) tampil asli.
 */
export function TeamSkeleton() {
  usePageTitle(t.team.title);
  return (
    <div className={pageStyles.page}>
      <PageHeader title={t.team.title} parent="settings" />
      <div className={pageStyles.body}>
        <SkeletonRegion className={styles.content}>
          <div className={styles.card}>
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>{t.team.invite.title}</h2>
              <span className={styles.skeletonLines}>
                <Skeleton className={styles.skeletonHint} />
                {/* Di HP petunjuk ini tiga baris. */}
                <Skeleton className={styles.skeletonHintHp} />
                <Skeleton className={styles.skeletonHintShort} />
              </span>
            </div>
            <div className={styles.form}>
              <div className={styles.inviteRow}>
                <div className={styles.skeletonField}>
                  <span className={styles.skeletonLabel}>{t.team.invite.email}</span>
                  <Skeleton className={styles.skeletonControl} />
                </div>
                {/* Peran bawaan selalu CS: petunjuknya sudah pasti, tampil asli. */}
                <div className={styles.skeletonField}>
                  <span className={styles.skeletonLabel}>{t.team.invite.role}</span>
                  <Skeleton className={styles.skeletonControl} />
                  <p className={styles.skeletonFieldHint}>{t.team.invite.roleHints.cs}</p>
                </div>
              </div>
              <div className={styles.formFooter}>
                <Skeleton className={styles.skeletonButtons} />
              </div>
            </div>
          </div>
          <div className={styles.card}>
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>{t.team.list.title}</h2>
              <span className={styles.skeletonLines}>
                <Skeleton className={styles.skeletonHint} />
              </span>
            </div>
            <div className={styles.list}>
              {[0, 1].map((index) => (
                <div key={index} className={styles.row}>
                  <div className={styles.rowMain}>
                    <Skeleton className={styles.skeletonEmail} />
                    <Skeleton className={styles.skeletonMeta} />
                    <Skeleton className={styles.skeletonDetail} />
                  </div>
                  <Skeleton className={styles.skeletonButtons} />
                </div>
              ))}
            </div>
          </div>
        </SkeletonRegion>
      </div>
    </div>
  );
}
