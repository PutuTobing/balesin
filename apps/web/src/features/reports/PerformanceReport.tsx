import {
  CSAT_SCORE_LABELS,
  type AgentPerformance,
  type CsatStats,
  type ReportPerformance,
} from '@balesin/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ReportsIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { SelectField, TextField } from '../../components/ui/Field';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { endpoints } from '../../lib/api/endpoints';
import { useCan, useSession } from '../auth/session';
import { inboxChannelsQuery } from '../inbox/inbox-queries';
import { TagChip } from '../inbox/TagPicker';
import { BarChart, ChartLegend, type BarSeries } from './BarChart';
import { ExportButton, ReportError, ReportSection, StatTile } from './ReportBits';
import {
  RANGE_PRESETS,
  formatCount,
  formatDay,
  formatDuration,
  formatPercent,
  formatRange,
  formatScore,
  presetRange,
  reportRetryDelay,
  retryReport,
  rangeError,
  todayIn,
  type DateRange,
  type RangePreset,
} from './report-logic';
import styles from './Reports.module.css';

const r = t.reports;

const DAILY_SERIES: BarSeries[] = [
  { name: r.dailyLegendResolved, tone: 'primary' },
  { name: r.dailyLegendOpen, tone: 'teal' },
];

/** Kinerja: rentang + channel → ringkasan, tren, agen/bot/tag, CSAT. `own` = kinerja diri saja. */
export function PerformanceReport({ own }: { own: boolean }) {
  const session = useSession();
  const zone = session?.organization.timezone ?? 'Asia/Jakarta';
  const today = todayIn(zone);
  const [preset, setPreset] = useState<RangePreset>('7');
  const [range, setRange] = useState<DateRange>(() => presetRange('7', today));
  const [draft, setDraft] = useState<DateRange>(range);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [channelId, setChannelId] = useState('');
  const channels = useQuery(inboxChannelsQuery);

  const report = useQuery({
    queryKey: ['reports', 'performance', range.from, range.to, channelId],
    queryFn: ({ signal }) =>
      endpoints.reports.performance(
        { from: range.from, to: range.to, channelId: channelId || undefined },
        signal,
      ),
    placeholderData: keepPreviousData,
    retry: retryReport,
    retryDelay: reportRetryDelay,
    staleTime: 60_000,
  });

  const choosePreset = (value: RangePreset) => {
    setPreset(value);
    if (value !== 'kustom') {
      const next = presetRange(value, today);
      setRange(next);
      setDraft(next);
      setDraftError(null);
    }
  };
  const applyCustom = (event: FormEvent) => {
    event.preventDefault();
    const error = rangeError(draft);
    setDraftError(error);
    if (!error) setRange(draft);
  };
  const exportBase = { from: range.from, to: range.to, channelId: channelId || undefined };

  return (
    <div className={styles.report}>
      {own ? <p className={styles.intro}>{r.ownIntro}</p> : null}
      <div className={styles.controls}>
        <SelectField
          label={r.rangeLabel}
          value={preset}
          onChange={(event) =>
            choosePreset(RANGE_PRESETS.find((value) => value === event.target.value) ?? '7')
          }
          options={RANGE_PRESETS.map((value) => ({ value, label: r.presets[value] }))}
          className={styles.control}
        />
        {preset === 'kustom' ? (
          <form className={styles.customRange} onSubmit={applyCustom} noValidate>
            <TextField
              label={r.from}
              type="date"
              value={draft.from}
              max={today}
              onChange={(event) => setDraft({ ...draft, from: event.target.value })}
              className={styles.control}
            />
            <TextField
              label={r.to}
              type="date"
              value={draft.to}
              max={today}
              onChange={(event) => setDraft({ ...draft, to: event.target.value })}
              error={draftError}
              className={styles.control}
            />
            <Button type="submit">{r.apply}</Button>
          </form>
        ) : null}
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
      <p className={styles.rangeNote}>
        {formatRange(range)} · {r.timezoneNote(report.data?.report.range.timezone ?? zone)}
      </p>

      {report.isPending ? (
        <ReportSkeleton />
      ) : report.isError && !report.data ? (
        <ReportError error={report.error} onRetry={() => void report.refetch()} />
      ) : report.data ? (
        <div className={styles.results} aria-busy={report.isFetching || undefined}>
          {report.isError ? (
            <ReportError error={report.error} onRetry={() => void report.refetch()} />
          ) : null}
          {own ? (
            <OwnReport report={report.data.report} exportBase={exportBase} />
          ) : (
            <OrganizationReport report={report.data.report} exportBase={exportBase} />
          )}
        </div>
      ) : null}
    </div>
  );
}

