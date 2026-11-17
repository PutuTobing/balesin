import type { OutgoingWebhook, WebhookDelivery } from '@balesin/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge, type StatusTone } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTime, formatDateTimeInline } from '../../lib/format';
import { deliveryErrorText } from './delivery-errors';
import { integrationKeys } from './integration-queries';
import styles from './Integrations.module.css';

const copy = t.webhooks;

const TONE: Record<WebhookDelivery['status'], StatusTone> = {
  pending: 'warning',
  succeeded: 'success',
  failed: 'danger',
};

/** Riwayat pengiriman satu webhook (terbaru dulu) + Kirim ulang. */
export function WebhookDeliveriesDialog({
  webhook,
  onClose,
}: {
  webhook: OutgoingWebhook;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const deliveries = useInfiniteQuery({
    queryKey: integrationKeys.deliveries(webhook.id),
    queryFn: ({ pageParam, signal }) =>
      endpoints.webhooks.deliveries(webhook.id, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const items = deliveries.data?.pages.flatMap((page) => page.deliveries) ?? [];

  const redeliver = async (delivery: WebhookDelivery) => {
    setNotice(null);
    try {
      await endpoints.webhooks.redeliver(webhook.id, delivery.id);
      setNotice({ tone: 'success', text: copy.redelivered });
      void queryClient.invalidateQueries({ queryKey: integrationKeys.deliveries(webhook.id) });
    } catch (caught) {
      setNotice({
        tone: 'danger',
        text: isApiError(caught) ? caught.message : t.api.network,
      });
    }
  };

  return (
    <Dialog open title={copy.historyTitle} description={webhook.url} onRequestClose={onClose}>
      <div className={styles.history}>
        {notice ? (
          <Notice tone={notice.tone} role={notice.tone === 'danger' ? 'alert' : 'status'}>
            {notice.text}
          </Notice>
        ) : null}
        {deliveries.isPending ? (
          <SkeletonRegion className={styles.list}>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className={styles.skeletonLine} />
            ))}
          </SkeletonRegion>
        ) : deliveries.isError ? (
          <Notice tone="danger" role="alert">
            {copy.historyFailed}
          </Notice>
        ) : items.length === 0 ? (
          <p className={styles.hint}>{copy.historyEmpty}</p>
        ) : (
          <ol className={styles.deliveries}>
            {items.map((delivery) => (
              <DeliveryRow
                key={delivery.id}
                delivery={delivery}
                onRedeliver={() => void redeliver(delivery)}
              />
            ))}
          </ol>
        )}
        {deliveries.hasNextPage ? (
          <Button
            variant="ghost"
            loading={deliveries.isFetchingNextPage}
            onClick={() => void deliveries.fetchNextPage()}
          >
            {copy.loadMore}
          </Button>
        ) : null}
      </div>
      <DialogActions>
        <Button onClick={onClose}>{copy.close}</Button>
      </DialogActions>
    </Dialog>
  );
}

function DeliveryRow({
  delivery,
  onRedeliver,
}: {
  delivery: WebhookDelivery;
  onRedeliver: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const facts = [
    // HTTP + artinya sudah ada di kalimat galat bila galatnya `http_…`.
    delivery.httpStatus !== null && !delivery.error?.startsWith('http_')
      ? copy.httpStatus(delivery.httpStatus)
      : null,
    delivery.durationMs !== null ? copy.duration(delivery.durationMs) : null,
    copy.attempts(delivery.attempts),
    delivery.error ? copy.errorCode(deliveryErrorText(delivery.error)) : null,
    delivery.status === 'pending' && delivery.nextAttemptAt
      ? copy.nextAttempt(formatDateTimeInline(delivery.nextAttemptAt))
      : null,
  ].filter((item): item is string => item !== null);
  return (
    <li className={styles.delivery}>
      <div className={styles.deliveryHead}>
        <code className={styles.monoSmall}>{delivery.event}</code>
        <StatusBadge tone={TONE[delivery.status]} label={copy.deliveryStatus[delivery.status]} />
      </div>
      <p className={styles.meta}>
        <time dateTime={delivery.createdAt}>{formatDateTime(delivery.createdAt)}</time>
        {facts.length > 0 ? ` · ${facts.join(' · ')}` : ''}
      </p>
      {delivery.responseSnippet ? (
        <details className={styles.snippet}>
          <summary>{copy.response}</summary>
          <p className={styles.hint}>{copy.responseLabel}</p>
          {/* Isi dari server penerima (tidak tepercaya): tampil sebagai teks saja. */}
          <pre className={styles.snippetBody}>{delivery.responseSnippet}</pre>
        </details>
      ) : null}
      {delivery.status !== 'pending' ? (
        delivery.payloadPurged ? (
          <p className={styles.hint}>{copy.purged}</p>
        ) : (
          <div className={styles.itemActions}>
            <Button
              loading={busy}
              onClick={() => {
                setBusy(true);
                onRedeliver();
                setTimeout(() => setBusy(false), 600);
              }}
            >
              {copy.redeliver}
            </Button>
          </div>
        )
      ) : null}
    </li>
  );
}
