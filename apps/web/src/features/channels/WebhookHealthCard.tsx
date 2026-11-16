import type { WebhookHealth } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { channelWebhookHealthQuery } from '../../lib/api/queries';
import { formatDateTime, formatDateTimeInline } from '../../lib/format';
import { Fact } from './NumberFacts';
import styles from './Channels.module.css';

const copy = t.channels.webhookHealth;

/** Alasan "perlu dicek" — hanya hitungan, tanpa isi pesan/payload. */
function healthProblems(health: WebhookHealth): string[] {
  const last = health.last24h;
  const problems: string[] = [];
  if (last.signatureFailures > 0) {
    problems.push(
      copy.signatureFailures(
        last.signatureFailures,
        health.lastSignatureFailureAt ? formatDateTimeInline(health.lastSignatureFailureAt) : null,
      ),
    );
  }
  if (last.failed > 0) problems.push(copy.failed(last.failed));
  if (last.rejected > 0) problems.push(copy.rejected(last.rejected));
  if (health.stalledPending > 0) problems.push(copy.stalled(health.stalledPending));
  if (last.expiredPending > 0) problems.push(copy.expired(last.expiredPending));
  return problems;
}

/**
 * Diagnosis webhook 24 jam (`channels.manage`): apakah Meta benar-benar mengirim data ke channel ini
 * dan worker memprosesnya. Hanya hitungan dan waktu — tidak pernah isi pesan.
 */
export function WebhookHealthCard({ channelId }: { channelId: string }) {
  const health = useQuery(channelWebhookHealthQuery(channelId));

  return (
    <section className={styles.subSection} aria-labelledby="channel-webhook-diagnosis">
      <div className={styles.subHead}>
        <h3 id="channel-webhook-diagnosis" className={styles.subTitle}>
          {copy.title}
        </h3>
        <Button
          variant="ghost"
          loading={health.isFetching}
          onClick={() => void health.refetch()}
          disabled={health.isPending}
        >
          {health.isFetching ? copy.checking : copy.recheck}
        </Button>
      </div>
      {health.data ? (
        <HealthBody health={health.data.health} />
      ) : health.isPending ? (
        <SkeletonRegion className={styles.facts}>
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className={styles.skeletonInput} />
          ))}
        </SkeletonRegion>
      ) : (
        <Notice tone="danger" role="alert" title={copy.failedTitle}>
          {isApiError(health.error) ? health.error.message : t.api.network}
        </Notice>
      )}
    </section>
  );
}

function HealthBody({ health }: { health: WebhookHealth }) {
  const last = health.last24h;
  const problems = healthProblems(health);
  return (
    <>
      {health.status === 'ok' ? (
        <Notice tone="success" role="status" title={copy.okTitle}>
          {copy.okBody}
        </Notice>
      ) : health.status === 'idle' ? (
        <Notice tone="warning" role="status" title={copy.idleTitle}>
          {copy.idleBody}
        </Notice>
      ) : (
        <Notice tone="danger" role="status" title={copy.attentionTitle}>
          <ul className={styles.healthProblems}>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Notice>
      )}
      <dl className={styles.facts}>
        <Fact label={copy.received}>{last.received.toLocaleString('id-ID')}</Fact>
        <Fact label={copy.processed}>{last.processed.toLocaleString('id-ID')}</Fact>
        <Fact label={copy.pending}>{last.pending.toLocaleString('id-ID')}</Fact>
        <Fact label={copy.failedLabel}>
          {(last.failed + last.rejected).toLocaleString('id-ID')}
        </Fact>
        <Fact label={copy.lastReceived}>
          {health.lastReceivedAt ? formatDateTime(health.lastReceivedAt) : copy.never}
        </Fact>
        <Fact label={copy.lastProcessed}>
          {health.lastProcessedAt ? formatDateTime(health.lastProcessedAt) : copy.never}
        </Fact>
      </dl>
      <p className={styles.hint}>{copy.checkedAt(formatDateTimeInline(health.checkedAt))}</p>
    </>
  );
}
