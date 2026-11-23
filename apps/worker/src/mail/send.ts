import {
  buildComposedMime,
  ComposeHeaderError,
  openMailAccountSecret,
  sendAccountMail,
  signatureLogoCid,
  type AccountMailSender,
  type ApiMailFailureKind,
  type HostLookup,
  type Logger,
  type MailBusEventInput,
  type MailEventPublisher,
  type MediaStore,
  type Redis,
  type SecretBox,
  type SecurityNoticeAdminEmailPayload,
  type SmtpPolicy,
  type SmtpTimeouts,
} from '@balesin/core';
import {
  auditLogs,
  emailSenderSettings,
  emailTemplates,
  mailAccessIndexOf,
  mailAccounts,
  mailCorrespondents,
  mailDraftAttachments,
  mailDrafts,
  mailIdentities,
  mailOutbox,
  mailSignatures,
  organizations,
  users,
  type Database,
  type DbExecutor,
  type MailOutboxRow,
} from '@balesin/db';
import {
  MAIL_SEND_FAILURE_MESSAGES,
  hasPermission,
  mailLevelAtLeast,
  type EmailSenderBlockedReason,
  type MailOutboxHoldReason,
  type MailSendFailureReason,
} from '@balesin/shared';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import { acquireLease } from './lease';

/**
 * Pengiriman email menu Email (tahap 9B, KONTRAK-API-EMAIL-TULIS §9, §13):
 *
 *  - `runMailSendTick` (2 dtk): klaim ≤ 20 baris `pending`/`queued` JATUH TEMPO (`send_after`,
 *    `next_attempt_at`) dengan `FOR UPDATE SKIP LOCKED` di satu transaksi; rem darurat / jeda / blokir /
 *    pembatasan laju / batas per jam akun → ditahan (`hold_reason`); lolos → `sending` (dihitung ke
 *    batas per jam seketika) lalu job `mail-send`. Batal di api = pembaruan bersyarat `pending/queued`:
 *    siapa pun yang commit dulu menang (tidak ada "dibatalkan tapi terkirim").
 *  - `runMailSend`: cek ULANG hak (pengguna aktif, `mail.send`, level ≥ send), identitas MASIH
 *    terverifikasi & milik akun, akun tidak diputus/pemilik nonaktif → MIME (Bcc hanya amplop) → SMTP
 *    akun lewat penjaga host KETAT → hasil di satu transaksi. SATU SMTP bersamaan per akun (sewa).
 *  - Log: ID, status, jumlah penerima, kode SMTP — tanpa subjek/isi/alamat lengkap.
 */

export interface MailSendDeps {
  db: Database;
  logger: Logger;
  redis: Redis;
  prefix: string;
  secretBox: SecretBox | null;
  publisher: MailEventPublisher;
  store: MediaStore | null;
  smtp: {
    extraPorts?: readonly number[];
    testCa?: string;
    allowLoopback?: boolean;
    lookup?: HostLookup;
    timeouts?: Partial<SmtpTimeouts>;
  };
  /** Titik ganti tes (bawaan `sendAccountMail`). */
  send?: AccountMailSender;
  notifyOwner?: (payload: SecurityNoticeAdminEmailPayload) => Promise<void>;
  enqueueSend?: (payload: { organizationId: string; outboxId: string }) => Promise<void>;
  enqueueAppendSent?: (
    payload: { organizationId: string; outboxId: string },
    delayMs: number,
  ) => Promise<void>;
  enqueueDraftRemoteDelete?: (payload: {
    organizationId: string;
    accountId: string;
    folderId: string;
    uid: number;
    uidValidity: number;
  }) => Promise<void>;
  now?: () => Date;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CLAIM_BATCH = 20;
/** 1, 5, 15, 30, 60 menit, lalu tiap jam (maks. 24 jam). */
const RETRY_DELAYS_MS = [1, 5, 15, 30, 60].map((minutes) => minutes * MINUTE);
const HOLD_MAX_MS = 24 * HOUR;
const SENDING_STALE_MS = 15 * MINUTE;
const DEFAULT_HOURLY_LIMIT = 100;
const SMTP_LEASE_MS = 5 * MINUTE;
const SENT_COPY_AUTO_DELAY_MS = 20_000;
const SENT_COPY_LEASE_MS = 10 * MINUTE;
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export function retryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[Math.max(0, attempts - 1)] ?? HOUR;
}

