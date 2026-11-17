import {
  BROADCAST_PAUSE_REASON_LABELS,
  BROADCAST_SKIP_REASON_LABELS,
  BROADCAST_STATUS_LABELS,
  BROADCAST_WAIT_REASON_LABELS,
  type BroadcastCampaign,
  type BroadcastReport,
  type BroadcastSkipReason,
  type IdentityConfirmation,
} from '@balesin/shared';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi } from '@tanstack/react-router';
import { Download, Pause, Play, X } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  LoadFailedIllustration,
  NotFoundIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { SelectField, TextAreaField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTimeInline } from '../../lib/format';
import { useCan, useSession } from '../auth/session';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { useMinuteClock } from '../inbox/use-minute-clock';
import { formatInZone, isLive, progressOf, statusTone } from './broadcast-logic';
import {
  LIVE_REFRESH_MS,
  broadcastKeys,
  broadcastQuery,
  storeBroadcast,
} from './broadcast-queries';
import { BroadcastWizard } from './BroadcastWizard';
import styles from './Broadcast.module.css';

const b = t.broadcast;
const routeApi = getRouteApi('/_app/broadcast/$broadcastId');
const RECIPIENT_FILTERS = [
  'all',
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
  'skipped',
  'cancelled',
] as const;

/** Broadcast → kampanye baru. */
export function BroadcastNewPage() {
  return <BroadcastWizard campaign={null} />;
}

/** Broadcast → satu kampanye: draf = wizard, selain itu detail. */
export function BroadcastCampaignPage() {
  const { broadcastId } = routeApi.useParams();
  const detail = useQuery(broadcastQuery(broadcastId));
  if (detail.isPending) return <DetailSkeleton />;
  if (detail.isError) {
    const notFound = isApiError(detail.error) && detail.error.status === 404;
    return (
      <Page>
        <EmptyState
          illustration={notFound ? <NotFoundIllustration /> : <LoadFailedIllustration />}
          title={notFound ? b.notFoundTitle : b.loadFailedTitle}
          body={
            notFound
              ? b.notFoundBody
              : isApiError(detail.error)
                ? detail.error.message
                : t.api.network
          }
          actions={
            notFound ? (
              <Button variant="primary" asChild>
                <Link to="/broadcast">{b.backToList}</Link>
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void detail.refetch()}>
                {t.common.retry}
              </Button>
            )
          }
        />
      </Page>
    );
  }
  const campaign = detail.data.broadcast;
  return campaign.status === 'draft' ? (
    <BroadcastWizard key={campaign.id} campaign={campaign} />
  ) : (
    <BroadcastDetail campaign={campaign} />
  );
}

