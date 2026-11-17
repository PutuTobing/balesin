import {
  BROADCAST_ALARMS_INTERVAL_MS,
  BROADCAST_GUARD_INTERVAL_MS,
  BROADCAST_JOBS,
  BROADCAST_LEASE_MS,
  BROADCAST_SLICE_MS,
  BROADCAST_TICK_INTERVAL_MS,
  MESSAGE_JOBS,
  NOOP_INBOX_EVENT_PUBLISHER,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  broadcastRunJobId,
  broadcastRunJobPayloadSchema,
  broadcastScheduledJobPayloadSchema,
  dedupeInboxEvents,
  sendTelegramMessage,
  type InboxBusEventInput,
  type InboxEventPublisher,
  type Logger,
  type MetaGraphClient,
  type SecretBox,
  type SecurityNoticeAdminEmailPayload,
} from '@balesin/core';
import {
  TELEGRAM_TOKEN_PURPOSE,
  alarmEvents,
  auditLogs,
  broadcastCampaigns,
  broadcastRecipients,
  channels,
  contacts,
  conversations,
  loadBroadcastSettings,
  messageTemplates,
  messages,
  organizations,
  recordAlarm,
  recordOutgoingEvent,
  telegramAlarmSettings,
  users,
  type BroadcastCampaignRow,
  type Database,
  type DbExecutor,
  type MessageExtras,
} from '@balesin/db';
import {
  alarmText,
  broadcastMappingSchema,
  broadcastRequiredVariables,
  renderBroadcastParameters,
  templateContentSchema,
  templateVariables,
  whatsAppNumberSummarySchema,
  type AlarmKind,
  type BroadcastPauseReason,
  type BroadcastWaitReason,
  type TemplateContent,
} from '@balesin/shared';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import { lockContactIdentities } from '../inbound/contacts';
import { processSendMessageJob, type SendMessageResult } from './messages';
import type { QueueConnectionOptions } from './system';

/**
 * Antrian `broadcast` (Fase 4, docs/KONTRAK-API-BROADCAST.md "Worker").
 *
 * - `tick` (tiap 2 dtk): kampanye `scheduled` yang jatuh tempo → `running`; rem darurat organisasi →
 *   kampanye aktif dijeda (`emergency_brake`) + alarm sekali per penarikan; setiap kampanye `running`
 *   tanpa sewa aktif dan tidak sedang menunggu → job `run` (payload hanya ID).
 * - `run`: ambil SEWA kampanye (60 dtk) → kirim bertahap ±25 dtk dengan throttle `rate_per_second`.
 *   Klaim penerima = `pending → queued` DI TRANSAKSI YANG SAMA dengan pembuatan pesan (kampanye dikunci
 *   `FOR SHARE`: jeda/batal menunggu transaksi itu, lalu tidak ada pesan baru). Pesan dikirim lewat
 *   `processSendMessageJob` (jalur kirim yang sama: rem darurat, klaim kirim atomik, status awal).
 *   Restart aman: penerima `queued` yang pesannya masih `pending` tanpa klaim dikirim ulang lebih dulu;
 *   klaim yang macet diurus pemeriksa `stale-send-claims` (tidak pernah dikirim dua kali).
 * - Batas: cadangan kuota CS (persen batas harian organisasi tidak dipakai broadcast), tier Meta nomor
 *   (pelanggan unik/24 jam), batas laju Meta → status MENUNGGU (lanjut sendiri).
 * - Rem otomatis kampanye: lonjakan gagal, kode Meta tingkat akun (diblokir/dibatasi/pembayaran/token),
 *   template dijeda/dinonaktifkan, kualitas nomor merah/ditandai, channel nonaktif → `paused` + alarm;
 *   melanjutkan butuh `sending.resume`.
 * - `guard` (tiap menit): rem darurat OTOMATIS organisasi bila pesan keluar NON-broadcast per menit
 *   melonjak (SECURITY §5), retensi data kolom penerima 30 hari setelah kampanye selesai.
 * - `alarms` (tiap 10 dtk): outbox `alarm_events` → Telegram (bila diatur), teks tanpa data pelanggan.
 *
 * Real-time: event pesan dikumpulkan lalu diterbitkan per potongan (bukan satu per pesan). Log hanya
 * ID + jumlah + kode — tidak pernah nomor, isi, atau token.
 */

export interface BroadcastJob {
  id?: string;
  name: string;
  data: unknown;
}

export interface BroadcastJobDeps {
  db: Database;
  logger: Logger;
  meta: MetaGraphClient;
  secretBox: SecretBox | null;
  publisher?: InboxEventPublisher;
  /** Mengantre job `run` (diisi worker; tes memanggil langsung). */
  enqueueRun?: (job: { organizationId: string; campaignId: string }) => Promise<void>;
  /** Email Owner untuk rem otomatis (antrian `email`). */
  notifyOwner?: (payload: SecurityNoticeAdminEmailPayload) => Promise<void>;
  /** HANYA tes: server Telegram tiruan. */
  telegramBaseUrl?: string;
  now?: () => Date;
  /** HANYA tes: tidur pengatur kecepatan (bawaan setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** HANYA tes: lama satu potongan kerja. */
  sliceMs?: number;
}