type ExportBase = { from: string; to: string; channelId?: string };

function OrganizationReport({
  report,
  exportBase,
}: {
  report: ReportPerformance;
  exportBase: ExportBase;
}) {
  const summary = report.summary;
  if (
    summary &&
    summary.conversations === 0 &&
    report.csat.sent === 0 &&
    report.agents.length === 0
  ) {
    return (
      // Di dalam kartu, rata dengan saringan dan kartu KPI saat terisi (audit akhir D4).
      <div className={styles.card}>
        <EmptyState
          illustration={<ReportsIllustration />}
          title={r.emptyTitle}
          body={r.emptyBody}
        />
      </div>
    );
  }
  return (
    <>
      {summary ? (
        <section aria-label={r.summaryLabel}>
          <dl className={`${styles.tiles} ${styles.summaryTiles}`}>
            <StatTile
              label={r.conversations}
              value={formatCount(summary.conversations)}
              detail={r.customerInitiated(formatCount(summary.customerInitiated))}
            />
            <StatTile
              label={r.resolved}
              value={formatCount(summary.resolved)}
              detail={(() => {
                const share = formatPercent(summary.resolved, summary.conversations);
                return share ? r.resolvedShare(share) : null;
              })()}
            />
            <DurationTile label={r.firstResponse} stats={summary.firstResponse} />
            <DurationTile label={r.wait} stats={summary.wait} />
            <DurationTile label={r.resolution} stats={summary.resolution} />
            <StatTile label={r.humanHandled} value={formatCount(summary.handledByHuman)} />
            <StatTile
              label={r.botTile}
              value={formatCount(summary.resolvedByBotOnly)}
              detail={`${r.botOnly} · ${r.botTileDetail(formatCount(summary.handoffs))}`}
            />
          </dl>
        </section>
      ) : null}

      {report.trends ? (
        <>
          <DailyTrend report={report} exportBase={exportBase} />
          <HourlyTrend report={report} />
        </>
      ) : null}

      <CsatCard csat={report.csat} exportBase={exportBase} />

      <ReportSection
        id="laporan-agen"
        title={r.agentsTitle}
        actions={<ExportButton params={{ ...exportBase, kind: 'agents' }} what={r.agentsTitle} />}
      >
        <AgentsTable agents={report.agents} />
      </ReportSection>

      {report.bots ? (
        <ReportSection
          id="laporan-bot"
          title={r.botsTitle}
          actions={<ExportButton params={{ ...exportBase, kind: 'bots' }} what={r.botsTitle} />}
        >
          {report.bots.length === 0 ? (
            <p className={styles.hint}>{r.botsEmpty}</p>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{r.colBot}</th>
                    <th scope="col">{r.colMessages}</th>
                    <th scope="col">{r.colConversations}</th>
                    <th scope="col">{r.colHandoffs}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.bots.map((bot) => (
                    <tr key={bot.apiKey.id}>
                      <th scope="row">{bot.apiKey.name}</th>
                      <td data-label={r.colMessages}>{formatCount(bot.messagesSent)}</td>
                      <td data-label={r.colConversations}>{formatCount(bot.conversations)}</td>
                      <td data-label={r.colHandoffs}>{formatCount(bot.handoffs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ReportSection>
      ) : null}

      {report.tags ? (
        <ReportSection
          id="laporan-tag"
          title={r.tagsTitle}
          actions={<ExportButton params={{ ...exportBase, kind: 'tags' }} what={r.tagsTitle} />}
        >
          {report.tags.length === 0 ? (
            <p className={styles.hint}>{r.tagsEmpty}</p>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{r.colTag}</th>
                    <th scope="col">{r.colConversations}</th>
                    <th scope="col">{r.colResolved}</th>
                    <th scope="col">{r.colResolution}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.tags.map((row) => (
                    <tr key={row.tag.id}>
                      <th scope="row">
                        <TagChip tag={row.tag} />
                      </th>
                      <td data-label={r.colConversations}>{formatCount(row.conversations)}</td>
                      <td data-label={r.colResolved}>{formatCount(row.resolved)}</td>
                      <td data-label={r.colResolution}>
                        {formatDuration(row.resolution.medianSeconds)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ReportSection>
      ) : null}
    </>
  );
}

function OwnReport({ report, exportBase }: { report: ReportPerformance; exportBase: ExportBase }) {
  const me = report.agents[0];
  return (
    <>
      <section aria-label={r.ownTitle}>
        <dl className={`${styles.tiles} ${styles.tilesFour}`}>
          <StatTile label={r.colHandled} value={formatCount(me?.conversationsHandled ?? 0)} />
          <StatTile label={r.colResolved} value={formatCount(me?.resolved ?? 0)} />
          <StatTile label={r.colMessages} value={formatCount(me?.messagesSent ?? 0)} />
          <DurationTile
            label={r.firstResponse}
            stats={
              me?.firstResponse ?? {
                count: 0,
                averageSeconds: null,
                medianSeconds: null,
                p90Seconds: null,
              }
            }
          />
        </dl>
      </section>
      <CsatCard csat={report.csat} exportBase={exportBase} />
      <ReportSection
        id="laporan-saya"
        title={r.agentsTitle}
        actions={<ExportButton params={{ ...exportBase, kind: 'agents' }} what={r.agentsTitle} />}
      >
        <AgentsTable agents={report.agents} />
      </ReportSection>
    </>
  );
}

function DurationTile({
  label,
  stats,
}: {
  label: string;
  stats: {
    count: number;
    averageSeconds: number | null;
    medianSeconds: number | null;
    p90Seconds: number | null;
  };
}) {
  if (stats.count === 0 || stats.medianSeconds === null) {
    return <StatTile label={label} value="—" detail={r.noDuration} />;
  }
  return (
    <StatTile
      label={`${label} (${r.median})`}
      value={formatDuration(stats.medianSeconds)}
      detail={r.averageP90(formatDuration(stats.averageSeconds), formatDuration(stats.p90Seconds))}
    />
  );
}

function DailyTrend({ report, exportBase }: { report: ReportPerformance; exportBase: ExportBase }) {
  const [table, setTable] = useState(false);
  const daily = report.trends?.daily ?? [];
  return (
    <ReportSection
      id="laporan-harian"
      title={r.dailyTitle}
      hint={r.dailyHint}
      actions={
        <div className={styles.sectionActions}>
          <Button variant="ghost" aria-pressed={table} onClick={() => setTable((value) => !value)}>
            {table ? r.showChart : r.showTable}
          </Button>
          <ExportButton params={{ ...exportBase, kind: 'daily' }} what={r.dailyTitle} />
        </div>
      }
    >
      {table ? (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{r.columnDate}</th>
                <th scope="col">{r.columnNew}</th>
                <th scope="col">{r.columnResolved}</th>
                <th scope="col">{r.columnFirstResponse}</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((day) => (
                <tr key={day.date}>
                  <th scope="row">{formatDay(day.date, true)}</th>
                  <td data-label={r.columnNew}>{formatCount(day.conversations)}</td>
                  <td data-label={r.columnResolved}>{formatCount(day.resolved)}</td>
                  <td data-label={r.columnFirstResponse}>
                    {formatDuration(day.averageFirstResponseSeconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <ChartLegend series={DAILY_SERIES} />
          <BarChart
            label={r.dailyTitle}
            series={DAILY_SERIES}
            data={daily.map((day) => ({
              key: day.date,
              label: formatDay(day.date),
              title: r.chartDayTitle(formatDay(day.date, true), day.conversations, day.resolved),
              values: [day.resolved, Math.max(0, day.conversations - day.resolved)],
            }))}
          />
        </>
      )}
    </ReportSection>
  );
}

function HourlyTrend({ report }: { report: ReportPerformance }) {
  const [table, setTable] = useState(false);
  const hourly = [...(report.trends?.hourly ?? [])].sort((a, b) => a.hour - b.hour);
  const hourText = (hour: number) => `${String(hour).padStart(2, '0')}.00`;
  return (
    <ReportSection
      id="laporan-jam"
      title={r.hourlyTitle}
      hint={r.hourlyHint}
      actions={
        <Button variant="ghost" aria-pressed={table} onClick={() => setTable((value) => !value)}>
          {table ? r.showChart : r.showTable}
        </Button>
      }
    >
      {table ? (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{r.columnHour}</th>
                <th scope="col">{r.columnNew}</th>
              </tr>
            </thead>
            <tbody>
              {hourly.map((row) => (
                <tr key={row.hour}>
                  <th scope="row">{hourText(row.hour)}</th>
                  <td data-label={r.columnNew}>{formatCount(row.conversations)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <BarChart
          label={r.hourlyTitle}
          series={[{ name: r.columnNew, tone: 'primary' }]}
          labelEvery={3}
          data={hourly.map((row) => ({
            key: String(row.hour),
            label: String(row.hour).padStart(2, '0'),
            title: r.chartHourTitle(hourText(row.hour), row.conversations),
            values: [row.conversations],
          }))}
        />
      )}
    </ReportSection>
  );
}

function CsatCard({ csat, exportBase }: { csat: CsatStats; exportBase: ExportBase }) {
  const canSettings = useCan('settings.workspace.manage');
  const total = Object.values(csat.distribution).reduce((sum, value) => sum + value, 0);
  return (
    <ReportSection
      id="laporan-csat"
      title={r.csatTitle}
      actions={
        csat.sent > 0 ? (
          <ExportButton params={{ ...exportBase, kind: 'csat' }} what={r.exportCsatLabel} />
        ) : undefined
      }
    >
      {csat.sent === 0 ? (
        <p className={styles.hint}>
          {r.csatNone}{' '}
          {canSettings ? (
            <Link to="/pengaturan/csat" className={styles.inlineLink}>
              {r.csatOff}
            </Link>
          ) : null}
        </p>
      ) : (
        <div className={styles.csat}>
          <div className={styles.csatScore}>
            <p className={styles.csatValue}>
              {formatScore(csat.average)}
              <span className={styles.csatOutOf}> {r.outOfFive}</span>
            </p>
            <p className={styles.hint}>{r.csatResponses(csat.responses, csat.sent)}</p>
            {csat.responseRate !== null ? (
              <p className={styles.hint}>
                {r.csatRate(`${Math.round(csat.responseRate).toLocaleString('id-ID')}%`)}
              </p>
            ) : null}
          </div>
          <ul className={styles.distribution} aria-label={r.csatDistributionLabel}>
            {([5, 4, 3, 2, 1] as const).map((score) => {
              const count = csat.distribution[String(score) as '1'] ?? 0;
              const share = total > 0 ? count / total : 0;
              return (
                <li key={score} className={styles.distributionRow}>
                  <span className={styles.distributionLabel}>
                    {r.csatScoreLabel(score, CSAT_SCORE_LABELS[score])}
                  </span>
                  <span className={styles.meter} aria-hidden="true">
                    <span
                      className={styles.meterFill}
                      style={{ width: `${String(share * 100)}%` }}
                    />
                  </span>
                  <span className={styles.distributionCount}>{formatCount(count)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </ReportSection>
  );
}

function AgentsTable({ agents }: { agents: readonly AgentPerformance[] }) {
  if (agents.length === 0) return <p className={styles.hint}>{r.agentsEmpty}</p>;
  return (
    <div className={styles.tableScroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{r.colAgent}</th>
            <th scope="col">{r.colHandled}</th>
            <th scope="col">{r.colResolved}</th>
            <th scope="col">{r.colMessages}</th>
            <th scope="col">{r.colFirstResponse}</th>
            <th scope="col">{r.colCsat}</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => (
            <tr key={agent.user.id}>
              <th scope="row">{agent.user.name}</th>
              <td data-label={r.colHandled}>{formatCount(agent.conversationsHandled)}</td>
              <td data-label={r.colResolved}>{formatCount(agent.resolved)}</td>
              <td data-label={r.colMessages}>{formatCount(agent.messagesSent)}</td>
              <td data-label={r.colFirstResponse}>
                {formatDuration(agent.firstResponse.medianSeconds)}
              </td>
              <td data-label={r.colCsat}>
                {agent.csat.responses > 0
                  ? `${formatScore(agent.csat.average)} (${formatCount(agent.csat.responses)})`
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReportSkeleton() {
  return (
    <SkeletonRegion className={styles.results}>
      <div className={styles.tiles}>
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className={styles.tile}>
            <Skeleton className={styles.skeletonLabel} />
            <Skeleton className={styles.skeletonValue} />
          </div>
        ))}
      </div>
      <div className={styles.card}>
        <Skeleton className={styles.skeletonLabel} />
        <Skeleton className={styles.skeletonChart} />
      </div>
    </SkeletonRegion>
  );
}
