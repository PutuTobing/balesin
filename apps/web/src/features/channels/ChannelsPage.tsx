import type { ChannelSettingsListResponse, WhatsAppChannel } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { ChevronRight, Plus, Smartphone } from 'lucide-react';
import {
  ChannelIllustration,
  LoadFailedIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { RichText } from '../../components/ui/RichText';
import { SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { channelSettingsQuery } from '../../lib/api/queries';
import { cx } from '../../lib/cx';
import { ChannelStatusBadge, QualityBadge } from './ChannelBadges';
import { addBlockedReason } from './channel-status';
import { MasterKeyCommand } from './MasterKeyCommand';
import styles from './Channels.module.css';
import { ChannelListSkeleton } from './ChannelsSkeleton';
import { ConnectionsSection } from './connections/ConnectionsSection';
import './route-state';

const copy = t.channels.list;
const BLOCKED_NOTICE_ID = 'channel-tambah-alasan';

/**
 * Pengaturan → Channel (izin `channels.manage`: Owner, Admin): daftar nomor WhatsApp dengan
 * status koneksi dan kualitas, tombol tambah nomor, dan keadaan kosong yang mengajak menghubungkan
 * nomor pertama; di bawahnya channel lain (Telegram, Email, Messenger, Instagram).
 */
export function ChannelsPage() {
  const list = useQuery(channelSettingsQuery);
  const deleted = useRouterState({ select: (state) => state.location.state.deletedChannel });

  return (
    <Page>
      <div className={styles.content}>
        {deleted ? (
          <Notice tone="success" role="status">
            {copy.deleted(deleted)}
          </Notice>
        ) : null}
        {list.data ? (
          <>
            <ChannelList data={list.data} />
            <ConnectionsSection />
          </>
        ) : list.isPending ? (
          <SkeletonRegion>
            <ChannelListSkeleton />
          </SkeletonRegion>
        ) : (
          <EmptyState
            illustration={<LoadFailedIllustration />}
            title={copy.loadFailedTitle}
            body={isApiError(list.error) ? list.error.message : t.api.network}
            actions={
              <Button variant="primary" onClick={() => void list.refetch()}>
                {t.common.retry}
              </Button>
            }
          />
        )}
      </div>
    </Page>
  );
}

function ChannelList({ data }: { data: ChannelSettingsListResponse }) {
  const blocked = addBlockedReason(data);

  if (data.channels.length === 0) {
    return (
      <>
        {blocked ? <BlockedNotice reason={blocked} max={data.maxChannels} /> : null}
        <EmptyState
          illustration={<ChannelIllustration />}
          title={copy.emptyTitle}
          body={copy.emptyBody}
          actions={<AddButton blocked={blocked !== null} label={copy.emptyAction} />}
        />
      </>
    );
  }

  return (
    <section className={styles.card} aria-labelledby="channel-whatsapp">
      <div className={styles.sectionHead}>
        <div className={styles.cardHead}>
          <h2 id="channel-whatsapp" className={styles.cardTitle}>
            {copy.sectionTitle}
          </h2>
          <p className={styles.hint}>{copy.sectionHint}</p>
        </div>
        <AddButton blocked={blocked !== null} label={copy.add} />
      </div>
      {blocked ? <BlockedNotice reason={blocked} max={data.maxChannels} /> : null}
      <ul className={styles.channelList} aria-label={copy.listLabel}>
        {data.channels.map((channel) => (
          <li key={channel.id}>
            <ChannelRow channel={channel} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Nonaktif = tombol biasa yang dimatikan, dengan alasannya di kotak pesan (`aria-describedby`). */
function AddButton({ blocked, label }: { blocked: boolean; label: string }) {
  if (blocked) {
    return (
      <Button variant="primary" disabled aria-describedby={BLOCKED_NOTICE_ID}>
        <Icon icon={Plus} size={16} />
        {label}
      </Button>
    );
  }
  return (
    <Button asChild variant="primary">
      <Link to="/pengaturan/channel/tambah">
        <Icon icon={Plus} size={16} />
        {label}
      </Link>
    </Button>
  );
}

function BlockedNotice({ reason, max }: { reason: 'noMasterKey' | 'limit'; max: number }) {
  return reason === 'noMasterKey' ? (
    <Notice
      id={BLOCKED_NOTICE_ID}
      tone="warning"
      title={copy.noMasterKeyTitle}
      actions={<MasterKeyCommand />}
    >
      <RichText text={copy.noMasterKeyBody} />
    </Notice>
  ) : (
    <Notice id={BLOCKED_NOTICE_ID} tone="info" title={copy.limitTitle}>
      {copy.limitBody(max)}
    </Notice>
  );
}

function ChannelRow({ channel }: { channel: WhatsAppChannel }) {
  const number = channel.number;
  const meta = number?.displayPhoneNumber
    ? [number.displayPhoneNumber, number.verifiedName].filter(Boolean).join(' · ')
    : copy.noNumber;
  return (
    <Link
      to="/pengaturan/channel/$channelId"
      params={{ channelId: channel.id }}
      className={styles.channelLink}
    >
      <span className={cx(styles.channelIcon, !channel.enabled && styles.channelIconOff)}>
        <Icon icon={Smartphone} size={20} />
      </span>
      <span className={styles.channelText}>
        <span className={styles.channelName}>{channel.name}</span>
        <span className={styles.channelMeta}>{meta}</span>
      </span>
      <span className={styles.channelBadges}>
        <ChannelStatusBadge channel={channel} className={styles.smallBadge} />
        {number ? (
          <QualityBadge rating={number.qualityRating} withLabel className={styles.smallBadge} />
        ) : null}
      </span>
      <Icon icon={ChevronRight} size={16} className={styles.chevron} />
    </Link>
  );
}