/** Kode Meta tingkat akun/nomor: kampanye dijeda (bukan sekadar satu penerima gagal). */
const ACCOUNT_BLOCK_CODES = new Set([368, 130497, 131031, 131048, 131042, 190, 10, 131005]);
/** Template tidak lagi bisa dipakai (dihapus/dijeda/dinonaktifkan). */
const TEMPLATE_BLOCK_CODES = new Set([132001, 132015, 132016]);
const BLOCKED_QUALITY = new Set(['RED']);
const BLOCKED_NUMBER_STATUS = new Set(['FLAGGED', 'RESTRICTED', 'BANNED', 'DISCONNECTED']);
const FAILURE_REASONS_COUNTED = ['meta_rejected', 'delivery_failed'];
const DATA_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const TIERS: Readonly<Record<string, number>> = {
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1_000,
  TIER_2K: 2_000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Penerbit yang mengumpulkan event lalu menerbitkannya sekaligus (dedupe) saat `flush`. */
export function createBatchingPublisher(inner: InboxEventPublisher) {
  let buffer: InboxBusEventInput[] = [];
  return {
    publish(events: readonly InboxBusEventInput[]) {
      buffer.push(...events);
      return Promise.resolve();
    },
    async flush() {
      const events = dedupeInboxEvents(buffer);
      buffer = [];
      if (events.length > 0) await inner.publish(events);
    },
  };
}

// ── tick ────────────────────────────────────────────────────────────────────

export async function broadcastTick(deps: BroadcastJobDeps): Promise<Record<string, number>> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();

  // Rem darurat organisasi → semua kampanye aktif organisasi itu dijeda.
  const braked = await db
    .update(broadcastCampaigns)
    .set({
      status: 'paused',
      pausedReason: 'emergency_brake',
      pausedAt: now,
      pausedByUserId: null,
      waitingReason: null,
      waitingUntil: null,
      runnerLeaseUntil: null,
    })
    .where(
      and(
        inArray(broadcastCampaigns.status, ['scheduled', 'running']),
        sql`exists (select 1 from ${organizations} o where o.id = ${broadcastCampaigns.organizationId} and o.sending_paused_at is not null)`,
      ),
    )
    .returning({ id: broadcastCampaigns.id });

  // Alarm sekali per penarikan rem (manual dari Pengaturan, atau otomatis dari `guard`).
  const pausedOrgs = await db
    .select({
      id: organizations.id,
      pausedAt: organizations.sendingPausedAt,
      reason: organizations.sendingPauseReason,
    })
    .from(organizations)
    .where(sql`${organizations.sendingPausedAt} is not null`);
  for (const org of pausedOrgs) {
    if (!org.pausedAt) continue;
    const [existing] = await db
      .select({ id: alarmEvents.id })
      .from(alarmEvents)
      .where(
        and(
          eq(alarmEvents.organizationId, org.id),
          inArray(alarmEvents.kind, ['emergency_brake', 'auto_brake']),
          gte(alarmEvents.createdAt, org.pausedAt),
        ),
      )
      .limit(1);
    if (!existing) {
      await recordAlarm(db, {
        organizationId: org.id,
        kind: 'emergency_brake',
        details: { reason: org.reason ? org.reason.slice(0, 200) : null },
      });
    }
  }

  // Kampanye terjadwal yang jatuh tempo mulai berjalan.
  const started = await db
    .update(broadcastCampaigns)
    .set({ status: 'running', startedAt: sql`coalesce(${broadcastCampaigns.startedAt}, ${now})` })
    .where(
      and(
        eq(broadcastCampaigns.status, 'scheduled'),
        or(isNull(broadcastCampaigns.scheduledAt), lt(broadcastCampaigns.scheduledAt, now)),
      ),
    )
    .returning({ id: broadcastCampaigns.id });

  const due = await db
    .select({ id: broadcastCampaigns.id, organizationId: broadcastCampaigns.organizationId })
    .from(broadcastCampaigns)
    .where(
      and(
        eq(broadcastCampaigns.status, 'running'),
        or(
          isNull(broadcastCampaigns.runnerLeaseUntil),
          lt(broadcastCampaigns.runnerLeaseUntil, now),
        ),
        or(isNull(broadcastCampaigns.waitingUntil), lt(broadcastCampaigns.waitingUntil, now)),
      ),
    )
    .limit(50);
  for (const campaign of due) {
    await deps.enqueueRun?.({ organizationId: campaign.organizationId, campaignId: campaign.id });
  }
  if (braked.length > 0) {
    deps.logger.warn({ campaigns: braked.length }, 'Broadcast dijeda karena rem darurat');
  }
  return { braked: braked.length, started: started.length, enqueued: due.length };
}

// ── run ─────────────────────────────────────────────────────────────────────

interface RunContext {
  campaign: BroadcastCampaignRow;
  template: {
    id: string;
    name: string;
    language: string;
    category: string;
    content: TemplateContent;
  };
}

async function pauseCampaign(
  db: DbExecutor,
  campaign: { id: string; organizationId: string; name: string },
  reason: BroadcastPauseReason,
  now: Date,
  details: Record<string, number | string | null> = {},
): Promise<boolean> {
  const updated = await db
    .update(broadcastCampaigns)
    .set({
      status: 'paused',
      pausedReason: reason,
      pausedAt: now,
      pausedByUserId: null,
      waitingReason: null,
      waitingUntil: null,
      runnerLeaseUntil: null,
    })
    .where(
      and(
        eq(broadcastCampaigns.id, campaign.id),
        inArray(broadcastCampaigns.status, ['running', 'scheduled']),
      ),
    )
    .returning({ id: broadcastCampaigns.id });
  if (updated.length === 0) return false;
  if (reason !== 'emergency_brake') {
    await recordAlarm(db, {
      organizationId: campaign.organizationId,
      kind: 'broadcast_auto_paused',
      campaignId: campaign.id,
      details: { campaign: campaign.name, reason, ...details },
    });
  }
  return true;
}

