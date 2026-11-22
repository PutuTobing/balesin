import {
  EMAIL_OUTBOUND_JOBS,
  EMAIL_OUTBOUND_TICK_INTERVAL_MS,
  NOOP_INBOX_EVENT_PUBLISHER,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  emailOutboundJobPayloadSchema,
  fallbackEmailSettings,
  openChannelConnectionSecret,
  openStoredEmailSettings,
  sendApiEmail,
  type ApiMailMessage,
  type ApiMailResult,
  type HostLookup,
  type InboxBusEventInput,
  type InboxEventPublisher,
  type Logger,
  type MediaStore,
  type PlaintextLoginPolicy,
  type SecretBox,
  type SecurityNoticeAdminEmailPayload,
  type SmtpConnectionConfig,
  type SmtpFallbackConfig,
  type SmtpPolicy,
  type SmtpTimeouts,
} from '@balesin/core';
import {
  apiKeyEmailSenders,
  apiKeys,
  auditLogs,
  channels,
  emailOutbound,
  emailOutboundAttachments,
  emailSenderSettings,
  emailSettings,
  messages,
  organizations,
  recordAlarm,
  recordOutgoingEvent,
  users,
  type Channel,
  type Database,
  type DbExecutor,
  type EmailOutboundRow,
  type EmailSenderSettingsRow,
} from '@balesin/db';
import {
  EMAIL_HOLD_MAX_HOURS,
  EMAIL_HOURLY_LIMIT_DEFAULT,
  apiKeyHasScope,
  maskEmailAddress,
  type EmailFailureReason,
  type EmailSenderBlockedReason,
} from '@balesin/shared';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { QueueConnectionOptions } from './system';

/**
 * Worker `email-outbound` (tahap 9.1, docs/KONTRAK-API-EMAIL-KIRIM.md §4). Job berkala tiap 5 dtk
 * (pola `webhooks-out`, tanpa produsen di api): klaim baris `email_outbound` jatuh tempo dengan
 * `FOR UPDATE SKIP LOCKED` (maks. 20), periksa ulang (key, channel, kredensial, rem darurat, keadaan &
 * batas per jam pengirim), kirim lewat SMTP pengirim, lalu catat hasil + outbox webhook `email.*`
 * (+ status pesan Inbox) di transaksi yang sama.
 *
 *  - Tertahan (rem darurat / jeda / terblokir / throttle / batas per jam) → tetap `queued`;
 *    > 24 jam sejak dibuat/jadwal → `failed` (alasan sesuai penahan).
 *  - 4xx / sambungan gagal → coba lagi 1, 5, 15, 30, 60 menit, lalu tiap jam (maks. 24 jam). 4xx
 *    pembatasan laju (`4.7.x`) juga menyetel pengirim `throttled` (5 menit, ×2 beruntun, maks. 60).
 *  - Login ditolak / kredensial tidak terbuka / pengaturan SMTP salah → pengirim `blocked` + audit
 *    `settings.email_sender.blocked` (kejadian keamanan) + alarm Telegram + email Owner.
 *  - Tidak ada coba ulang setelah isi mungkin diterima server (`delivery_unknown`).
 * Log: ID email/pengirim, jumlah penerima + penerima pertama TERSAMAR, status, kode SMTP, durasi.
 */

export interface EmailOutboundDeps {
  db: Database;
  secretBox: SecretBox | null;
  store: MediaStore | null;
  smtp: {
    allowedPorts: readonly number[];
    plaintextLogin: PlaintextLoginPolicy;
    fallback: SmtpFallbackConfig | null;
    lookup?: HostLookup;
    timeouts?: Partial<SmtpTimeouts>;
  };
  logger: Logger;
  publisher?: InboxEventPublisher;
  /** Email ke Owner saat pengirim terblokir. */
  notifyOwner?: (payload: SecurityNoticeAdminEmailPayload) => Promise<void>;
  now?: () => Date;
  /** Titik ganti tes (bawaan `sendApiEmail`). */
  send?: (
    config: SmtpConnectionConfig,
    policy: SmtpPolicy,
    message: ApiMailMessage,
  ) => Promise<ApiMailResult>;
}

