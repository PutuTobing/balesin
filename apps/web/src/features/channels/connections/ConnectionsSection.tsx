import type { ConnectionChannel, ConnectionChannelListResponse } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Icon } from '../../../components/ui/Icon';
import { Notice } from '../../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../../components/ui/Skeleton';
import { t } from '../../../i18n/id';
import { cx } from '../../../lib/cx';
import { ChannelStatusBadge } from '../ChannelBadges';
import { CHANNEL_TYPE_ICONS, channelTypeLabel } from '../channel-type';
import channelStyles from '../Channels.module.css';
import { connectionsQuery, isConnectionType } from './connection-queries';
import styles from './Connections.module.css';

const c = t.connections;

/**
 * Pengaturan → Channel, bagian "Channel lain" (`channels.manage`): Telegram, Email, Messenger,
 * Instagram yang sudah terhubung + kartu "Tambah channel" per jenis dari `types` server (catatan App
 * Review Meta ikut tampil). WhatsApp tetap di bagian atasnya (halaman lama).
 */
export function ConnectionsSection() {
  const list = useQuery(connectionsQuery);
  return (
    <section className={channelStyles.card} aria-labelledby="channel-lain">
      <div className={channelStyles.cardHead}>
        <h2 id="channel-lain" className={channelStyles.cardTitle}>
          {c.sectionTitle}
        </h2>
        <p className={channelStyles.hint}>{c.sectionHint}</p>
      </div>
      {list.isPending ? (
        <SkeletonRegion className={styles.typeGrid}>
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className={styles.typeSkeleton} />
          ))}
        </SkeletonRegion>
      ) : list.isError ? (
        <Notice
          tone="danger"
          actions={<Button onClick={() => void list.refetch()}>{t.common.retry}</Button>}
        >
          {c.loadFailed}
        </Notice>
      ) : (
        <ConnectionList data={list.data} />
      )}
    </section>
  );
}

function ConnectionList({ data }: { data: ConnectionChannelListResponse }) {
  const blocked = !data.canStoreSecrets
    ? c.noMasterKey
    : data.channels.length >= data.maxChannels
      ? c.limitReached(data.maxChannels)
      : null;
  const types = data.types.filter((item) => item.type !== 'whatsapp');
  return (
    <>
      {data.channels.length > 0 ? (
        <ul
          className={cx(channelStyles.channelList, styles.connectionList)}
          aria-label={c.listLabel}
        >
          {data.channels.map((channel) => (
            <li key={channel.id}>
              <ConnectionRow channel={channel} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.addBlock}>
        <h3 className={styles.addTitle}>{c.addTitle}</h3>
        {blocked ? <Notice tone="info">{blocked}</Notice> : null}
        <ul className={styles.typeGrid}>
          {types.map((info) => {
            const type = info.type;
            const TypeIcon = CHANNEL_TYPE_ICONS[type];
            const usable = info.available && blocked === null && isConnectionType(type);
            const body = (
              <>
                <span className={styles.typeIcon}>
                  <Icon icon={TypeIcon} size={20} />
                </span>
                <span className={styles.typeText}>
                  <span className={styles.typeName}>{c.addLabel(info.label)}</span>
                  <span className={styles.typeHint}>{c.typeHints[type] ?? ''}</span>
                  {info.note ? <span className={styles.typeNote}>{c.reviewBadge}</span> : null}
                </span>
              </>
            );
            return (
              <li key={type}>
                {usable ? (
                  <Link
                    to="/pengaturan/channel/baru/$type"
                    params={{ type }}
                    className={styles.typeCard}
                  >
                    {body}
                  </Link>
                ) : (
                  <span className={cx(styles.typeCard, styles.typeCardOff)} aria-disabled="true">
                    {body}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

function connectionMeta(channel: ConnectionChannel): string {
  switch (channel.type) {
    case 'telegram':
      return channel.botUsername ? `@${channel.botUsername}` : c.bot;
    case 'email':
      return channel.emailAddress;
    default:
      return c.pageShort(channel.pageId);
  }
}

function ConnectionRow({ channel }: { channel: ConnectionChannel }) {
  const TypeIcon = CHANNEL_TYPE_ICONS[channel.type];
  return (
    <Link
      to="/pengaturan/channel/lain/$channelId"
      params={{ channelId: channel.id }}
      className={channelStyles.channelLink}
      aria-label={c.open(channel.name)}
    >
      <span
        className={cx(channelStyles.channelIcon, !channel.enabled && channelStyles.channelIconOff)}
      >
        <Icon icon={TypeIcon} size={20} />
      </span>
      <span className={channelStyles.channelText}>
        <span className={channelStyles.channelName}>{channel.name}</span>
        <span className={channelStyles.channelMeta}>
          {channelTypeLabel(channel.type)} · {connectionMeta(channel)}
        </span>
      </span>
      <span className={channelStyles.channelBadges}>
        <ChannelStatusBadge channel={channel} className={channelStyles.smallBadge} />
        {'requiresAppReview' in channel && !channel.enabled ? (
          <span className={styles.reviewBadge}>{c.reviewBadge}</span>
        ) : null}
      </span>
      <Icon icon={ChevronRight} size={16} className={channelStyles.chevron} />
    </Link>
  );
}