async function wait(
  db: DbExecutor,
  campaignId: string,
  reason: BroadcastWaitReason,
  until: Date,
): Promise<void> {
  await db
    .update(broadcastCampaigns)
    .set({ waitingReason: reason, waitingUntil: until, runnerLeaseUntil: null })
    .where(and(eq(broadcastCampaigns.id, campaignId), eq(broadcastCampaigns.status, 'running')));
}

/** Pemeriksaan sebelum (dan berkala selama) mengirim. `null` = boleh lanjut. */
async function guardCampaign(
  deps: BroadcastJobDeps,
  context: RunContext,
  now: Date,
): Promise<'stop' | null> {
  const { db } = deps;
  const { campaign } = context;
  const org = campaign.organizationId;
  const [organization] = await db
    .select({
      pausedAt: organizations.sendingPausedAt,
      dailyLimit: organizations.sendDailyLimitPerOrganization,
    })
    .from(organizations)
    .where(eq(organizations.id, org));
  if (!organization) return 'stop';
  if (organization.pausedAt) {
    await pauseCampaign(db, campaign, 'emergency_brake', now);
    return 'stop';
  }
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.organizationId, org), eq(channels.id, campaign.channelId)));
  if (!channel || !channel.enabled || channel.deletedAt !== null || !channel.waPhoneNumberId) {
    await pauseCampaign(db, campaign, 'channel_unavailable', now);
    return 'stop';
  }
  const summary = whatsAppNumberSummarySchema.safeParse(channel.waNumberSummary);
  if (
    summary.success &&
    (BLOCKED_QUALITY.has(summary.data.qualityRating ?? '') ||
      BLOCKED_NUMBER_STATUS.has(summary.data.status ?? ''))
  ) {
    await pauseCampaign(db, campaign, 'quality_low', now);
    return 'stop';
  }
  const [template] = await db
    .select({ status: messageTemplates.status, qualityScore: messageTemplates.qualityScore })
    .from(messageTemplates)
    .where(
      and(eq(messageTemplates.organizationId, org), eq(messageTemplates.id, context.template.id)),
    );
  if (!template || template.status !== 'APPROVED') {
    await pauseCampaign(db, campaign, 'template_unavailable', now);
    return 'stop';
  }
  const settings = await loadBroadcastSettings(db, org);
  // Cadangan kuota CS: broadcast berhenti sebelum batas harian organisasi habis.
  const [sent] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.organizationId, org),
        eq(messages.direction, 'outbound'),
        sql`${messages.createdAt} > ${new Date(now.getTime() - DAY_MS)}`,
      ),
    );
  const quota = Math.floor((organization.dailyLimit * (100 - settings.quotaReservePercent)) / 100);
  if (Number(sent?.total ?? 0) >= quota) {
    await wait(db, campaign.id, 'daily_quota', new Date(now.getTime() + 5 * 60_000));
    return 'stop';
  }
  // Tier Meta: pelanggan unik per 24 jam per nomor (perkiraan dari broadcast di nomor itu).
  const tier = summary.success ? TIERS[summary.data.messagingLimit ?? ''] : undefined;
  if (tier !== undefined) {
    const [unique] = await db
      .select({ total: sql<number>`count(distinct ${broadcastRecipients.phone})::int` })
      .from(broadcastRecipients)
      .innerJoin(
        broadcastCampaigns,
        and(
          eq(broadcastCampaigns.organizationId, broadcastRecipients.organizationId),
          eq(broadcastCampaigns.id, broadcastRecipients.campaignId),
        ),
      )
      .where(
        and(
          eq(broadcastRecipients.organizationId, org),
          eq(broadcastCampaigns.channelId, campaign.channelId),
          eq(broadcastRecipients.status, 'queued'),
          sql`${broadcastRecipients.processedAt} > ${new Date(now.getTime() - DAY_MS)}`,
        ),
      );
    const allowed = Math.floor((tier * (100 - settings.quotaReservePercent)) / 100);
    if (Number(unique?.total ?? 0) >= allowed) {
      await wait(db, campaign.id, 'meta_tier', new Date(now.getTime() + 15 * 60_000));
      return 'stop';
    }
  }
  // Lonjakan gagal pada sampel terakhir (sejak kampanye terakhir dilanjutkan).
  if (settings.autoBrake.enabled) {
    const sample = Math.max(settings.autoBrake.failureSpikeMinSample, 50);
    const recent = await db
      .select({ status: messages.status, reason: messages.failureReason })
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, org),
          eq(messages.broadcastId, campaign.id),
          campaign.failureWindowFrom
            ? sql`${messages.createdAt} >= ${campaign.failureWindowFrom}`
            : undefined,
          sql`${messages.status} <> 'pending'`,
        ),
      )
      .orderBy(sql`${messages.createdAt} desc`)
      .limit(sample);
    const failed = recent.filter(
      (entry) => entry.status === 'failed' && FAILURE_REASONS_COUNTED.includes(entry.reason ?? ''),
    ).length;
    if (
      recent.length >= settings.autoBrake.failureSpikeMinSample &&
      failed * 100 >= settings.autoBrake.failureSpikePercent * recent.length
    ) {
      await pauseCampaign(db, campaign, 'failure_spike', now, {
        sent: recent.length,
        failed,
      });
      return 'stop';
    }
  }
  return null;
}

