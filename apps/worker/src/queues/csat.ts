import {
  MESSAGE_JOBS,
  NOOP_INBOX_EVENT_PUBLISHER,
  type InboxEventPublisher,
  type Logger,
  type MetaGraphClient,
  type SecretBox,
} from '@balesin/core';
import {
  channels,
  contacts,
  conversations,
  csatSettings,
  csatSurveys,
  messages,
  type Database,
} from '@balesin/db';
import {
  CSAT_SCORE_LABELS,
  csatRowId,
  type CsatSkipReason,
  type InteractiveMessage,
} from '@balesin/shared';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import { createBatchingPublisher } from './broadcast';
import { processSendMessageJob } from './messages';

/**
 * CSAT otomatis (Fase 5, docs/KONTRAK-API-LAPORAN.md "CSAT"), job pemeliharaan `csat-dispatch`:
 *
 * 1. **Buat survei** dari kejadian `resolved` 15 menit terakhir yang PELAKUNYA PENGGUNA (agen) —
 *    tidak pernah untuk penyelesaian oleh bot/API key/sistem (batas waktu bot), percakapan broadcast/
 *    API yang dibuat `resolved` (tanpa kejadian), atau organisasi yang mematikan CSAT. Syarat lain
 *    (dicatat `skip_reason`): masih `resolved`, ada pesan pelanggan, ada balasan agen manusia, jendela
 *    24 jam masih terbuka (pesan daftar butuh jendela), channel aktif, kontak bernomor, kontak tidak
 *    disurvei dalam `min_interval_hours`. Satu survei per percakapan (indeks unik).
 * 2. **Kirim** survei `pending` sebagai pesan daftar (skor 1–5, ID baris `csat:<survei>:<skor>`) lewat
 *    jalur kirim yang sama (`processSendMessageJob`: rem darurat, klaim kirim) — `sender_kind: system`.
 * 3. **Terima kasih** setelah dijawab (jendela terbuka karena pelanggan baru membalas).
 * 4. **Kedaluwarsa**: survei `sent` > 24 jam → `expired`.
 * Kejadian dipindai lewat batas UUIDv7 (indeks primary key). Log hanya ID + jumlah.
 */

export interface CsatJobDeps {
  db: Database;
  logger: Logger;
  meta?: MetaGraphClient;
  secretBox?: SecretBox | null;
  publisher?: InboxEventPublisher;
  now?: () => Date;
}

const LOOKBACK_MS = 15 * 60_000;
const SURVEY_TTL_MS = 24 * 60 * 60_000;
const WINDOW_MARGIN_MS = 5 * 60_000;
const BATCH = 50;

