import {
  AppError,
  assembleMailBody,
  buildMailQuote,
  newOutboundMessageId,
  type MailEventPublisher,
} from '@balesin/core';
import {
  emailSenderSettings,
  mailDrafts,
  mailIdentityApprovalAllows,
  mailIdentityApprovalStateOf,
  mailMessageBodies,
  mailOrganizationDomains,
  mailOutbox,
  type Database,
  type DbExecutor,
  type MailDraftRow,
  type MailOutboxRow,
} from '@balesin/db';
import {
  MAIL_COMPOSE_MESSAGES,
  MAIL_SENDER_QUEUE_HOURS,
  MAIL_SEND_FAILURE_MESSAGES,
  MAIL_UNDO_SEND_SECONDS,
  replyReferencesFor,
  type MailOutboxItem,
  type MailSendFailureReason,
  type SendMailDraftRequest,
} from '@balesin/shared';
import { and, desc, eq, gt, inArray, notExists, sql } from 'drizzle-orm';

import type { RateLimiter } from '../../http/rate-limit';
import type { AccessDeniedRecorder } from '../auth/access-denied';
import type { AuthContext } from '../auth/session.service';
import type { SendingLimitsService } from '../sending-limits/sending-limits.service';
import { createComposeAccess } from './mail-compose-access';
import { composeLimitsOf, composeNotFound, detailError, loadIdentity } from './mail-compose.repo';
import {
  NEW_ADDRESS_RULE,
  assertSubject,
  mergeRecipients,
  type MailDraftsService,
} from './mail-drafts.service';
import { isUuid } from './mail.repo';
import type { MailContext } from './mail.service';
import type { MailSignaturesService } from './mail-signatures.service';

/**
 * Kirim & batalkan kirim (KONTRAK-API-EMAIL-TULIS §9). Pola R1 9.1: TIDAK ada baris dibuat sebelum
 * semua pemeriksaan lolos. Masa batal = baris `pending` dengan `send_after` (bukan job tertunda);
 * batal = pembaruan bersyarat `status in ('pending','queued')`; worker mengklaim dengan `SKIP LOCKED`
 * hanya setelah `send_after` — siapa pun yang commit dulu menang. Idempotensi = indeks unik sebagian
 * satu outbox aktif per draf + `baseVersion`. Outbox = PRIBADI pembuatnya (lain → 404).
 */

const OUTBOX_NOT_FOUND = 'Email ini tidak ditemukan di antrean kirim.';
const DEFAULT_HOURLY_LIMIT = 100;
const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function toOutboxItem(row: MailOutboxRow): MailOutboxItem {
  return {
    id: row.id,
    draftId: row.draftId,
    accountId: row.accountId,
    identity: { id: row.identityId, address: row.fromAddress, displayName: row.fromName },
    status: row.status as MailOutboxItem['status'],
    holdReason: (row.holdReason as MailOutboxItem['holdReason']) ?? null,
    sendAfter: row.sendAfter.toISOString(),
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    attempts: row.attempts,
    subject: row.subject,
    recipientCount: row.recipientCount,
    toPreview: row.to.slice(0, 3).map((item) => item.name ?? item.address),
    sentAt: row.sentAt?.toISOString() ?? null,
    failure: row.failureReason
      ? {
          reason: row.failureReason as MailSendFailureReason,
          message: MAIL_SEND_FAILURE_MESSAGES[row.failureReason as MailSendFailureReason],
          smtpCode: row.smtpCode,
        }
      : null,
    rejectedRecipients: row.rejectedRecipients,
    sentCopy: { state: row.sentCopyState as MailOutboxItem['sentCopy']['state'] },
    createdAt: row.createdAt.toISOString(),
  };
}

export function outboxEvent(row: MailOutboxRow) {
  return {
    organizationId: row.organizationId,
    accountId: row.accountId,
    userIds: [row.createdByUserId],
    event: {
      type: 'mail.outbox.updated' as const,
      accountId: row.accountId,
      outboxId: row.id,
      draftId: row.draftId,
      status: row.status as MailOutboxItem['status'],
      holdReason: row.holdReason,
      sendAfter: row.sendAfter.toISOString(),
      nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      failureReason: row.failureReason,
    },
  };
}

