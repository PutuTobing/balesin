import { TEMPLATE_CATEGORIES, type ChannelCost } from '@balesin/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { SelectField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTimeInline } from '../../lib/format';
import { useCan, useSession } from '../auth/session';
import { inboxChannelsQuery } from '../inbox/inbox-queries';
import { ExportButton, ReportError, ReportSection } from './ReportBits';
import {
  formatCount,
  formatMonth,
  recentMonths,
  reportRetryDelay,
  retryReport,
  todayIn,
} from './report-logic';
import styles from './Reports.module.css';

const r = t.reports;

/**
 * Biaya pesan Meta per bulan (cakupan `all`): per channel WhatsApp — percakapan layanan (kuota
 * gratis), template per kategori, total. SELALU perkiraan: label + sumber tarif (`rateSource`).
 */
export function CostsReport() {
  const session = useSession();
  const zone = session?.organization.timezone ?? 'Asia/Jakarta';
  const months = recentMonths(todayIn(zone));
  const [month, setMonth] = useState(months[0] ?? '');
  const [channelId, setChannelId] = useState('');
  const channels = useQuery({
    ...inboxChannelsQuery,
    // Biaya pesan Meta hanya untuk channel WhatsApp.
    select: (data) => ({
      ...data,
      channels: data.channels.filter((channel) => channel.type === 'whatsapp'),
    }),
  });
  const canLimits = useCan('sending.limits.manage');
  const costs = useQuery({
    queryKey: ['reports', 'costs', month, channelId],
    queryFn: ({ signal }) =>
      endpoints.reports.costs({ month, channelId: channelId || undefined }, signal),
    placeholderData: keepPreviousData,
    retry: retryReport,
    retryDelay: reportRetryDelay,
    staleTime: 60_000,
  });
  const data = costs.data?.costs;

  return (
    <div className={styles.report}>
      <p className={styles.intro}>{r.costsIntro}</p>
      <div className={styles.controls}>
        <SelectField
          label={r.monthLabel}
          value={month}
          onChange={(event) => setMonth(event.target.value)}
          options={months.map((value) => ({ value, label: formatMonth(value) }))}
          className={styles.control}
        />
        {(channels.data?.channels.length ?? 0) > 1 ? (
          <SelectField
            label={r.channelLabel}
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
            options={[
              { value: '', label: r.allChannels },
              ...(channels.data?.channels ?? []).map((channel) => ({
                value: channel.id,
                label: channel.name,
              })),
            ]}
            className={styles.control}
          />
        ) : null}
      </div>
      {costs.isPending ? (
        <SkeletonRegion className={styles.results}>
          <div className={styles.card}>
            <Skeleton className={styles.skeletonLabel} />
            <Skeleton className={styles.skeletonValue} />
          </div>
        </SkeletonRegion>
      ) : costs.isError && !data ? (
        <ReportError error={costs.error} onRetry={() => void costs.refetch()} />
      ) : data ? (
        <div className={styles.results} aria-busy={costs.isFetching || undefined}>
          <ReportSection
            id="biaya-total"
            title={r.costsTotal}
            actions={
              <ExportButton
                params={{ kind: 'costs', month, channelId: channelId || undefined }}
                what={r.tabCosts}
              />
            }
          >
            <div className={styles.totalRow}>
              <p className={styles.totalValue}>{r.money(data.currency, data.total)}</p>
              <span className={styles.estimate}>{r.estimateBadge}</span>
            </div>
            <dl className={styles.rateSource}>
              <dt>{r.rateSourceLabel}</dt>
              <dd>{data.rateSource}</dd>
            </dl>
            {canLimits ? (
              <Link to="/pengaturan/batas-kirim" className={styles.touchLink}>
                {r.rateSettingsLink}
              </Link>
            ) : null}
            {data.unknownRate > 0 ? (
              <Notice tone="warning">{r.unknownRate(data.unknownRate)}</Notice>
            ) : null}
            <p className={styles.hint}>{r.computedAt(formatDateTimeInline(data.computedAt))}</p>
          </ReportSection>
          {data.channels.length === 0 ? (
            <p className={styles.hint}>{r.costsEmpty}</p>
          ) : (
            data.channels.map((channel) => (
              <ChannelCostCard key={channel.channel.id} cost={channel} currency={data.currency} />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function ChannelCostCard({ cost, currency }: { cost: ChannelCost; currency: string }) {
  const id = `biaya-${cost.channel.id}`;
  return (
    <ReportSection id={id} title={cost.channel.name}>
      <dl className={styles.tiles}>
        <div className={styles.tile}>
          <dt className={styles.tileLabel}>{r.serviceConversations}</dt>
          <dd className={styles.tileValue}>{formatCount(cost.serviceConversations)}</dd>
          <dd className={styles.tileDetail}>
            {r.freeQuota(formatCount(cost.freeQuota), formatCount(cost.freeRemaining))}
          </dd>
        </div>
        <div className={styles.tile}>
          <dt className={styles.tileLabel}>{r.billableService}</dt>
          <dd className={styles.tileValue}>{formatCount(cost.billableService)}</dd>
          <dd
            className={styles.tileDetail}
          >{`${r.serviceCost}: ${r.money(currency, cost.serviceCost)}`}</dd>
        </div>
        <div className={styles.tile}>
          <dt className={styles.tileLabel}>{r.channelTotal}</dt>
          <dd className={styles.tileValue}>{r.money(currency, cost.total)}</dd>
          <dd className={styles.tileDetail}>{r.estimateBadge}</dd>
        </div>
      </dl>
      <h3 className={styles.subTitle}>{r.templatesTitle}</h3>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{r.colCategory}</th>
              <th scope="col">{r.colSent}</th>
              <th scope="col">{r.colBillable}</th>
              <th scope="col">{r.colFree}</th>
              <th scope="col">{r.colCost}</th>
            </tr>
          </thead>
          <tbody>
            {TEMPLATE_CATEGORIES.map((category) => {
              const row = cost.templates[category];
              return (
                <tr key={category}>
                  <th scope="row">{r.categories[category] ?? category}</th>
                  <td data-label={r.colSent}>{formatCount(row.sent)}</td>
                  <td data-label={r.colBillable}>{formatCount(row.billable)}</td>
                  <td data-label={r.colFree}>{formatCount(row.free)}</td>
                  <td data-label={r.colCost}>{r.money(currency, row.cost)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ReportSection>
  );
}
