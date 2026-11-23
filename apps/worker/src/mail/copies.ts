import {
  assembleMailBody,
  buildComposedMime,
  buildMailQuote,
  hasMailImapCompose,
  mailIdentityVerificationContext,
  type Logger,
  type MailEventPublisher,
  type MailImapActions,
  type MailImapCompose,
  type MailImapSession,
  type MediaStore,
  type SecretBox,
} from '@balesin/core';
import {
  mailAccounts,
  mailDraftAttachments,
  mailDrafts,
  mailFolders,
  mailIdentities,
  mailMessageBodies,
  mailOutbox,
  mailSignatures,
  newId,
  type Database,
  type MailAccountRow,
  type MailFolderRow,
} from '@balesin/db';
import {
  MAIL_DRAFT_SERVER_COPY_MAX_BYTES,
  MAIL_VERIFICATION_AUTO_CHECK_MINUTES,
} from '@balesin/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';

/**
 * Salinan di server IMAP akun (tahap 9B, KONTRAK-API-EMAIL-TULIS §7, §13) — semua lewat sambungan
 * kerja akun (`withWorkSlot` di antrian `mail`):
 *  - Salinan Terkirim: `none` → `skipped`; `append` → APPEND `.eml` ber-Bcc ke folder `sent` (`\Seen`);
 *    `auto` → cari `Message-ID` di Terkirim dulu (Gmail/M365 menyimpan sendiri) → `server_saved`,
 *    tidak ada → APPEND. 3× coba (1, 10, 60 mnt) lalu `failed` (email TETAP terkirim).
 *  - Draf server: APPEND (`\Draft \Seen`) + hapus UID lama (`\Deleted` + `UID EXPUNGE` bila UIDPLUS;
 *    tanpa UIDPLUS hanya `\Deleted` — TIDAK PERNAH `EXPUNGE` biasa). Diam ≥ 30 dtk, ≤ 1×/2 menit.
 *    Database = kebenaran; > 30 MB tidak disalin.
 *  - Cadangan verifikasi: `UID SEARCH HEADER Message-ID` di Kotak masuk & Spam (maks. 15 menit).
 */

const MINUTE = 60_000;
const SENT_COPY_RETRY_MS = [1, 10, 60].map((minutes) => minutes * MINUTE);
const SENT_COPY_MAX_ATTEMPTS = 3;
export const DRAFT_SYNC_QUIET_MS = 30_000;
export const DRAFT_SYNC_MIN_INTERVAL_MS = 2 * MINUTE;
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

type ComposeSession = MailImapSession & MailImapActions & MailImapCompose;

export interface MailCopiesDeps {
  db: Database;
  logger: Logger;
  secretBox: SecretBox | null;
  publisher: MailEventPublisher;
  store: MediaStore | null;
  openSession(account: MailAccountRow): Promise<MailImapSession & MailImapActions>;
  enqueueFolder?: (payload: {
    organizationId: string;
    accountId: string;
    folderId: string;
  }) => Promise<void>;
  now?: () => Date;
}

export type CopyResult =
  | { status: 'done' | 'skipped' | 'failed' | 'server_saved' | 'verified' | 'not_found' }
  | { status: 'delay'; delayMs: number };

