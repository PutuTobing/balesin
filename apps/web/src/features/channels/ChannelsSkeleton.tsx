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

/**
 * Isi kerangka halaman nomor: hanya kepala kartu ringkasan (ikon, nama, nomor, status), setinggi
 * persis baris aslinya. Isi di bawahnya (fakta, kotak nonaktif/gagal, tombol tes) bergantung data,
 * jadi tidak ditebak di kerangka: kartu cukup tumbuh ke bawah tanpa ada yang bergeser.
 */
export function ChannelDetailCardsSkeleton() {
  return (
    <div className={styles.content}>
      <div className={styles.card}>
        <div className={styles.summaryHead}>
          <Skeleton className={styles.skeletonBigIcon} />
          <div className={styles.summaryText}>
            <Skeleton className={styles.skeletonBigName} />
            <Skeleton className={styles.skeletonNumber} />
            <span className={styles.summaryBadges}>
              <Skeleton className={styles.skeletonBadge} />
            </span>
          </div>
        </div>
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
