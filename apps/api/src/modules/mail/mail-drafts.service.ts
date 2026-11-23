import { randomBytes } from 'node:crypto';

import {
  AppError,
  MAIL_INLINE_CID_PATTERN,
  classifyOutboundEmailAttachment,
  cleanFileName,
  randomBase32,
  renderOutboundEmail,
  sanitizeComposerHtml,
  signatureLogoCid,
  type MailComposeKeys,
  type MailEventPublisher,
  type MediaStore,
  type Redis,
} from '@balesin/core';
import {
  accessibleMailAccountsOf,
  contacts,
  emailTemplateVersions,
  emailTemplates,
  mailAttachments,
  mailCorrespondents,
  mailAccounts,
  mailDraftAttachments,
  mailDrafts,
  mailIdentityApprovalAllows,
  mailIdentityApprovalStateOf,
  mailMessageBodies,
  mailOrganizationDomains,
  mailMessages,
  mailSignatures,
  newId,
  quickReplies,
  users,
  type Database,
  type DbExecutor,
  type MailAddressRow,
  type MailDraftAttachmentRow,
  type MailDraftRow,
  type MailIdentityRow,
  type MailSourceSnapshotRow,
} from '@balesin/db';
import {
  MAIL_BCC_WARNING_THRESHOLD,
  MAIL_COMPOSE_MESSAGES,
  MAIL_DRAFTS_PER_USER_MAX,
  MAIL_DRAFT_ATTACHMENTS_MAX,
  MAIL_DRAFT_ATTACHMENT_FILE_MAX_BYTES,
  MAIL_DRAFT_BODY_HTML_MAX_BYTES,
  MAIL_DRAFT_BODY_TEXT_MAX_BYTES,
  MAIL_DRAFT_INLINE_IMAGE_MAX_BYTES,
  MAIL_DRAFT_UPLOAD_QUOTA_BYTES,
  MAIL_NEW_ADDRESS_DAILY_LIMIT,
  MAIL_PRESENCE_TTL_SECONDS,
  MAIL_SEND_FAILURE_MESSAGES,
  MAIL_SUBJECT_MAX,
  QUICK_REPLY_NAME_FALLBACK,
  canMailSend,
  composeSubjectFor,
  mailDomainOf,
  mailHeaderTextSafe,
  mailLevelAtLeast,
  mailThreadRootOf,
  renderQuickReply,
  replyRecipientsFor,
  type CreateMailDraftRequest,
  type MailCannotSendReason,
  type MailComposeRecipientInput,
  type MailDraft,
  type MailDraftAttachment,
  type MailDraftCheckResponse,
  type MailFolderRole,
  type MailSendFailureReason,
  type MailSnippetRequest,
  type UpdateMailDraftRequest,
} from '@balesin/shared';
import { and, count, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import type { RateLimiter, RateLimitRule } from '../../http/rate-limit';
import type { MailJobEnqueuer } from '../../queues/mail-queue';
import type { AccessDeniedRecorder } from '../auth/access-denied';
import { contactScope } from '../inbox/inbox.repo';
import type { PermissionGrant } from '../auth/permission-grant';
import type { AuthContext } from '../auth/session.service';
import { createComposeAccess, type AccountAccess } from './mail-compose-access';
import {
  composeLimitsOf,
  composeNotFound,
  detailError,
  identitiesOf,
  loadIdentity,
  normalizeAddress,
  threadKeyOf,
} from './mail-compose.repo';
import { isUuid } from './mail.repo';
import type { MailContext } from './mail.service';
import type { MailSignaturesService } from './mail-signatures.service';

/**
 * Draf, lampiran draf, cek sebelum kirim, snippet, saran penerima, presence (KONTRAK-API-EMAIL-TULIS
 * §6–§8, §10–§11). Draf = PRIBADI pembuatnya: orang lain (termasuk Owner) → 404. Hak tulis =
 * `mail.send` + level ≥ `send` di akun draf (dibaca segar). HTML editor lewat profil editor (server
 * penentu), gambar hanya `cid:` lampiran inline draf / logo tanda tangan. Kutipan email asli TIDAK
 * pernah dikirim sebagai HTML ke editor (dirakit server saat kirim).
 */

const DRAFT_NOT_FOUND = 'Draf tidak ditemukan. Mungkin sudah dikirim atau dibuang.';
const ATTACHMENT_NOT_FOUND = 'Lampiran tidak ditemukan.';
const DRAFT_PAGE_SIZE = 50;
/** Draf server disalin setelah draf diam ≥ 30 dtk (worker mengecek ulang & menunda bila perlu). */
export const DRAFT_SYNC_DELAY_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const NEW_ADDRESS_RULE: RateLimitRule = {
  name: 'mail-alamat-baru',
  limit: MAIL_NEW_ADDRESS_DAILY_LIMIT,
  windowSeconds: 24 * 60 * 60,
};
export const PRESENCE_DRAFT_RULE: RateLimitRule = {
  name: 'mail-presence',
  limit: 6,
  windowSeconds: 60,
};

export type DraftField = 'to' | 'cc' | 'bcc';

export interface MergedRecipients {
  to: MailAddressRow[];
  cc: MailAddressRow[];
  bcc: MailAddressRow[];
  total: number;
}

/** Alamat dinormalisasi + digabung tanpa beda huruf (Kepada > Cc > Bcc). Tidak sah → 400. */
export function mergeRecipients(
  fields: Readonly<
    Record<DraftField, readonly MailComposeRecipientInput[] | readonly MailAddressRow[]>
  >,
): MergedRecipients {
  const seen = new Set<string>();
  const result: Record<DraftField, MailAddressRow[]> = { to: [], cc: [], bcc: [] };
  for (const field of ['to', 'cc', 'bcc'] as const) {
    fields[field].forEach((item, index) => {
      const address = normalizeAddress(item.address);
      if (!address) {
        throw detailError(
          'VALIDATION_ERROR',
          'recipient_invalid',
          `Alamat email tidak valid: periksa penulisan di ${field}.${String(index)}.`,
          `${field}.${String(index)}`,
        );
      }
      const name = item.name?.trim() ? item.name.trim() : null;
      if (name && (!mailHeaderTextSafe(name) || /[<>"\\]/.test(name) || name.length > 80)) {
        throw detailError(
          'VALIDATION_ERROR',
          'recipient_invalid',
          'Nama penerima maksimal 80 karakter, tanpa karakter khusus.',
          `${field}.${String(index)}.name`,
        );
      }
      if (seen.has(address)) return;
      seen.add(address);
      result[field].push({ address, name });
    });
  }
  return { ...result, total: result.to.length + result.cc.length + result.bcc.length };
}

/** Subjek satu baris ≤ 200 (header injection: CR/LF, `\p{Cc}`, U+2028/2029, pengubah arah → 400). */
export function assertSubject(subject: string): string {
  const value = subject.trim();
  if (value.length > MAIL_SUBJECT_MAX || !mailHeaderTextSafe(value)) {
    throw detailError(
      'VALIDATION_ERROR',
      'subject_invalid',
      MAIL_COMPOSE_MESSAGES.subjectInvalid,
      'subject',
    );
  }
  return value;
}

export function snapshotOf(message: typeof mailMessages.$inferSelect): MailSourceSnapshotRow {
  return {
    messageIdHeader: message.messageIdHeader,
    inReplyTo: message.inReplyTo,
    references: message.references.slice(-20),
    from: message.fromAddress ? { address: message.fromAddress, name: message.fromName } : null,
    to: message.to.slice(0, 100),
    cc: message.cc.slice(0, 100),
    replyTo: (message.replyTo ?? []).slice(0, 10),
    subject: message.subject,
    sentAt: (message.sentAt ?? message.receivedAt).toISOString(),
    folderRole: message.folderRole,
  };
}

interface DraftDeps {
  db: Database;
  redis: Redis | null;
  redisPrefix: string;
  keys: MailComposeKeys;
  accessDenied: AccessDeniedRecorder;
  publisher: MailEventPublisher;
  limiter: RateLimiter;
  store: MediaStore | null;
  signatures: MailSignaturesService;
  queue?: MailJobEnqueuer;
  now?: () => Date;
}

export function createMailDraftsService(deps: DraftDeps) {
  const { db, keys, publisher, limiter } = deps;
  const now = deps.now ?? (() => new Date());
  const access = createComposeAccess({ db, accessDenied: deps.accessDenied });

  function requireStore(): MediaStore {
    if (!deps.store) {
      throw new AppError('SERVICE_UNAVAILABLE', { message: 'Penyimpanan lampiran belum siap.' });
    }
    return deps.store;
  }

  // ── Pemuatan ──────────────────────────────────────────────────────────

  async function loadDraftRow(
    executor: DbExecutor,
    auth: AuthContext,
    draftId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<MailDraftRow> {
    if (!isUuid(draftId)) throw composeNotFound(DRAFT_NOT_FOUND);
    const query = executor
      .select()
      .from(mailDrafts)
      .where(
        and(
          eq(mailDrafts.organizationId, auth.organizationId),
          eq(mailDrafts.id, draftId),
          // PRIBADI pembuatnya — juga terhadap Owner.
          eq(mailDrafts.ownerUserId, auth.user.id),
        ),
      )
      .limit(1);
    const [row] = options.forUpdate ? await query.for('update') : await query;
    if (!row) throw composeNotFound(DRAFT_NOT_FOUND);
    return row;
  }

  /** Draf milikku + hak `send` di akunnya SAAT INI (dicabut → 403 lewat `forbidByRule`). */
  async function loadDraft(auth: AuthContext, draftId: string, context: MailContext) {
    const draft = await loadDraftRow(db, auth, draftId);
    const account = await access.require(auth, draft.accountId, 'send', context.client, {
      includeDeleted: true,
    });
    return { draft, account };
  }

  async function attachmentsOf(executor: DbExecutor, organizationId: string, draftId: string) {
    return executor
      .select()
      .from(mailDraftAttachments)
      .where(
        and(
          eq(mailDraftAttachments.organizationId, organizationId),
          eq(mailDraftAttachments.draftId, draftId),
        ),
      )
      .orderBy(mailDraftAttachments.position, mailDraftAttachments.createdAt);
  }

  function toAttachment(row: MailDraftAttachmentRow): MailDraftAttachment {
    return {
      id: row.id,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      inline: row.inline,
      contentId: row.contentId,
      state: row.state as MailDraftAttachment['state'],
      source: row.source as MailDraftAttachment['source'],
    };
  }

  /** `cid` yang boleh dirujuk badan draf: gambar inline draf + logo tanda tangan yang boleh dipakai. */
  async function allowedCidsOf(
    executor: DbExecutor,
    auth: AuthContext,
    draft: Pick<MailDraftRow, 'id' | 'accountId'>,
  ): Promise<Set<string>> {
    const [inline, signatures] = await Promise.all([
      executor
        .select({ contentId: mailDraftAttachments.contentId })
        .from(mailDraftAttachments)
        .where(
          and(
            eq(mailDraftAttachments.organizationId, auth.organizationId),
            eq(mailDraftAttachments.draftId, draft.id),
            eq(mailDraftAttachments.inline, true),
          ),
        ),
      executor
        .select({ id: mailSignatures.id })
        .from(mailSignatures)
        .where(
          and(
            eq(mailSignatures.organizationId, auth.organizationId),
            eq(mailSignatures.accountId, draft.accountId),
            sql`${mailSignatures.logoPng} is not null`,
            or(isNull(mailSignatures.ownerUserId), eq(mailSignatures.ownerUserId, auth.user.id)),
          ),
        ),
    ]);
    return new Set([
      ...inline.flatMap((row) => (row.contentId ? [row.contentId] : [])),
      ...signatures.map((row) => signatureLogoCid(row.id)),
    ]);
  }

  // ── Kuota unggah: catatan unggahan yang dihapus (review 9B R5) ──────────

  const uploadLedgerKey = (organizationId: string, userId: string) =>
    `${deps.redisPrefix}:mail:upload-removed:${organizationId}:${userId}`;

  /**
   * Lampiran UNGGAHAN (≤ 24 jam) yang dihapus/dibuang dicatat di sorted set Redis per pengguna (skor =
   * waktu unggah, anggota = `<id>:<byte>`), supaya tetap memakai kuota unggah sampai 24 jam sejak
   * diunggah. Tanpa Redis → tidak dicatat (kuota hanya dari lampiran yang masih ada).
   */
  async function recordRemovedUploads(
    organizationId: string,
    rows: readonly Pick<
      MailDraftAttachmentRow,
      'id' | 'source' | 'sizeBytes' | 'createdAt' | 'createdByUserId'
    >[],
  ): Promise<void> {
    const redis = deps.redis;
    if (!redis) return;
    const cutoff = now().getTime() - DAY_MS;
    const byUser = new Map<string, (string | number)[]>();
    for (const row of rows) {
      if (row.source !== 'upload' || !row.createdByUserId) continue;
      if (row.createdAt.getTime() <= cutoff) continue;
      const list = byUser.get(row.createdByUserId) ?? [];
      list.push(row.createdAt.getTime(), `${row.id}:${String(row.sizeBytes)}`);
      byUser.set(row.createdByUserId, list);
    }
    for (const [userId, members] of byUser) {
      const key = uploadLedgerKey(organizationId, userId);
      try {
        await redis.zadd(key, ...members);
        await redis.zremrangebyscore(key, '-inf', cutoff);
        await redis.expire(key, 25 * 60 * 60);
      } catch {
        // Redis tidak tersedia: kuota dihitung dari lampiran yang masih ada saja.
      }
    }
  }

  async function removedUploadBytes(organizationId: string, userId: string): Promise<number> {
    const redis = deps.redis;
    if (!redis) return 0;
    try {
      const members = await redis.zrangebyscore(
        uploadLedgerKey(organizationId, userId),
        `(${String(now().getTime() - DAY_MS)}`,
        '+inf',
      );
      return members.reduce((sum, member) => {
        const bytes = Number(member.slice(member.lastIndexOf(':') + 1));
        return sum + (Number.isFinite(bytes) && bytes > 0 ? bytes : 0);
      }, 0);
    } catch {
      return 0;
    }
  }

  async function identityOf(executor: DbExecutor, auth: AuthContext, identityId: string) {
    const identity = await loadIdentity(executor, auth.organizationId, identityId);
    if (!identity) throw composeNotFound();
    return identity;
  }

  /** Review 9B S3: identitas akun PRIBADI berdomain organisasi harus disetujui Owner/Admin. */
  async function approvalAllows(
    organizationId: string,
    accountKind: string,
    identity: Pick<MailIdentityRow, 'address' | 'approvalState'> | null,
  ): Promise<boolean> {
    if (!identity || accountKind !== 'personal') return true;
    const domains = await mailOrganizationDomains(db, organizationId);
    return mailIdentityApprovalAllows(mailIdentityApprovalStateOf(identity, accountKind, domains));
  }

  async function cannotSendOf(
    auth: AuthContext,
    account: AccountAccess,
    identity: Pick<MailIdentityRow, 'verificationState' | 'address' | 'approvalState'> | null,
  ): Promise<MailCannotSendReason | null> {
    if (account.row.deletedAt !== null) return 'account_deleting';
    if (account.row.syncState === 'owner_inactive') return 'account_unavailable';
    if (!canMailSend(auth.user.role, account.level)) return 'level_insufficient';
    if (!(await approvalAllows(auth.organizationId, account.row.kind, identity))) {
      return 'identity_not_approved';
    }
    if (!identity || identity.verificationState !== 'verified') return 'identity_unverified';
    return null;
  }

  async function toView(
    auth: AuthContext,
    draft: MailDraftRow,
    account: AccountAccess,
  ): Promise<MailDraft> {
    const [attachments, identity] = await Promise.all([
      attachmentsOf(db, auth.organizationId, draft.id),
      loadIdentity(db, auth.organizationId, draft.identityId),
    ]);
    let hasHtml = false;
    if (draft.sourceMessageId) {
      const [body] = await db
        .select({ html: sql<boolean>`${mailMessageBodies.htmlSanitized} is not null` })
        .from(mailMessageBodies)
        .where(
          and(
            eq(mailMessageBodies.organizationId, auth.organizationId),
            eq(mailMessageBodies.messageId, draft.sourceMessageId),
          ),
        )
        .limit(1);
      hasHtml = body?.html === true;
    }
    const snapshot = draft.sourceSnapshot;
    const reason = await cannotSendOf(auth, account, identity);
    const error = draft.lastSendError;
    return {
      id: draft.id,
      accountId: draft.accountId,
      identityId: draft.identityId,
      mode: draft.mode as MailDraft['mode'],
      sourceMessageId: draft.sourceMessageId,
      threadKey: threadKeyOf(keys, draft.accountId, draft.threadRoot),
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      format: draft.format as MailDraft['format'],
      bodyHtml: draft.bodyHtml,
      bodyText: draft.bodyText,
      includeQuote: draft.includeQuote,
      quote: {
        available: draft.mode !== 'new' && snapshot !== null,
        messageId: draft.sourceMessageId,
        from: snapshot?.from ?? null,
        sentAt: snapshot?.sentAt ?? null,
        hasHtml,
      },
      attachments: attachments.map(toAttachment),
      attachmentTotalBytes: attachments.reduce((sum, row) => sum + row.sizeBytes, 0),
      version: draft.version,
      state: draft.state as MailDraft['state'],
      lastSendError: error
        ? {
            reason: error.reason as MailSendFailureReason,
            message:
              MAIL_SEND_FAILURE_MESSAGES[error.reason as MailSendFailureReason] ?? error.message,
            at: error.at,
          }
        : null,
      serverCopy: {
        state: draft.serverSyncState as MailDraft['serverCopy']['state'],
        syncedAt: draft.serverSyncedAt?.toISOString() ?? null,
      },
      threadSeenAt: draft.threadSeenAt?.toISOString() ?? null,
      canSend: reason === null,
      cannotSendReason: reason,
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString(),
    };
  }

  function publishDraft(
    draft: Pick<
      MailDraftRow,
      'organizationId' | 'accountId' | 'id' | 'version' | 'serverSyncState' | 'ownerUserId'
    >,
  ) {
    return publisher.publish([
      {
        organizationId: draft.organizationId,
        accountId: draft.accountId,
        userIds: [draft.ownerUserId],
        event: {
          type: 'mail.draft.updated',
          accountId: draft.accountId,
          draftId: draft.id,
          version: draft.version,
          serverCopyState: draft.serverSyncState as 'pending' | 'synced' | 'error' | 'disabled',
        },
      },
    ]);
  }

  async function scheduleServerCopy(
    draft: Pick<MailDraftRow, 'organizationId' | 'accountId' | 'id'>,
  ) {
    await deps.queue
      ?.draftSync?.(
        { organizationId: draft.organizationId, accountId: draft.accountId, draftId: draft.id },
        DRAFT_SYNC_DELAY_MS,
      )
      .catch(() => undefined);
  }

  async function bumpVersion(executor: DbExecutor, draft: MailDraftRow): Promise<MailDraftRow> {
    const [saved] = await executor
      .update(mailDrafts)
      .set({ version: sql`${mailDrafts.version} + 1`, serverSyncState: 'pending' })
      .where(eq(mailDrafts.id, draft.id))
      .returning();
    return saved ?? draft;
  }

  // ── Lampiran asli (teruskan / sertakan lampiran asli) ─────────────────

  async function readAll(
    store: MediaStore,
    storageKey: string,
    max: number,
  ): Promise<Buffer | null> {
    const parts: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of store.chunks(storageKey)) {
        size += chunk.length;
        if (size > max) return null;
        parts.push(chunk);
      }
    } catch {
      return null;
    }
    return Buffer.concat(parts);
  }

  /**
   * Salin satu lampiran email asli ke berkas keluar draf (jenis dari isi, daftar izin keluar 9.1).
   * Belum di cache → baris `loading` (+ job ambil lampiran 9A); diselesaikan malas saat draf dibuka /
   * dicek / dikirim (`resolveLoading`).
   */
  async function copyOriginal(row: typeof mailAttachments.$inferSelect): Promise<
    | {
        ok: true;
        storageKey: string;
        filename: string;
        contentType: string;
        size: number;
        sha256: string;
      }
    | { ok: false; reason: 'blocked' | 'type_not_allowed' | 'too_large' }
    | { ok: 'loading' }
  > {
    if (row.risk !== 'ok') return { ok: false, reason: 'blocked' };
    if (row.sizeBytes > MAIL_DRAFT_ATTACHMENT_FILE_MAX_BYTES)
      return { ok: false, reason: 'too_large' };
    if (!row.storageKey) return { ok: 'loading' };
    const store = requireStore();
    const content = await readAll(store, row.storageKey, MAIL_DRAFT_ATTACHMENT_FILE_MAX_BYTES);
    if (!content) return { ok: 'loading' };
    const verdict = classifyOutboundEmailAttachment(
      content,
      cleanFileName(row.filename) ?? 'lampiran',
    );
    if (!verdict.ok) return { ok: false, reason: 'type_not_allowed' };
    const saved = await store.save('email-out', content);
    return {
      ok: true,
      storageKey: saved.storageKey,
      filename: verdict.filename,
      contentType: verdict.mimeType,
      size: saved.sizeBytes,
      sha256: saved.sha256,
    };
  }

  async function resolveLoading(auth: AuthContext, draft: MailDraftRow): Promise<void> {
    const loading = await db
      .select()
      .from(mailDraftAttachments)
      .where(
        and(
          eq(mailDraftAttachments.organizationId, auth.organizationId),
          eq(mailDraftAttachments.draftId, draft.id),
          eq(mailDraftAttachments.state, 'loading'),
        ),
      );
    for (const item of loading) {
      if (!item.sourceAttachmentId) {
        await db
          .update(mailDraftAttachments)
          .set({ state: 'failed', failureCode: 'source_gone' })
          .where(eq(mailDraftAttachments.id, item.id));
        continue;
      }
      const [source] = await db
        .select()
        .from(mailAttachments)
        .where(
          and(
            eq(mailAttachments.organizationId, auth.organizationId),
            eq(mailAttachments.id, item.sourceAttachmentId),
          ),
        )
        .limit(1);
      if (!source) {
        await db
          .update(mailDraftAttachments)
          .set({ state: 'failed', failureCode: 'source_gone' })
          .where(eq(mailDraftAttachments.id, item.id));
        continue;
      }
      const copied = await copyOriginal(source);
      if (copied.ok === 'loading') continue;
      await db
        .update(mailDraftAttachments)
        .set(
          copied.ok
            ? {
                state: 'ready',
                storageKey: copied.storageKey,
                filename: copied.filename,
                contentType: copied.contentType,
                sizeBytes: copied.size,
                sha256: copied.sha256,
                failureCode: null,
              }
            : { state: 'failed', failureCode: copied.reason },
        )
        .where(eq(mailDraftAttachments.id, item.id));
    }
  }

  async function addOriginals(
    executor: DbExecutor,
    auth: AuthContext,
    draft: Pick<MailDraftRow, 'id' | 'accountId'>,
    sources: readonly (typeof mailAttachments.$inferSelect)[],
    limits: { maxBytes: number },
    sourceAccountId: string,
  ) {
    const existing = await attachmentsOf(executor, auth.organizationId, draft.id);
    let count = existing.length;
    let total = existing.reduce((sum, row) => sum + row.sizeBytes, 0);
    const skipped: { filename: string; reason: 'blocked' | 'type_not_allowed' | 'too_large' }[] =
      [];
    const added: MailDraftAttachmentRow[] = [];
    for (const source of sources) {
      const filename = cleanFileName(source.filename) ?? 'lampiran';
      if (count >= MAIL_DRAFT_ATTACHMENTS_MAX || total + source.sizeBytes > limits.maxBytes) {
        skipped.push({ filename, reason: 'too_large' });
        continue;
      }
      const copied = await copyOriginal(source);
      if (copied.ok === false) {
        skipped.push({ filename, reason: copied.reason });
        continue;
      }
      const [row] = await executor
        .insert(mailDraftAttachments)
        .values({
          organizationId: auth.organizationId,
          draftId: draft.id,
          position: count,
          filename: copied.ok === true ? copied.filename : filename.slice(0, 255),
          contentType:
            copied.ok === true
              ? copied.contentType
              : (source.detectedType ?? source.declaredType ?? 'application/octet-stream').slice(
                  0,
                  128,
                ),
          sizeBytes: copied.ok === true ? copied.size : source.sizeBytes,
          sha256: copied.ok === true ? copied.sha256 : null,
          storageKey: copied.ok === true ? copied.storageKey : null,
          source: 'original',
          sourceAttachmentId: source.id,
          state: copied.ok === true ? 'ready' : 'loading',
          createdByUserId: auth.user.id,
        })
        .returning();
      if (!row) continue;
      added.push(row);
      count += 1;
      total += row.sizeBytes;
      if (copied.ok === 'loading') {
        await deps.queue
          ?.fetchAttachment?.({
            organizationId: auth.organizationId,
            accountId: sourceAccountId,
            attachmentId: source.id,
          })
          .catch(() => undefined);
      }
    }
    return { added, skipped };
  }

  // ── Penerima & utas ───────────────────────────────────────────────────

  async function threadNewMessages(
    auth: AuthContext,
    draft: Pick<MailDraftRow, 'accountId' | 'threadRoot' | 'threadSeenAt'>,
    since: Date | null,
  ) {
    if (!draft.threadRoot) return { count: 0, latestReceivedAt: null, messageIds: [] as string[] };
    const own = await identitiesOf(db, auth.organizationId, [draft.accountId]);
    const cutoff = since ?? draft.threadSeenAt ?? new Date(0);
    const rows = await db
      .select({ id: mailMessages.id, receivedAt: mailMessages.receivedAt })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.organizationId, auth.organizationId),
          eq(mailMessages.accountId, draft.accountId),
          eq(mailMessages.threadRoot, draft.threadRoot),
          gt(mailMessages.receivedAt, cutoff),
          sql`(${mailMessages.folderRole} is null or ${mailMessages.folderRole} not in ('sent', 'drafts', 'trash'))`,
          own.length > 0
            ? sql`(${mailMessages.fromAddress} is null or ${mailMessages.fromAddress} not in ${own.map((row) => row.address)})`
            : undefined,
        ),
      )
      .orderBy(desc(mailMessages.receivedAt))
      .limit(50);
    return {
      count: rows.length,
      latestReceivedAt: rows[0]?.receivedAt.toISOString() ?? null,
      messageIds: rows.slice(0, 5).map((row) => row.id),
    };
  }

  /** Alamat yang BELUM pernah berkorespondensi dengan akun ini (jatah "alamat baru"). */
  async function unknownAddresses(
    organizationId: string,
    accountId: string,
    addresses: readonly string[],
  ): Promise<Set<string>> {
    if (addresses.length === 0) return new Set();
    const known = await db
      .select({ address: mailCorrespondents.address })
      .from(mailCorrespondents)
      .where(
        and(
          eq(mailCorrespondents.organizationId, organizationId),
          eq(mailCorrespondents.accountId, accountId),
          inArray(mailCorrespondents.address, [...addresses]),
        ),
      );
    const knownSet = new Set(known.map((row) => row.address));
    return new Set(addresses.filter((address) => !knownSet.has(address)));
  }

  // ── Presence ─────────────────────────────────────────────────────────

  const presenceKey = (accountId: string, threadKey: string) =>
    `${deps.redisPrefix}:mail:presence:${accountId}:${threadKey}`;

  async function presenceUsers(accountId: string, threadKey: string) {
    if (!deps.redis) return [];
    const raw = await deps.redis.hgetall(presenceKey(accountId, threadKey)).catch(() => ({}));
    const at = now().getTime();
    const ids = Object.entries(raw as Record<string, string>)
      .filter(([, expiry]) => Number(expiry) > at)
      .map(([id]) => id)
      .filter((id) => isUuid(id))
      .slice(0, 20);
    if (ids.length === 0) return [];
    return db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  }

  async function publishPresence(organizationId: string, accountId: string, threadKey: string) {
    const list = await presenceUsers(accountId, threadKey);
    await publisher.publish([
      {
        organizationId,
        accountId,
        event: {
          type: 'mail.compose.presence',
          accountId,
          threadKey,
          users: list.map((user) => ({ id: user.id, name: user.name.slice(0, 100) })),
        },
      },
    ]);
  }

  async function clearPresence(draft: MailDraftRow, userId: string) {
    if (!deps.redis || !draft.threadRoot) return;
    const threadKey = keys.threadKey(draft.accountId, draft.threadRoot);
    const removed = await deps.redis
      .hdel(presenceKey(draft.accountId, threadKey), userId)
      .catch(() => 0);
    if (removed > 0) await publishPresence(draft.organizationId, draft.accountId, threadKey);
  }

  // ── Layanan ──────────────────────────────────────────────────────────

  const service = {
    /** Rekan yang sedang membalas utas (detail email 9A, §11); diri sendiri tidak ikut. */
    async composing(accountId: string, threadKey: string, excludeUserId: string) {
      const list = await presenceUsers(accountId, threadKey);
      return list.filter((user) => user.id !== excludeUserId);
    },
    /** `server_message_id` salinan draf milik pengguna → ID draf. */
    async myDraftIds(organizationId: string, userId: string, headers: readonly string[]) {
      const rows = await db
        .select({ id: mailDrafts.id, header: mailDrafts.serverMessageId })
        .from(mailDrafts)
        .where(
          and(
            eq(mailDrafts.organizationId, organizationId),
            eq(mailDrafts.ownerUserId, userId),
            inArray(mailDrafts.serverMessageId, [...new Set(headers)].slice(0, 200)),
          ),
        );
      return new Map(rows.flatMap((row) => (row.header ? [[row.header, row.id] as const] : [])));
    },
    loadDraftRow,
    attachmentsOf,
    allowedCidsOf,
    threadNewMessages,
    unknownAddresses,
    resolveLoading,
    clearPresence,
    publishDraft,
    toView,

    async create(auth: AuthContext, input: CreateMailDraftRequest, context: MailContext) {
      let source: typeof mailMessages.$inferSelect | null = null;
      let sourceAccess: AccountAccess | null = null;
      if (input.mode !== 'new') {
        if (!input.sourceMessageId) {
          throw detailError(
            'VALIDATION_ERROR',
            'source_required',
            'Pilih email yang mau dibalas atau diteruskan.',
            'sourceMessageId',
          );
        }
        const [message] = await db
          .select()
          .from(mailMessages)
          .where(
            and(
              eq(mailMessages.organizationId, auth.organizationId),
              eq(mailMessages.id, input.sourceMessageId),
            ),
          )
          .limit(1);
        if (!message) throw composeNotFound('Email tidak ditemukan. Mungkin sudah dihapus.');
        // Hak `read` di akun email asal (akun pribadi orang lain → 404).
        sourceAccess = await access.require(auth, message.accountId, 'read', context.client);
        source = message;
      }

      // Identitas & akun draf.
      let identity: MailIdentityRow | null = null;
      if (input.identityId) {
        identity = await identityOf(db, auth, input.identityId);
      } else if (source && input.mode !== 'forward') {
        identity = null; // dipilih di bawah dari akun asal
      } else if (source && sourceAccess && canMailSend(auth.user.role, sourceAccess.level)) {
        identity = null;
      } else {
        const levels = await accessibleMailAccountsOf(db, auth.organizationId, auth.user.id);
        const sendable = [...levels.entries()]
          .filter(([, level]) => canMailSend(auth.user.role, level))
          .map(([id]) => id);
        const candidates = (await identitiesOf(db, auth.organizationId, sendable)).filter(
          (row) => row.isPrimary || row.verificationState === 'verified',
        );
        if (candidates.length !== 1 || !candidates[0]) {
          throw detailError(
            'VALIDATION_ERROR',
            'identity_required',
            'Pilih alamat pengirim (Dari) dulu.',
            'identityId',
          );
        }
        identity = candidates[0];
      }
      const accountId =
        identity?.accountId ??
        source?.accountId ??
        (() => {
          throw detailError(
            'VALIDATION_ERROR',
            'identity_required',
            'Pilih alamat pengirim (Dari) dulu.',
            'identityId',
          );
        })();
      // Balas hanya dari akun yang SAMA (§6.1, keputusan #20).
      if (source && input.mode !== 'forward' && accountId !== source.accountId) {
        throw detailError(
          'VALIDATION_ERROR',
          'identity_not_in_account',
          MAIL_COMPOSE_MESSAGES.identityNotInAccount,
          'identityId',
        );
      }
      const account = await access.require(auth, accountId, 'send', context.client);
      const own = await identitiesOf(db, auth.organizationId, [account.row.id]);
      if (!identity && source) {
        // Identitas bawaan balasan: Delivered-To → muncul di To/Cc asli → utama.
        const verified = own.filter((row) => row.verificationState === 'verified');
        const inSource = new Set(
          [...source.to, ...source.cc].map((item) => item.address.toLowerCase()),
        );
        identity =
          verified.find((row) => row.address === source?.deliveredTo?.toLowerCase()) ??
          verified.find((row) => inSource.has(row.address)) ??
          own.find((row) => row.isPrimary) ??
          null;
      }
      if (!identity || identity.accountId !== account.row.id) {
        throw detailError(
          'VALIDATION_ERROR',
          'identity_not_in_account',
          MAIL_COMPOSE_MESSAGES.identityNotInAccount,
          'identityId',
        );
      }

      const snapshot = source ? snapshotOf(source) : null;
      const replied = snapshot
        ? replyRecipientsFor(
            input.mode,
            {
              ...snapshot,
              folderRole: snapshot.folderRole as MailFolderRole | null,
            },
            own.map((row) => row.address),
          )
        : { to: [], cc: [] };
      const recipients = mergeRecipients({
        to: input.mode === 'new' ? (input.to ?? []) : replied.to,
        cc: input.mode === 'new' ? (input.cc ?? []) : replied.cc,
        bcc: input.mode === 'new' ? (input.bcc ?? []) : [],
      });
      const subject =
        input.mode === 'new'
          ? assertSubject(input.subject ?? '')
          : composeSubjectFor(input.mode, snapshot?.subject ?? null);
      const preferences = await deps.signatures.preferences(auth);
      const signature = deps.signatures.renderSignature(
        await deps.signatures.effectiveSignature(
          db,
          auth,
          identity,
          input.mode === 'reply' || input.mode === 'reply_all' ? 'reply' : 'new',
        ),
        {
          agentName: auth.user.name,
          senderAddress: identity.address,
          organizationName: auth.organization.name,
        },
      );
      let bodyHtml: string | null = null;
      let bodyText: string | null = null;
      if (preferences.composeFormat === 'text') {
        bodyText = signature.text ? `\n\n${signature.text}` : '';
      } else {
        const initial = input.mode === 'new' && input.bodyHtml ? input.bodyHtml : '';
        if (Buffer.byteLength(initial, 'utf8') > MAIL_DRAFT_BODY_HTML_MAX_BYTES) {
          throw detailError(
            'VALIDATION_ERROR',
            'body_too_large',
            MAIL_COMPOSE_MESSAGES.bodyTooLarge,
            'bodyHtml',
          );
        }
        const clean = sanitizeComposerHtml(initial, { allowedCids: new Set() });
        if (clean.tooComplex) {
          throw detailError(
            'VALIDATION_ERROR',
            'html_too_complex',
            'Isi email terlalu rumit.',
            'bodyHtml',
          );
        }
        bodyHtml = `${clean.html || '<p><br></p>'}${signature.html}`;
      }
      const threadRoot = source ? (source.threadRoot ?? mailThreadRootOf(source)) : null;
      const limits = await composeLimitsOf(db, auth.organizationId);
      const draftId = newId();
      const result = await db.transaction(async (tx) => {
        // Batas 100 draf per pengguna (semua akun), di bawah kunci per pengguna.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`mail-drafts|${auth.organizationId}|${auth.user.id}`}, 0))`,
        );
        const [total] = await tx
          .select({ value: count() })
          .from(mailDrafts)
          .where(
            and(
              eq(mailDrafts.organizationId, auth.organizationId),
              eq(mailDrafts.ownerUserId, auth.user.id),
            ),
          );
        if ((total?.value ?? 0) >= MAIL_DRAFTS_PER_USER_MAX) {
          throw detailError('CONFLICT', 'draft_limit', MAIL_COMPOSE_MESSAGES.draftLimit, 'mode');
        }
        const [inserted] = await tx
          .insert(mailDrafts)
          .values({
            id: draftId,
            organizationId: auth.organizationId,
            accountId: account.row.id,
            identityId: identity.id,
            ownerUserId: auth.user.id,
            mode: input.mode,
            sourceMessageId: source?.id ?? null,
            sourceSnapshot: snapshot,
            threadRoot,
            threadSeenAt: now(),
            to: recipients.to,
            cc: recipients.cc,
            bcc: recipients.bcc,
            subject,
            format: preferences.composeFormat,
            bodyHtml,
            bodyText,
            includeQuote: input.mode !== 'new',
            serverRef: randomBase32(),
          })
          .returning();
        if (!inserted) throw new Error('Draf tidak tersimpan');
        let skipped: { filename: string; reason: 'blocked' | 'type_not_allowed' | 'too_large' }[] =
          [];
        if (input.mode === 'forward' && source) {
          const originals = await tx
            .select()
            .from(mailAttachments)
            .where(
              and(
                eq(mailAttachments.organizationId, auth.organizationId),
                eq(mailAttachments.messageId, source.id),
                eq(mailAttachments.isInline, false),
              ),
            )
            .limit(MAIL_DRAFT_ATTACHMENTS_MAX * 2);
          skipped = (
            await addOriginals(
              tx,
              auth,
              inserted,
              originals,
              { maxBytes: limits.maxAttachmentBytes },
              source.accountId,
            )
          ).skipped;
        }
        return { draft: inserted, skipped };
      });
      await scheduleServerCopy(result.draft);
      return {
        draft: await toView(auth, result.draft, account),
        skippedAttachments: result.skipped,
      };
    },

    async get(auth: AuthContext, draftId: string, context: MailContext) {
      const { draft, account } = await loadDraft(auth, draftId, context);
      await resolveLoading(auth, draft);
      return { draft: await toView(auth, draft, account) };
    },

    async list(auth: AuthContext, query: { accountId?: string; cursor?: string }) {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const rows = await db
        .select()
        .from(mailDrafts)
        .where(
          and(
            eq(mailDrafts.organizationId, auth.organizationId),
            eq(mailDrafts.ownerUserId, auth.user.id),
            query.accountId ? eq(mailDrafts.accountId, query.accountId) : undefined,
            cursor
              ? or(
                  lt(mailDrafts.updatedAt, cursor.updatedAt),
                  and(eq(mailDrafts.updatedAt, cursor.updatedAt), lt(mailDrafts.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(mailDrafts.updatedAt), desc(mailDrafts.id))
        .limit(DRAFT_PAGE_SIZE + 1);
      const page = rows.slice(0, DRAFT_PAGE_SIZE);
      const levels = await accessibleMailAccountsOf(db, auth.organizationId, auth.user.id);
      const identities = await identitiesOf(db, auth.organizationId, [
        ...new Set(page.map((row) => row.accountId)),
      ]);
      const attachmentCounts = page.length
        ? await db
            .select({ draftId: mailDraftAttachments.draftId, value: count() })
            .from(mailDraftAttachments)
            .where(
              and(
                eq(mailDraftAttachments.organizationId, auth.organizationId),
                inArray(
                  mailDraftAttachments.draftId,
                  page.map((row) => row.id),
                ),
              ),
            )
            .groupBy(mailDraftAttachments.draftId)
        : [];
      const withAttachments = new Set(attachmentCounts.map((row) => row.draftId));
      const last = page.at(-1);
      // Review 9B S3: persetujuan identitas akun pribadi berdomain organisasi.
      const personal = page.length
        ? new Set(
            (
              await db
                .select({ id: mailAccounts.id })
                .from(mailAccounts)
                .where(
                  and(
                    eq(mailAccounts.organizationId, auth.organizationId),
                    eq(mailAccounts.kind, 'personal'),
                    inArray(mailAccounts.id, [...new Set(page.map((row) => row.accountId))]),
                  ),
                )
            ).map((row) => row.id),
          )
        : new Set<string>();
      const domains =
        personal.size > 0
          ? await mailOrganizationDomains(db, auth.organizationId)
          : new Set<string>();
      return {
        drafts: page.map((row) => {
          const identity = identities.find((item) => item.id === row.identityId);
          const level = levels.get(row.accountId) ?? null;
          const approved =
            !identity ||
            mailIdentityApprovalAllows(
              mailIdentityApprovalStateOf(
                identity,
                personal.has(row.accountId) ? 'personal' : 'shared',
                domains,
              ),
            );
          const canSend =
            canMailSend(auth.user.role, level) &&
            approved &&
            identity?.verificationState === 'verified';
          const error = row.lastSendError;
          return {
            id: row.id,
            accountId: row.accountId,
            identityId: row.identityId,
            mode: row.mode as MailDraft['mode'],
            subject: row.subject,
            toPreview: row.to.slice(0, 3).map((item) => item.name ?? item.address),
            updatedAt: row.updatedAt.toISOString(),
            state: row.state as MailDraft['state'],
            hasAttachments: withAttachments.has(row.id),
            canSend,
            lastSendError: error
              ? {
                  reason: error.reason as MailSendFailureReason,
                  message:
                    MAIL_SEND_FAILURE_MESSAGES[error.reason as MailSendFailureReason] ??
                    error.message,
                  at: error.at,
                }
              : null,
          };
        }),
        nextCursor:
          rows.length > DRAFT_PAGE_SIZE && last ? encodeCursor(last.updatedAt, last.id) : null,
      };
    },

    async update(
      auth: AuthContext,
      draftId: string,
      input: UpdateMailDraftRequest,
      context: MailContext,
    ) {
      const { draft: current, account } = await loadDraft(auth, draftId, context);
      // Validasi isi SEBELUM transaksi (pesan galat jelas, tanpa memegang kunci).
      const recipients =
        input.to !== undefined || input.cc !== undefined || input.bcc !== undefined
          ? mergeRecipients({
              to: input.to ?? current.to,
              cc: input.cc ?? current.cc,
              bcc: input.bcc ?? current.bcc,
            })
          : null;
      const subject = input.subject !== undefined ? assertSubject(input.subject) : undefined;
      if (input.identityId !== undefined && input.identityId !== current.identityId) {
        const identity = await identityOf(db, auth, input.identityId);
        if (identity.accountId !== current.accountId) {
          throw detailError(
            'VALIDATION_ERROR',
            'identity_not_in_account',
            MAIL_COMPOSE_MESSAGES.identityNotInAccount,
            'identityId',
          );
        }
      }
      let bodyHtml: string | null | undefined;
      let sanitized = false;
      if (input.bodyHtml !== undefined && input.bodyHtml !== null) {
        if (Buffer.byteLength(input.bodyHtml, 'utf8') > MAIL_DRAFT_BODY_HTML_MAX_BYTES) {
          throw detailError(
            'VALIDATION_ERROR',
            'body_too_large',
            MAIL_COMPOSE_MESSAGES.bodyTooLarge,
            'bodyHtml',
          );
        }
        const clean = sanitizeComposerHtml(input.bodyHtml, {
          allowedCids: await allowedCidsOf(db, auth, current),
        });
        if (clean.tooComplex) {
          throw detailError(
            'VALIDATION_ERROR',
            'html_too_complex',
            'Isi email terlalu rumit (terlalu banyak tag atau sarang terlalu dalam).',
            'bodyHtml',
          );
        }
        bodyHtml = clean.html;
        sanitized = clean.changed;
      } else if (input.bodyHtml === null) {
        bodyHtml = null;
      }
      if (
        input.bodyText !== undefined &&
        input.bodyText !== null &&
        Buffer.byteLength(input.bodyText, 'utf8') > MAIL_DRAFT_BODY_TEXT_MAX_BYTES
      ) {
        throw detailError(
          'VALIDATION_ERROR',
          'body_too_large',
          'Isi email terlalu panjang (maks. 128 KB).',
          'bodyText',
        );
      }
      const saved = await db.transaction(async (tx) => {
        const draft = await loadDraftRow(tx, auth, draftId, { forUpdate: true });
        if (!input.force && input.baseVersion !== draft.version) {
          throw detailError(
            'CONFLICT',
            'draft_version_conflict',
            MAIL_COMPOSE_MESSAGES.draftVersionConflict,
            'baseVersion',
            { currentVersion: draft.version, updatedAt: draft.updatedAt.toISOString() },
          );
        }
        if (draft.state === 'sending') {
          throw detailError(
            'CONFLICT',
            'draft_locked',
            MAIL_COMPOSE_MESSAGES.draftLocked,
            'draftId',
          );
        }
        const [row] = await tx
          .update(mailDrafts)
          .set({
            ...(input.identityId !== undefined ? { identityId: input.identityId } : {}),
            ...(recipients ? { to: recipients.to, cc: recipients.cc, bcc: recipients.bcc } : {}),
            ...(subject !== undefined ? { subject } : {}),
            ...(input.format !== undefined ? { format: input.format } : {}),
            ...(bodyHtml !== undefined ? { bodyHtml } : {}),
            ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
            ...(input.includeQuote !== undefined && draft.mode !== 'forward' && draft.mode !== 'new'
              ? { includeQuote: input.includeQuote }
              : {}),
            version: sql`${mailDrafts.version} + 1`,
            serverSyncState: draft.serverSyncState === 'disabled' ? 'disabled' : 'pending',
          })
          .where(eq(mailDrafts.id, draft.id))
          .returning();
        if (!row) throw composeNotFound(DRAFT_NOT_FOUND);
        return row;
      });
      await publishDraft(saved);
      await scheduleServerCopy(saved);
      void account;
      return {
        draft: {
          id: saved.id,
          version: saved.version,
          updatedAt: saved.updatedAt.toISOString(),
          serverCopy: {
            state: saved.serverSyncState as MailDraft['serverCopy']['state'],
            syncedAt: saved.serverSyncedAt?.toISOString() ?? null,
          },
        },
        ...(sanitized && bodyHtml !== undefined && bodyHtml !== null
          ? { sanitized: true, bodyHtml }
          : {}),
      };
    },

    async remove(auth: AuthContext, draftId: string) {
      // Membuang draf milik sendiri tidak butuh hak kirim (hak bisa sudah dicabut).
      const draft = await loadDraftRow(db, auth, draftId);
      if (draft.state === 'sending') {
        throw detailError('CONFLICT', 'draft_locked', MAIL_COMPOSE_MESSAGES.draftLocked, 'draftId');
      }
      const files = await attachmentsOf(db, auth.organizationId, draft.id);
      const deleted = await db
        .delete(mailDrafts)
        .where(
          and(
            eq(mailDrafts.organizationId, auth.organizationId),
            eq(mailDrafts.id, draft.id),
            eq(mailDrafts.ownerUserId, auth.user.id),
            eq(mailDrafts.state, 'editing'),
          ),
        )
        .returning({ id: mailDrafts.id });
      if (deleted.length === 0) {
        throw detailError('CONFLICT', 'draft_locked', MAIL_COMPOSE_MESSAGES.draftLocked, 'draftId');
      }
      await recordRemovedUploads(auth.organizationId, files);
      for (const file of files) {
        if (file.storageKey) await deps.store?.remove(file.storageKey).catch(() => undefined);
      }
      if (draft.serverFolderId && draft.serverUid && draft.serverUidvalidity !== null) {
        await deps.queue
          ?.draftRemoteDelete?.({
            organizationId: auth.organizationId,
            accountId: draft.accountId,
            folderId: draft.serverFolderId,
            uid: draft.serverUid,
            uidValidity: draft.serverUidvalidity,
          })
          .catch(() => undefined);
      }
      await clearPresence(draft, auth.user.id);
      await publisher.publish([
        {
          organizationId: auth.organizationId,
          accountId: draft.accountId,
          userIds: [auth.user.id],
          event: { type: 'mail.draft.deleted', accountId: draft.accountId, draftId: draft.id },
        },
      ]);
      return { deleted: true as const };
    },

    async check(
      auth: AuthContext,
      draftId: string,
      context: MailContext,
      contactsGrant: PermissionGrant | null,
    ): Promise<MailDraftCheckResponse> {
      const { draft, account } = await loadDraft(auth, draftId, context);
      await resolveLoading(auth, draft);
      const limits = await composeLimitsOf(db, auth.organizationId);
      const own = await identitiesOf(db, auth.organizationId, [draft.accountId]);
      const ownSet = new Set(own.map((row) => row.address));
      const identity = own.find((row) => row.id === draft.identityId) ?? null;
      const entries: { field: 'to' | 'cc' | 'bcc'; address: string; valid: boolean }[] = [];
      const seen = new Set<string>();
      for (const field of ['to', 'cc', 'bcc'] as const) {
        for (const item of draft[field]) {
          const address = normalizeAddress(item.address);
          const key = address ?? item.address.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          entries.push({ field, address: key, valid: address !== null });
        }
      }
      const validAddresses = entries.filter((item) => item.valid).map((item) => item.address);
      const unknown = await unknownAddresses(auth.organizationId, draft.accountId, validAddresses);
      // Domain internal: domain semua identitas akun Email + Channel Email organisasi.
      const internal = new Set<string>();
      if (account.row.warnExternalRecipients) {
        const domains = await db.execute<{ domain: string }>(
          sql`select distinct lower(split_part(i.address, '@', 2)) as domain from mail_identities i join mail_accounts a on a.organization_id = i.organization_id and a.id = i.account_id where i.organization_id = ${auth.organizationId} and a.deleted_at is null
              union select distinct lower(split_part(c.email_address, '@', 2)) from channels c where c.organization_id = ${auth.organizationId} and c.type = 'email' and c.deleted_at is null and c.email_address is not null`,
        );
        for (const row of domains.rows) internal.add(row.domain);
      }
      const contactIds = new Map<string, string>();
      if (contactsGrant && validAddresses.length > 0) {
        const found = await db
          .select({ id: contacts.id, email: contacts.email, external: contacts.externalUserId })
          .from(contacts)
          .where(
            and(
              eq(contacts.organizationId, auth.organizationId),
              or(
                inArray(sql`lower(${contacts.email})`, validAddresses),
                and(
                  eq(contacts.channelType, 'email'),
                  inArray(contacts.externalUserId, validAddresses),
                ),
              ),
              contactScope(contactsGrant),
            ),
          )
          .limit(200);
        for (const row of found) {
          const key = (row.email ?? row.external ?? '').toLowerCase();
          if (key && !contactIds.has(key)) contactIds.set(key, row.id);
        }
      }
      const quota = await limiter.peek(NEW_ADDRESS_RULE, `${auth.organizationId}:${auth.user.id}`);
      const attachments = await attachmentsOf(db, auth.organizationId, draft.id);
      const snapshot = draft.sourceSnapshot;
      const replyTo = snapshot?.replyTo[0]?.address ?? null;
      const replyToDiffers =
        draft.mode !== 'new' &&
        replyTo &&
        snapshot?.from &&
        mailDomainOf(replyTo) !== mailDomainOf(snapshot.from.address)
          ? replyTo
          : null;
      const thread = await threadNewMessages(auth, draft, null);
      const reason = await cannotSendOf(auth, account, identity);
      return {
        checks: {
          totalRecipients: entries.length,
          maxRecipients: limits.maxRecipients,
          bccCount: entries.filter((item) => item.field === 'bcc').length,
          bccWarning:
            entries.filter((item) => item.field === 'bcc').length > MAIL_BCC_WARNING_THRESHOLD,
          recipients: entries.map((item) => ({
            field: item.field,
            address: item.address,
            valid: item.valid,
            known: item.valid && !unknown.has(item.address),
            external:
              account.row.warnExternalRecipients &&
              item.valid &&
              !internal.has(mailDomainOf(item.address)),
            ownIdentity: ownSet.has(item.address),
            contactId: contactIds.get(item.address) ?? null,
          })),
          newAddressCount: unknown.size,
          newAddressQuota: {
            limit: NEW_ADDRESS_RULE.limit,
            remaining: Math.max(0, NEW_ADDRESS_RULE.limit - quota.count),
          },
          replyToDiffers,
          identity: {
            verified: identity?.verificationState === 'verified',
            reason,
          },
          attachments: {
            totalBytes: attachments.reduce((sum, row) => sum + row.sizeBytes, 0),
            maxBytes: limits.maxAttachmentBytes,
            notReady: attachments.filter((row) => row.state !== 'ready').length,
          },
          threadNewMessages: { count: thread.count, latestReceivedAt: thread.latestReceivedAt },
        },
      };
    },

    // ── Lampiran ─────────────────────────────────────────────────────────

    async upload(
      auth: AuthContext,
      draftId: string,
      file: { stream: AsyncIterable<Buffer>; filename: string | null; truncated: () => boolean },
      inline: boolean,
      context: MailContext,
    ) {
      const { draft } = await loadDraft(auth, draftId, context);
      if (draft.state === 'sending') {
        throw detailError('CONFLICT', 'draft_locked', MAIL_COMPOSE_MESSAGES.draftLocked, 'draftId');
      }
      const limits = await composeLimitsOf(db, auth.organizationId);
      const existing = await attachmentsOf(db, auth.organizationId, draft.id);
      if (existing.length >= MAIL_DRAFT_ATTACHMENTS_MAX) {
        throw detailError(
          'VALIDATION_ERROR',
          'attachments_too_many',
          MAIL_COMPOSE_MESSAGES.attachmentsTooMany,
          'file',
        );
      }
      const used = existing.reduce((sum, row) => sum + row.sizeBytes, 0);
      const room = Math.min(MAIL_DRAFT_ATTACHMENT_FILE_MAX_BYTES, limits.maxAttachmentBytes - used);
      // Kuota unggah 500 MB / 24 jam / pengguna: lampiran unggahan yang masih ada + yang sudah dihapus.
      const [quota] = await db
        .select({ total: sql<number>`coalesce(sum(${mailDraftAttachments.sizeBytes}), 0)::bigint` })
        .from(mailDraftAttachments)
        .where(
          and(
            eq(mailDraftAttachments.organizationId, auth.organizationId),
            eq(mailDraftAttachments.createdByUserId, auth.user.id),
            eq(mailDraftAttachments.source, 'upload'),
            gt(mailDraftAttachments.createdAt, new Date(now().getTime() - DAY_MS)),
          ),
        );
      // Review 9B R5: unggahan 24 jam yang SUDAH dihapus tetap dihitung (unggah-lalu-hapus tidak
      // membebaskan kuota).
      const uploadedToday =
        Number(quota?.total ?? 0) + (await removedUploadBytes(auth.organizationId, auth.user.id));
      if (uploadedToday >= MAIL_DRAFT_UPLOAD_QUOTA_BYTES) {
        throw detailError(
          'RATE_LIMITED',
          'upload_quota',
          MAIL_COMPOSE_MESSAGES.uploadQuota,
          'file',
          {},
          {
            retryAfterSeconds: 3_600,
          },
        );
      }
      const parts: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      for await (const chunk of file.stream) {
        size += chunk.length;
        if (size > room || size > MAIL_DRAFT_UPLOAD_QUOTA_BYTES - uploadedToday) {
          tooLarge = true;
          continue; // kuras aliran tanpa menampung
        }
        parts.push(chunk);
      }
      if (tooLarge || file.truncated()) {
        if (size > MAIL_DRAFT_UPLOAD_QUOTA_BYTES - uploadedToday && size <= room) {
          throw detailError(
            'RATE_LIMITED',
            'upload_quota',
            MAIL_COMPOSE_MESSAGES.uploadQuota,
            'file',
            {},
            {
              retryAfterSeconds: 3_600,
            },
          );
        }
        throw new AppError('PAYLOAD_TOO_LARGE', {
          message: MAIL_COMPOSE_MESSAGES.attachmentTooLarge(limits.maxAttachmentMb),
          details: [
            {
              location: 'body',
              field: 'file',
              message: MAIL_COMPOSE_MESSAGES.attachmentTooLarge(limits.maxAttachmentMb),
              reason: 'attachment_too_large',
            },
          ],
        });
      }
      const content = Buffer.concat(parts);
      const filename = cleanFileName(file.filename) ?? 'lampiran';
      const verdict = classifyOutboundEmailAttachment(content, filename);
      if (!verdict.ok) {
        throw detailError(
          'VALIDATION_ERROR',
          'attachment_type_blocked',
          verdict.reason === 'empty'
            ? 'Berkas kosong.'
            : MAIL_COMPOSE_MESSAGES.attachmentTypeBlocked,
          'file',
        );
      }
      if (inline && (!verdict.rasterImage || content.length > MAIL_DRAFT_INLINE_IMAGE_MAX_BYTES)) {
        throw detailError(
          'VALIDATION_ERROR',
          'attachment_type_blocked',
          'Gambar di isi email harus PNG, JPG, GIF, atau WebP, maksimal 5 MB.',
          'file',
        );
      }
      const stored = await requireStore().save('email-out', content);
      try {
        const result = await db.transaction(async (tx) => {
          const locked = await loadDraftRow(tx, auth, draft.id, { forUpdate: true });
          if (locked.state === 'sending') {
            throw detailError(
              'CONFLICT',
              'draft_locked',
              MAIL_COMPOSE_MESSAGES.draftLocked,
              'draftId',
            );
          }
          const current = await attachmentsOf(tx, auth.organizationId, locked.id);
          const total = current.reduce((sum, row) => sum + row.sizeBytes, 0) + stored.sizeBytes;
          if (current.length >= MAIL_DRAFT_ATTACHMENTS_MAX) {
            throw detailError(
              'VALIDATION_ERROR',
              'attachments_too_many',
              MAIL_COMPOSE_MESSAGES.attachmentsTooMany,
              'file',
            );
          }
          if (total > limits.maxAttachmentBytes) {
            throw detailError(
              'VALIDATION_ERROR',
              'attachment_too_large',
              MAIL_COMPOSE_MESSAGES.attachmentTooLarge(limits.maxAttachmentMb),
              'file',
            );
          }
          const [row] = await tx
            .insert(mailDraftAttachments)
            .values({
              organizationId: auth.organizationId,
              draftId: locked.id,
              position: current.length,
              filename: verdict.filename.slice(0, 255),
              contentType: verdict.mimeType,
              sizeBytes: stored.sizeBytes,
              sha256: stored.sha256,
              storageKey: stored.storageKey,
              source: 'upload',
              state: 'ready',
              inline,
              contentId: inline ? `img-${randomBytes(4).toString('hex')}` : null,
              createdByUserId: auth.user.id,
            })
            .returning();
          if (!row) throw new Error('Lampiran tidak tersimpan');
          const saved = await bumpVersion(tx, locked);
          return { row, saved };
        });
        await publishDraft(result.saved);
        await scheduleServerCopy(result.saved);
        return { attachment: toAttachment(result.row), draft: { version: result.saved.version } };
      } catch (error) {
        await deps.store?.remove(stored.storageKey).catch(() => undefined);
        throw error;
      }
    },

    async attachFromMessage(
      auth: AuthContext,
      draftId: string,
      attachmentIds: readonly string[],
      context: MailContext,
    ) {
      const { draft } = await loadDraft(auth, draftId, context);
      if (draft.state === 'sending') {
        throw detailError('CONFLICT', 'draft_locked', MAIL_COMPOSE_MESSAGES.draftLocked, 'draftId');
      }
      const rows = await db
        .select({ attachment: mailAttachments, accountId: mailMessages.accountId })
        .from(mailAttachments)
        .innerJoin(
          mailMessages,
          and(
            eq(mailMessages.organizationId, mailAttachments.organizationId),
            eq(mailMessages.id, mailAttachments.messageId),
          ),
        )
        .where(
          and(
            eq(mailAttachments.organizationId, auth.organizationId),
            inArray(mailAttachments.id, [...new Set(attachmentIds)]),
          ),
        );
      if (rows.length !== new Set(attachmentIds).size) throw composeNotFound(ATTACHMENT_NOT_FOUND);
      // Hak `read` di SETIAP akun email asal (akun pribadi orang lain → 404).
      for (const accountId of new Set(rows.map((row) => row.accountId))) {
        await access.require(auth, accountId, 'read', context.client);
      }
      const limits = await composeLimitsOf(db, auth.organizationId);
      const result = await db.transaction(async (tx) => {
        const locked = await loadDraftRow(tx, auth, draft.id, { forUpdate: true });
        if (locked.state === 'sending') {
          throw detailError(
            'CONFLICT',
            'draft_locked',
            MAIL_COMPOSE_MESSAGES.draftLocked,
            'draftId',
          );
        }
        const added = await addOriginals(
          tx,
          auth,
          locked,
          rows.map((row) => row.attachment),
          { maxBytes: limits.maxAttachmentBytes },
          rows[0]?.accountId ?? locked.accountId,
        );
        const saved = await bumpVersion(tx, locked);
        return { ...added, saved };
      });
      await publishDraft(result.saved);
      await scheduleServerCopy(result.saved);
      return {
        attachments: result.added.map(toAttachment),
        skippedAttachments: result.skipped,
        draft: { version: result.saved.version },
      };
    },

    async attachmentFile(auth: AuthContext, draftId: string, attachmentId: string) {
      // Pemilik draf (lampiran milikku sendiri tetap bisa diunduh walau hak kirim dicabut).
      const draft = await loadDraftRow(db, auth, draftId);
      if (!isUuid(attachmentId)) throw composeNotFound(ATTACHMENT_NOT_FOUND);
      const [row] = await db
        .select()
        .from(mailDraftAttachments)
        .where(
          and(
            eq(mailDraftAttachments.organizationId, auth.organizationId),
            eq(mailDraftAttachments.draftId, draft.id),
            eq(mailDraftAttachments.id, attachmentId),
          ),
        )
        .limit(1);
      if (!row || row.state !== 'ready' || !row.storageKey)
        throw composeNotFound(ATTACHMENT_NOT_FOUND);
      const opened = await requireStore().open(row.storageKey);
      if (!opened) throw composeNotFound(ATTACHMENT_NOT_FOUND);
      return { row, ...opened };
    },

    async removeAttachment(
      auth: AuthContext,
      draftId: string,
      attachmentId: string,
      context: MailContext,
    ) {
      const { draft } = await loadDraft(auth, draftId, context);
      if (!isUuid(attachmentId)) throw composeNotFound(ATTACHMENT_NOT_FOUND);
      const result = await db.transaction(async (tx) => {
        const locked = await loadDraftRow(tx, auth, draft.id, { forUpdate: true });
        if (locked.state === 'sending') {
          throw detailError(
            'CONFLICT',
            'draft_locked',
            MAIL_COMPOSE_MESSAGES.draftLocked,
            'draftId',
          );
        }
        const [removed] = await tx
          .delete(mailDraftAttachments)
          .where(
            and(
              eq(mailDraftAttachments.organizationId, auth.organizationId),
              eq(mailDraftAttachments.draftId, locked.id),
              eq(mailDraftAttachments.id, attachmentId),
            ),
          )
          .returning();
        if (!removed) throw composeNotFound(ATTACHMENT_NOT_FOUND);
        const saved = await bumpVersion(tx, locked);
        return { removed, saved };
      });
      await recordRemovedUploads(auth.organizationId, [result.removed]);
      if (result.removed.storageKey) {
        await deps.store?.remove(result.removed.storageKey).catch(() => undefined);
      }
      await publishDraft(result.saved);
      await scheduleServerCopy(result.saved);
      return { deleted: true as const, draft: { version: result.saved.version } };
    },

    // ── Snippet & saran penerima (§10) ────────────────────────────────────

    async snippets(auth: AuthContext, q: string | undefined) {
      const pattern = q ? `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
      const replies = await db
        .select({ id: quickReplies.id, shortcut: quickReplies.shortcut, title: quickReplies.title })
        .from(quickReplies)
        .where(
          and(
            eq(quickReplies.organizationId, auth.organizationId),
            pattern
              ? or(ilike(quickReplies.shortcut, pattern), ilike(quickReplies.title, pattern))
              : undefined,
          ),
        )
        .orderBy(desc(quickReplies.usageCount), quickReplies.shortcut)
        .limit(20);
      const templates = await db
        .select({
          id: emailTemplates.id,
          slug: emailTemplates.slug,
          name: emailTemplates.name,
          variables: emailTemplateVersions.variables,
        })
        .from(emailTemplates)
        .innerJoin(
          emailTemplateVersions,
          and(
            eq(emailTemplateVersions.organizationId, emailTemplates.organizationId),
            eq(emailTemplateVersions.templateId, emailTemplates.id),
            eq(emailTemplateVersions.version, emailTemplates.publishedVersion),
          ),
        )
        .where(
          and(
            eq(emailTemplates.organizationId, auth.organizationId),
            isNull(emailTemplates.archivedAt),
            sql`${emailTemplates.publishedVersion} is not null`,
            pattern
              ? or(ilike(emailTemplates.name, pattern), ilike(emailTemplates.slug, pattern))
              : undefined,
          ),
        )
        .orderBy(emailTemplates.name)
        .limit(20);
      return {
        quickReplies: replies,
        emailTemplates: templates.map((row) => ({
          id: row.id,
          slug: row.slug,
          name: row.name,
          variables: row.variables
            .filter((item) => item.name !== 'qris')
            .map((item) => ({ name: item.name, label: item.label, required: item.required })),
        })),
      };
    },

    async snippet(
      auth: AuthContext,
      draftId: string,
      input: MailSnippetRequest,
      context: MailContext,
      contactsGrant: PermissionGrant | null,
    ) {
      const { draft } = await loadDraft(auth, draftId, context);
      const first = draft.to[0] ?? null;
      let contact: { name: string | null; attributes: { key: string; value: string }[] } | null =
        null;
      if (first && contactsGrant) {
        const [row] = await db
          .select({
            name: contacts.name,
            profileName: contacts.profileName,
            attributes: contacts.attributes,
          })
          .from(contacts)
          .where(
            and(
              eq(contacts.organizationId, auth.organizationId),
              or(
                sql`lower(${contacts.email}) = ${first.address}`,
                and(eq(contacts.channelType, 'email'), eq(contacts.externalUserId, first.address)),
              ),
              contactScope(contactsGrant),
            ),
          )
          .limit(1);
        if (row) contact = { name: row.name ?? row.profileName, attributes: row.attributes };
      }
      if (input.kind === 'quick_reply') {
        const [reply] = await db
          .select()
          .from(quickReplies)
          .where(
            and(
              eq(quickReplies.organizationId, auth.organizationId),
              eq(quickReplies.id, input.id),
            ),
          )
          .limit(1);
        if (!reply) throw composeNotFound('Balasan cepat tidak ditemukan.');
        const text = renderQuickReply(reply.body, {
          nama: contact?.name ?? first?.name ?? QUICK_REPLY_NAME_FALLBACK,
          agen: auth.user.name,
        });
        await db
          .update(quickReplies)
          .set({ usageCount: sql`${quickReplies.usageCount} + 1`, lastUsedAt: now() })
          .where(eq(quickReplies.id, reply.id));
        const html = text
          .split('\n')
          .map((line) =>
            line.replace(/[&<>"']/g, (char) =>
              char === '&'
                ? '&amp;'
                : char === '<'
                  ? '&lt;'
                  : char === '>'
                    ? '&gt;'
                    : char === '"'
                      ? '&quot;'
                      : '&#39;',
            ),
          )
          .join('<br>');
        return { html, text, subject: null, missingVariables: [] };
      }
      const [template] = await db
        .select({
          id: emailTemplates.id,
          subject: emailTemplateVersions.subject,
          html: emailTemplateVersions.html,
          text: emailTemplateVersions.text,
          variables: emailTemplateVersions.variables,
        })
        .from(emailTemplates)
        .innerJoin(
          emailTemplateVersions,
          and(
            eq(emailTemplateVersions.organizationId, emailTemplates.organizationId),
            eq(emailTemplateVersions.templateId, emailTemplates.id),
            eq(emailTemplateVersions.version, emailTemplates.publishedVersion),
          ),
        )
        .where(
          and(
            eq(emailTemplates.organizationId, auth.organizationId),
            eq(emailTemplates.id, input.id),
            isNull(emailTemplates.archivedAt),
          ),
        )
        .limit(1);
      if (!template)
        throw composeNotFound('Template email tidak ditemukan atau belum diterbitkan.');
      const values: Record<string, string> = {};
      for (const attribute of contact?.attributes ?? []) values[attribute.key] = attribute.value;
      if (contact?.name) values.nama = contact.name;
      for (const [key, value] of Object.entries(input.variables ?? {})) values[key] = value;
      values.qris = '';
      const missing = template.variables
        .filter(
          (item) => item.name !== 'qris' && item.required && !(values[item.name] ?? '').trim(),
        )
        .map((item) => ({ name: item.name, label: item.label, required: item.required }));
      if (missing.length > 0)
        return { html: '', text: '', subject: null, missingVariables: missing };
      const rendered = renderOutboundEmail({
        subject: template.subject,
        html: template.html,
        text: template.text,
        values,
        organizationName: auth.organization.name,
        qrisImageSrc: null,
        layout: 'none',
        brand: { primaryColor: '#2563eb', logoSrc: null, footerText: null },
      });
      if (!rendered.ok) {
        const first = rendered.errors[0];
        throw detailError(
          'VALIDATION_ERROR',
          first?.reason ?? 'content_too_large',
          first?.message ?? 'Template tidak bisa diisi.',
          'variables',
        );
      }
      const clean = sanitizeComposerHtml(rendered.html ?? '', { allowedCids: new Set() });
      // Statistik `last_used_at` diperbarui saat email terkirim (template terakhir di draf).
      await db
        .update(mailDrafts)
        .set({ templateId: template.id })
        .where(eq(mailDrafts.id, draft.id));
      return {
        html: clean.tooComplex ? '' : clean.html,
        text: rendered.text,
        subject: rendered.subject,
        missingVariables: [],
      };
    },

    async suggest(
      auth: AuthContext,
      query: { q: string; accountId?: string },
      contactsGrant: PermissionGrant | null,
    ) {
      const q = query.q.trim().toLowerCase();
      const pattern = `${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      const anywhere = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      const results: {
        address: string;
        name: string | null;
        source: 'contact' | 'history';
        contactId: string | null;
      }[] = [];
      const seen = new Set<string>();
      if (contactsGrant) {
        const rows = await db
          .select({
            id: contacts.id,
            name: contacts.name,
            profileName: contacts.profileName,
            email: contacts.email,
            external: contacts.externalUserId,
            channelType: contacts.channelType,
          })
          .from(contacts)
          .where(
            and(
              eq(contacts.organizationId, auth.organizationId),
              or(
                ilike(contacts.email, pattern),
                and(eq(contacts.channelType, 'email'), ilike(contacts.externalUserId, pattern)),
                and(sql`${contacts.email} is not null`, ilike(contacts.name, anywhere)),
              ),
              contactScope(contactsGrant),
            ),
          )
          .limit(10);
        for (const row of rows) {
          const address = normalizeAddress(
            row.email ?? (row.channelType === 'email' ? (row.external ?? '') : ''),
          );
          if (!address || seen.has(address)) continue;
          seen.add(address);
          results.push({
            address,
            name: row.name ?? row.profileName,
            source: 'contact',
            contactId: row.id,
          });
        }
      }
      // Korespondensi akun yang bisa kubaca (akun pribadi: hanya pemiliknya — lewat hak akses).
      const levels = await accessibleMailAccountsOf(db, auth.organizationId, auth.user.id);
      const readable = [...levels.entries()]
        .filter(([, level]) => mailLevelAtLeast(level, 'read'))
        .map(([id]) => id)
        .filter((id) => !query.accountId || id === query.accountId);
      if (readable.length > 0 && results.length < 10) {
        const rows = await db
          .select({ address: mailCorrespondents.address, name: mailCorrespondents.name })
          .from(mailCorrespondents)
          .where(
            and(
              eq(mailCorrespondents.organizationId, auth.organizationId),
              inArray(mailCorrespondents.accountId, readable),
              or(
                sql`${mailCorrespondents.address} like ${pattern}`,
                ilike(mailCorrespondents.name, anywhere),
              ),
            ),
          )
          .orderBy(desc(mailCorrespondents.lastSeenAt))
          .limit(20);
        for (const row of rows) {
          if (seen.has(row.address) || results.length >= 10) continue;
          seen.add(row.address);
          results.push({
            address: row.address,
            name: row.name,
            source: 'history',
            contactId: null,
          });
        }
      }
      return { suggestions: results.slice(0, 10) };
    },

    // ── Presence (§11) ─────────────────────────────────────────────────────

    async presence(auth: AuthContext, draftId: string, active: boolean, context: MailContext) {
      const { draft, account } = await loadDraft(auth, draftId, context);
      if (!draft.threadRoot) return { threadKey: null, users: [] };
      const threadKey = keys.threadKey(draft.accountId, draft.threadRoot);
      // Akun pribadi: tidak berguna & tidak dibuat.
      if (account.row.kind === 'personal' || !deps.redis) return { threadKey, users: [] };
      const key = presenceKey(draft.accountId, threadKey);
      if (!active) {
        await clearPresence(draft, auth.user.id);
        return { threadKey, users: [] };
      }
      const state = await limiter.consume(PRESENCE_DRAFT_RULE, draft.id);
      if (!state.allowed) {
        throw new AppError('RATE_LIMITED', {
          message: 'Terlalu sering memperbarui penanda. Coba lagi sebentar.',
          retryAfterSeconds: state.retryAfterSeconds,
        });
      }
      const expiry = now().getTime() + MAIL_PRESENCE_TTL_SECONDS * 1000;
      const added = await deps.redis
        .multi()
        .hset(key, auth.user.id, String(expiry))
        .pexpire(key, MAIL_PRESENCE_TTL_SECONDS * 1000 * 2)
        .exec()
        .then((replies) => Number(replies?.[0]?.[1] ?? 0))
        .catch(() => 0);
      if (added > 0) await publishPresence(auth.organizationId, draft.accountId, threadKey);
      const list = await presenceUsers(draft.accountId, threadKey);
      return { threadKey, users: list.filter((user) => user.id !== auth.user.id) };
    },
  };
  return service;
}

export type MailDraftsService = ReturnType<typeof createMailDraftsService>;

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(value: string): { updatedAt: Date; id: string } | null {
  try {
    const [at, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
    const updatedAt = new Date(at ?? '');
    if (Number.isNaN(updatedAt.getTime()) || !id || !isUuid(id)) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

/** Ditandai `MAIL_INLINE_CID_PATTERN` dipakai web untuk membedakan cid lampiran dari logo. */
export { MAIL_INLINE_CID_PATTERN };
