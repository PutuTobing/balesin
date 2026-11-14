import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import styles from './TeamUser.module.css';

const copy = t.teamUser;

/**
 * Isi kerangka detail anggota: kartu profil dengan label fakta asli (nilainya balok), lalu kartu
 * Peran dengan judul dan petunjuk asli. Kartu yang bergantung data (2FA, sesi, akses, riwayat)
 * muncul di bawahnya, jadi kartu di atas tidak bergeser.
 */
export function TeamUserCardsSkeleton() {
  return (
    <div className={styles.content}>
      <div className={styles.card}>
        <div className={styles.profile}>
          <Skeleton className={styles.skeletonAvatar} />
          <div className={styles.identity}>
            <Skeleton className={styles.skeletonName} />
            <Skeleton className={styles.skeletonEmail} />
            <Skeleton className={styles.skeletonBadges} />
          </div>
        </div>
        <div className={styles.facts}>
          {[copy.facts.joined, copy.facts.lastLogin, copy.facts.twoFactor, copy.facts.email].map(
            (label) => (
              <div key={label} className={styles.fact}>
                <span className={styles.factLabel}>{label}</span>
                <Skeleton className={styles.skeletonValue} />
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/** Kerangka rute detail anggota: header asli + isi kerangka. */
export function TeamUserSkeleton() {
  return (
    <Page>
      <SkeletonRegion>
        <TeamUserCardsSkeleton />
      </SkeletonRegion>
    </Page>
  );
}