const CLAIM_BATCH = 20;
const PARALLEL_SENDS = 4;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const HOLD_MAX_MS = EMAIL_HOLD_MAX_HOURS * HOUR;
const RETRY_DELAYS_MS = [1, 5, 15, 30, 60].map((minutes) => minutes * MINUTE);
/** Baris `sending` yang tidak selesai (proses mati di tengah kirim) → `delivery_unknown`. */
const SENDING_STALE_MS = 15 * MINUTE;
const BODY_RETENTION_MS = 30 * 24 * HOUR;
const ROW_RETENTION_MS = 180 * 24 * HOUR;
const RETENTION_BATCH = 200;

type Outcome = 'sent' | 'failed' | 'retried' | 'held';

export interface EmailOutboundTickResult {
  claimed: number;
  sent: number;
  failed: number;
  retried: number;
  held: number;
  recovered: number;
  purged: number;
}

const heldSince = (row: EmailOutboundRow) => (row.scheduledAt ?? row.createdAt).getTime();

function retryDelay(attempts: number): number {
  return RETRY_DELAYS_MS[Math.max(0, attempts - 1)] ?? HOUR;
}

/** Kejadian outbox + WebSocket untuk perubahan status (dipanggil DI DALAM transaksinya). */
async function statusChanged(
  tx: DbExecutor,
  row: EmailOutboundRow,
  status: 'sent' | 'failed',
  events: InboxBusEventInput[],
  at: Date,
): Promise<void> {
  if (row.messageId && row.conversationId) {
    await tx
      .update(messages)
      .set(
        status === 'sent'
          ? { status: 'sent', statusUpdatedAt: at, failureReason: null }
          : { status: 'failed', statusUpdatedAt: at, failureReason: 'email_api_failed' },
      )
      .where(
        and(
          eq(messages.organizationId, row.organizationId),
          eq(messages.id, row.messageId),
          eq(messages.status, 'pending'),
        ),
      );
    await recordOutgoingEvent(tx, {
      organizationId: row.organizationId,
      type: status === 'sent' ? 'message.sent' : 'message.status',
      conversationId: row.conversationId,
      messageId: row.messageId,
      contactId: row.contactId,
    });
    events.push(
      {
        type: 'message.status',
        organizationId: row.organizationId,
        conversationId: row.conversationId,
        messageId: row.messageId,
      },
      {
        type: 'conversation.updated',
        organizationId: row.organizationId,
        conversationId: row.conversationId,
      },
    );
  }
  // Email kirim tes tidak memicu webhook.
  if (row.source === 'api') {
    await recordOutgoingEvent(tx, {
      organizationId: row.organizationId,
      type: status === 'sent' ? 'email.sent' : 'email.failed',
      emailOutboundId: row.id,
      conversationId: row.conversationId,
      contactId: row.contactId,
    });
  }
}

async function failRow(
  tx: DbExecutor,
  row: EmailOutboundRow,
  reason: EmailFailureReason,
  events: InboxBusEventInput[],
  at: Date,
  smtpCode: number | null = null,
): Promise<void> {
  const updated = await tx
    .update(emailOutbound)
    .set({ status: 'failed', failedAt: at, failureReason: reason, smtpCode })
    .where(
      and(
        eq(emailOutbound.id, row.id),
        inArray(emailOutbound.status, ['queued', 'scheduled', 'sending']),
      ),
    )
    .returning({ id: emailOutbound.id });
  if (updated.length > 0) await statusChanged(tx, row, 'failed', events, at);
}

async function holdRow(
  tx: DbExecutor,
  row: EmailOutboundRow,
  until: Date,
  status: 'queued' | 'scheduled' = 'queued',
): Promise<void> {
  await tx
    .update(emailOutbound)
    .set({ status, nextAttemptAt: until, sendingStartedAt: null })
    .where(eq(emailOutbound.id, row.id));
}

interface SenderContext {
  channel: Channel | undefined;
  settings: EmailSenderSettingsRow | undefined;
  /** PENERIMA terkirim/sedang dikirim 60 menit terakhir (dinaikkan saat baris diklaim putaran ini). */
  sentLastHour: number;
  oldestInWindow: Date | null;
}

