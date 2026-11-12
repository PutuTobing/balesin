import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import styles from './Inbox.module.css';
import { useDetailPanel } from './use-detail-panel';

const ROWS = 7;

/**
 * Kerangka memuat Inbox. Bentuknya sama dengan layar jadi (baris chat ber-avatar,
 * bubble, kartu kontak) supaya tidak ada lompatan layout saat data tiba.
 */
export function InboxSkeleton() {
  const detail = useDetailPanel();

  return (
    <SkeletonRegion className={styles.skeletonRoot}>
      <div className={styles.inbox} data-detail={detail.open ? 'open' : 'closed'}>
        <div className={styles.list}>
          <div className={styles.titleRow}>
            <p className={styles.title}>{t.inbox.title}</p>
          </div>
          <div className={styles.searchRow}>
            <Skeleton className={styles.skeletonSearch} />
          </div>
          <div className={styles.skeletonTabs}>
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className={styles.skeletonTab} />
            ))}
          </div>
          <div className={styles.listBody}>
            {Array.from({ length: ROWS }, (_, index) => (
              <div key={index} className={styles.skeletonRow}>
                <Skeleton className={styles.skeletonAvatar} />
                <div className={styles.skeletonLines}>
                  <Skeleton className={styles.skeletonName} />
                  <Skeleton className={styles.skeletonSnippet} />
                </div>
                <Skeleton className={styles.skeletonTime} />
              </div>
            ))}
          </div>
        </div>

        <div className={styles.chat}>
          <div className={styles.skeletonThread}>
            <Bubble side="in" width={styles.w55} />
            <Bubble side="out" width={styles.w40} />
            <Bubble side="in" width={styles.w40} tall />
            <Bubble side="out" width={styles.w30} />
          </div>
          <Skeleton className={styles.skeletonComposer} />
        </div>

        {detail.open ? (
          <div className={styles.detail}>
            <div className={styles.skeletonProfile}>
              <Skeleton className={styles.skeletonPortrait} />
              <Skeleton className={styles.skeletonHeading} />
              <Skeleton className={styles.skeletonSub} />
            </div>
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className={styles.skeletonSection}>
                <Skeleton className={styles.skeletonLabel} />
                <Skeleton className={styles.skeletonField} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </SkeletonRegion>
  );
}

function Bubble({ side, width, tall }: { side: 'in' | 'out'; width?: string; tall?: boolean }) {
  return (
    <Skeleton
      className={cx(
        styles.skeletonBubble,
        side === 'in' ? styles.skeletonBubbleIn : styles.skeletonBubbleOut,
        width,
        tall && styles.tall,
      )}
    />
  );
}
