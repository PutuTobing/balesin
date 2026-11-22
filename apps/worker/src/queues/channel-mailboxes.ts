import { createHash } from 'node:crypto';

import {
  CHANNEL_JOBS,
  EMAIL_POLL_JOB_OPTIONS,
  EMAIL_POLL_MAX_MESSAGES,
  EMAIL_TICK_BATCH,
  EMAIL_TICK_INTERVAL_MS,
  ImapFailure,
  OnMessageError,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  defaultTrustedAuthServIds,
  emailExternalId,
  emailPollJobId,
  emailPollJobPayloadSchema,
  openChannelConnectionSecret,
  emailDestination,
  emailReplyAll,
  parseInboundEmail,
  pollImapMailbox,
  type ChannelInboundMessage,
  type ImapPolicy,
  type Logger,
  type MediaStore,
  type SecretBox,
  type WebhookEventJobPayload,
} from '@balesin/core';
import {
  channels,
  emailMailboxStates,
  emailSettings,
  mediaFiles,
  organizations,
  webhookEvents,
  type Channel,
  type Database,
} from '@balesin/db';
import { MEDIA_RETENTION_DAYS } from '@balesin/shared';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import { processEmailBounce } from '../inbound/email-api-events';
import type { QueueConnectionOptions } from './system';

/**
 * Antrian `channels` (Fase 6) — pengambil kotak masuk channel Email (polling IMAP, bukan IDLE: satu
 * sambungan pendek per putaran, tidak ada sambungan yang ditahan worker).
 *
 *  - `email-tick` (tiap 30 dtk): pilih kotak masuk yang jatuh tempo (`email_mailbox_states.next_poll_at`)
 *    dari channel email yang hidup & aktif → antrekan `email-poll` (ID job per channel = tidak ganda).
 *  - `email-poll`: ambil email baru (UID > posisi terakhir) → urai + sanitasi → lampiran ke media store
 *    → simpan `webhook_events` (source `email`, idempoten per `Message-ID`) → antrekan ID ke antrian
 *    `webhooks` (pemrosesan kontak/percakapan sama dengan channel lain). Posisi & status disimpan di
 *    `email_mailbox_states` (BUKAN `channels`, review webhook N1).
 *  - Gagal (IMAP) → kode dicatat, dicoba lagi dengan jeda bertambah (interval × 2^gagal, maks. 1 jam).
 *  - Balasan otomatis / bounce / email dari alamat sendiri / terlalu besar → dilewati & dihitung.
 *
 * Log hanya ID + kode — tidak pernah alamat, subjek, atau isi email.
 */

export interface ChannelMailboxDeps {
  db: Database;
  logger: Logger;
  secretBox: SecretBox | null;
  store: MediaStore | null;
  imapPolicy: ImapPolicy;
  /** Antrekan kejadian ke antrian `webhooks`. */
  enqueueEvents(events: readonly WebhookEventJobPayload[]): Promise<void>;
  /** Antrekan putaran ambil email (dipakai `email-tick`). */
  enqueuePoll(payload: { organizationId: string; channelId: string }): Promise<void>;
  now?: () => Date;
}

export interface ChannelJob {
  id?: string;
  name: string;
  data: unknown;
}

const MAX_BACKOFF_MS = 60 * 60 * 1000;
/** Sewa: kotak masuk yang sudah diantrekan tidak diantrekan lagi selama ini. */
const POLL_LEASE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function runEmailTick(deps: ChannelMailboxDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await deps.db
    .select({
      channelId: emailMailboxStates.channelId,
      organizationId: emailMailboxStates.organizationId,
    })
    .from(emailMailboxStates)
    .innerJoin(
      channels,
      and(
        eq(channels.organizationId, emailMailboxStates.organizationId),
        eq(channels.id, emailMailboxStates.channelId),
      ),
    )
    .where(
      and(
        lte(emailMailboxStates.nextPollAt, now),
        eq(channels.type, 'email'),
        eq(channels.enabled, true),
        isNull(channels.deletedAt),
      ),
    )
    .limit(EMAIL_TICK_BATCH);
  if (due.length === 0) return 0;
  await deps.db
    .update(emailMailboxStates)
    .set({ nextPollAt: new Date(now.getTime() + POLL_LEASE_MS) })
    .where(
      inArray(
        emailMailboxStates.channelId,
        due.map((row) => row.channelId),
      ),
    );
  for (const row of due) await deps.enqueuePoll(row);
  return due.length;
}

