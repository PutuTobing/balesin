import {
  messagingLimitLabel,
  nameStatusLabel,
  phoneNumberStatusLabel,
  type ChannelLastTest,
  type WhatsAppNumberSummary,
} from '@balesin/shared';
import type { ReactNode } from 'react';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { formatDateTime, formatDateTimeInline } from '../../lib/format';
import { QualityBadge } from './ChannelBadges';
import styles from './Channels.module.css';

const copy = t.channels.number;

export function Fact({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `${styles.fact} ${className}` : styles.fact}>
      <dt className={styles.factLabel}>{label}</dt>
      <dd className={styles.factValue}>{children}</dd>
    </div>
  );
}

/**
 * Data nomor dari Meta (tes berhasil terakhir): kualitas, status, batas pesan, nama tampilan.
 * Nilai mentah Meta diberi label Indonesia lewat `@balesin/shared`; nilai baru yang belum dikenal
 * tampil apa adanya.
 */
export function NumberFacts({
  number,
  lastTest,
  divided = false,
}: {
  number: WhatsAppNumberSummary;
  /** `undefined` = baris "Tes terakhir" tidak ditampilkan (mis. tepat setelah tes di wizard). */
  lastTest?: ChannelLastTest | null;
  divided?: boolean;
}) {
  return (
    <div className={cx(styles.factsBlock, divided && styles.factsDivided)}>
      <dl className={styles.facts}>
        <Fact label={copy.quality}>
          <QualityBadge rating={number.qualityRating} />
        </Fact>
        <Fact label={copy.status}>{phoneNumberStatusLabel(number.status)}</Fact>
        <Fact label={copy.limit}>{messagingLimitLabel(number.messagingLimit)}</Fact>
        <Fact label={copy.verifiedName}>
          {number.verifiedName ?? '—'}
          {number.nameStatus ? (
            <span className={styles.factSub}>
              {copy.nameStatus(nameStatusLabel(number.nameStatus))}
            </span>
          ) : null}
        </Fact>
        {lastTest !== undefined ? (
          <Fact label={copy.lastTest}>
            {lastTest ? formatDateTime(lastTest.testedAt) : copy.neverTested}
          </Fact>
        ) : null}
      </dl>
      {/* Fakta di atas bisa basi (mis. tes terakhir gagal): sebut kapan dibaca dari Meta. */}
      <p className={styles.factsSource}>{copy.fetchedAt(formatDateTimeInline(number.fetchedAt))}</p>
    </div>
  );
}