function templateSpec(
  context: RunContext,
  parameters: ReturnType<typeof renderBroadcastParameters>['parameters'],
): NonNullable<MessageExtras['template']> {
  const { content } = context.template;
  const required = broadcastRequiredVariables(content);
  const header = content.header;
  const headerVariable =
    header?.format === 'TEXT' ? (templateVariables(header.text)[0] ?? null) : null;
  return {
    templateId: context.template.id,
    name: context.template.name,
    language: context.template.language,
    category: context.template.category,
    named: content.parameterFormat === 'named',
    headerFormat: header?.format ?? null,
    headerVariable,
    headerText: headerVariable ? (parameters.header?.text ?? null) : null,
    headerMediaFileId: null,
    bodyVariables: required.body,
    values: parameters.body,
    buttons: required.buttons.map((index) => {
      const button = content.buttons[Number(index)];
      return {
        index: Number(index),
        type: button?.type === 'COPY_CODE' ? ('COPY_CODE' as const) : ('URL' as const),
        value: parameters.buttons[index] ?? '',
      };
    }),
  };
}

type Claim =
  | { kind: 'message'; recipientId: string; messageId: string; attempts: number }
  | { kind: 'skipped' }
  | { kind: 'none' }
  | { kind: 'stopped' };

/** Pesan yang sudah dibuat tetapi belum pernah sampai ke Meta (restart / dilanjutkan). */
async function unsentQueued(db: DbExecutor, campaign: BroadcastCampaignRow): Promise<Claim> {
  const [row] = await db
    .select({
      recipientId: broadcastRecipients.id,
      messageId: messages.id,
      attempts: broadcastRecipients.sendAttempts,
    })
    .from(broadcastRecipients)
    .innerJoin(
      messages,
      and(
        eq(messages.organizationId, broadcastRecipients.organizationId),
        eq(messages.id, broadcastRecipients.messageId),
      ),
    )
    .where(
      and(
        eq(broadcastRecipients.organizationId, campaign.organizationId),
        eq(broadcastRecipients.campaignId, campaign.id),
        eq(broadcastRecipients.status, 'queued'),
        eq(messages.status, 'pending'),
        isNull(messages.wamid),
        isNull(messages.sendClaimedAt),
      ),
    )
    .orderBy(asc(broadcastRecipients.rowNumber))
    .limit(1);
  return row ? { kind: 'message', ...row } : { kind: 'none' };
}