async function senderContext(
  tx: DbExecutor,
  row: EmailOutboundRow,
  cache: Map<string, SenderContext>,
  at: Date,
): Promise<SenderContext> {
  const channelId = row.channelId ?? '';
  const cached = cache.get(channelId);
  if (cached) return cached;
  const [channel] = await tx
    .select()
    .from(channels)
    .where(and(eq(channels.organizationId, row.organizationId), eq(channels.id, channelId)))
    .limit(1);
  const [settings] = await tx
    .select()
    .from(emailSenderSettings)
    .where(eq(emailSenderSettings.channelId, channelId))
    .limit(1);
  const hourAgo = new Date(at.getTime() - HOUR);
  const [window] = await tx
    .select({
      total: sql<number>`coalesce(sum(${emailOutbound.recipientCount}), 0)::int`,
      oldest: sql<Date | null>`min(coalesce(${emailOutbound.sentAt}, ${emailOutbound.sendingStartedAt}))`,
    })
    .from(emailOutbound)
    .where(
      and(
        eq(emailOutbound.organizationId, row.organizationId),
        eq(emailOutbound.channelId, channelId),
        sql`${emailOutbound.status} in ('sent', 'sending', 'bounced')`,
        gt(sql`coalesce(${emailOutbound.sentAt}, ${emailOutbound.sendingStartedAt})`, hourAgo),
      ),
    );
  const context: SenderContext = {
    channel,
    settings,
    sentLastHour: Number(window?.total ?? 0),
    oldestInWindow: window?.oldest ? new Date(window.oldest) : null,
  };
  cache.set(channelId, context);
  return context;
}

/** Key masih aktif + `email:send` + pengirim masih di daftarnya (channel belum dihapus). */
async function keyStillAllowed(tx: DbExecutor, row: EmailOutboundRow, at: Date): Promise<boolean> {
  if (row.source !== 'api') return true;
  if (!row.apiKeyId || !row.channelId) return false;
  const [key] = await tx
    .select({ scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.organizationId, row.organizationId),
        eq(apiKeys.id, row.apiKeyId),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, at)),
      ),
    )
    .limit(1);
  if (!key || !apiKeyHasScope(key.scopes, 'email:send')) return false;
  const [link] = await tx
    .select({ id: apiKeyEmailSenders.id })
    .from(apiKeyEmailSenders)
    .where(
      and(
        eq(apiKeyEmailSenders.organizationId, row.organizationId),
        eq(apiKeyEmailSenders.apiKeyId, row.apiKeyId),
        eq(apiKeyEmailSenders.channelId, row.channelId),
      ),
    )
    .limit(1);
  return link !== undefined;
}

/**
 * Klaim + pemeriksaan ulang di SATU transaksi: baris yang lolos jadi `sending` (dihitung ke batas per
 * jam seketika), lainnya ditahan / gagal final.
 */