async function retentionDays(db: Database, organizationId: string): Promise<number> {
  const [row] = await db
    .select({ days: organizations.mediaRetentionDays })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row?.days ?? MEDIA_RETENTION_DAYS.default;
}

export type EmailPollResult =
  | { status: 'polled'; stored: number; skipped: number; more: boolean }
  | { status: 'failed'; code: string }
  | { status: 'skipped'; reason: 'not_found' | 'inactive' | 'secret_unavailable' };

export async function runEmailPoll(
  payload: { organizationId: string; channelId: string },
  deps: ChannelMailboxDeps,
): Promise<EmailPollResult> {
  const { db, logger } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const { organizationId, channelId } = payload;
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.organizationId, organizationId), eq(channels.id, channelId)))
    .limit(1);
  const [state] = await db
    .select()
    .from(emailMailboxStates)
    .where(
      and(
        eq(emailMailboxStates.organizationId, organizationId),
        eq(emailMailboxStates.channelId, channelId),
      ),
    )
    .limit(1);
  if (!channel || channel.type !== 'email' || !state)
    return { status: 'skipped', reason: 'not_found' };
  if (!channel.enabled || channel.deletedAt !== null)
    return { status: 'skipped', reason: 'inactive' };
  const intervalMs = (channel.emailPollIntervalMinutes ?? 2) * 60 * 1000;

  const recordFailure = async (code: string) => {
    const failures = state.consecutiveFailures + 1;
    await db
      .update(emailMailboxStates)
      .set({
        lastPolledAt: now,
        lastPollOk: false,
        lastPollCode: code,
        consecutiveFailures: failures,
        nextPollAt: new Date(
          now.getTime() + Math.min(intervalMs * 2 ** Math.min(failures, 10), MAX_BACKOFF_MS),
        ),
      })
      .where(eq(emailMailboxStates.channelId, channelId));
  };

  let password;
  try {
    if (!deps.secretBox || !channel.emailImapPasswordEncrypted) throw new Error('tanpa kunci');
    password = openChannelConnectionSecret(
      deps.secretBox,
      channel,
      'emailImapPassword',
      channel.emailImapPasswordEncrypted,
    );
  } catch {
    await recordFailure('secret_unavailable');
    return { status: 'skipped', reason: 'secret_unavailable' };
  }

  // Tahap 9.0: alias channel juga alamat sendiri (email darinya = loop).
  const ownAddresses = [channel.emailAddress ?? '', ...channel.emailAliases];
  const [system] = await db
    .select({ fromAddress: emailSettings.fromAddress })
    .from(emailSettings)
    .where(eq(emailSettings.organizationId, organizationId))
    .limit(1);
  if (system?.fromAddress && channel.emailSmtpMode === 'system')
    ownAddresses.push(system.fromAddress.toLowerCase());
  const days = await retentionDays(db, organizationId);

  let stored = 0;
  let skipped = 0;
  try {
    const result = await pollImapMailbox(
      {
        host: channel.emailImapHost ?? '',
        port: channel.emailImapPort ?? 993,
        security: channel.emailImapSecurity === 'starttls' ? 'starttls' : 'ssl',
        username: channel.emailImapUsername ?? '',
        password,
        folder: channel.emailImapFolder ?? 'INBOX',
      },
      deps.imapPolicy,
      { uidValidity: state.uidValidity, lastUid: state.lastUid },
      {
        maxMessages: EMAIL_POLL_MAX_MESSAGES,
        markAsRead: channel.emailMarkAsRead ?? true,
        onMessage: async ({ raw }) => {
          if (!raw) {
            skipped += 1;
            return;
          }
          const outcome = await storeEmail(channel, raw, ownAddresses, days, deps, now);
          if (outcome === 'stored') stored += 1;
          else if (outcome === 'skipped') skipped += 1;
        },
      },
    );
    await db
      .update(emailMailboxStates)
      .set({
        uidValidity: result.position.uidValidity,
        lastUid: result.position.lastUid,
        lastPolledAt: now,
        lastPollOk: true,
        lastPollCode: 'ok',
        consecutiveFailures: 0,
        skippedMessages: sql`${emailMailboxStates.skippedMessages} + ${skipped}`,
        nextPollAt: result.more ? now : new Date(now.getTime() + intervalMs),
      })
      .where(eq(emailMailboxStates.channelId, channelId));
    logger.info({ channelId, stored, skipped, more: result.more }, 'Kotak masuk email diambil');
    return { status: 'polled', stored, skipped, more: result.more };
  } catch (error) {
    if (error instanceof ImapFailure) {
      await recordFailure(error.code);
      logger.warn(
        { channelId, code: error.code, diagnostic: error.diagnostic },
        'Kotak masuk email gagal diambil',
      );
      return { status: 'failed', code: error.code };
    }
    await recordFailure('unknown');
    logger.error(
      { channelId, err: error instanceof OnMessageError ? error.cause : error },
      'Pemrosesan kotak masuk email gagal',
    );
    return { status: 'failed', code: 'unknown' };
  }
}