/** Klaim penerima berikutnya + buat kontak/percakapan/pesan dalam SATU transaksi. */
async function claimNext(db: Database, context: RunContext, now: Date): Promise<Claim> {
  return db.transaction(async (tx) => {
    const { campaign } = context;
    const org = campaign.organizationId;
    const [live] = await tx
      .select({ status: broadcastCampaigns.status })
      .from(broadcastCampaigns)
      .where(eq(broadcastCampaigns.id, campaign.id))
      .for('share');
    if (live?.status !== 'running') return { kind: 'stopped' };
    const [recipient] = await tx
      .select()
      .from(broadcastRecipients)
      .where(
        and(
          eq(broadcastRecipients.organizationId, org),
          eq(broadcastRecipients.campaignId, campaign.id),
          eq(broadcastRecipients.status, 'pending'),
        ),
      )
      .orderBy(asc(broadcastRecipients.rowNumber))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!recipient) return { kind: 'none' };

    const skip = async (reason: string) => {
      await tx
        .update(broadcastRecipients)
        .set({ status: 'skipped', skipReason: reason, processedAt: now })
        .where(eq(broadcastRecipients.id, recipient.id));
      return { kind: 'skipped' as const };
    };
    const mapping = broadcastMappingSchema.safeParse(campaign.mapping);
    if (!mapping.success) return skip('missing_variable');
    const render = renderBroadcastParameters(
      context.template.content,
      mapping.data,
      recipient.data,
    );
    if (render.missing.length > 0) return skip('missing_variable');
    if (render.invalid.length > 0) return skip('invalid_variable');

    // Kunci identitas nomor (sama dengan worker pesan masuk & api) — juga menserialkan anti-dobel.
    await lockContactIdentities(tx, org, 'whatsapp', { bsuid: null, phone: recipient.phone });
    if (campaign.dedupeHours !== null) {
      const since = new Date(now.getTime() - campaign.dedupeHours * 60 * 60 * 1000);
      const [recent] = await tx
        .select({ id: broadcastRecipients.id })
        .from(broadcastRecipients)
        .innerJoin(
          broadcastCampaigns,
          and(
            eq(broadcastCampaigns.organizationId, broadcastRecipients.organizationId),
            eq(broadcastCampaigns.id, broadcastRecipients.campaignId),
          ),
        )
        .where(
          and(
            eq(broadcastRecipients.organizationId, org),
            eq(broadcastRecipients.phone, recipient.phone),
            eq(broadcastRecipients.status, 'queued'),
            sql`${broadcastRecipients.processedAt} > ${since}`,
            sql`${broadcastRecipients.campaignId} <> ${campaign.id}`,
            campaign.dedupeScope === 'template'
              ? eq(broadcastCampaigns.templateId, campaign.templateId)
              : undefined,
          ),
        )
        .limit(1);
      if (recent) return skip('recently_sent');
    }

    let [contact] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, org),
          eq(contacts.channelType, 'whatsapp'),
          eq(contacts.phone, recipient.phone),
        ),
      )
      .limit(1);
    if (!contact) {
      [contact] = await tx
        .insert(contacts)
        .values({ organizationId: org, channelType: 'whatsapp', phone: recipient.phone })
        .returning({ id: contacts.id });
      if (!contact) throw new Error('INSERT kontak tidak mengembalikan baris');
      await recordOutgoingEvent(tx, {
        organizationId: org,
        type: 'contact.created',
        contactId: contact.id,
      });
    }
    // Percakapan: yang terbuka, lalu yang terakhir; bila belum ada dibuat `resolved` (pesan sistem —
    // tidak menambah antrian; balasan pelanggan membuka sesi baru), sama seperti API v1.
    const [existing] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, org),
          eq(conversations.contactId, contact.id),
          eq(conversations.channelId, campaign.channelId),
        ),
      )
      .orderBy(
        sql`case when ${conversations.status} <> 'resolved' then 0 else 1 end`,
        sql`${conversations.createdAt} desc`,
      )
      .limit(1)
      .for('update');
    let conversationId = existing?.id;
    if (!conversationId) {
      const [created] = await tx
        .insert(conversations)
        .values({
          organizationId: org,
          contactId: contact.id,
          channelId: campaign.channelId,
          status: 'resolved',
          resolvedAt: now,
          lastMessageAt: now,
        })
        .returning({ id: conversations.id });
      if (!created) throw new Error('INSERT percakapan tidak mengembalikan baris');
      conversationId = created.id;
      await recordOutgoingEvent(tx, {
        organizationId: org,
        type: 'conversation.created',
        conversationId,
        contactId: contact.id,
      });
    }
    const spec = templateSpec(context, render.parameters);
    const [message] = await tx
      .insert(messages)
      .values({
        organizationId: org,
        conversationId,
        contactId: contact.id,
        channelId: campaign.channelId,
        direction: 'outbound',
        senderKind: 'broadcast',
        type: 'template',
        text: render.preview,
        extras: { template: spec },
        templateId: spec.templateId,
        templateCategory: spec.category,
        broadcastId: campaign.id,
        status: 'pending',
        statusUpdatedAt: now,
        sendAttempts: 1,
        occurredAt: now,
      })
      .returning({ id: messages.id });
    if (!message) throw new Error('INSERT pesan broadcast tidak mengembalikan baris');
    await tx
      .update(conversations)
      .set({ lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${now})` })
      .where(and(eq(conversations.organizationId, org), eq(conversations.id, conversationId)));
    await tx
      .update(broadcastRecipients)
      .set({
        status: 'queued',
        contactId: contact.id,
        conversationId,
        messageId: message.id,
        processedAt: now,
      })
      .where(eq(broadcastRecipients.id, recipient.id));
    return { kind: 'message', recipientId: recipient.id, messageId: message.id, attempts: 0 };
  });
}

async function completeIfDone(db: Database, campaign: BroadcastCampaignRow, now: Date) {
  const [left] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(broadcastRecipients)
    .leftJoin(
      messages,
      and(
        eq(messages.organizationId, broadcastRecipients.organizationId),
        eq(messages.id, broadcastRecipients.messageId),
      ),
    )
    .where(
      and(
        eq(broadcastRecipients.organizationId, campaign.organizationId),
        eq(broadcastRecipients.campaignId, campaign.id),
        or(
          eq(broadcastRecipients.status, 'pending'),
          and(
            eq(broadcastRecipients.status, 'queued'),
            eq(messages.status, 'pending'),
            isNull(messages.wamid),
          ),
        ),
      ),
    );
  if (Number(left?.total ?? 0) > 0) return false;
  const done = await db
    .update(broadcastCampaigns)
    .set({ status: 'completed', completedAt: now, runnerLeaseUntil: null })
    .where(and(eq(broadcastCampaigns.id, campaign.id), eq(broadcastCampaigns.status, 'running')))
    .returning({ id: broadcastCampaigns.id });
  if (done.length > 0) {
    const [counts] = await db
      .select({
        recipients: sql<number>`count(*)::int`,
        sent: sql<number>`count(*) filter (where ${broadcastRecipients.status} = 'queued')::int`,
      })
      .from(broadcastRecipients)
      .where(
        and(
          eq(broadcastRecipients.organizationId, campaign.organizationId),
          eq(broadcastRecipients.campaignId, campaign.id),
        ),
      );
    await recordAlarm(db, {
      organizationId: campaign.organizationId,
      kind: 'broadcast_completed',
      campaignId: campaign.id,
      details: {
        campaign: campaign.name,
        recipients: Number(counts?.recipients ?? 0),
        sent: Number(counts?.sent ?? 0),
      },
    });
  }
  return true;
}

export async function runBroadcastSlice(
  payload: { organizationId: string; campaignId: string },
  deps: BroadcastJobDeps,
): Promise<{ status: 'skipped' | 'stopped' | 'completed' | 'sliced'; sent: number }> {
  const { db, logger } = deps;
  const clock = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const start = clock();
  const [campaign] = await db
    .update(broadcastCampaigns)
    .set({
      runnerLeaseUntil: new Date(start.getTime() + BROADCAST_LEASE_MS),
      waitingReason: null,
      waitingUntil: null,
    })
    .where(
      and(
        eq(broadcastCampaigns.organizationId, payload.organizationId),
        eq(broadcastCampaigns.id, payload.campaignId),
        eq(broadcastCampaigns.status, 'running'),
        or(
          isNull(broadcastCampaigns.runnerLeaseUntil),
          lt(broadcastCampaigns.runnerLeaseUntil, start),
        ),
        or(isNull(broadcastCampaigns.waitingUntil), lt(broadcastCampaigns.waitingUntil, start)),
      ),
    )
    .returning();
  if (!campaign) return { status: 'skipped', sent: 0 };

  const release = () =>
    db
      .update(broadcastCampaigns)
      .set({ runnerLeaseUntil: null })
      .where(eq(broadcastCampaigns.id, campaign.id));
  const [template] = await db
    .select()
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.organizationId, campaign.organizationId),
        eq(messageTemplates.id, campaign.templateId),
      ),
    );
  const content = templateContentSchema.safeParse(template?.content);
  if (!template || !content.success) {
    await pauseCampaign(db, campaign, 'template_unavailable', start);
    return { status: 'stopped', sent: 0 };
  }
  const context: RunContext = {
    campaign,
    template: {
      id: template.id,
      name: template.name,
      language: template.language,
      category: template.category,
      content: content.data,
    },
  };
  const publisher = createBatchingPublisher(deps.publisher ?? NOOP_INBOX_EVENT_PUBLISHER);
  const interval = 1000 / Math.max(1, campaign.ratePerSecond);
  const sliceMs = deps.sliceMs ?? BROADCAST_SLICE_MS;
  let sent = 0;
  let sinceGuard = 0;
  let status: 'stopped' | 'completed' | 'sliced' = 'sliced';
  try {
    if ((await guardCampaign(deps, context, start)) === 'stop') return { status: 'stopped', sent };
    while (clock().getTime() - start.getTime() < sliceMs) {
      const tickStart = clock();
      let claim = await unsentQueued(db, campaign);
      if (claim.kind === 'none') claim = await claimNext(db, context, tickStart);
      if (claim.kind === 'stopped') {
        status = 'stopped';
        break;
      }
      if (claim.kind === 'none') {
        status = (await completeIfDone(db, campaign, tickStart)) ? 'completed' : 'sliced';
        break;
      }
      if (claim.kind === 'skipped') continue;

      let result: SendMessageResult;
      try {
        result = await processSendMessageJob(
          {
            name: MESSAGE_JOBS.send,
            data: { organizationId: campaign.organizationId, messageId: claim.messageId },
            attemptsMade: claim.attempts,
            opts: { attempts: 5 },
          },
          {
            db,
            logger,
            meta: deps.meta,
            secretBox: deps.secretBox,
            publisher,
            now: () => clock(),
          },
        );
      } catch {
        // Batas laju / gangguan sementara Meta: pesan tetap `pending` (klaim dilepas), dicoba lagi.
        await db
          .update(broadcastRecipients)
          .set({ sendAttempts: sql`${broadcastRecipients.sendAttempts} + 1` })
          .where(eq(broadcastRecipients.id, claim.recipientId));
        await wait(
          db,
          campaign.id,
          'meta_rate_limit',
          new Date(clock().getTime() + 10_000 * 2 ** Math.min(claim.attempts, 5)),
        );
        status = 'stopped';
        break;
      }
      sent += 1;
      sinceGuard += 1;
      if (result.status === 'failed') {
        const code = result.errorCode;
        const reason =
          result.reason === 'channel_unavailable' || result.reason === 'credentials_unavailable'
            ? 'channel_unavailable'
            : code !== null && ACCOUNT_BLOCK_CODES.has(code)
              ? 'meta_blocked'
              : code !== null && TEMPLATE_BLOCK_CODES.has(code)
                ? 'template_unavailable'
                : result.reason === 'sending_paused'
                  ? 'emergency_brake'
                  : null;
        if (reason) {
          await pauseCampaign(
            db,
            campaign,
            reason,
            clock(),
            code !== null ? { metaCode: code } : {},
          );
          status = 'stopped';
          break;
        }
      }
      if (sinceGuard >= 10) {
        sinceGuard = 0;
        await publisher.flush();
        if ((await guardCampaign(deps, context, clock())) === 'stop') {
          status = 'stopped';
          break;
        }
        await db
          .update(broadcastCampaigns)
          .set({ runnerLeaseUntil: new Date(clock().getTime() + BROADCAST_LEASE_MS) })
          .where(eq(broadcastCampaigns.id, campaign.id));
      }
      const elapsed = clock().getTime() - tickStart.getTime();
      if (elapsed < interval) await sleep(interval - elapsed);
    }
  } finally {
    await publisher.flush();
    if (status === 'sliced') await release();
  }
  logger.info({ campaignId: campaign.id, sent, status }, 'Potongan broadcast selesai');
  return { status, sent };
}

// ── guard: rem otomatis organisasi + retensi ────────────────────────────────

export async function broadcastGuard(deps: BroadcastJobDeps): Promise<Record<string, number>> {
  const { db, logger } = deps;
  const now = (deps.now ?? (() => new Date()))();
  let braked = 0;
  const bursts = await db
    .select({
      organizationId: messages.organizationId,
      total: sql<number>`count(*)::int`,
    })
    .from(messages)
    .where(
      and(
        eq(messages.direction, 'outbound'),
        isNull(messages.broadcastId),
        sql`${messages.createdAt} > ${new Date(now.getTime() - 60_000)}`,
      ),
    )
    .groupBy(messages.organizationId);
  for (const burst of bursts) {
    const perMinute = Number(burst.total);
    const settings = await loadBroadcastSettings(db, burst.organizationId);
    const brake = settings.autoBrake;
    if (!brake.enabled || perMinute <= brake.spikeMinPerMinute) continue;
    let trigger = perMinute > brake.spikeAbsolutePerMinute;
    if (!trigger) {
      const [week] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(
            eq(messages.organizationId, burst.organizationId),
            eq(messages.direction, 'outbound'),
            isNull(messages.broadcastId),
            sql`${messages.createdAt} > ${new Date(now.getTime() - 7 * DAY_MS)}`,
          ),
        );
      const average = Number(week?.total ?? 0) / (7 * 24 * 60);
      trigger = perMinute > brake.spikeMultiplier * average;
    }
    if (!trigger) continue;
    const reason = `Rem otomatis: ${String(perMinute)} pesan keluar dalam 1 menit (di luar broadcast).`;
    const updated = await db
      .update(organizations)
      .set({ sendingPausedAt: now, sendingPausedByUserId: null, sendingPauseReason: reason })
      .where(and(eq(organizations.id, burst.organizationId), isNull(organizations.sendingPausedAt)))
      .returning({ id: organizations.id });
    if (updated.length === 0) continue;
    braked += 1;
    const [audit] = await db
      .insert(auditLogs)
      .values({
        organizationId: burst.organizationId,
        actorUserId: null,
        action: 'sending.paused',
        targetType: 'organization',
        targetId: burst.organizationId,
        metadata: { reason, automatic: true, perMinute },
      })
      .returning({ id: auditLogs.id });
    await recordAlarm(db, {
      organizationId: burst.organizationId,
      kind: 'auto_brake',
      details: { reason, perMinute },
    });
    logger.warn(
      { organizationId: burst.organizationId, perMinute },
      'Rem darurat OTOMATIS: lonjakan pesan keluar',
    );
    await (deps.publisher ?? NOOP_INBOX_EVENT_PUBLISHER).publish([
      { type: 'sending.changed', organizationId: burst.organizationId },
    ]);
    if (deps.notifyOwner) {
      const owners = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.organizationId, burst.organizationId),
            eq(users.role, 'owner'),
            isNull(users.disabledAt),
          ),
        );
      for (const owner of owners) {
        await deps
          .notifyOwner({
            organizationId: burst.organizationId,
            recipientUserId: owner.id,
            subjectUserId: owner.id,
            event: 'sending_auto_paused',
            occurredAt: now.toISOString(),
            ...(audit ? { auditLogId: audit.id } : {}),
          })
          .catch(() => {
            logger.warn(
              { organizationId: burst.organizationId },
              'Email rem otomatis tidak terantre',
            );
          });
      }
    }
  }

  // Retensi data kolom penerima (nama, tagihan, …) 30 hari setelah kampanye selesai/dibatalkan.
  const expired = await db
    .select({ id: broadcastCampaigns.id, organizationId: broadcastCampaigns.organizationId })
    .from(broadcastCampaigns)
    .where(
      and(
        inArray(broadcastCampaigns.status, ['completed', 'cancelled']),
        isNull(broadcastCampaigns.dataPurgedAt),
        sql`coalesce(${broadcastCampaigns.completedAt}, ${broadcastCampaigns.cancelledAt}) < ${new Date(now.getTime() - DATA_RETENTION_DAYS * DAY_MS)}`,
      ),
    )
    .limit(5);
  for (const campaign of expired) {
    await db.transaction(async (tx) => {
      await tx
        .update(broadcastRecipients)
        .set({ data: {} })
        .where(
          and(
            eq(broadcastRecipients.organizationId, campaign.organizationId),
            eq(broadcastRecipients.campaignId, campaign.id),
          ),
        );
      await tx
        .update(broadcastCampaigns)
        .set({ dataPurgedAt: now })
        .where(eq(broadcastCampaigns.id, campaign.id));
    });
  }
  return { braked, purged: expired.length };
}

// ── alarms → Telegram ───────────────────────────────────────────────────────

const PERMANENT_TELEGRAM_FAILURES = new Set(['token_invalid', 'chat_not_found', 'forbidden']);

export async function deliverAlarms(deps: BroadcastJobDeps): Promise<Record<string, number>> {
  const { db, secretBox } = deps;
  const now = (deps.now ?? (() => new Date()))();
  // Klaim dengan memajukan jadwal (proses lain tidak mengirim alarm yang sama bersamaan).
  const claimed = await db.execute<{
    id: string;
    organization_id: string;
    kind: string;
    details: Record<string, string | number | boolean | null>;
    attempts: number;
  }>(sql`
    update alarm_events a set next_attempt_at = ${new Date(now.getTime() + 60_000)}, updated_at = now()
    where a.id in (
      select id from alarm_events
      where status = 'pending' and next_attempt_at <= ${now}
      order by next_attempt_at limit 20
      for update skip locked
    )
    returning a.id, a.organization_id, a.kind, a.details, a.attempts`);
  let sent = 0;
  let skipped = 0;
  for (const alarm of claimed.rows) {
    const [settings] = await db
      .select({
        enabled: telegramAlarmSettings.enabled,
        token: telegramAlarmSettings.botTokenEncrypted,
        chat: telegramAlarmSettings.telegramChat,
        productName: organizations.productName,
        name: organizations.name,
      })
      .from(telegramAlarmSettings)
      .innerJoin(organizations, eq(organizations.id, telegramAlarmSettings.organizationId))
      .where(eq(telegramAlarmSettings.organizationId, alarm.organization_id));
    const finish = (values: Partial<typeof alarmEvents.$inferInsert>) =>
      db.update(alarmEvents).set(values).where(eq(alarmEvents.id, alarm.id));
    if (!settings?.enabled || !secretBox) {
      // Tanpa Telegram: alarm tetap tercatat (audit/banner/email jalur lain), tidak dikirim.
      await finish({ status: 'skipped' });
      skipped += 1;
      continue;
    }
    let token: string;
    try {
      token = secretBox.decrypt(settings.token, {
        organizationId: alarm.organization_id,
        purpose: TELEGRAM_TOKEN_PURPOSE,
        subjectId: alarm.organization_id,
      });
    } catch {
      await finish({ status: 'failed', lastErrorCode: 'credentials_unavailable' });
      continue;
    }
    const result = await sendTelegramMessage({
      token,
      chatId: settings.chat,
      text: alarmText(
        settings.productName ?? settings.name,
        alarm.kind as AlarmKind,
        alarm.details,
      ),
      ...(deps.telegramBaseUrl ? { baseUrl: deps.telegramBaseUrl } : {}),
    });
    if (result.ok) {
      await finish({ status: 'sent', sentAt: now, attempts: alarm.attempts + 1 });
      sent += 1;
      continue;
    }
    const attempts = alarm.attempts + 1;
    const permanent = PERMANENT_TELEGRAM_FAILURES.has(result.code) || attempts >= 5;
    await finish({
      status: permanent ? 'failed' : 'pending',
      attempts,
      lastErrorCode: result.code,
      nextAttemptAt: new Date(
        now.getTime() + (result.retryAfterSeconds ?? 30 * 2 ** attempts) * 1000,
      ),
    });
    deps.logger.warn({ alarmId: alarm.id, code: result.code }, 'Alarm Telegram gagal dikirim');
  }
  return { sent, skipped, claimed: claimed.rows.length };
}

// ── BullMQ ──────────────────────────────────────────────────────────────────

export async function processBroadcastJob(
  job: BroadcastJob,
  deps: BroadcastJobDeps,
): Promise<Record<string, number | string>> {
  switch (job.name) {
    case BROADCAST_JOBS.tick:
      if (!broadcastScheduledJobPayloadSchema.safeParse(job.data ?? {}).success) break;
      return broadcastTick(deps);
    case BROADCAST_JOBS.guard:
      if (!broadcastScheduledJobPayloadSchema.safeParse(job.data ?? {}).success) break;
      return broadcastGuard(deps);
    case BROADCAST_JOBS.alarms:
      if (!broadcastScheduledJobPayloadSchema.safeParse(job.data ?? {}).success) break;
      return deliverAlarms(deps);
    case BROADCAST_JOBS.run: {
      const payload = broadcastRunJobPayloadSchema.safeParse(job.data);
      if (!payload.success) break;
      return runBroadcastSlice(payload.data, deps);
    }
    default:
      throw new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian broadcast`);
  }
  throw new UnrecoverableError('Payload job broadcast tidak valid');
}