async function claim(
  deps: EmailOutboundDeps,
  at: Date,
  events: InboxBusEventInput[],
  counts: { held: number; failed: number },
): Promise<EmailOutboundRow[]> {
  return deps.db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(emailOutbound)
      .where(
        and(
          inArray(emailOutbound.status, ['queued', 'scheduled']),
          sql`${emailOutbound.nextAttemptAt} <= ${at}`,
        ),
      )
      .orderBy(asc(sql`coalesce(${emailOutbound.scheduledAt}, ${emailOutbound.createdAt})`))
      .limit(CLAIM_BATCH)
      .for('update', { skipLocked: true });
    if (due.length === 0) return [];
    const organizationIds = [...new Set(due.map((row) => row.organizationId))];
    const orgs = await tx
      .select({ id: organizations.id, pausedAt: organizations.sendingPausedAt })
      .from(organizations)
      .where(inArray(organizations.id, organizationIds));
    const paused = new Set(orgs.filter((org) => org.pausedAt).map((org) => org.id));
    const cache = new Map<string, SenderContext>();
    const ready: EmailOutboundRow[] = [];
    for (const row of due) {
      const expired = at.getTime() - heldSince(row) > HOLD_MAX_MS;
      const hold = async (until: Date, reason: EmailFailureReason) => {
        if (expired) {
          await failRow(tx, row, reason, events, at);
          counts.failed += 1;
        } else {
          await holdRow(tx, row, until);
          counts.held += 1;
        }
      };
      if (!(await keyStillAllowed(tx, row, at))) {
        await failRow(tx, row, 'sender_not_allowed', events, at);
        counts.failed += 1;
        continue;
      }
      const sender = await senderContext(tx, row, cache, at);
      if (!sender.channel || sender.channel.deletedAt !== null || sender.channel.type !== 'email') {
        await failRow(tx, row, 'sender_unavailable', events, at);
        counts.failed += 1;
        continue;
      }
      if (!sender.channel.enabled) {
        await hold(new Date(at.getTime() + 5 * MINUTE), 'sender_unavailable');
        continue;
      }
      if (paused.has(row.organizationId)) {
        await hold(new Date(at.getTime() + MINUTE), 'sending_paused_expired');
        continue;
      }
      const settings = sender.settings;
      if (settings?.state === 'paused') {
        await hold(new Date(at.getTime() + MINUTE), 'sending_paused_expired');
        continue;
      }
      if (settings?.state === 'blocked') {
        await hold(new Date(at.getTime() + 5 * MINUTE), 'sender_unavailable');
        continue;
      }
      if (
        settings?.state === 'throttled' &&
        settings.throttledUntil &&
        settings.throttledUntil.getTime() > at.getTime()
      ) {
        await hold(settings.throttledUntil, 'throttle_expired');
        continue;
      }
      const limit = settings?.hourlyLimit ?? EMAIL_HOURLY_LIMIT_DEFAULT;
      // Review 9.1 S2: batas per jam = PENERIMA. Email yang sendirian melebihi batas tetap boleh
      // bila jendela kosong (tidak macet selamanya).
      if (sender.sentLastHour > 0 && sender.sentLastHour + row.recipientCount > limit) {
        const until = sender.oldestInWindow
          ? new Date(sender.oldestInWindow.getTime() + HOUR)
          : new Date(at.getTime() + MINUTE);
        await hold(until, 'throttle_expired');
        continue;
      }
      sender.sentLastHour += row.recipientCount;
      sender.oldestInWindow ??= at;
      await tx
        .update(emailOutbound)
        .set({
          status: 'sending',
          sendingStartedAt: at,
          attempts: sql`${emailOutbound.attempts} + 1`,
        })
        .where(eq(emailOutbound.id, row.id));
      ready.push({ ...row, attempts: row.attempts + 1 });
    }
    return ready;
  });
}

interface Transport {
  config: SmtpConnectionConfig;
  policy: SmtpPolicy;
  fromAddress: string;
}

type TransportResult =
  { ok: true; transport: Transport } | { ok: false; reason: EmailSenderBlockedReason };

async function transportFor(
  deps: EmailOutboundDeps,
  channel: Channel,
  row: EmailOutboundRow,
): Promise<TransportResult> {
  const basePolicy = {
    plaintextLogin: deps.smtp.plaintextLogin,
    ...(deps.smtp.lookup ? { lookup: deps.smtp.lookup } : {}),
    ...(deps.smtp.timeouts ? { timeouts: deps.smtp.timeouts } : {}),
  };
  if (channel.emailSmtpMode === 'custom') {
    if (!deps.secretBox || !channel.emailSmtpPasswordEncrypted) {
      return { ok: false, reason: 'credentials_unavailable' };
    }
    try {
      const password = openChannelConnectionSecret(
        deps.secretBox,
        channel,
        'emailSmtpPassword',
        channel.emailSmtpPasswordEncrypted,
      );
      return {
        ok: true,
        transport: {
          config: {
            host: channel.emailSmtpHost ?? '',
            port: channel.emailSmtpPort ?? 465,
            security: (channel.emailSmtpSecurity ?? 'ssl') as SmtpConnectionConfig['security'],
            username: channel.emailSmtpUsername,
            password,
          },
          policy: { ...basePolicy, allowedPorts: deps.smtp.allowedPorts },
          // Alias se-domain yang sudah diperiksa api (atau alamat channel).
          fromAddress: row.fromAddress,
        },
      };
    } catch {
      return { ok: false, reason: 'credentials_unavailable' };
    }
  }
  // SMTP sistem: kirim atas nama alamat Email pengirim sistem; balasan ke alamat channel.
  const [stored] = await deps.db
    .select()
    .from(emailSettings)
    .where(eq(emailSettings.organizationId, channel.organizationId))
    .limit(1);
  if (stored) {
    const opened = openStoredEmailSettings(stored, deps.secretBox);
    if (!opened.ok) return { ok: false, reason: 'credentials_unavailable' };
    return {
      ok: true,
      transport: {
        config: opened.settings.connection,
        policy: { ...basePolicy, allowedPorts: deps.smtp.allowedPorts },
        fromAddress: opened.settings.sender.fromAddress,
      },
    };
  }
  if (deps.smtp.fallback) {
    const settings = fallbackEmailSettings(deps.smtp.fallback);
    return {
      ok: true,
      transport: {
        config: settings.connection,
        policy: {
          ...basePolicy,
          allowedPorts: [...deps.smtp.allowedPorts, deps.smtp.fallback.port],
        },
        fromAddress: settings.sender.fromAddress,
      },
    };
  }
  return { ok: false, reason: 'credentials_unavailable' };
}

