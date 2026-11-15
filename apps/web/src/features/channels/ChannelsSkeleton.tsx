import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import styles from './Channels.module.css';

/** Isi kerangka daftar channel: kartu "WhatsApp" dengan judul asli dan dua baris nomor. */
export function ChannelListSkeleton() {
  return (
    <div className={styles.card}>
      <div className={styles.sectionHead}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>{t.channels.list.sectionTitle}</span>
          <span className={styles.hint}>{t.channels.list.sectionHint}</span>
        </div>
        <Skeleton className={styles.skeletonButton} />
      </div>
      <ul className={styles.channelList}>
        {[0, 1].map((index) => (
          <li key={index}>
            <div className={styles.channelLink}>
              <Skeleton className={styles.skeletonIcon} />
              <span className={styles.skeletonText}>
                <Skeleton className={styles.skeletonName} />
                <Skeleton className={styles.skeletonMeta} />
              </span>
              <span className={styles.channelBadges}>
                <Skeleton className={styles.skeletonBadge} />
              </span>
              <span />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Kerangka rute daftar channel (header asli + isi kerangka). */
export function ChannelsSkeleton() {
  return (
    <Page>
      <div className={styles.content}>
        <SkeletonRegion>
          <ChannelListSkeleton />
        </SkeletonRegion>
      </div>
    </Page>
  );
}

/** Isi kerangka halaman nomor: kartu ringkasan dengan label fakta asli. */
export function ChannelDetailCardsSkeleton() {
  const facts = t.channels.number;
  return (
    <div className={styles.content}>
      <div className={styles.card}>
        <div className={styles.summaryHead}>
          <Skeleton className={styles.skeletonBigIcon} />
          <div className={styles.summaryText}>
            <Skeleton className={styles.skeletonBigName} />
            <Skeleton className={styles.skeletonMeta} />
            <Skeleton className={styles.skeletonBadge} />
          </div>
        </div>
        <div className={`${styles.facts} ${styles.factsDivided}`}>
          {[facts.quality, facts.status, facts.limit, facts.verifiedName, facts.lastTest].map(
            (label) => (
              <div key={label} className={styles.fact}>
                <span className={styles.factLabel}>{label}</span>
                <Skeleton className={styles.skeletonValue} />
              </div>
            ),
          )}
        </div>
        <Skeleton className={styles.skeletonButton} />
      </div>
    </div>
  );
}

/** Kerangka rute halaman nomor. */
export function ChannelDetailSkeleton() {
  return (
    <Page>
      <SkeletonRegion>
        <ChannelDetailCardsSkeleton />
      </SkeletonRegion>
    </Page>
  );
}