export function createBroadcastQueue(options: QueueConnectionOptions): Queue {
  return new Queue(QUEUE_NAMES.broadcast, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
  });
}

export async function scheduleBroadcastJobs(queue: Queue): Promise<void> {
  const opts = { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } };
  await queue.upsertJobScheduler(
    BROADCAST_JOBS.tick,
    { every: BROADCAST_TICK_INTERVAL_MS },
    { name: BROADCAST_JOBS.tick, data: {}, opts },
  );
  await queue.upsertJobScheduler(
    BROADCAST_JOBS.guard,
    { every: BROADCAST_GUARD_INTERVAL_MS },
    { name: BROADCAST_JOBS.guard, data: {}, opts },
  );
  await queue.upsertJobScheduler(
    BROADCAST_JOBS.alarms,
    { every: BROADCAST_ALARMS_INTERVAL_MS },
    { name: BROADCAST_JOBS.alarms, data: {}, opts },
  );
}

/** Pengantre job `run` (ID job per kampanye per 5 detik: tick yang sering tidak menggandakan). */
export function runEnqueuer(queue: Queue) {
  return async (job: { organizationId: string; campaignId: string }) => {
    await queue.add(BROADCAST_JOBS.run, broadcastRunJobPayloadSchema.parse(job), {
      jobId: broadcastRunJobId(job.campaignId, Date.now()),
      attempts: 1,
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    });
  };
}

export function createBroadcastWorker(
  options: QueueConnectionOptions,
  deps: BroadcastJobDeps,
): Worker {
  return new Worker(QUEUE_NAMES.broadcast, (job) => processBroadcastJob(job, deps), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    // Beberapa kampanye boleh berjalan bersamaan; job berkala singkat.
    concurrency: 4,
  });
}