/** Pengirim → `blocked` (sekali per kejadian): audit + alarm Telegram + email Owner. */
async function blockSender(
  deps: EmailOutboundDeps,
  row: EmailOutboundRow,
  channel: Channel,
  reason: EmailSenderBlockedReason,
  at: Date,
): Promise<void> {
  let auditLogId: string | null = null;
  await deps.db.transaction(async (tx) => {
    const [current] = await tx
      .select({ state: emailSenderSettings.state })
      .from(emailSenderSettings)
      .where(eq(emailSenderSettings.channelId, channel.id))
      .for('update')
      .limit(1);
    if (current?.state === 'blocked') return;
    await tx
      .insert(emailSenderSettings)
      .values({
        organizationId: channel.organizationId,
        senderKind: 'channel',
        channelId: channel.id,
        state: 'blocked',
        blockedReason: reason,
        blockedAt: at,
      })
      .onConflictDoUpdate({
        target: emailSenderSettings.channelId,
        set: { state: 'blocked', blockedReason: reason, blockedAt: at },
      });
    const address = (channel.emailAddress ?? '').toLowerCase();
    const [audit] = await tx
      .insert(auditLogs)
      .values({
        organizationId: channel.organizationId,
        actorUserId: null,
        action: 'settings.email_sender.blocked',
        targetType: 'email_sender',
        targetId: channel.id,
        metadata: { senderId: `chn_${channel.id}`, address, reason },
      })
      .returning({ id: auditLogs.id });
    await recordAlarm(tx, {
      organizationId: channel.organizationId,
      kind: 'email_sender_blocked',
      details: { sender: address, reason },
    });
    auditLogId = audit?.id ?? null;
  });
  const logId = auditLogId as string | null;
  if (!logId) return;
  deps.logger.warn(
    { emailId: row.id, senderId: `chn_${channel.id}`, reason },
    'Pengirim email API terblokir',
  );
  if (!deps.notifyOwner) return;
  const owners = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, channel.organizationId),
        eq(users.role, 'owner'),
        isNull(users.disabledAt),
      ),
    );
  for (const owner of owners) {
    await deps
      .notifyOwner({
        organizationId: channel.organizationId,
        recipientUserId: owner.id,
        // Tanpa pelaku: subjek = penerima sendiri.
        subjectUserId: owner.id,
        event: 'email_sender_blocked',
        occurredAt: at.toISOString(),
        auditLogId: logId,
      })
      .catch((err: unknown) => {
        deps.logger.warn({ err }, 'Gagal mengantre email pengirim email terblokir ke Owner');
      });
  }
}

async function loadParts(deps: EmailOutboundDeps, row: EmailOutboundRow) {
  const rows = await deps.db
    .select()
    .from(emailOutboundAttachments)
    .where(
      and(
        eq(emailOutboundAttachments.organizationId, row.organizationId),
        eq(emailOutboundAttachments.emailOutboundId, row.id),
      ),
    )
    .orderBy(asc(emailOutboundAttachments.position));
  const inline: ApiMailMessage['inline'][number][] = [];
  const attachments: ApiMailMessage['attachments'][number][] = [];
  for (const part of rows) {
    if (!part.storageKey || !deps.store) return null;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of deps.store.chunks(part.storageKey)) chunks.push(chunk);
    } catch {
      return null;
    }
    const content = Buffer.concat(chunks);
    if (part.inline && part.contentId) {
      inline.push({
        cid: part.contentId,
        filename: part.filename,
        contentType: part.contentType,
        content,
      });
    } else {
      attachments.push({ filename: part.filename, contentType: part.contentType, content });
    }
  }
  return { inline, attachments };
}