/** Urai + simpan satu email. `duplicate` = sudah pernah diambil (Message-ID sama). */
async function storeEmail(
  channel: Channel,
  raw: Buffer,
  ownAddresses: readonly string[],
  retentionDaysValue: number,
  deps: ChannelMailboxDeps,
  now: Date,
): Promise<'stored' | 'skipped' | 'duplicate'> {
  const { db } = deps;
  // Review Fase 6 R1: hanya hasil verifikasi dari server penerima tepercaya kotak masuk ini.
  const parsed = await parseInboundEmail(
    raw,
    ownAddresses,
    channel.emailTrustedAuthServIds ?? defaultTrustedAuthServIds(channel.emailImapHost ?? ''),
  );
  if (!parsed.ok) {
    deps.logger.info({ channelId: channel.id, reason: parsed.reason }, 'Email masuk dilewati');
    // Tahap 9.1: laporan bounce untuk email lewat API (tetap tidak masuk Inbox).
    if (parsed.reason === 'bounce') {
      await processEmailBounce(db, channel, raw, now, deps.logger).catch((err: unknown) => {
        deps.logger.warn({ err, channelId: channel.id }, 'Laporan bounce email API gagal diproses');
      });
    }
    return 'skipped';
  }
  const email = parsed.email;
  const externalId = emailExternalId(email.messageId);
  const dedupKey = `em:${createHash('sha256').update(email.messageId).digest('hex')}`;
  const [existing] = await db
    .select({ id: webhookEvents.id })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.channelId, channel.id), eq(webhookEvents.dedupKey, dedupKey)))
    .limit(1);
  if (existing) return 'duplicate';

  // Lampiran → media store (nama acak, jenis dari isi) SEBELUM kejadian disimpan.
  const saved: { id: string; storageKey: string }[] = [];
  const attachments: NonNullable<ChannelInboundMessage['email']>['attachments'] = [];
  let skippedAttachments = email.skippedAttachments;
  try {
    for (const attachment of email.attachments) {
      if (!deps.store) {
        skippedAttachments += 1;
        continue;
      }
      const file = await deps.store.save('inbound', attachment.content);
      const [row] = await db
        .insert(mediaFiles)
        .values({
          organizationId: channel.organizationId,
          channelId: channel.id,
          source: 'inbound',
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          filename: attachment.filename,
          storageKey: file.storageKey,
          expiresAt: new Date(now.getTime() + retentionDaysValue * DAY_MS),
        })
        .returning({ id: mediaFiles.id });
      if (!row) throw new Error('INSERT media tidak mengembalikan baris');
      saved.push({ id: row.id, storageKey: file.storageKey });
      attachments.push({
        kind: attachment.kind,
        ref: `email:${row.id}`,
        mimeType: attachment.mimeType,
        filename: attachment.filename,
        sizeBytes: file.sizeBytes,
        voice: false,
        animated: false,
        mediaFileId: row.id,
      });
    }

    const text =
      email.text ?? email.subject ?? (attachments.length > 0 ? null : '(Email tanpa isi teks)');
    const message: ChannelInboundMessage = {
      kind: 'message',
      externalId,
      sentAt: (email.date && email.date <= now ? email.date : now).toISOString(),
      sender: {
        externalUserId: email.from.address,
        handle: email.from.address,
        displayName: email.from.name,
      },
      type: 'text',
      rawType: 'email',
      text: text ?? '(Lampiran)',
      media: null,
      location: null,
      replyToExternalId: null,
      reply: null,
      email: {
        subject: email.subject,
        inReplyTo: email.inReplyTo,
        references: email.references,
        authWarning: email.authWarning,
        senderVerification: email.senderVerification,
        skippedAttachments,
        html: email.html,
        attachments,
        to: email.to,
        cc: email.cc,
        // Tahap 9.0: hanya alamat/alias CHANNEL yang bisa jadi alamat tujuan (bukan alamat SMTP sistem).
        recipient: emailDestination(email, [channel.emailAddress ?? '', ...channel.emailAliases]),
        replyAll: emailReplyAll(email, [...ownAddresses, email.from.address]),
      },
    };
    const [event] = await db
      .insert(webhookEvents)
      .values({
        organizationId: channel.organizationId,
        channelId: channel.id,
        source: 'email',
        kind: 'message',
        field: 'message',
        dedupKey,
        externalId,
        payload: message,
        occurredAt: new Date(message.sentAt),
        receivedAt: now,
        status: 'pending',
      })
      .onConflictDoNothing({ target: [webhookEvents.channelId, webhookEvents.dedupKey] })
      .returning({ id: webhookEvents.id });
    if (!event) throw new DuplicateEmail();
    saved.length = 0;
    await deps.enqueueEvents([{ organizationId: channel.organizationId, eventId: event.id }]);
    return 'stored';
  } catch (error) {
    // Lampiran yang tidak jadi dipakai dihapus lagi.
    for (const file of saved) {
      await db
        .delete(mediaFiles)
        .where(eq(mediaFiles.id, file.id))
        .catch(() => undefined);
      await deps.store?.remove(file.storageKey).catch(() => undefined);
    }
    if (error instanceof DuplicateEmail) return 'duplicate';
    throw error;
  }
}