function uuidV7Floor(at: Date): string {
  const hex = Math.max(0, at.getTime()).toString(16).padStart(12, '0').slice(-12);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

export function csatSurveyMessage(surveyId: string, question: string): InteractiveMessage {
  return {
    kind: 'list',
    body: question,
    buttonText: 'Beri nilai',
    sections: [
      {
        rows: ([5, 4, 3, 2, 1] as const).map((score) => ({
          id: csatRowId(surveyId, score),
          title: `${String(score)} — ${CSAT_SCORE_LABELS[score]}`,
        })),
      },
    ],
  };
}

async function createSurveys(deps: CsatJobDeps, now: Date): Promise<number> {
  const { db } = deps;
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const events = (
    await db.execute<{
      organization_id: string;
      conversation_id: string;
      actor_user_id: string;
      assignee_user_id: string | null;
      created_at: Date;
      min_interval_hours: number;
    }>(sql`
      select e.organization_id, e.conversation_id, e.actor_user_id, e.assignee_user_id, e.created_at,
        s.min_interval_hours
      from conversation_events e
      join csat_settings s on s.organization_id = e.organization_id and s.enabled
        and s.enabled_at is not null and e.created_at >= s.enabled_at
      where e.id >= ${uuidV7Floor(since)}::uuid and e.created_at > ${since}
        and e.kind = 'resolved' and e.actor_user_id is not null
        and not exists (select 1 from csat_surveys v where v.conversation_id = e.conversation_id)
      order by e.created_at
      limit ${BATCH}`)
  ).rows;
  let created = 0;
  for (const event of events) {
    const org = event.organization_id;
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(
        and(eq(conversations.organizationId, org), eq(conversations.id, event.conversation_id)),
      );
    if (!conversation) continue;
    const skip = async (): Promise<CsatSkipReason | null> => {
      if (conversation.status !== 'resolved') return 'reopened';
      if (!conversation.lastInboundAt) return 'no_customer_message';
      const [human] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, org),
            eq(messages.conversationId, conversation.id),
            eq(messages.direction, 'outbound'),
            eq(messages.senderKind, 'agent'),
          ),
        )
        .limit(1);
      if (!human) return 'no_human_reply';
      if (
        !conversation.windowExpiresAt ||
        conversation.windowExpiresAt.getTime() <= now.getTime() + WINDOW_MARGIN_MS
      ) {
        return 'window_closed';
      }
      const [channel] = await db
        .select({ enabled: channels.enabled, deletedAt: channels.deletedAt, type: channels.type })
        .from(channels)
        .where(and(eq(channels.organizationId, org), eq(channels.id, conversation.channelId)));
      if (
        !channel ||
        !channel.enabled ||
        channel.deletedAt !== null ||
        channel.type !== 'whatsapp'
      ) {
        return 'channel_unavailable';
      }
      const [contact] = await db
        .select({ phone: contacts.phone })
        .from(contacts)
        .where(and(eq(contacts.organizationId, org), eq(contacts.id, conversation.contactId)));
      if (!contact?.phone) return 'recipient_unavailable';
      const [recent] = await db
        .select({ id: csatSurveys.id })
        .from(csatSurveys)
        .where(
          and(
            eq(csatSurveys.organizationId, org),
            eq(csatSurveys.contactId, conversation.contactId),
            inArray(csatSurveys.status, ['pending', 'sent', 'answered', 'expired']),
            sql`${csatSurveys.createdAt} > ${new Date(now.getTime() - event.min_interval_hours * 60 * 60_000)}`,
          ),
        )
        .limit(1);
      return recent ? 'recently_surveyed' : null;
    };
    const reason = await skip();
    const inserted = await db
      .insert(csatSurveys)
      .values({
        organizationId: org,
        conversationId: conversation.id,
        contactId: conversation.contactId,
        channelId: conversation.channelId,
        agentUserId: event.assignee_user_id ?? event.actor_user_id,
        resolvedByUserId: event.actor_user_id,
        resolvedAt: conversation.resolvedAt ?? event.created_at,
        status: reason ? 'skipped' : 'pending',
        skipReason: reason,
      })
      .onConflictDoNothing({ target: csatSurveys.conversationId })
      .returning({ id: csatSurveys.id });
    if (inserted.length > 0 && !reason) created += 1;
  }
  return created;
}