async function deliver(
  deps: EmailOutboundDeps,
  row: EmailOutboundRow,
  events: InboxBusEventInput[],
): Promise<Outcome> {
  const at = deps.now?.() ?? new Date();
  const started = Date.now();
  const [channel] = await deps.db
    .select()
    .from(channels)
    .where(
      and(eq(channels.organizationId, row.organizationId), eq(channels.id, row.channelId ?? '')),
    )
    .limit(1);
  if (!channel) {
    await deps.db.transaction((tx) => failRow(tx, row, 'sender_unavailable', events, at));
    return 'failed';
  }
  if (!row.html && !row.text) {
    // Isi sudah dipangkas (tidak semestinya untuk baris yang belum final).
    await deps.db.transaction((tx) => failRow(tx, row, 'attachment_unavailable', events, at));
    return 'failed';
  }
  const parts = await loadParts(deps, row);
  if (!parts) {
    await deps.db.transaction((tx) => failRow(tx, row, 'attachment_unavailable', events, at));
    return 'failed';
  }
  const transport = await transportFor(deps, channel, row);
  if (!transport.ok) {
    await blockSender(deps, row, channel, transport.reason, at);
    await deps.db.transaction((tx) => holdRow(tx, row, new Date(at.getTime() + 5 * MINUTE)));
    return 'held';
  }
  const result = await (deps.send ?? sendApiEmail)(
    transport.transport.config,
    transport.transport.policy,
    {
      envelopeFrom: transport.transport.fromAddress,
      from: { name: row.fromName, address: transport.transport.fromAddress },
      to: row.to,
      cc: row.cc,
      bcc: row.bcc.map((item) => item.email),
      replyTo: row.replyTo,
      subject: row.subject,
      text: row.text ?? '',
      html: row.html,
      messageId: row.messageIdHeader,
      inReplyTo: row.inReplyTo,
      references: row.references,
      inline: parts.inline,
      attachments: parts.attachments,
    },
  );
  const log = {
    emailId: row.id,
    apiKeyId: row.apiKeyId,
    senderId: `chn_${channel.id}`,
    recipientCount: row.recipientCount,
    firstRecipient: maskEmailAddress(row.to[0]?.email ?? ''),
    durationMs: Date.now() - started,
  };
  const done = deps.now?.() ?? new Date();

  if (result.ok) {
    const recipients = new Set(
      [...row.to, ...row.cc, ...row.bcc].map((item) => item.email.toLowerCase()),
    );
    const rejected = result.rejected.filter((address) => recipients.has(address));
    await deps.db.transaction(async (tx) => {
      await tx
        .update(emailOutbound)
        .set({ status: 'sent', sentAt: done, rejectedRecipients: rejected, smtpCode: null })
        .where(and(eq(emailOutbound.id, row.id), eq(emailOutbound.status, 'sending')));
      await statusChanged(tx, row, 'sent', events, done);
      // Kiriman berhasil = jeda beruntun pengirim berakhir.
      await tx
        .update(emailSenderSettings)
        .set({ throttleStreak: 0 })
        .where(
          and(
            eq(emailSenderSettings.channelId, channel.id),
            gt(emailSenderSettings.throttleStreak, 0),
          ),
        );
    });
    deps.logger.info({ ...log, status: 'sent', rejected: rejected.length }, 'Email API terkirim');
    return 'sent';
  }

  deps.logger.warn(
    { ...log, status: result.kind, smtpCode: result.smtpCode, code: result.code },
    'Email API belum terkirim',
  );
  switch (result.kind) {
    case 'temporary':
    case 'throttled': {
      const next = new Date(done.getTime() + retryDelay(row.attempts));
      await deps.db.transaction(async (tx) => {
        if (result.kind === 'throttled') {
          const [settings] = await tx
            .select({ streak: emailSenderSettings.throttleStreak })
            .from(emailSenderSettings)
            .where(eq(emailSenderSettings.channelId, channel.id))
            .for('update')
            .limit(1);
          const streak = (settings?.streak ?? 0) + 1;
          const until = new Date(done.getTime() + Math.min(5 * 2 ** (streak - 1), 60) * MINUTE);
          await tx
            .insert(emailSenderSettings)
            .values({
              organizationId: channel.organizationId,
              senderKind: 'channel',
              channelId: channel.id,
              state: 'throttled',
              throttledUntil: until,
              throttleStreak: streak,
            })
            .onConflictDoUpdate({
              target: emailSenderSettings.channelId,
              set: {
                state: sql`case when ${emailSenderSettings.state} in ('paused', 'blocked') then ${emailSenderSettings.state} else 'throttled' end`,
                throttledUntil: until,
                throttleStreak: streak,
              },
            });
        }
        if (next.getTime() - heldSince(row) > HOLD_MAX_MS) {
          await failRow(tx, row, 'throttle_expired', events, done, result.smtpCode);
        } else {
          await holdRow(tx, row, next);
        }
      });
      return 'retried';
    }
    case 'auth':
    case 'config':
      await blockSender(
        deps,
        row,
        channel,
        result.kind === 'auth' ? 'smtp_auth_failed' : 'smtp_config_invalid',
        done,
      );
      await deps.db.transaction((tx) => holdRow(tx, row, new Date(done.getTime() + 5 * MINUTE)));
      return 'held';
    case 'recipients_rejected':
      await deps.db.transaction((tx) =>
        failRow(tx, row, 'recipient_rejected', events, done, result.smtpCode),
      );
      return 'failed';
    case 'sender_rejected':
      await deps.db.transaction((tx) =>
        failRow(tx, row, 'sender_rejected', events, done, result.smtpCode),
      );
      return 'failed';
    case 'message_rejected':
      await deps.db.transaction((tx) =>
        failRow(tx, row, 'message_rejected', events, done, result.smtpCode),
      );
      return 'failed';
    default:
      await deps.db.transaction((tx) =>
        failRow(tx, row, 'delivery_unknown', events, done, result.smtpCode),
      );
      return 'failed';
  }
}

