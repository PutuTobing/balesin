import { AppError } from '@balesin/core';
import { channels, webhookEvents, type DbExecutor } from '@balesin/db';
import type { WebhookHealth } from '@balesin/shared';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';

import type { RateLimiter } from '../../http/rate-limit';
import { REJECTED_EVENT_ERROR_PREFIX } from './webhook-events.repo';
import { WEBHOOK_SIGNATURE_DAY_RULE, WEBHOOK_SIGNATURE_LAST_FLAG } from './webhook-guard';

/**
 * Diagnosis webhook satu channel (butir 10 sisa, `GET /settings/channels/:id/webhook-health`):
 * hitungan `webhook_events` 24 jam terakhir per status + kejadian terakhir + tanda tangan gagal
 * (Redis). HANYA angka & waktu — tidak pernah payload, wamid, nomor, atau IP.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** `pending` lebih lama dari ini = worker macet/mati (job biasa selesai dalam detik). */
const STALLED_MS = 10 * 60 * 1000;

const CHANNEL_NOT_FOUND = 'Channel tidak ditemukan.';

export async function webhookHealth(
  db: DbExecutor,
  limiter: RateLimiter,
  organizationId: string,
  channelId: string,
  now: Date = new Date(),
): Promise<WebhookHealth> {
  const [channel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.organizationId, organizationId),
        eq(channels.id, channelId),
        isNull(channels.deletedAt),
      ),
    );
  if (!channel) throw new AppError('NOT_FOUND', { message: CHANNEL_NOT_FOUND });

  const since = new Date(now.getTime() - DAY_MS);
  const stalledBefore = new Date(now.getTime() - STALLED_MS);
  const rejected = `${REJECTED_EVENT_ERROR_PREFIX}%`;
  const countWhere = (condition: ReturnType<typeof sql>) =>
    sql<number>`(count(*) filter (where ${condition}))::int`;
  const [counts] = await db
    .select({
      received: sql<number>`count(*)::int`,
      processed: countWhere(sql`${webhookEvents.status} = 'processed'`),
      skipped: countWhere(sql`${webhookEvents.status} = 'skipped'`),
      pending: countWhere(sql`${webhookEvents.status} = 'pending'`),
      failed: countWhere(
        sql`${webhookEvents.status} = 'failed' and coalesce(${webhookEvents.lastError}, '') not like ${rejected} and coalesce(${webhookEvents.lastError}, '') <> 'expired_pending'`,
      ),
      rejected: countWhere(
        sql`${webhookEvents.status} = 'failed' and ${webhookEvents.lastError} like ${rejected}`,
      ),
      expiredPending: countWhere(
        sql`${webhookEvents.status} = 'failed' and ${webhookEvents.lastError} = 'expired_pending'`,
      ),
    })
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.organizationId, organizationId),
        eq(webhookEvents.channelId, channelId),
        gte(webhookEvents.receivedAt, since),
      ),
    );
  const [latest] = await db
    .select({
      lastReceivedAt: sql<Date | null>`max(${webhookEvents.receivedAt})`,
      lastProcessedAt: sql<Date | null>`max(${webhookEvents.processedAt})`,
      stalled: sql<number>`(count(*) filter (where ${webhookEvents.status} = 'pending' and ${webhookEvents.receivedAt} < ${stalledBefore}))::int`,
    })
    .from(webhookEvents)
    .where(
      and(eq(webhookEvents.organizationId, organizationId), eq(webhookEvents.channelId, channelId)),
    );

  const signature = await limiter.peek(WEBHOOK_SIGNATURE_DAY_RULE, channelId);
  const ttl = await limiter.flagTtl(WEBHOOK_SIGNATURE_LAST_FLAG, channelId);
  const lastSignatureFailureAt =
    ttl > 0
      ? new Date(now.getTime() - (WEBHOOK_SIGNATURE_DAY_RULE.windowSeconds - ttl) * 1000)
      : null;

  const value = (n: number | undefined | null) => Number(n ?? 0);
  const last24h = {
    received: value(counts?.received),
    processed: value(counts?.processed),
    skipped: value(counts?.skipped),
    pending: value(counts?.pending),
    failed: value(counts?.failed),
    rejected: value(counts?.rejected),
    expiredPending: value(counts?.expiredPending),
    // `peek` menghitung jatah yang SUDAH dipakai (tanpa menaikkan).
    signatureFailures: signature.count,
  };
  const stalledPending = value(latest?.stalled);
  const asIso = (date: Date | string | null | undefined) =>
    date ? new Date(date).toISOString() : null;
  const attention =
    last24h.failed + last24h.rejected + last24h.expiredPending + last24h.signatureFailures > 0 ||
    stalledPending > 0;
  return {
    status: attention ? 'attention' : last24h.received === 0 ? 'idle' : 'ok',
    lastReceivedAt: asIso(latest?.lastReceivedAt),
    lastProcessedAt: asIso(latest?.lastProcessedAt),
    last24h,
    stalledPending,
    lastSignatureFailureAt: lastSignatureFailureAt?.toISOString() ?? null,
    checkedAt: now.toISOString(),
  };
}