export function createMailOutboxService(deps: {
  db: Database;
  accessDenied: AccessDeniedRecorder;
  publisher: MailEventPublisher;
  limiter: RateLimiter;
  sendingLimits: Pick<SendingLimitsService, 'assertCanSendMail'>;
  drafts: MailDraftsService;
  signatures: MailSignaturesService;
  now?: () => Date;
}) {
  const { db, limiter, publisher, drafts } = deps;
  const now = deps.now ?? (() => new Date());
  const access = createComposeAccess({ db, accessDenied: deps.accessDenied });

  async function activeOf(executor: DbExecutor, organizationId: string, draftId: string) {
    const [row] = await executor
      .select()
      .from(mailOutbox)
      .where(
        and(
          eq(mailOutbox.organizationId, organizationId),
          eq(mailOutbox.draftId, draftId),
          inArray(mailOutbox.status, ['pending', 'queued', 'sending']),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function loadOwn(auth: AuthContext, outboxId: string): Promise<MailOutboxRow> {
    if (!isUuid(outboxId)) throw composeNotFound(OUTBOX_NOT_FOUND);
    const [row] = await db
      .select()
      .from(mailOutbox)
      .where(
        and(
          eq(mailOutbox.organizationId, auth.organizationId),
          eq(mailOutbox.id, outboxId),
          eq(mailOutbox.createdByUserId, auth.user.id),
        ),
      )
      .limit(1);
    if (!row) throw composeNotFound(OUTBOX_NOT_FOUND);
    return row;
  }

  /** Jatah alamat baru: ambil `units` (dikembalikan bila gagal/batal). */
  async function takeNewAddressUnits(auth: AuthContext, units: number): Promise<number> {
    if (units === 0) return 0;
    const key = `${auth.organizationId}:${auth.user.id}`;
    const peek = await limiter.peek(NEW_ADDRESS_RULE, key);
    if (peek.count + units > NEW_ADDRESS_RULE.limit) {
      throw detailError(
        'RATE_LIMITED',
        'new_address_quota',
        MAIL_COMPOSE_MESSAGES.newAddressQuota(NEW_ADDRESS_RULE.limit),
        'to',
        {},
        { retryAfterSeconds: peek.retryAfterSeconds },
      );
    }
    let taken = 0;
    for (; taken < units; taken += 1) {
      const state = await limiter.consume(NEW_ADDRESS_RULE, key);
      if (!state.allowed) {
        await refundNewAddressUnits(auth.organizationId, auth.user.id, taken + 1);
        throw detailError(
          'RATE_LIMITED',
          'new_address_quota',
          MAIL_COMPOSE_MESSAGES.newAddressQuota(NEW_ADDRESS_RULE.limit),
          'to',
          {},
          { retryAfterSeconds: state.retryAfterSeconds },
        );
      }
    }
    return taken;
  }

  async function refundNewAddressUnits(organizationId: string, userId: string, units: number) {
    for (let index = 0; index < units; index += 1) {
      await limiter.refund(NEW_ADDRESS_RULE, `${organizationId}:${userId}`).catch(() => undefined);
    }
  }

  /** Kutipan dari isi tampilan tersimpan 9A (isi asli tidak tersedia → tanpa kutipan). */
  async function quoteOf(auth: AuthContext, draft: MailDraftRow) {
    if (!draft.includeQuote || !draft.sourceMessageId || !draft.sourceSnapshot) return null;
    const [body] = await db
      .select({ html: mailMessageBodies.htmlSanitized, text: mailMessageBodies.text })
      .from(mailMessageBodies)
      .where(
        and(
          eq(mailMessageBodies.organizationId, auth.organizationId),
          eq(mailMessageBodies.messageId, draft.sourceMessageId),
        ),
      )
      .limit(1);
    if (!body) return null;
    const snapshot = draft.sourceSnapshot;
    return buildMailQuote({
      mode: draft.mode === 'forward' ? 'forward' : 'reply',
      from: snapshot.from,
      to: snapshot.to,
      cc: snapshot.cc,
      subject: snapshot.subject,
      sentAt: snapshot.sentAt ? new Date(snapshot.sentAt) : null,
      html: body.html,
      text: body.text,
      timeZone: auth.organization.timezone,
    });
  }

  const service = {
    async send(
      auth: AuthContext,
      draftId: string,
      input: SendMailDraftRequest,
      context: MailContext,
    ): Promise<{ outbox: MailOutboxItem; duplicate?: boolean; status: 200 | 202 }> {
      // 1. Draf milikku (lain → 404).
      const draft = await drafts.loadDraftRow(db, auth, draftId);
      // 2. Idempotensi: klik ganda / dua tab → outbox aktif yang sama.
      const active = await activeOf(db, auth.organizationId, draft.id);
      if (active) return { outbox: toOutboxItem(active), duplicate: true, status: 200 };
      // 3. Versi yang dikirim = versi yang disimpan web.
      if (input.baseVersion !== draft.version) {
        throw detailError(
          'CONFLICT',
          'draft_version_conflict',
          MAIL_COMPOSE_MESSAGES.draftVersionConflict,
          'baseVersion',
          { currentVersion: draft.version, updatedAt: draft.updatedAt.toISOString() },
        );
      }
      // 4. Hak kirim SAAT INI; akun sedang diputus → 409.
      const account = await access.require(auth, draft.accountId, 'send', context.client, {
        includeDeleted: true,
      });
      if (account.row.deletedAt !== null) {
        throw detailError(
          'CONFLICT',
          'account_deleting',
          MAIL_COMPOSE_MESSAGES.accountDeleting,
          'draftId',
        );
      }
      // 5. Identitas milik akun & TERVERIFIKASI (diperiksa ulang di worker).
      const identity = await loadIdentity(db, auth.organizationId, draft.identityId);
      if (!identity || identity.accountId !== account.row.id) {
        throw detailError(
          'VALIDATION_ERROR',
          'identity_not_in_account',
          MAIL_COMPOSE_MESSAGES.identityNotInAccount,
          'identityId',
        );
      }
      // Review 9B S3: akun PRIBADI berdomain organisasi → wajib disetujui Owner/Admin (worker cek ulang).
      if (account.row.kind === 'personal') {
        const domains = await mailOrganizationDomains(db, auth.organizationId);
        const approval = mailIdentityApprovalStateOf(identity, 'personal', domains);
        if (!mailIdentityApprovalAllows(approval)) {
          throw detailError(
            'CONFLICT',
            'identity_not_approved',
            approval === 'rejected'
              ? MAIL_COMPOSE_MESSAGES.approvalRejected
              : MAIL_COMPOSE_MESSAGES.approvalRequired,
            'identityId',
          );
        }
      }
      if (identity.verificationState !== 'verified') {
        throw detailError(
          'CONFLICT',
          'identity_unverified',
          MAIL_COMPOSE_MESSAGES.identityUnverified(identity.address),
          'identityId',
        );
      }
      // 6. Isi.
      const subject = assertSubject(draft.subject);
      // 7. Penerima.
      const limits = await composeLimitsOf(db, auth.organizationId);
      const recipients = mergeRecipients({ to: draft.to, cc: draft.cc, bcc: draft.bcc });
      if (recipients.total === 0) {
        throw detailError(
          'VALIDATION_ERROR',
          'recipient_invalid',
          MAIL_COMPOSE_MESSAGES.noRecipients,
          'to',
        );
      }
      if (recipients.total > limits.maxRecipients) {
        throw detailError(
          'VALIDATION_ERROR',
          'too_many_recipients',
          MAIL_COMPOSE_MESSAGES.tooManyRecipients(limits.maxRecipients),
          'to',
        );
      }
      // 8. Lampiran.
      await drafts.resolveLoading(auth, draft);
      const attachments = await drafts.attachmentsOf(db, auth.organizationId, draft.id);
      if (attachments.some((row) => row.state !== 'ready')) {
        throw detailError(
          'CONFLICT',
          'attachments_not_ready',
          MAIL_COMPOSE_MESSAGES.attachmentsNotReady,
          'attachments',
        );
      }
      const totalBytes = attachments.reduce((sum, row) => sum + row.sizeBytes, 0);
      if (totalBytes > limits.maxAttachmentBytes) {
        throw detailError(
          'VALIDATION_ERROR',
          'attachment_too_large',
          MAIL_COMPOSE_MESSAGES.attachmentTooLarge(limits.maxAttachmentMb),
          'attachments',
        );
      }
      // 9. Email baru di utas sejak draf dibuka (ditegakkan server).
      const acknowledged = input.acknowledgeNewMessagesUntil
        ? new Date(input.acknowledgeNewMessagesUntil)
        : null;
      const since =
        acknowledged && draft.threadSeenAt && acknowledged > draft.threadSeenAt
          ? acknowledged
          : (draft.threadSeenAt ?? acknowledged);
      const thread = await drafts.threadNewMessages(auth, draft, since);
      if (thread.count > 0) {
        throw detailError(
          'CONFLICT',
          'thread_has_new_messages',
          MAIL_COMPOSE_MESSAGES.threadHasNewMessages(thread.count),
          'draftId',
          {
            count: thread.count,
            ...(thread.latestReceivedAt ? { latestReceivedAt: thread.latestReceivedAt } : {}),
            messageIds: thread.messageIds,
          },
        );
      }
      // 10–11. Rem darurat (423) + batas harian pengguna (pesan + email, per penerima).
      await deps.sendingLimits.assertCanSendMail({
        organizationId: auth.organizationId,
        userId: auth.user.id,
        client: context.client,
        recipients: recipients.total,
      });
      // 12. Jatah alamat baru (dikembalikan bila langkah berikut gagal).
      const all = [...recipients.to, ...recipients.cc, ...recipients.bcc].map(
        (item) => item.address,
      );
      const unknown = await drafts.unknownAddresses(auth.organizationId, account.row.id, all);
      const units = await takeNewAddressUnits(auth, unknown.size);
      try {
        // 13. Antrean akun penuh.
        const [sender] = await db
          .select({ hourlyLimit: emailSenderSettings.hourlyLimit })
          .from(emailSenderSettings)
          .where(
            and(
              eq(emailSenderSettings.organizationId, auth.organizationId),
              eq(emailSenderSettings.mailAccountId, account.row.id),
            ),
          )
          .limit(1);
        const [waiting] = await db
          .select({ total: sql<number>`coalesce(sum(${mailOutbox.recipientCount}), 0)::int` })
          .from(mailOutbox)
          .where(
            and(
              eq(mailOutbox.organizationId, auth.organizationId),
              eq(mailOutbox.accountId, account.row.id),
              inArray(mailOutbox.status, ['pending', 'queued', 'sending']),
            ),
          );
        const hourly = sender?.hourlyLimit ?? DEFAULT_HOURLY_LIMIT;
        if (Number(waiting?.total ?? 0) + recipients.total > MAIL_SENDER_QUEUE_HOURS * hourly) {
          throw detailError(
            'RATE_LIMITED',
            'sender_queue_full',
            MAIL_COMPOSE_MESSAGES.senderQueueFull,
            'draftId',
            {},
            { retryAfterSeconds: 60 * 60 },
          );
        }
        // 14. Rakit isi FINAL (badan + kutipan; tanda tangan sudah di badan).
        const cids = await drafts.allowedCidsOf(db, auth, draft);
        const assembled = assembleMailBody({
          format: draft.format as 'html' | 'text',
          bodyHtml: draft.bodyHtml,
          bodyText: draft.bodyText,
          quote: await quoteOf(auth, draft),
          allowedCids: cids,
        });
        if (!assembled.ok) {
          throw detailError(
            'VALIDATION_ERROR',
            assembled.reason,
            assembled.reason === 'html_too_complex'
              ? 'Isi email terlalu rumit (terlalu banyak tag atau sarang terlalu dalam).'
              : 'Isi email setelah kutipan digabung melebihi 512 KB. Matikan kutipan atau perpendek isinya.',
            'bodyHtml',
          );
        }
        const snapshot = draft.sourceSnapshot;
        const isReply = draft.mode === 'reply' || draft.mode === 'reply_all';
        const references =
          isReply && snapshot
            ? replyReferencesFor(snapshot.references, snapshot.messageIdHeader)
            : [];
        const preferences = await deps.signatures.preferences(auth);
        const at = now();
        const sendAfter = new Date(
          at.getTime() +
            Math.min(
              Math.max(preferences.undoSendSeconds, MAIL_UNDO_SEND_SECONDS.min),
              MAIL_UNDO_SEND_SECONDS.max,
            ) *
              1000,
        );
        // 15. Satu transaksi: outbox `pending` + draf `sending`.
        const created = await db.transaction(async (tx) => {
          const locked = await drafts.loadDraftRow(tx, auth, draft.id, { forUpdate: true });
          const existing = await activeOf(tx, auth.organizationId, locked.id);
          if (existing) return { row: existing, duplicate: true };
          if (locked.version !== input.baseVersion) {
            throw detailError(
              'CONFLICT',
              'draft_version_conflict',
              MAIL_COMPOSE_MESSAGES.draftVersionConflict,
              'baseVersion',
              { currentVersion: locked.version, updatedAt: locked.updatedAt.toISOString() },
            );
          }
          // Review 9B R2: batas harian dihitung ULANG di bawah kunci advisory per pengguna (kirim
          // paralel berurutan; outbox pengirim sebelumnya sudah ter-commit saat kunci didapat).
          await deps.sendingLimits.assertCanSendMail({
            organizationId: auth.organizationId,
            userId: auth.user.id,
            client: context.client,
            recipients: recipients.total,
            executor: tx,
          });
          const [row] = await tx
            .insert(mailOutbox)
            .values({
              organizationId: auth.organizationId,
              accountId: account.row.id,
              identityId: identity.id,
              draftId: locked.id,
              createdByUserId: auth.user.id,
              mode: locked.mode,
              fromAddress: identity.address,
              fromName: identity.displayName,
              replyTo: identity.replyTo,
              envelopeFrom: account.row.emailAddress,
              to: recipients.to,
              cc: recipients.cc,
              bcc: recipients.bcc,
              recipientCount: recipients.total,
              newRecipientCount: unknown.size,
              attachmentCount: attachments.length,
              subject,
              html: assembled.html,
              text: assembled.text,
              messageIdHeader: newOutboundMessageId(identity.address),
              inReplyTo:
                isReply &&
                snapshot?.messageIdHeader &&
                references.includes(snapshot.messageIdHeader)
                  ? snapshot.messageIdHeader
                  : null,
              references,
              status: 'pending',
              sendAfter,
              sentCopyState: account.row.sentCopyMode === 'none' ? 'skipped' : 'pending',
              newAddressUnits: units,
              templateId: locked.templateId,
            })
            .onConflictDoNothing()
            .returning();
          if (!row) {
            // Permintaan bersamaan menang lebih dulu (indeks unik sebagian) → baca hasilnya.
            const winner = await activeOf(tx, auth.organizationId, locked.id);
            if (!winner) throw new AppError('CONFLICT', { message: 'Coba kirim lagi.' });
            return { row: winner, duplicate: true };
          }
          await tx
            .update(mailDrafts)
            .set({ state: 'sending', lastSendError: null })
            .where(eq(mailDrafts.id, locked.id));
          return { row, duplicate: false };
        });
        if (created.duplicate) {
          await refundNewAddressUnits(auth.organizationId, auth.user.id, units);
          return { outbox: toOutboxItem(created.row), duplicate: true, status: 200 };
        }
        await publisher.publish([outboxEvent(created.row)]);
        await drafts.clearPresence(draft, auth.user.id);
        return { outbox: toOutboxItem(created.row), status: 202 };
      } catch (error) {
        await refundNewAddressUnits(auth.organizationId, auth.user.id, units);
        throw error;
      }
    },

    async list(auth: AuthContext, state: 'active' | 'failed' | 'recent') {
      const base = and(
        eq(mailOutbox.organizationId, auth.organizationId),
        eq(mailOutbox.createdByUserId, auth.user.id),
      );
      const condition =
        state === 'active'
          ? inArray(mailOutbox.status, ['pending', 'queued', 'sending'])
          : state === 'failed'
            ? and(
                // Review 9B R4: `delivery_unknown` ikut baki "gagal" (pengguna perlu memeriksanya).
                inArray(mailOutbox.status, ['failed', 'delivery_unknown']),
                gt(mailOutbox.failedAt, new Date(now().getTime() - FAILED_WINDOW_MS)),
                // Drafnya belum dikirim ulang (tidak ada outbox lebih baru untuk draf yang sama).
                notExists(
                  db
                    .select({ id: sql`1` })
                    .from(sql`mail_outbox newer`)
                    .where(
                      sql`newer.draft_id = ${mailOutbox.draftId} and newer.created_at > ${mailOutbox.createdAt}`,
                    ),
                ),
              )
            : undefined;
      const rows = await db
        .select()
        .from(mailOutbox)
        .where(and(base, condition))
        .orderBy(desc(mailOutbox.createdAt))
        .limit(50);
      return { outbox: rows.map(toOutboxItem) };
    },

    async get(auth: AuthContext, outboxId: string) {
      return { outbox: toOutboxItem(await loadOwn(auth, outboxId)) };
    },

    /** Batalkan kirim: hanya dari `pending`/`queued` (pembaruan bersyarat — tepat satu menang). */
    async cancel(auth: AuthContext, outboxId: string) {
      const current = await loadOwn(auth, outboxId);
      const result = await db.transaction(async (tx) => {
        const [canceled] = await tx
          .update(mailOutbox)
          .set({ status: 'canceled', canceledAt: now(), holdReason: null })
          .where(
            and(
              eq(mailOutbox.organizationId, auth.organizationId),
              eq(mailOutbox.id, current.id),
              eq(mailOutbox.createdByUserId, auth.user.id),
              inArray(mailOutbox.status, ['pending', 'queued']),
            ),
          )
          .returning();
        if (!canceled) return null;
        if (canceled.draftId) {
          await tx
            .update(mailDrafts)
            .set({ state: 'editing' })
            .where(and(eq(mailDrafts.id, canceled.draftId), eq(mailDrafts.state, 'sending')));
        }
        return canceled;
      });
      if (!result) {
        throw detailError(
          'CONFLICT',
          'not_cancelable',
          MAIL_COMPOSE_MESSAGES.notCancelable,
          'outboxId',
        );
      }
      await refundNewAddressUnits(auth.organizationId, auth.user.id, result.newAddressUnits);
      await publisher.publish([outboxEvent(result)]);
      return { outbox: toOutboxItem(result), draftId: result.draftId };
    },

    /** "Kirim sekarang": lewati masa batal (`pending` saja). */
    async sendNow(auth: AuthContext, outboxId: string) {
      const current = await loadOwn(auth, outboxId);
      const [updated] = await db
        .update(mailOutbox)
        .set({ sendAfter: now() })
        .where(
          and(
            eq(mailOutbox.organizationId, auth.organizationId),
            eq(mailOutbox.id, current.id),
            eq(mailOutbox.status, 'pending'),
          ),
        )
        .returning();
      const row = updated ?? current;
      if (updated) await publisher.publish([outboxEvent(updated)]);
      return { outbox: toOutboxItem(row) };
    },
  };
  return service;
}

export type MailOutboxService = ReturnType<typeof createMailOutboxService>;