/** Baris `sending` yang ditinggal proses mati: tidak pasti terkirim → `delivery_unknown`. */
async function recoverStale(
  deps: EmailOutboundDeps,
  at: Date,
  events: InboxBusEventInput[],
): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const stale = await tx
      .select()
      .from(emailOutbound)
      .where(
        and(
          eq(emailOutbound.status, 'sending'),
          lt(emailOutbound.sendingStartedAt, new Date(at.getTime() - SENDING_STALE_MS)),
        ),
      )
      .limit(CLAIM_BATCH)
      .for('update', { skipLocked: true });
    for (const row of stale) await failRow(tx, row, 'delivery_unknown', events, at);
    return stale.length;
  });
}

/**
 * Retensi (§11): isi HTML/teks + berkas lampiran dipangkas 30 hari setelah status final; baris dihapus
 * setelah 180 hari (idempotensi ikut berakhir).
 */
async function retention(deps: EmailOutboundDeps, at: Date): Promise<number> {
  const purgeBefore = new Date(at.getTime() - BODY_RETENTION_MS);
  const due = await deps.db
    .select({ id: emailOutbound.id, organizationId: emailOutbound.organizationId })
    .from(emailOutbound)
    .where(
      and(
        isNull(emailOutbound.bodyPurgedAt),
        inArray(emailOutbound.status, ['sent', 'failed', 'bounced', 'canceled']),
        lt(emailOutbound.createdAt, purgeBefore),
        lt(
          sql`coalesce(${emailOutbound.sentAt}, ${emailOutbound.failedAt}, ${emailOutbound.canceledAt}, ${emailOutbound.createdAt})`,
          purgeBefore,
        ),
      ),
    )
    .limit(RETENTION_BATCH);
  if (due.length > 0) {
    const ids = due.map((row) => row.id);
    const files = await deps.db
      .select({ id: emailOutboundAttachments.id, storageKey: emailOutboundAttachments.storageKey })
      .from(emailOutboundAttachments)
      .where(inArray(emailOutboundAttachments.emailOutboundId, ids));
    for (const file of files) {
      if (file.storageKey) await deps.store?.remove(file.storageKey).catch(() => undefined);
    }
    await deps.db
      .update(emailOutboundAttachments)
      .set({ storageKey: null })
      .where(inArray(emailOutboundAttachments.emailOutboundId, ids));
    await deps.db
      .update(emailOutbound)
      .set({ html: null, text: null, bodyPurgedAt: at })
      .where(inArray(emailOutbound.id, ids));
  }
  const deleteBefore = new Date(at.getTime() - ROW_RETENTION_MS);
  const old = await deps.db
    .select({ id: emailOutbound.id })
    .from(emailOutbound)
    .where(
      and(
        lt(emailOutbound.createdAt, deleteBefore),
        inArray(emailOutbound.status, ['sent', 'failed', 'bounced', 'canceled']),
      ),
    )
    .limit(RETENTION_BATCH);
  if (old.length > 0) {
    const ids = old.map((row) => row.id);
    const files = await deps.db
      .select({ storageKey: emailOutboundAttachments.storageKey })
      .from(emailOutboundAttachments)
      .where(inArray(emailOutboundAttachments.emailOutboundId, ids));
    for (const file of files) {
      if (file.storageKey) await deps.store?.remove(file.storageKey).catch(() => undefined);
    }
    await deps.db.delete(emailOutbound).where(inArray(emailOutbound.id, ids));
  }
  return due.length;
}