export function mailSmtpLeaseKey(prefix: string, accountId: string): string {
  return `${prefix}:mail:smtp:${accountId}`;
}

export class MailSendBusyError extends Error {
  override readonly name = 'MailSendBusyError';
}

function outboxEvent(row: MailOutboxRow): MailBusEventInput {
  return {
    organizationId: row.organizationId,
    accountId: row.accountId,
    userIds: [row.createdByUserId],
    event: {
      type: 'mail.outbox.updated',
      accountId: row.accountId,
      outboxId: row.id,
      draftId: row.draftId,
      status: row.status as 'pending' | 'queued' | 'sending' | 'sent' | 'failed' | 'canceled',
      holdReason: row.holdReason,
      sendAfter: row.sendAfter.toISOString(),
      nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      failureReason: row.failureReason,
    },
  };
}

/** Gagal final: outbox `failed` + draf kembali `editing` dengan `last_send_error` (§9.2). */
async function failRow(
  tx: DbExecutor,
  row: MailOutboxRow,
  reason: MailSendFailureReason,
  at: Date,
  smtpCode: number | null = null,
): Promise<MailOutboxRow | null> {
  const [failed] = await tx
    .update(mailOutbox)
    .set({
      status: 'failed',
      failedAt: at,
      failureReason: reason,
      smtpCode,
      holdReason: null,
      nextAttemptAt: null,
    })
    .where(
      and(eq(mailOutbox.id, row.id), inArray(mailOutbox.status, ['pending', 'queued', 'sending'])),
    )
    .returning();
  if (!failed) return null;
  if (failed.draftId) {
    await tx
      .update(mailDrafts)
      .set({
        state: 'editing',
        lastSendError: {
          reason,
          message: MAIL_SEND_FAILURE_MESSAGES[reason],
          at: at.toISOString(),
        },
      })
      .where(eq(mailDrafts.id, failed.draftId));
  }
  return failed;
}

async function holdRow(
  tx: DbExecutor,
  row: MailOutboxRow,
  reason: MailOutboxHoldReason,
  until: Date,
): Promise<MailOutboxRow | null> {
  const [held] = await tx
    .update(mailOutbox)
    .set({ status: 'queued', holdReason: reason, nextAttemptAt: until, sendingStartedAt: null })
    .where(eq(mailOutbox.id, row.id))
    .returning();
  return held ?? null;
}

/** Ditahan sejak jatuh tempo (`send_after`) — > 24 jam → gagal final. */
const heldTooLong = (row: MailOutboxRow, at: Date) =>
  at.getTime() - row.sendAfter.getTime() > HOLD_MAX_MS;

interface AccountWindow {
  hourlyLimit: number;
  state: string;
  throttledUntil: Date | null;
  sentLastHour: number;
  oldest: Date | null;
}

async function accountWindow(
  tx: DbExecutor,
  row: MailOutboxRow,
  cache: Map<string, AccountWindow>,
  at: Date,
): Promise<AccountWindow> {
  const cached = cache.get(row.accountId);
  if (cached) return cached;
  const [settings] = await tx
    .select()
    .from(emailSenderSettings)
    .where(
      and(
        eq(emailSenderSettings.organizationId, row.organizationId),
        eq(emailSenderSettings.mailAccountId, row.accountId),
      ),
    )
    .limit(1);
  const hourAgo = new Date(at.getTime() - HOUR);
  // Batas per jam akun SATU sumber: menu Email (`mail_outbox`) — `email_outbound` akun menyusul 9E.
  const [window] = await tx
    .select({
      total: sql<number>`coalesce(sum(${mailOutbox.recipientCount}), 0)::int`,
      oldest: sql<
        string | null
      >`min(coalesce(${mailOutbox.sentAt}, ${mailOutbox.sendingStartedAt}))`,
    })
    .from(mailOutbox)
    .where(
      and(
        eq(mailOutbox.organizationId, row.organizationId),
        eq(mailOutbox.accountId, row.accountId),
        inArray(mailOutbox.status, ['sending', 'sent']),
        gt(sql`coalesce(${mailOutbox.sentAt}, ${mailOutbox.sendingStartedAt})`, hourAgo),
      ),
    );
  const result: AccountWindow = {
    hourlyLimit: settings?.hourlyLimit ?? DEFAULT_HOURLY_LIMIT,
    state: settings?.state ?? 'ok',
    throttledUntil: settings?.throttledUntil ?? null,
    sentLastHour: Number(window?.total ?? 0),
    oldest: window?.oldest ? new Date(window.oldest) : null,
  };
  cache.set(row.accountId, result);
  return result;
}