class DuplicateEmail extends Error {}

export async function processChannelJob(
  job: ChannelJob,
  deps: ChannelMailboxDeps,
): Promise<unknown> {
  switch (job.name) {
    case CHANNEL_JOBS.emailTick:
      return { queued: await runEmailTick(deps) };
    case CHANNEL_JOBS.emailPoll: {
      const payload = emailPollJobPayloadSchema.safeParse(job.data);
      if (!payload.success) throw new UnrecoverableError('Payload job email-poll tidak valid');
      return runEmailPoll(payload.data, deps);
    }
    default:
      throw new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian channels`);
  }
}

export function createChannelsQueue(options: QueueConnectionOptions): Queue {
  return new Queue(QUEUE_NAMES.channels, {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
  });
}

export async function scheduleChannelJobs(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    CHANNEL_JOBS.emailTick,
    { every: EMAIL_TICK_INTERVAL_MS },
    {
      name: CHANNEL_JOBS.emailTick,
      data: {},
      opts: { attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: { count: 200 } },
    },
  );
}

export function pollEnqueuer(queue: Queue) {
  return async (payload: { organizationId: string; channelId: string }) => {
    await queue.add(CHANNEL_JOBS.emailPoll, emailPollJobPayloadSchema.parse(payload), {
      ...EMAIL_POLL_JOB_OPTIONS,
      jobId: emailPollJobId(payload.channelId),
    });
  };
}

export function createChannelsWorker(
  options: QueueConnectionOptions,
  deps: ChannelMailboxDeps,
): Worker {
  return new Worker(QUEUE_NAMES.channels, (job) => processChannelJob(job, deps), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    // Sambungan IMAP pendek; beberapa kotak masuk boleh diambil bersamaan.
    concurrency: 4,
  });
}