export async function processEmailOutboundTick(
  deps: EmailOutboundDeps,
): Promise<EmailOutboundTickResult> {
  const at = deps.now?.() ?? new Date();
  const events: InboxBusEventInput[] = [];
  const counts = { sent: 0, failed: 0, retried: 0, held: 0 };
  const recovered = await recoverStale(deps, at, events);
  const ready = await claim(deps, at, events, counts);
  for (let index = 0; index < ready.length; index += PARALLEL_SENDS) {
    const outcomes = await Promise.all(
      ready.slice(index, index + PARALLEL_SENDS).map((row) =>
        deliver(deps, row, events).catch(async (err: unknown) => {
          deps.logger.error({ err, emailId: row.id }, 'Email API gagal diproses');
          // Galat tak terduga sebelum/ saat kirim: tidak pasti → jangan kirim ganda.
          await deps.db
            .transaction((tx) => failRow(tx, row, 'delivery_unknown', events, at))
            .catch(() => undefined);
          return 'failed' as const;
        }),
      ),
    );
    for (const outcome of outcomes) counts[outcome] += 1;
  }
  const purged = await retention(deps, at);
  await (deps.publisher ?? NOOP_INBOX_EVENT_PUBLISHER).publish(events).catch(() => undefined);
  if (ready.length + counts.held + recovered > 0) {
    deps.logger.info({ claimed: ready.length, ...counts, recovered }, 'Antrean email API diproses');
  }
  return { claimed: ready.length, ...counts, recovered, purged };
}

// ── BullMQ ─────────────────────────────────────────────────────────────────

export async function processEmailOutboundJob(
  job: { name: string; data: unknown },
  deps: EmailOutboundDeps,
): Promise<EmailOutboundTickResult> {
  if (job.name !== EMAIL_OUTBOUND_JOBS.tick) {
    throw new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian email-outbound`);
  }
  if (!emailOutboundJobPayloadSchema.safeParse(job.data ?? {}).success) {
    throw new UnrecoverableError('Payload job email-outbound tidak valid');
  }
  return processEmailOutboundTick(deps);
}

export function createEmailOutboundQueue(options: QueueConnectionOptions): Queue {
  return new Queue(QUEUE_NAMES.emailOutbound, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
  });
}

export async function scheduleEmailOutbound(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    EMAIL_OUTBOUND_JOBS.tick,
    { every: EMAIL_OUTBOUND_TICK_INTERVAL_MS },
    {
      name: EMAIL_OUTBOUND_JOBS.tick,
      data: {},
      opts: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 50 } },
    },
  );
}

export function createEmailOutboundWorker(
  options: QueueConnectionOptions,
  deps: EmailOutboundDeps,
): Worker {
  return new Worker(QUEUE_NAMES.emailOutbound, (job) => processEmailOutboundJob(job, deps), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    concurrency: 1,
  });
}