/** Buat pesan sistem keluar (survei/terima kasih) di percakapan survei lalu kirim lewat jalur biasa. */
async function sendSystemMessage(
  deps: CsatJobDeps,
  publisher: InboxEventPublisher,
  survey: {
    id: string;
    organizationId: string;
    conversationId: string;
    contactId: string;
    channelId: string;
  },
  content: { text: string; interactive?: InteractiveMessage },
  mark: 'survey' | 'thanks',
  now: Date,
): Promise<'sent' | 'failed' | 'skipped'> {
  const { db } = deps;
  const messageId = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: csatSurveys.status, thanks: csatSurveys.thanksMessageId })
      .from(csatSurveys)
      .where(eq(csatSurveys.id, survey.id))
      .for('update', { skipLocked: true });
    if (!locked) return null;
    if (mark === 'survey' && locked.status !== 'pending') return null;
    if (mark === 'thanks' && (locked.status !== 'answered' || locked.thanks !== null)) return null;
    const [conversation] = await tx
      .select({ status: conversations.status, windowExpiresAt: conversations.windowExpiresAt })
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, survey.organizationId),
          eq(conversations.id, survey.conversationId),
        ),
      );
    const windowOpen =
      conversation?.windowExpiresAt && conversation.windowExpiresAt.getTime() > now.getTime();
    if (mark === 'survey' && (conversation?.status !== 'resolved' || !windowOpen)) {
      await tx
        .update(csatSurveys)
        .set({
          status: 'skipped',
          skipReason: conversation?.status !== 'resolved' ? 'reopened' : 'window_closed',
        })
        .where(eq(csatSurveys.id, survey.id));
      return null;
    }
    if (!windowOpen) return null;
    const [message] = await tx
      .insert(messages)
      .values({
        organizationId: survey.organizationId,
        conversationId: survey.conversationId,
        contactId: survey.contactId,
        channelId: survey.channelId,
        direction: 'outbound',
        senderKind: 'system',
        type: content.interactive ? 'interactive' : 'text',
        text: content.text,
        extras: content.interactive ? { interactiveMessage: content.interactive } : {},
        status: 'pending',
        statusUpdatedAt: now,
        sendAttempts: 1,
        occurredAt: now,
      })
      .returning({ id: messages.id });
    if (!message) throw new Error('INSERT pesan CSAT tidak mengembalikan baris');
    await tx
      .update(conversations)
      .set({ lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${now})` })
      .where(
        and(
          eq(conversations.organizationId, survey.organizationId),
          eq(conversations.id, survey.conversationId),
        ),
      );
    await tx
      .update(csatSurveys)
      .set(
        mark === 'survey'
          ? { status: 'sent', messageId: message.id, sentAt: now }
          : { thanksMessageId: message.id },
      )
      .where(eq(csatSurveys.id, survey.id));
    return message.id;
  });
  if (!messageId) return 'skipped';
  await publisher.publish([
    {
      type: 'message.created',
      organizationId: survey.organizationId,
      conversationId: survey.conversationId,
      messageId,
    },
  ]);
  if (!deps.meta) return 'sent';
  let result;
  try {
    result = await processSendMessageJob(
      {
        name: MESSAGE_JOBS.send,
        data: { organizationId: survey.organizationId, messageId },
        attemptsMade: 4,
        opts: { attempts: 5 },
      },
      {
        db,
        logger: deps.logger,
        meta: deps.meta,
        secretBox: deps.secretBox ?? null,
        publisher,
        now: () => now,
      },
    );
  } catch {
    result = { status: 'failed' as const };
  }
  if (result.status === 'failed' && mark === 'survey') {
    await db.update(csatSurveys).set({ status: 'failed' }).where(eq(csatSurveys.id, survey.id));
    return 'failed';
  }
  return result.status === 'failed' ? 'failed' : 'sent';
}

export async function dispatchCsat(deps: CsatJobDeps): Promise<Record<string, number>> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const publisher = createBatchingPublisher(deps.publisher ?? NOOP_INBOX_EVENT_PUBLISHER);
  const created = await createSurveys(deps, now);

  let sent = 0;
  let failed = 0;
  const pending = await db
    .select({
      id: csatSurveys.id,
      organizationId: csatSurveys.organizationId,
      conversationId: csatSurveys.conversationId,
      contactId: csatSurveys.contactId,
      channelId: csatSurveys.channelId,
      question: csatSettings.question,
      enabled: csatSettings.enabled,
    })
    .from(csatSurveys)
    .innerJoin(csatSettings, eq(csatSettings.organizationId, csatSurveys.organizationId))
    .where(eq(csatSurveys.status, 'pending'))
    .orderBy(csatSurveys.createdAt)
    .limit(BATCH);
  for (const survey of pending) {
    if (!survey.enabled) {
      // CSAT dimatikan setelah survei dibuat: tidak dikirim.
      await db
        .update(csatSurveys)
        .set({ status: 'skipped', skipReason: 'disabled' })
        .where(and(eq(csatSurveys.id, survey.id), eq(csatSurveys.status, 'pending')));
      continue;
    }
    const outcome = await sendSystemMessage(
      deps,
      publisher,
      survey,
      { text: survey.question, interactive: csatSurveyMessage(survey.id, survey.question) },
      'survey',
      now,
    );
    if (outcome === 'sent') sent += 1;
    if (outcome === 'failed') failed += 1;
  }

  const answered = await db
    .select({
      id: csatSurveys.id,
      organizationId: csatSurveys.organizationId,
      conversationId: csatSurveys.conversationId,
      contactId: csatSurveys.contactId,
      channelId: csatSurveys.channelId,
      thanks: csatSettings.thanks,
    })
    .from(csatSurveys)
    .innerJoin(csatSettings, eq(csatSettings.organizationId, csatSurveys.organizationId))
    .where(
      and(
        eq(csatSurveys.status, 'answered'),
        isNull(csatSurveys.thanksMessageId),
        sql`${csatSurveys.answeredAt} > ${new Date(now.getTime() - 60 * 60_000)}`,
      ),
    )
    .limit(BATCH);
  let thanked = 0;
  for (const survey of answered) {
    if (
      (await sendSystemMessage(deps, publisher, survey, { text: survey.thanks }, 'thanks', now)) ===
      'sent'
    ) {
      thanked += 1;
    }
  }

  const expired = await db
    .update(csatSurveys)
    .set({ status: 'expired' })
    .where(
      and(
        eq(csatSurveys.status, 'sent'),
        lt(csatSurveys.sentAt, new Date(now.getTime() - SURVEY_TTL_MS)),
      ),
    )
    .returning({ id: csatSurveys.id });
  await publisher.flush();
  return { created, sent, failed, thanked, expired: expired.length };
}
