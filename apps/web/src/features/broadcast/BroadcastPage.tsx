import {
  BROADCAST_STATUSES,
  BROADCAST_STATUS_LABELS,
  type BroadcastCampaign,
  type BroadcastStatus,
} from '@balesin/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Megaphone, Plus } from 'lucide-react';
import { useState } from 'react';
import {
  BroadcastIllustration,
  LoadFailedIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { SelectField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { cx } from '../../lib/cx';
import { formatDateTimeInline } from '../../lib/format';
import { useSession } from '../auth/session';
import { campaignProgress, formatInZone, statusTone } from './broadcast-logic';
import { broadcastListQuery, takeBroadcastFlash } from './broadcast-queries';
import styles from './Broadcast.module.css';

const b = t.broadcast;

/**
 * Broadcast (`broadcast.send`): daftar kampanye dengan status, progres, penerima, jadwal, dan biaya
 * perkiraan; saringan status; "Buat kampanye". Kampanye yang masih bergerak disegarkan berkala.
 */
export function BroadcastPage() {
  const [status, setStatus] = useState<BroadcastStatus | ''>('');
  const [done] = useState(() => takeBroadcastFlash());
  const list = useInfiniteQuery(broadcastListQuery(status || null));
  const items = list.data?.pages.flatMap((page) => page.broadcasts) ?? [];

  const add = (
    <Button variant="primary" asChild>
      <Link to="/broadcast/baru">
        <Icon icon={Plus} size={16} />
        {b.newCampaign}
      </Link>
    </Button>
  );

  return (
    <Page>
      <div className={styles.content}>
        <p className={styles.intro}>{b.intro}</p>
        {done ? (
          <Notice tone="success" role="status">
            {done}
          </Notice>
        ) : null}
        {list.isPending ? (
          <ListSkeleton />
        ) : list.isError ? (
          <EmptyState
            illustration={<LoadFailedIllustration />}
            title={b.loadFailedTitle}
            body={isApiError(list.error) ? list.error.message : t.api.network}
            actions={
              <Button variant="primary" onClick={() => void list.refetch()}>
                {t.common.retry}
              </Button>
            }
          />
        ) : items.length === 0 && !status ? (
          <EmptyState
            illustration={<BroadcastIllustration />}
            title={b.emptyTitle}
            body={b.emptyBody}
            actions={add}
          />
        ) : (
          <>
            <div className={styles.toolbar}>
              <SelectField
                label={b.statusLabel}
                value={status}
                onChange={(event) => setStatus(event.target.value as BroadcastStatus | '')}
                options={[
                  { value: '', label: b.allStatuses },
                  ...BROADCAST_STATUSES.map((value) => ({
                    value,
                    label: BROADCAST_STATUS_LABELS[value],
                  })),
                ]}
                className={styles.statusFilter}
              />
              {add}
            </div>
            {items.length === 0 ? (
              <div className={styles.noMatch}>
                <p>{b.noMatch}</p>
                <Button variant="ghost" onClick={() => setStatus('')}>
                  {b.showAll}
                </Button>
              </div>
            ) : (
              <ul className={styles.list} aria-label={b.listLabel}>
                {items.map((campaign) => (
                  <CampaignRow key={campaign.id} campaign={campaign} />
                ))}
              </ul>
            )}
            {list.hasNextPage ? (
              <Button
                className={styles.loadMore}
                loading={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? b.loadingMore : b.loadMore}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </Page>
  );
}

function CampaignRow({ campaign }: { campaign: BroadcastCampaign }) {
  const zone = useSession()?.organization.timezone ?? 'Asia/Jakarta';
  const progress = campaignProgress(campaign);
  const detailsId = `kampanye-${campaign.id}-rincian`;
  const showProgress = campaign.status !== 'draft' && campaign.status !== 'pending_approval';
  const facts = [
    campaign.template ? campaign.template.name : b.noTemplate,
    campaign.channel.name,
    b.recipients(campaign.counts.recipients),
  ];
  const when =
    campaign.status === 'scheduled' && campaign.scheduledAt
      ? b.scheduledFor(formatInZone(campaign.scheduledAt, zone))
      : campaign.createdBy
        ? b.createdBy(campaign.createdBy.name, formatDateTimeInline(campaign.createdAt))
        : b.createdAt(formatDateTimeInline(campaign.createdAt));
  return (
    <li>
      {/* Seluruh kartu = tautan (target besar di HP, review broadcast BC4). */}
      <Link
        to="/broadcast/$broadcastId"
        params={{ broadcastId: campaign.id }}
        className={cx(styles.item, styles.itemLink)}
        aria-label={b.open(campaign.name)}
        aria-describedby={detailsId}
      >
        <span className={styles.itemHead}>
          <Icon icon={Megaphone} size={20} className={styles.itemIcon} />
          <span className={styles.itemName}>{campaign.name}</span>
          <StatusBadge
            tone={statusTone(campaign.status)}
            label={BROADCAST_STATUS_LABELS[campaign.status]}
            className={styles.itemStatus}
          />
        </span>
        <span id={detailsId} className={styles.itemDetails}>
          <span className={styles.itemFacts}>{facts.join(' · ')}</span>
          {showProgress && progress.total > 0 ? (
            <span className={styles.progressRow}>
              <span
                className={styles.meter}
                role="meter"
                aria-label={b.progressLabel}
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.done}
                data-tone={campaign.status === 'paused' ? 'warning' : 'normal'}
              >
                <span className={styles.meterFill} style={{ width: `${progress.ratio * 100}%` }} />
              </span>
              <span className={styles.progressText}>
                {b.processed(progress.done, progress.total)}
              </span>
            </span>
          ) : null}
          <span className={styles.itemMeta}>
            {when}
            {campaign.estimate
              ? ` · ${b.estimateShort(b.money(campaign.estimate.currency, campaign.estimate.total))}`
              : null}
          </span>
        </span>
      </Link>
    </li>
  );
}

function ListSkeleton() {
  return (
    <SkeletonRegion className={styles.list}>
      {[0, 1, 2].map((index) => (
        <div key={index} className={styles.item}>
          <Skeleton className={styles.skeletonHead} />
          <Skeleton className={styles.skeletonLine} />
          <Skeleton className={styles.skeletonShort} />
        </div>
      ))}
    </SkeletonRegion>
  );
}