function DetailSkeleton() {
  return (
    <Page>
      <SkeletonRegion className={styles.detail}>
        <Skeleton className={styles.skeletonCard} />
        <Skeleton className={styles.skeletonCard} />
      </SkeletonRegion>
    </Page>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

function BroadcastDetail({ campaign }: { campaign: BroadcastCampaign }) {
  const zone = useSession()?.organization.timezone ?? 'Asia/Jakarta';
  const live = isLive(campaign.status);
  const report = useQuery({
    queryKey: broadcastKeys.report(campaign.id),
    queryFn: ({ signal }) => endpoints.broadcasts.report(campaign.id, signal),
    // Juga setelah selesai selama masih ada pesan yang menunggu jawaban Meta.
    refetchInterval: (query) =>
      live || campaign.status === 'paused' || (query.state.data?.report.sending ?? 0) > 0
        ? LIVE_REFRESH_MS
        : false,
  });
  const facts: [string, string][] = [
    [b.facts.channel, campaign.channel.name],
    [b.facts.template, campaign.template?.name ?? b.noTemplate],
    [b.facts.source, campaign.source ? campaign.source.label : '—'],
    [
      b.facts.schedule,
      campaign.scheduledAt ? formatInZone(campaign.scheduledAt, zone) : b.scheduleImmediate,
    ],
    [b.facts.rate, b.rateValue(campaign.ratePerSecond)],
    [
      b.facts.dedupe,
      campaign.dedupe.hours === null
        ? b.dedupeOff
        : b.dedupeValue(campaign.dedupe.hours, b.dedupeScope[campaign.dedupe.scope]),
    ],
    [b.facts.autoTag, campaign.autoTag?.name ?? b.autoTagNone],
    [
      b.facts.createdBy,
      campaign.createdBy
        ? `${campaign.createdBy.name}, ${formatDateTimeInline(campaign.createdAt)}`
        : formatDateTimeInline(campaign.createdAt),
    ],
  ];
  return (
    <Page>
      <div className={styles.detail}>
        <section className={styles.card} aria-labelledby="kampanye-judul">
          <div className={styles.detailHead}>
            <h2 id="kampanye-judul" className={styles.detailName}>
              {campaign.name}
            </h2>
            <StatusBadge
              tone={statusTone(campaign.status)}
              label={BROADCAST_STATUS_LABELS[campaign.status]}
            />
          </div>
          <StatusNotice campaign={campaign} zone={zone} />
          <CampaignActions campaign={campaign} />
          <dl className={styles.facts} aria-label={b.factsLabel}>
            {facts.map(([label, value]) => (
              <div key={label} className={styles.factRow}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        {report.data ? (
          <ReportCard report={report.data.report} live={live} />
        ) : report.isError ? (
          <Notice tone="danger" role="alert">
            {b.reportFailed}
          </Notice>
        ) : (
          <Skeleton className={styles.skeletonCard} />
        )}
        <RecipientsCard campaign={campaign} />
      </div>
    </Page>
  );
}

function StatusNotice({ campaign, zone }: { campaign: BroadcastCampaign; zone: string }) {
  const now = useMinuteClock();
  const selfId = useSession()?.user.id;
  const own = campaign.createdBy?.id === selfId;
  const canResume = useCan('sending.resume');
  if (campaign.status === 'pending_approval') {
    return (
      <Notice tone="warning" role="status" title={b.pendingTitle}>
        {b.pendingBody(campaign.approval.threshold)}
        {own ? ` ${b.pendingOwn}` : null}
      </Notice>
    );
  }
  if (campaign.status === 'paused' && campaign.pause) {
    const { pause } = campaign;
    return (
      <Notice
        tone={pause.requiresAdmin ? 'danger' : 'warning'}
        role="status"
        title={BROADCAST_PAUSE_REASON_LABELS[pause.reason]}
      >
        {pause.by
          ? b.pausedBy(pause.by.name, formatDateTimeInline(pause.at))
          : b.pausedAt(formatDateTimeInline(pause.at))}
        {pause.requiresAdmin ? ` ${b.pausedAdmin}` : null}
        {pause.requiresAdmin && !canResume ? ` ${b.resumeNeedsAdmin}` : null}
      </Notice>
    );
  }
  if (campaign.status === 'running' && campaign.waiting) {
    return (
      <Notice tone="info" role="status" title={b.waitingTitle}>
        {BROADCAST_WAIT_REASON_LABELS[campaign.waiting.reason]}{' '}
        {b.waitingUntil(formatInZone(campaign.waiting.until, zone))}
      </Notice>
    );
  }
  if (campaign.status === 'scheduled') {
    return (
      <Notice tone="info" role="status" title={b.scheduledTitle}>
        {campaign.scheduledAt && Date.parse(campaign.scheduledAt) > now
          ? b.scheduledBody(formatInZone(campaign.scheduledAt, zone))
          : b.scheduledSoon}
      </Notice>
    );
  }
  return null;
}

function CampaignActions({ campaign }: { campaign: BroadcastCampaign }) {
  const queryClient = useQueryClient();
  const selfId = useSession()?.user.id;
  const canApprove = useCan('broadcast.approve');
  const canResume = useCan('sending.resume');
  const canExport = useCan('contacts.export');
  const [busy, setBusy] = useState<'pause' | 'cancel' | 'reject' | 'export' | null>(null);
  const [dialog, setDialog] = useState<'resume' | 'approve' | 'reject' | 'cancel' | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [exported, setExported] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const own = campaign.createdBy?.id === selfId;
  const status = campaign.status;
  const canPause = status === 'running' || status === 'scheduled';
  const blockedResume = campaign.pause?.requiresAdmin === true && !canResume;

  const act = async (
    name: 'pause' | 'cancel' | 'reject' | 'export',
    action: () => Promise<void>,
  ) => {
    setBusy(name);
    setFailure(null);
    setExported(false);
    try {
      await action();
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(null);
    }
  };

  const withIdentity =
    (action: (confirmation: IdentityConfirmation) => Promise<{ broadcast: BroadcastCampaign }>) =>
    async (confirmation: IdentityConfirmation) => {
      try {
        const { broadcast } = await action(confirmation);
        setDialog(null);
        storeBroadcast(queryClient, broadcast);
      } catch (caught) {
        if (isConfirmationError(caught)) throw caught;
        setDialog(null);
        setFailure(caught);
      }
    };

  const exportCsv = () =>
    act('export', async () => {
      const { blob } = await endpoints.broadcasts.exportCsv(campaign.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `broadcast-${campaign.id.slice(0, 8)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      setExported(true);
    });

  const showExport = canExport && status !== 'pending_approval';
  return (
    <>
      <div className={styles.actionsRow}>
        {status === 'pending_approval' && canApprove && !own ? (
          <>
            <Button variant="primary" onClick={() => setDialog('approve')}>
              {b.approve}
            </Button>
            <Button onClick={() => setDialog('reject')}>{b.reject}</Button>
          </>
        ) : null}
        {canPause ? (
          <Button
            loading={busy === 'pause'}
            onClick={() =>
              void act('pause', async () =>
                storeBroadcast(
                  queryClient,
                  (await endpoints.broadcasts.pause(campaign.id)).broadcast,
                ),
              )
            }
          >
            {busy === 'pause' ? null : <Icon icon={Pause} size={16} />}
            {busy === 'pause' ? b.pausing : b.pause}
          </Button>
        ) : null}
        {status === 'paused' ? (
          <Button
            ref={openerRef}
            variant="primary"
            disabled={blockedResume}
            onClick={() => setDialog('resume')}
          >
            <Icon icon={Play} size={16} />
            {b.resume}
          </Button>
        ) : null}
        {showExport ? (
          <Button loading={busy === 'export'} onClick={() => void exportCsv()}>
            {busy === 'export' ? null : <Icon icon={Download} size={16} />}
            {busy === 'export' ? b.exporting : b.exportCsv}
          </Button>
        ) : null}
        {canPause || status === 'paused' || status === 'pending_approval' ? (
          <Button
            variant="ghost"
            className={styles.dangerButton}
            onClick={() => setDialog('cancel')}
          >
            <Icon icon={X} size={16} />
            {b.cancelCampaign}
          </Button>
        ) : null}
      </div>
      {exported ? (
        <Notice tone="success" role="status">
          {b.exported}
        </Notice>
      ) : null}
      {failure ? (
        <Notice tone="danger" role="alert">
          {isApiError(failure) ? failure.message : t.api.network}
        </Notice>
      ) : null}
      {campaign.approval.rejectionReason && campaign.approval.decidedBy ? (
        <Notice tone="info" role="status" title={b.rejectedTitle}>
          {b.rejectedBody(campaign.approval.decidedBy.name, campaign.approval.rejectionReason)}
        </Notice>
      ) : null}

      <IdentityDialog
        open={dialog === 'resume'}
        title={b.confirmResumeTitle}
        body={b.confirmResumeBody}
        confirmLabel={b.resume}
        pendingLabel={b.saving}
        requireCode
        returnFocusRef={openerRef}
        onCancel={() => setDialog(null)}
        onConfirm={withIdentity((confirmation) =>
          endpoints.broadcasts.resume(campaign.id, confirmation),
        )}
      />
      <IdentityDialog
        open={dialog === 'approve'}
        title={b.confirmApproveTitle}
        body={b.confirmApproveBody(
          campaign.counts.pending || campaign.counts.recipients,
          campaign.estimate ? b.money(campaign.estimate.currency, campaign.estimate.total) : null,
        )}
        confirmLabel={b.approve}
        pendingLabel={b.saving}
        requireCode
        onCancel={() => setDialog(null)}
        onConfirm={withIdentity((confirmation) =>
          endpoints.broadcasts.approve(campaign.id, confirmation),
        )}
      />
      <Dialog
        open={dialog === 'reject'}
        title={b.rejectTitle}
        description={b.rejectBody}
        onRequestClose={() => setDialog(null)}
      >
        <form
          className={styles.dialogForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (!reason.trim()) {
              setReasonError('Tulis alasan penolakan.');
              return;
            }
            setReasonError(null);
            void act('reject', async () => {
              const { broadcast } = await endpoints.broadcasts.reject(campaign.id, reason.trim());
              setDialog(null);
              setReason('');
              storeBroadcast(queryClient, broadcast);
            });
          }}
          noValidate
        >
          <TextAreaField
            label={b.rejectReason}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            error={reasonError}
            rows={3}
            maxLength={300}
          />
          <DialogActions>
            <Button onClick={() => setDialog(null)}>{b.cancel}</Button>
            <Button type="submit" variant="danger" loading={busy === 'reject'}>
              {busy === 'reject' ? b.rejecting : b.reject}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
      <ConfirmDialog
        open={dialog === 'cancel'}
        title={b.confirmCancelTitle}
        body={b.confirmCancelBody}
        cancelLabel={b.cancel}
        confirmLabel={busy === 'cancel' ? b.cancelling : b.cancelCampaign}
        confirmVariant="danger"
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          if (busy) return;
          void act('cancel', async () => {
            const { broadcast } = await endpoints.broadcasts.cancel(campaign.id);
            setDialog(null);
            storeBroadcast(queryClient, broadcast);
          });
        }}
      />
    </>
  );
}

function ReportCard({ report, live }: { report: BroadcastReport; live: boolean }) {
  const progress = progressOf(report);
  const tiles: [keyof typeof b.stats, number][] = [
    ['sent', report.sent],
    ['delivered', report.delivered],
    ['read', report.read],
    ['replied', report.replied],
    ['failed', report.failed],
    ['skipped', report.skipped],
    ['pending', report.pending],
  ];
  // Hanya bila ada: tile kosong yang menyendiri tidak menambah informasi.
  if (report.cancelled > 0) tiles.push(['cancelled', report.cancelled]);
  if (report.sending > 0) tiles.splice(6, 0, ['sending', report.sending]);
  const skipped = (
    Object.entries(report.skippedByReason) as [BroadcastSkipReason, number][]
  ).filter(([, count]) => count > 0);
  return (
    <section className={styles.card} aria-labelledby="kampanye-hasil">
      <h2 id="kampanye-hasil" className={styles.cardTitle}>
        {b.statsLabel}
      </h2>
      <div className={styles.progressRow}>
        <div
          className={styles.meter}
          role="meter"
          aria-label={b.progressLabel}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          data-tone="normal"
        >
          <span className={styles.meterFill} style={{ width: `${progress.ratio * 100}%` }} />
        </div>
        <span className={styles.progressText}>{b.processed(progress.done, progress.total)}</span>
      </div>
      {live ? <p className={styles.hint}>{b.liveHint}</p> : null}
      <dl className={styles.tiles}>
        {tiles.map(([key, value]) => (
          <div key={key} className={styles.tile} data-kind={key}>
            <dt>{b.stats[key]}</dt>
            <dd>{value.toLocaleString('id-ID')}</dd>
          </div>
        ))}
      </dl>
      <div className={styles.cost}>
        <h3 className={styles.groupLabel}>{b.costTitle}</h3>
        <p>
          {b.costActual(b.money(report.cost.currency, report.cost.total), report.cost.billable)}
        </p>
        {report.estimate ? (
          <p className={styles.hint}>
            {b.costEstimate(b.money(report.estimate.currency, report.estimate.total))}
          </p>
        ) : null}
      </div>
      {report.failures.length > 0 ? (
        <div className={styles.group}>
          <h3 className={styles.groupLabel}>{b.failuresTitle}</h3>
          <ul className={styles.reasonList}>
            {report.failures.map((failure) => (
              <li key={`${failure.reason}-${String(failure.errorCode)}`}>
                <span className={styles.reasonCount}>{failure.count.toLocaleString('id-ID')}×</span>
                <span>
                  {failure.message}
                  {failure.errorCode !== null ? ` (${b.failureCode(failure.errorCode)})` : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {skipped.length > 0 ? (
        <div className={styles.group}>
          <h3 className={styles.groupLabel}>{b.skippedTitle}</h3>
          <ul className={styles.reasonList}>
            {skipped.map(([reason, count]) => (
              <li key={reason}>
                <span className={styles.reasonCount}>{count.toLocaleString('id-ID')}×</span>
                <span>{BROADCAST_SKIP_REASON_LABELS[reason]}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function RecipientsCard({ campaign }: { campaign: BroadcastCampaign }) {
  const [filter, setFilter] = useState<(typeof RECIPIENT_FILTERS)[number]>('all');
  const status = filter === 'all' ? null : filter;
  const list = useInfiniteQuery({
    queryKey: broadcastKeys.recipients(campaign.id, status),
    queryFn: ({ signal, pageParam }) =>
      endpoints.broadcasts.recipients(campaign.id, status, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: isLive(campaign.status) ? LIVE_REFRESH_MS * 2 : false,
  });
  const items = list.data?.pages.flatMap((page) => page.recipients) ?? [];
  return (
    <section className={styles.card} aria-labelledby="kampanye-penerima">
      <div className={styles.cardHeadRow}>
        <h2 id="kampanye-penerima" className={styles.cardTitle}>
          {b.recipientsTitle}
        </h2>
        <SelectField
          label={b.recipientFilter}
          value={filter}
          onChange={(event) => setFilter(event.target.value as (typeof RECIPIENT_FILTERS)[number])}
          options={RECIPIENT_FILTERS.map((value) => ({
            value,
            label: b.recipientStatuses[value],
          }))}
          className={styles.recipientFilter}
        />
      </div>
      {list.isPending ? (
        <Skeleton className={styles.skeletonField} />
      ) : list.isError ? (
        <p className={styles.hint}>{isApiError(list.error) ? list.error.message : t.api.network}</p>
      ) : items.length === 0 ? (
        <p className={styles.hint}>{b.noRecipients}</p>
      ) : (
        <ul className={styles.recipients} aria-label={b.recipientsLabel}>
          {items.map((recipient) => {
            const state = recipient.messageStatus
              ? t.inbox.chat.deliveryStatus[recipient.messageStatus]
              : b.recipientState[recipient.status];
            const detail = recipient.skipReason
              ? BROADCAST_SKIP_REASON_LABELS[recipient.skipReason]
              : (recipient.failure?.message ?? null);
            return (
              <li key={recipient.id} className={styles.recipient}>
                <div className={styles.recipientMain}>
                  <span className={styles.recipientPhone}>{recipient.phone}</span>
                  <span className={styles.recipientRow}>{b.recipientRow(recipient.row)}</span>
                </div>
                <div className={styles.recipientState}>
                  <span data-tone={recipient.failure ? 'danger' : undefined}>{state}</span>
                  {recipient.repliedAt ? (
                    <span className={styles.recipientReplied}>
                      {b.repliedAt(formatDateTimeInline(recipient.repliedAt))}
                    </span>
                  ) : null}
                </div>
                {detail ? <p className={styles.recipientDetail}>{detail}</p> : null}
                {recipient.conversationId ? (
                  <Link
                    to="/inbox"
                    search={{ chat: recipient.conversationId }}
                    className={styles.recipientLink}
                  >
                    {b.openChat}
                  </Link>
                ) : null}
              </li>
            );
          })}
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
    </section>
  );
}