export interface MailSendTickResult {
  claimed: number;
  held: number;
  failed: number;
  recovered: number;
  sentCopies: number;
}

export function createMailSender(deps: MailSendDeps) {
  const { db, logger, publisher } = deps;
  const now = deps.now ?? (() => new Date());
  const send = deps.send ?? sendAccountMail;

  async function policyFor(organizationId: string): Promise<SmtpPolicy> {
    const [org] = await db
      .select({ cidrs: organizations.webhookPrivateCidrs })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return {
      allowedPorts: [465, 587, ...(deps.smtp.extraPorts ?? [])],
      plaintextLogin: 'private-only',
      lookup: deps.smtp.lookup,
      timeouts: deps.smtp.timeouts,
      strict: {
        privateCidrs: org?.cidrs ?? [],
        ...(deps.smtp.allowLoopback ? { allowLoopback: true } : {}),
      },
      ...(deps.smtp.testCa ? { testCa: deps.smtp.testCa } : {}),
    };
  }

  async function tick(): Promise<MailSendTickResult> {
    const at = now();
    const events: MailBusEventInput[] = [];
    const counts = { claimed: 0, held: 0, failed: 0, recovered: 0, sentCopies: 0 };
    const claimed = await db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(mailOutbox)
        .where(
          and(
            inArray(mailOutbox.status, ['pending', 'queued']),
            lte(mailOutbox.sendAfter, at),
            or(isNull(mailOutbox.nextAttemptAt), lte(mailOutbox.nextAttemptAt, at)),
          ),
        )
        .orderBy(mailOutbox.sendAfter)
        .limit(CLAIM_BATCH)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      const orgs = await tx
        .select({ id: organizations.id, pausedAt: organizations.sendingPausedAt })
        .from(organizations)
        .where(inArray(organizations.id, [...new Set(due.map((row) => row.organizationId))]));
      const paused = new Set(orgs.filter((org) => org.pausedAt).map((org) => org.id));
      const windows = new Map<string, AccountWindow>();
      const ready: MailOutboxRow[] = [];
      for (const row of due) {
        const hold = async (
          reason: MailOutboxHoldReason,
          until: Date,
          expired: MailSendFailureReason,
        ) => {
          const changed = heldTooLong(row, at)
            ? await failRow(tx, row, expired, at)
            : await holdRow(tx, row, reason, until);
          if (changed) {
            events.push(outboxEvent(changed));
            if (changed.status === 'failed') counts.failed += 1;
            else counts.held += 1;
          }
        };
        if (paused.has(row.organizationId)) {
          await hold('sending_paused', new Date(at.getTime() + MINUTE), 'sending_paused_expired');
          continue;
        }
        const window = await accountWindow(tx, row, windows, at);
        if (window.state === 'paused') {
          await hold('paused', new Date(at.getTime() + MINUTE), 'sending_paused_expired');
          continue;
        }
        if (window.state === 'blocked') {
          await hold('blocked', new Date(at.getTime() + 5 * MINUTE), 'sender_unavailable');
          continue;
        }
        if (window.state === 'throttled' && window.throttledUntil && window.throttledUntil > at) {
          await hold('throttled', window.throttledUntil, 'throttle_expired');
          continue;
        }
        // Batas per jam = PENERIMA; email yang sendirian melebihi batas tetap boleh bila jendela kosong.
        if (
          window.sentLastHour > 0 &&
          window.sentLastHour + row.recipientCount > window.hourlyLimit
        ) {
          const until = window.oldest
            ? new Date(window.oldest.getTime() + HOUR)
            : new Date(at.getTime() + MINUTE);
          await hold('hourly_limit', until, 'throttle_expired');
          continue;
        }
        window.sentLastHour += row.recipientCount;
        window.oldest ??= at;
        const [sending] = await tx
          .update(mailOutbox)
          .set({
            status: 'sending',
            sendingStartedAt: at,
            attempts: sql`${mailOutbox.attempts} + 1`,
            holdReason: null,
          })
          .where(eq(mailOutbox.id, row.id))
          .returning();
        if (sending) {
          ready.push(sending);
          events.push(outboxEvent(sending));
        }
      }
      return ready;
    });
    counts.claimed = claimed.length;

    // Proses mati di tengah kirim → status tidak pasti, TIDAK diulang.
    const stale = await db
      .select()
      .from(mailOutbox)
      .where(
        and(
          eq(mailOutbox.status, 'sending'),
          lte(mailOutbox.sendingStartedAt, new Date(at.getTime() - SENDING_STALE_MS)),
        ),
      )
      .limit(CLAIM_BATCH);
    for (const row of stale) {
      const failed = await db.transaction((tx) => failRow(tx, row, 'delivery_unknown', at));
      if (failed) {
        events.push(outboxEvent(failed));
        counts.recovered += 1;
      }
    }

    // Salinan Terkirim yang jatuh tempo (cadangan bila job tertunda hilang).
    const copies = await db
      .update(mailOutbox)
      .set({ sentCopyNextAt: new Date(at.getTime() + SENT_COPY_LEASE_MS) })
      .where(
        sql`${mailOutbox.id} in (select id from mail_outbox where status = 'sent' and sent_copy_state = 'pending' and sent_copy_next_at <= ${at} order by sent_copy_next_at limit ${CLAIM_BATCH} for update skip locked)`,
      )
      .returning({ id: mailOutbox.id, organizationId: mailOutbox.organizationId });
    for (const copy of copies) {
      await deps.enqueueAppendSent?.({ organizationId: copy.organizationId, outboxId: copy.id }, 0);
    }
    counts.sentCopies = copies.length;

    await publisher.publish(events);
    for (const row of claimed) {
      if (deps.enqueueSend) {
        await deps.enqueueSend({ organizationId: row.organizationId, outboxId: row.id });
      }
    }
    return counts;
  }

  /** Cek ulang §1 sesaat sebelum SMTP. `null` = boleh. */
  async function recheck(row: MailOutboxRow): Promise<MailSendFailureReason | null> {
    const [account] = await db
      .select()
      .from(mailAccounts)
      .where(
        and(
          eq(mailAccounts.organizationId, row.organizationId),
          eq(mailAccounts.id, row.accountId),
        ),
      )
      .limit(1);
    if (
      !account ||
      account.deletedAt !== null ||
      ['deleting', 'owner_inactive'].includes(account.syncState)
    ) {
      return 'account_unavailable';
    }
    const [user] = await db
      .select({ role: users.role, disabledAt: users.disabledAt })
      .from(users)
      .where(and(eq(users.organizationId, row.organizationId), eq(users.id, row.createdByUserId)))
      .limit(1);
    if (!user || user.disabledAt !== null || !hasPermission(user.role, 'mail.send'))
      return 'not_allowed';
    const index = await mailAccessIndexOf(
      db,
      row.organizationId,
      [row.createdByUserId],
      [row.accountId],
    );
    if (!mailLevelAtLeast(index.levelOf(row.createdByUserId, row.accountId), 'send'))
      return 'not_allowed';
    if (!row.identityId) return 'identity_unverified';
    const [identity] = await db
      .select()
      .from(mailIdentities)
      .where(
        and(
          eq(mailIdentities.organizationId, row.organizationId),
          eq(mailIdentities.id, row.identityId),
        ),
      )
      .limit(1);
    // Identitas MASIH terverifikasi, milik akun ini, dan alamatnya sama dengan yang dibekukan.
    if (
      !identity ||
      identity.accountId !== row.accountId ||
      identity.verificationState !== 'verified' ||
      identity.verifiedAt === null ||
      identity.address !== row.fromAddress
    ) {
      return 'identity_unverified';
    }
    return null;
  }

  async function readAll(storageKey: string): Promise<Buffer | null> {
    if (!deps.store) return null;
    const parts: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of deps.store.chunks(storageKey)) {
        size += chunk.length;
        if (size > ATTACHMENT_MAX_BYTES) return null;
        parts.push(chunk);
      }
    } catch {
      return null;
    }
    return Buffer.concat(parts);
  }

  /** Pengirim akun → `blocked` (sekali per kejadian): audit (kejadian keamanan) + email Owner. */
  async function blockSender(row: MailOutboxRow, reason: EmailSenderBlockedReason, at: Date) {
    let auditLogId: string | null = null;
    const [account] = await db
      .select({
        kind: mailAccounts.kind,
        ownerUserId: mailAccounts.ownerUserId,
        address: mailAccounts.emailAddress,
      })
      .from(mailAccounts)
      .where(eq(mailAccounts.id, row.accountId))
      .limit(1);
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ state: emailSenderSettings.state })
        .from(emailSenderSettings)
        .where(eq(emailSenderSettings.mailAccountId, row.accountId))
        .for('update')
        .limit(1);
      if (current?.state === 'blocked') return;
      await tx
        .insert(emailSenderSettings)
        .values({
          organizationId: row.organizationId,
          senderKind: 'account',
          mailAccountId: row.accountId,
          state: 'blocked',
          blockedReason: reason,
          blockedAt: at,
        })
        .onConflictDoUpdate({
          target: emailSenderSettings.mailAccountId,
          set: { state: 'blocked', blockedReason: reason, blockedAt: at },
        });
      const [audit] = await tx
        .insert(auditLogs)
        .values({
          organizationId: row.organizationId,
          actorUserId: null,
          action: 'settings.email_sender.blocked',
          targetType: 'email_sender',
          targetId: row.accountId,
          metadata: {
            senderId: `acc_${row.accountId}`,
            reason,
            // Akun pribadi: ID saja.
            ...(account?.kind === 'shared' ? { address: account.address } : {}),
          },
        })
        .returning({ id: auditLogs.id });
      auditLogId = audit?.id ?? null;
    });
    const logId = auditLogId as string | null;
    if (!logId || !deps.notifyOwner) return;
    logger.warn(
      { outboxId: row.id, accountId: row.accountId, reason },
      'Pengirim akun email terblokir',
    );
    const recipients =
      account?.kind === 'personal' && account.ownerUserId
        ? [account.ownerUserId]
        : (
            await db
              .select({ id: users.id })
              .from(users)
              .where(
                and(
                  eq(users.organizationId, row.organizationId),
                  eq(users.role, 'owner'),
                  isNull(users.disabledAt),
                ),
              )
          ).map((user) => user.id);
    for (const recipientUserId of recipients) {
      await deps
        .notifyOwner({
          organizationId: row.organizationId,
          recipientUserId,
          subjectUserId: recipientUserId,
          event: 'email_sender_blocked',
          occurredAt: at.toISOString(),
          auditLogId: logId,
        })
        .catch(() => undefined);
    }
  }

  async function throttleSender(row: MailOutboxRow, at: Date) {
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ streak: emailSenderSettings.throttleStreak })
        .from(emailSenderSettings)
        .where(eq(emailSenderSettings.mailAccountId, row.accountId))
        .for('update')
        .limit(1);
      const streak = (current?.streak ?? 0) + 1;
      const minutes = Math.min(60, 5 * 2 ** (streak - 1));
      const until = new Date(at.getTime() + minutes * MINUTE);
      await tx
        .insert(emailSenderSettings)
        .values({
          organizationId: row.organizationId,
          senderKind: 'account',
          mailAccountId: row.accountId,
          state: 'throttled',
          throttledUntil: until,
          throttleStreak: streak,
        })
        .onConflictDoUpdate({
          target: emailSenderSettings.mailAccountId,
          set: {
            state: sql`case when ${emailSenderSettings.state} = 'ok' or ${emailSenderSettings.state} = 'throttled' then 'throttled' else ${emailSenderSettings.state} end`,
            throttledUntil: until,
            throttleStreak: streak,
          },
        });
    });
  }

  async function finishFailure(
    row: MailOutboxRow,
    reason: MailSendFailureReason,
    smtpCode: number | null,
  ) {
    const at = now();
    const failed = await db.transaction((tx) => failRow(tx, row, reason, at, smtpCode));
    if (failed) await publisher.publish([outboxEvent(failed)]);
    logger.warn(
      { outboxId: row.id, accountId: row.accountId, reason, smtpCode },
      'Email menu Email gagal dikirim',
    );
    return { status: 'failed' as const, reason };
  }

  async function retryLater(
    row: MailOutboxRow,
    kind: Extract<ApiMailFailureKind, 'temporary' | 'throttled'>,
    smtpCode: number | null,
  ) {
    const at = now();
    if (heldTooLong(row, at)) return finishFailure(row, 'throttle_expired', smtpCode);
    if (kind === 'throttled') await throttleSender(row, at);
    const [queued] = await db
      .update(mailOutbox)
      .set({
        status: 'queued',
        holdReason: kind === 'throttled' ? 'throttled' : null,
        nextAttemptAt: new Date(at.getTime() + retryDelayMs(row.attempts)),
        smtpCode,
        sendingStartedAt: null,
      })
      .where(and(eq(mailOutbox.id, row.id), eq(mailOutbox.status, 'sending')))
      .returning();
    if (queued) await publisher.publish([outboxEvent(queued)]);
    return { status: 'retry' as const };
  }

  async function holdBlocked(row: MailOutboxRow, reason: EmailSenderBlockedReason) {
    const at = now();
    await blockSender(row, reason, at);
    if (heldTooLong(row, at)) {
      return finishFailure(
        row,
        reason === 'credentials_unavailable' ? 'credentials_unavailable' : 'sender_unavailable',
        null,
      );
    }
    const held = await db.transaction((tx) =>
      holdRow(tx, row, 'blocked', new Date(at.getTime() + 5 * MINUTE)),
    );
    if (held) await publisher.publish([outboxEvent(held)]);
    return { status: 'held' as const };
  }

  async function recordSent(row: MailOutboxRow, rejected: readonly string[], raw: Buffer | null) {
    const at = now();
    let rawKey: string | null = null;
    if (raw && row.sentCopyState === 'pending' && deps.store) {
      rawKey = (await deps.store.save('email-out', raw)).storageKey;
    }
    const recipients = [...row.to, ...row.cc, ...row.bcc];
    const draftFiles: string[] = [];
    let draftServerCopy: { folderId: string; uid: number; uidValidity: number } | null = null;
    const sent = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(mailOutbox)
        .set({
          status: 'sent',
          sentAt: at,
          holdReason: null,
          nextAttemptAt: null,
          rejectedRecipients: rejected.slice(0, 100),
          rawStorageKey: rawKey,
          sentCopyState: rawKey
            ? 'pending'
            : row.sentCopyState === 'pending'
              ? 'failed'
              : row.sentCopyState,
          sentCopyNextAt: rawKey ? at : null,
        })
        .where(and(eq(mailOutbox.id, row.id), eq(mailOutbox.status, 'sending')))
        .returning();
      if (!updated) return null;
      if (row.draftId) {
        const [draft] = await tx
          .select()
          .from(mailDrafts)
          .where(eq(mailDrafts.id, row.draftId))
          .limit(1);
        if (draft?.serverFolderId && draft.serverUid && draft.serverUidvalidity !== null) {
          draftServerCopy = {
            folderId: draft.serverFolderId,
            uid: draft.serverUid,
            uidValidity: draft.serverUidvalidity,
          };
        }
        const files = await tx
          .select({ storageKey: mailDraftAttachments.storageKey })
          .from(mailDraftAttachments)
          .where(eq(mailDraftAttachments.draftId, row.draftId));
        for (const file of files) if (file.storageKey) draftFiles.push(file.storageKey);
        await tx.delete(mailDrafts).where(eq(mailDrafts.id, row.draftId));
      }
      // Korespondensi: penerima yang diterima server (pelengkap + bukan "alamat baru" lagi).
      const accepted = recipients.filter((item) => !rejected.includes(item.address));
      if (accepted.length > 0) {
        await tx
          .insert(mailCorrespondents)
          .values(
            accepted.map((item) => ({
              organizationId: row.organizationId,
              accountId: row.accountId,
              address: item.address,
              name: item.name?.slice(0, 200) ?? null,
              sentCount: 1,
              lastSeenAt: at,
            })),
          )
          .onConflictDoUpdate({
            target: [mailCorrespondents.accountId, mailCorrespondents.address],
            set: {
              sentCount: sql`${mailCorrespondents.sentCount} + 1`,
              lastSeenAt: at,
              updatedAt: at,
            },
          });
      }
      if (row.templateId) {
        await tx
          .update(emailTemplates)
          .set({ lastUsedAt: at })
          .where(
            and(
              eq(emailTemplates.organizationId, row.organizationId),
              eq(emailTemplates.id, row.templateId),
            ),
          );
      }
      // Audit TANPA subjek/isi/alamat penerima; pelaku = pengguna.
      await tx.insert(auditLogs).values({
        organizationId: row.organizationId,
        actorUserId: row.createdByUserId,
        action: 'mail.message.sent',
        targetType: 'mail_account',
        targetId: row.accountId,
        metadata: {
          accountId: row.accountId,
          identityId: row.identityId,
          outboxId: row.id,
          mode: row.mode,
          recipientCount: row.recipientCount,
          newRecipientCount: row.newRecipientCount,
          attachmentCount: row.attachmentCount,
          hasBcc: row.bcc.length > 0,
          rejectedCount: rejected.length,
        },
      });
      return updated;
    });
    if (!sent) {
      if (rawKey) await deps.store?.remove(rawKey).catch(() => undefined);
      return { status: 'skipped' as const };
    }
    for (const key of draftFiles) await deps.store?.remove(key).catch(() => undefined);
    const copy = draftServerCopy as { folderId: string; uid: number; uidValidity: number } | null;
    if (copy) {
      await deps
        .enqueueDraftRemoteDelete?.({
          organizationId: row.organizationId,
          accountId: row.accountId,
          ...copy,
        })
        .catch(() => undefined);
    }
    const events: MailBusEventInput[] = [outboxEvent(sent)];
    if (row.draftId) {
      events.push({
        organizationId: row.organizationId,
        accountId: row.accountId,
        userIds: [row.createdByUserId],
        event: { type: 'mail.draft.deleted', accountId: row.accountId, draftId: row.draftId },
      });
    }
    await publisher.publish(events);
    if (sent.sentCopyState === 'pending') {
      const [account] = await db
        .select({ mode: mailAccounts.sentCopyMode })
        .from(mailAccounts)
        .where(eq(mailAccounts.id, row.accountId))
        .limit(1);
      await deps
        .enqueueAppendSent?.(
          { organizationId: row.organizationId, outboxId: row.id },
          account?.mode === 'append' ? 0 : SENT_COPY_AUTO_DELAY_MS,
        )
        .catch(() => undefined);
    }
    logger.info(
      {
        outboxId: row.id,
        accountId: row.accountId,
        recipients: row.recipientCount,
        rejected: rejected.length,
      },
      'Email menu Email terkirim',
    );
    return { status: 'sent' as const };
  }

  /** Satu baris outbox `sending` (job `mail-send`). */
  async function sendOne(payload: { organizationId: string; outboxId: string }) {
    const [row] = await db
      .select()
      .from(mailOutbox)
      .where(
        and(
          eq(mailOutbox.organizationId, payload.organizationId),
          eq(mailOutbox.id, payload.outboxId),
        ),
      )
      .limit(1);
    if (!row || row.status !== 'sending') return { status: 'skipped' as const };
    const lease = await acquireLease(
      deps.redis,
      mailSmtpLeaseKey(deps.prefix, row.accountId),
      SMTP_LEASE_MS,
    );
    if (!lease) throw new MailSendBusyError('SMTP akun ini sedang dipakai');
    try {
      const denied = await recheck(row);
      if (denied) return await finishFailure(row, denied, null);
      const [account] = await db
        .select()
        .from(mailAccounts)
        .where(eq(mailAccounts.id, row.accountId))
        .limit(1);
      if (!account) return await finishFailure(row, 'account_unavailable', null);
      // Lampiran draf + logo tanda tangan yang dirujuk HTML.
      const files = row.draftId
        ? await db
            .select()
            .from(mailDraftAttachments)
            .where(eq(mailDraftAttachments.draftId, row.draftId))
            .orderBy(mailDraftAttachments.position)
        : [];
      const inline: { cid: string; filename: string; contentType: string; content: Buffer }[] = [];
      const attachments: { filename: string; contentType: string; content: Buffer }[] = [];
      for (const file of files) {
        if (file.state !== 'ready' || !file.storageKey)
          return await finishFailure(row, 'attachment_unavailable', null);
        const content = await readAll(file.storageKey);
        if (!content) return await finishFailure(row, 'attachment_unavailable', null);
        if (file.inline && file.contentId) {
          inline.push({
            cid: file.contentId,
            filename: file.filename,
            contentType: file.contentType,
            content,
          });
        } else {
          attachments.push({ filename: file.filename, contentType: file.contentType, content });
        }
      }
      let html = row.html ?? '';
      const logoIds = [...html.matchAll(/cid:sig-logo-([0-9a-f-]{36})/g)].map(
        (match) => match[1] ?? '',
      );
      if (logoIds.length > 0) {
        const logos = await db
          .select({ id: mailSignatures.id, logo: mailSignatures.logoPng })
          .from(mailSignatures)
          .where(
            and(
              eq(mailSignatures.organizationId, row.organizationId),
              eq(mailSignatures.accountId, row.accountId),
              inArray(mailSignatures.id, [...new Set(logoIds)]),
            ),
          );
        for (const id of new Set(logoIds)) {
          const logo = logos.find((item) => item.id === id)?.logo;
          if (logo) {
            inline.push({
              cid: signatureLogoCid(id),
              filename: 'logo.png',
              contentType: 'image/png',
              content: logo,
            });
          } else {
            // Tanda tangan terhapus sebelum terkirim → gambar dibuang (teks alt tetap di versi teks).
            html = html.replace(
              new RegExp(`<img\\b[^>]*cid:${signatureLogoCid(id)}[^>]*>`, 'g'),
              '',
            );
          }
        }
      }
      // Kredensial SMTP akun: dibuka sesaat sebelum sambung, tidak pernah di-log.
      const sealed = account.smtpSameCredentials
        ? account.imapPasswordEncrypted
        : account.smtpPasswordEncrypted;
      const username = account.smtpSameCredentials ? account.imapUsername : account.smtpUsername;
      if (!deps.secretBox || !sealed || !username || !account.smtpHost || !account.smtpPort) {
        return await holdBlocked(row, 'credentials_unavailable');
      }
      let password;
      try {
        password = openMailAccountSecret(
          deps.secretBox,
          account,
          account.smtpSameCredentials ? 'imapPassword' : 'smtpPassword',
          sealed,
        );
      } catch {
        return await holdBlocked(row, 'credentials_unavailable');
      }
      let mime;
      try {
        mime = await buildComposedMime({
          from: { address: row.fromAddress, name: row.fromName },
          replyTo: row.replyTo,
          to: row.to,
          cc: row.cc,
          bcc: row.bcc,
          subject: row.subject ?? '',
          html,
          text: row.text ?? '',
          messageId: row.messageIdHeader,
          date: now(),
          inReplyTo: row.inReplyTo,
          references: row.references,
          inline,
          attachments,
        });
      } catch (error) {
        if (error instanceof ComposeHeaderError)
          return await finishFailure(row, 'message_rejected', null);
        throw error;
      }
      const result = await send(
        {
          host: account.smtpHost,
          port: account.smtpPort,
          security: account.smtpSecurity === 'starttls' ? 'starttls' : 'ssl',
          username,
          password,
        },
        await policyFor(row.organizationId),
        {
          from: row.envelopeFrom,
          to: [...row.to, ...row.cc, ...row.bcc].map((item) => item.address),
        },
        mime.forSending,
      );
      if (result.ok) {
        const total = row.recipientCount;
        if (result.rejected.length >= total) {
          return await finishFailure(row, 'recipient_rejected', null);
        }
        return await recordSent(row, result.rejected, mime.withBcc);
      }
      switch (result.kind) {
        case 'temporary':
        case 'throttled':
          return await retryLater(row, result.kind, result.smtpCode);
        case 'auth':
          return await holdBlocked(row, 'smtp_auth_failed');
        case 'config':
          return await holdBlocked(row, 'smtp_config_invalid');
        case 'recipients_rejected':
          return await finishFailure(row, 'recipient_rejected', result.smtpCode);
        case 'sender_rejected':
          return await finishFailure(row, 'sender_rejected', result.smtpCode);
        case 'message_rejected':
          return await finishFailure(row, 'message_rejected', result.smtpCode);
        default:
          return await finishFailure(row, 'delivery_unknown', result.smtpCode);
      }
    } finally {
      await lease.release();
    }
  }

  return { tick, sendOne, policyFor };
}

export type MailSender = ReturnType<typeof createMailSender>;