export function createMailCopies(deps: MailCopiesDeps) {
  const { db, logger } = deps;
  const now = deps.now ?? (() => new Date());

  async function loadAccount(organizationId: string, accountId: string) {
    const [row] = await db
      .select()
      .from(mailAccounts)
      .where(and(eq(mailAccounts.organizationId, organizationId), eq(mailAccounts.id, accountId)))
      .limit(1);
    if (!row || row.deletedAt !== null) return null;
    if (['paused', 'auth_failed', 'owner_inactive', 'deleting'].includes(row.syncState))
      return null;
    return row;
  }

  async function withSession<T>(
    account: MailAccountRow,
    run: (session: ComposeSession) => Promise<T>,
  ) {
    const session = await deps.openSession(account);
    try {
      if (!hasMailImapCompose(session)) throw new Error('Sesi IMAP tanpa APPEND');
      return await run(session);
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  /** Folder berperan `role`; tidak ada → dibuat (`Sent`/`Drafts`, gaya namespace folder lain). */
  async function ensureFolder(
    session: ComposeSession,
    account: MailAccountRow,
    role: 'sent' | 'drafts',
  ): Promise<MailFolderRow | null> {
    const folders = await db
      .select()
      .from(mailFolders)
      .where(
        and(
          eq(mailFolders.organizationId, account.organizationId),
          eq(mailFolders.accountId, account.id),
        ),
      );
    const existing = folders.find((folder) => folder.role === role);
    if (existing) {
      if (existing.roleSource === 'created' && existing.uidvalidity === null) {
        await session.createFolder(existing.path);
      }
      return existing;
    }
    const namespaced = folders.find((folder) => /^INBOX[./]/i.test(folder.path));
    const delimiter =
      namespaced?.delimiter ?? folders.find((folder) => folder.delimiter)?.delimiter ?? '.';
    const name = role === 'sent' ? 'Sent' : 'Drafts';
    const path = namespaced ? `INBOX${delimiter}${name}` : name;
    const created = await session.createFolder(path);
    if (!created) return null;
    const [row] = await db
      .insert(mailFolders)
      .values({
        id: newId(),
        organizationId: account.organizationId,
        accountId: account.id,
        path,
        delimiter,
        name: role === 'sent' ? 'Terkirim' : 'Draf',
        role,
        roleSource: 'created',
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  async function readFile(storageKey: string): Promise<Buffer | null> {
    if (!deps.store) return null;
    const parts: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of deps.store.chunks(storageKey)) {
        size += chunk.length;
        if (size > ATTACHMENT_MAX_BYTES * 2) return null;
        parts.push(chunk);
      }
    } catch {
      return null;
    }
    return Buffer.concat(parts);
  }

  // ── Salinan Terkirim ───────────────────────────────────────────────────

  async function appendSent(payload: {
    organizationId: string;
    outboxId: string;
  }): Promise<CopyResult> {
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
    if (!row || row.status !== 'sent' || row.sentCopyState !== 'pending')
      return { status: 'skipped' };
    const settle = async (state: 'done' | 'server_saved' | 'failed') => {
      if (row.rawStorageKey) await deps.store?.remove(row.rawStorageKey).catch(() => undefined);
      await db
        .update(mailOutbox)
        .set({ sentCopyState: state, sentCopyAt: now(), rawStorageKey: null, sentCopyNextAt: null })
        .where(eq(mailOutbox.id, row.id));
    };
    const account = await loadAccount(row.organizationId, row.accountId);
    const raw = row.rawStorageKey ? await readFile(row.rawStorageKey) : null;
    if (!raw) {
      await settle('failed');
      return { status: 'failed' };
    }
    const retry = async () => {
      const attempts = row.sentCopyAttempts + 1;
      if (attempts >= SENT_COPY_MAX_ATTEMPTS) {
        await settle('failed');
        logger.warn(
          { outboxId: row.id, accountId: row.accountId },
          'Salinan email terkirim gagal disimpan',
        );
        return { status: 'failed' as const };
      }
      await db
        .update(mailOutbox)
        .set({
          sentCopyAttempts: attempts,
          sentCopyNextAt: new Date(
            now().getTime() + (SENT_COPY_RETRY_MS[attempts - 1] ?? 60 * MINUTE),
          ),
        })
        .where(eq(mailOutbox.id, row.id));
      return { status: 'skipped' as const };
    };
    if (!account) return retry();
    try {
      const outcome = await withSession(account, async (session) => {
        const folder = await ensureFolder(session, account, 'sent');
        if (!folder) return 'failed' as const;
        if (account.sentCopyMode === 'auto') {
          await session.select(folder.path);
          const since = new Date((row.sentAt ?? now()).getTime() - 24 * 60 * MINUTE);
          const found = await session.searchMessageId(row.messageIdHeader, since);
          if (found.length > 0) return { state: 'server_saved' as const, folder };
        }
        const appended = await session.append(folder.path, raw, ['\\Seen']);
        return appended ? { state: 'done' as const, folder } : ('retry' as const);
      });
      if (outcome === 'failed') {
        await settle('failed');
        return { status: 'failed' };
      }
      if (outcome === 'retry') return retry();
      await settle(outcome.state);
      await deps
        .enqueueFolder?.({
          organizationId: row.organizationId,
          accountId: row.accountId,
          folderId: outcome.folder.id,
        })
        .catch(() => undefined);
      return { status: outcome.state };
    } catch (error) {
      logger.warn({ err: error, outboxId: row.id }, 'Salinan Terkirim: sambungan IMAP gagal');
      return retry();
    }
  }

  // ── Draf server ────────────────────────────────────────────────────────

  async function syncDraft(payload: {
    organizationId: string;
    accountId: string;
    draftId: string;
  }): Promise<CopyResult> {
    const [draft] = await db
      .select()
      .from(mailDrafts)
      .where(
        and(
          eq(mailDrafts.organizationId, payload.organizationId),
          eq(mailDrafts.id, payload.draftId),
        ),
      )
      .limit(1);
    if (!draft || draft.serverSyncState !== 'pending') return { status: 'skipped' };
    const at = now();
    const quiet = draft.updatedAt.getTime() + DRAFT_SYNC_QUIET_MS - at.getTime();
    const interval = draft.serverSyncedAt
      ? draft.serverSyncedAt.getTime() + DRAFT_SYNC_MIN_INTERVAL_MS - at.getTime()
      : 0;
    const wait = Math.max(quiet, interval);
    if (wait > 0) return { status: 'delay', delayMs: wait };
    const account = await loadAccount(draft.organizationId, draft.accountId);
    if (!account) return { status: 'skipped' };
    const [identity] = await db
      .select()
      .from(mailIdentities)
      .where(eq(mailIdentities.id, draft.identityId))
      .limit(1);
    if (!identity) return { status: 'skipped' };
    const attachments = await db
      .select()
      .from(mailDraftAttachments)
      .where(eq(mailDraftAttachments.draftId, draft.id))
      .orderBy(mailDraftAttachments.position);
    let total = 0;
    const inline: { cid: string; filename: string; contentType: string; content: Buffer }[] = [];
    const parts: { filename: string; contentType: string; content: Buffer }[] = [];
    for (const file of attachments) {
      if (file.state !== 'ready' || !file.storageKey) continue;
      const content = await readFile(file.storageKey);
      if (!content) continue;
      total += content.length;
      if (file.inline && file.contentId)
        inline.push({
          cid: file.contentId,
          filename: file.filename,
          contentType: file.contentType,
          content,
        });
      else parts.push({ filename: file.filename, contentType: file.contentType, content });
    }
    // Base64 menambah ±33%.
    if (total * 1.37 > MAIL_DRAFT_SERVER_COPY_MAX_BYTES) {
      await db
        .update(mailDrafts)
        .set({ serverSyncState: 'disabled' })
        .where(eq(mailDrafts.id, draft.id));
      return { status: 'skipped' };
    }
    const logos = await db
      .select({ id: mailSignatures.id })
      .from(mailSignatures)
      .where(
        and(
          eq(mailSignatures.accountId, draft.accountId),
          sql`${mailSignatures.logoPng} is not null`,
        ),
      );
    let quote = null;
    if (draft.includeQuote && draft.sourceMessageId && draft.sourceSnapshot) {
      const [body] = await db
        .select({ html: mailMessageBodies.htmlSanitized, text: mailMessageBodies.text })
        .from(mailMessageBodies)
        .where(eq(mailMessageBodies.messageId, draft.sourceMessageId))
        .limit(1);
      if (body) {
        quote = buildMailQuote({
          mode: draft.mode === 'forward' ? 'forward' : 'reply',
          from: draft.sourceSnapshot.from,
          to: draft.sourceSnapshot.to,
          cc: draft.sourceSnapshot.cc,
          subject: draft.sourceSnapshot.subject,
          sentAt: draft.sourceSnapshot.sentAt ? new Date(draft.sourceSnapshot.sentAt) : null,
          html: body.html,
          text: body.text,
          timeZone: 'Asia/Jakarta',
        });
      }
    }
    const assembled = assembleMailBody({
      format: draft.format as 'html' | 'text',
      bodyHtml: draft.bodyHtml,
      bodyText: draft.bodyText,
      quote,
      allowedCids: new Set([
        ...inline.map((item) => item.cid),
        ...logos.map((logo) => `sig-logo-${logo.id}`),
      ]),
    });
    if (!assembled.ok) {
      await db
        .update(mailDrafts)
        .set({ serverSyncState: 'error', serverErrorCode: assembled.reason })
        .where(eq(mailDrafts.id, draft.id));
      return { status: 'failed' };
    }
    const domain = identity.address.split('@')[1] ?? 'balesin.invalid';
    const messageId = `d.${draft.serverRef}.${String(draft.version)}@${domain}`;
    let mime;
    try {
      mime = await buildComposedMime({
        from: { address: identity.address, name: identity.displayName },
        replyTo: identity.replyTo,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        html: assembled.html,
        text: assembled.text,
        messageId,
        date: at,
        inReplyTo: null,
        references: [],
        inline,
        attachments: parts,
      });
    } catch {
      await db
        .update(mailDrafts)
        .set({ serverSyncState: 'error', serverErrorCode: 'mime_invalid' })
        .where(eq(mailDrafts.id, draft.id));
      return { status: 'failed' };
    }
    try {
      const saved = await withSession(account, async (session) => {
        const folder = await ensureFolder(session, account, 'drafts');
        if (!folder) return null;
        const appended = await session.append(folder.path, mime.withBcc, ['\\Draft', '\\Seen']);
        if (!appended) return null;
        await session.openWritable(folder.path);
        let uid = appended.uid;
        if (uid === null) {
          const found = await session.searchMessageId(messageId, null);
          uid = found.at(-1) ?? null;
        }
        // Salinan lama dihapus (UID-nya saja).
        if (draft.serverFolderId && draft.serverUid) {
          const old = await db
            .select()
            .from(mailFolders)
            .where(eq(mailFolders.id, draft.serverFolderId))
            .limit(1);
          const oldFolder = old[0];
          if (oldFolder && oldFolder.path !== folder.path)
            await session.openWritable(oldFolder.path);
          if (
            oldFolder &&
            (oldFolder.uidvalidity === null ||
              draft.serverUidvalidity === null ||
              oldFolder.uidvalidity === draft.serverUidvalidity ||
              oldFolder.path === folder.path)
          ) {
            await session.storeFlags([draft.serverUid], ['\\Deleted'], []);
            await session.expunge([draft.serverUid]);
          }
        }
        return { folder, uid, uidValidity: appended.uidValidity ?? folder.uidvalidity };
      });
      if (!saved) {
        await db
          .update(mailDrafts)
          .set({ serverSyncState: 'error', serverErrorCode: 'append_failed' })
          .where(eq(mailDrafts.id, draft.id));
        return { status: 'failed' };
      }
      // Draf berubah selama sinkron → tetap `pending` (sinkron berikutnya).
      await db
        .update(mailDrafts)
        .set({
          serverFolderId: saved.folder.id,
          serverUid: saved.uid,
          serverUidvalidity: saved.uidValidity,
          serverMessageId: messageId,
          serverSyncedVersion: draft.version,
          serverSyncedAt: now(),
          serverErrorCode: null,
          serverSyncState: sql`case when ${mailDrafts.version} = ${draft.version} then 'synced' else 'pending' end`,
        })
        .where(eq(mailDrafts.id, draft.id));
      return { status: 'done' };
    } catch (error) {
      logger.warn({ err: error, draftId: draft.id }, 'Salinan draf server: sambungan IMAP gagal');
      await db
        .update(mailDrafts)
        .set({ serverSyncState: 'error', serverErrorCode: 'connection_failed' })
        .where(eq(mailDrafts.id, draft.id));
      return { status: 'failed' };
    }
  }

  async function removeDraftCopy(payload: {
    organizationId: string;
    accountId: string;
    folderId: string;
    uid: number;
    uidValidity: number;
  }): Promise<CopyResult> {
    const account = await loadAccount(payload.organizationId, payload.accountId);
    if (!account) return { status: 'skipped' };
    const [folder] = await db
      .select()
      .from(mailFolders)
      .where(
        and(
          eq(mailFolders.organizationId, payload.organizationId),
          eq(mailFolders.id, payload.folderId),
        ),
      )
      .limit(1);
    if (!folder) return { status: 'skipped' };
    return withSession(account, async (session) => {
      const selected = await session.openWritable(folder.path);
      if (selected.uidValidity !== payload.uidValidity) return { status: 'skipped' as const };
      await session.storeFlags([payload.uid], ['\\Deleted'], []);
      await session.expunge([payload.uid]);
      return { status: 'done' as const };
    });
  }

  // ── Cadangan verifikasi alamat ─────────────────────────────────────────

  async function verifyCheck(payload: {
    organizationId: string;
    accountId: string;
    identityId: string;
  }): Promise<CopyResult> {
    const [identity] = await db
      .select()
      .from(mailIdentities)
      .where(
        and(
          eq(mailIdentities.organizationId, payload.organizationId),
          eq(mailIdentities.id, payload.identityId),
        ),
      )
      .limit(1);
    if (
      !identity ||
      identity.verificationState !== 'pending' ||
      !identity.verificationSecretEncrypted
    ) {
      return { status: 'skipped' };
    }
    const at = now();
    if (!identity.verificationSentAt) return { status: 'delay', delayMs: MINUTE };
    if (
      at.getTime() - identity.verificationSentAt.getTime() >
        MAIL_VERIFICATION_AUTO_CHECK_MINUTES * MINUTE ||
      (identity.verificationExpiresAt && identity.verificationExpiresAt <= at)
    ) {
      return { status: 'skipped' };
    }
    let messageId: string;
    try {
      if (!deps.secretBox) return { status: 'skipped' };
      const secret = JSON.parse(
        deps.secretBox.decrypt(
          identity.verificationSecretEncrypted,
          mailIdentityVerificationContext(identity.organizationId, identity.id),
        ),
      ) as { messageId?: unknown };
      if (typeof secret.messageId !== 'string') return { status: 'skipped' };
      messageId = secret.messageId;
    } catch {
      return { status: 'skipped' };
    }
    const account = await loadAccount(identity.organizationId, identity.accountId);
    if (!account) return { status: 'delay', delayMs: MINUTE };
    const targets = await db
      .select()
      .from(mailFolders)
      .where(
        and(eq(mailFolders.accountId, account.id), inArray(mailFolders.role, ['inbox', 'junk'])),
      );
    const since = new Date(identity.verificationSentAt.getTime() - 24 * 60 * MINUTE);
    const found = await withSession(account, async (session) => {
      for (const folder of targets) {
        await session.select(folder.path);
        const uids = await session.searchMessageId(messageId, since);
        if (uids.length > 0) return true;
      }
      return false;
    }).catch(() => false);
    if (!found) return { status: 'delay', delayMs: MINUTE };
    const verified = await markVerifiedByMailbox(db, identity.organizationId, identity.id, at);
    if (verified) {
      await deps.publisher.publish([
        {
          organizationId: identity.organizationId,
          accountId: identity.accountId,
          event: {
            type: 'mail.identity.updated',
            accountId: identity.accountId,
            identityId: identity.id,
            verificationState: 'verified',
          },
        },
      ]);
    }
    return { status: 'verified' };
  }

  return { appendSent, syncDraft, removeDraftCopy, verifyCheck };
}

/** Identitas `pending` → `verified` (`mailbox`) + audit. `false` bila sudah tidak tertunda. */
export async function markVerifiedByMailbox(
  db: Database,
  organizationId: string,
  identityId: string,
  at: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [saved] = await tx
      .update(mailIdentities)
      .set({
        verificationState: 'verified',
        verifiedAt: at,
        verifiedMethod: 'mailbox',
        verificationSecretEncrypted: null,
        verificationCodeHash: null,
        verificationMessageIdHash: null,
        verificationSentAt: null,
        verificationExpiresAt: null,
        verificationAttempts: 0,
      })
      .where(
        and(
          eq(mailIdentities.organizationId, organizationId),
          eq(mailIdentities.id, identityId),
          eq(mailIdentities.verificationState, 'pending'),
          sql`${mailIdentities.verificationExpiresAt} > ${at}`,
        ),
      )
      .returning();
    if (!saved) return false;
    const [account] = await tx
      .select({ kind: mailAccounts.kind, address: mailAccounts.emailAddress })
      .from(mailAccounts)
      .where(eq(mailAccounts.id, saved.accountId))
      .limit(1);
    await tx.execute(sql`insert into audit_logs (id, organization_id, actor_user_id, action, target_type, target_id, metadata)
      values (${newId()}, ${organizationId}, ${saved.verificationRequestedByUserId}, 'mail.identity.verified', 'mail_account', ${saved.accountId},
      ${JSON.stringify(
        account?.kind === 'shared'
          ? {
              accountId: saved.accountId,
              identityId: saved.id,
              kind: 'shared',
              address: saved.address,
              method: 'mailbox',
            }
          : {
              accountId: saved.accountId,
              identityId: saved.id,
              kind: 'personal',
              method: 'mailbox',
            },
      )}::jsonb)`);
    return true;
  });
}
