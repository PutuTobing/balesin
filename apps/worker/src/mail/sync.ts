import {
  boundMailBodyStructure,
  classifyMailImapError,
  decodeTextPreview,
  defaultMailImapConnector,
  defaultTrustedAuthServIds,
  hasAttachmentParts,
  mailSnippetOf,
  openMailAccountSecret,
  parseMailHeaderBlock,
  type ImapPolicy,
  type Logger,
  type MailBusEventInput,
  type MailEventPublisher,
  type MailImapConnector,
  type MailImapSession,
  type MailServerMessage,
  type SecretBox,
  withMailSession,
} from '@balesin/core';
import {
  auditLogs,
  departmentMembers,
  mailAccountAccess,
  mailAccounts,
  mailFolders,
  mailIdentities,
  mailMessages,
  organizations,
  users,
  type Database,
  type MailAccountRow,
  type MailFolderRow,
  type NewMailMessageRow,
} from '@balesin/db';
import {
  IMAP_ALLOWED_PORTS,
  MAIL_UNSYNCED_FOLDER_ROLES,
  mailFolderDisplayName,
  mailFolderRoleOf,
  type MailSyncState,
} from '@balesin/shared';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';

/**
 * Sinkron akun Email (KONTRAK-API-EMAIL §11) — satu sambungan kerja per job:
 *  1. Daftar folder (LIST + STATUS) bila basi (30 mnt)/dipaksa → peran RFC 6154 → nama Indonesia;
 *     `\All`/`\Flagged` tidak disinkron.
 *  2. Per folder jatuh tempo (Kotak masuk → Terkirim → Draf → lainnya): `SELECT`;
 *     `UIDVALIDITY` berubah → hapus pesan folder itu + sinkron ulang (`mail.resync`);
 *     `UID SEARCH SINCE <jendela>` dibanding UID lokal → header baru diambil DARI YANG TERBARU per 200;
 *     UID lokal (dalam jendela) yang hilang di server → dihapus; bendera: `CHANGEDSINCE` (CONDSTORE)
 *     atau 500 UID terbaru + sapuan penuh tiap jam.
 *  3. Ketahanan: gagal jaringan/TLS → `error` + backoff 1, 2, 5, 15, 30, 60 menit (maks.); login
 *     ditolak → `auth_failed`, BERHENTI mencoba + notifikasi; kredensial tak terbuka → `auth_failed`
 *     `secret_unavailable`; pemilik akun pribadi nonaktif → `owner_inactive`.
 *  Isi & lampiran TIDAK diambil (saat dibuka, bagian 2). Log: ID + kode + jumlah saja.
 */

export interface MailSyncDeps {
  db: Database;
  logger: Logger;
  secretBox: SecretBox | null;
  publisher: MailEventPublisher;
  imap: {
    /** Port TAMBAHAN (hanya server tiruan tes/E2E). */
    extraPorts?: readonly number[];
    testCa?: string;
    allowLoopback?: boolean;
    lookup?: ImapPolicy['lookup'];
    timeouts?: ImapPolicy['timeouts'];
  };
  connector?: MailImapConnector;
  /** Antre email pemberitahuan (pola `createOwnerNotifier`). */
  notify?: (payload: {
    organizationId: string;
    recipientUserId: string;
    subjectUserId: string;
    event: 'mail_account_auth_failed';
    occurredAt: string;
    auditLogId?: string;
  }) => Promise<void>;
  now?: () => Date;
}

export const MAIL_BACKOFF_MINUTES = [1, 2, 5, 15, 30, 60] as const;
export const MAIL_FOLDER_LIST_STALE_MS = 30 * 60 * 1000;
export const MAIL_FLAG_SWEEP_MS = 60 * 60 * 1000;
export const MAIL_NO_IDLE_INBOX_POLL_MINUTES = 2;
const HEADER_BATCH = 200;
/** Review 9A-1 S3: header baru per job (sisanya job berikutnya, segera). */
export const MAIL_SYNC_HEADER_BUDGET = 2_000;
/** Review 9A-1 S3: baris email per akun. */
export const MAIL_ACCOUNT_MESSAGES_MAX = 500_000;
/** Review 9A-1 S2: tenggat total satu job sinkron (sambungan diputus bila lewat). */
export const MAIL_SYNC_TOTAL_MS = 5 * 60 * 1000;
/** Jeda sebelum job lanjutan bila anggaran header habis. */
const CONTINUE_DELAY_MS = 5_000;
const FLAG_RECENT = 500;
/** Event per job sebelum diganti satu `mail.resync`. */
const EVENT_BUDGET = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const STOPPED_STATES: readonly MailSyncState[] = [
  'paused',
  'auth_failed',
  'owner_inactive',
  'deleting',
];
const AUTH_CODES = new Set(['imap_auth_failed', 'imap_app_password_required', 'imap_not_enabled']);

export type MailSyncResult =
  | { status: 'synced'; folders: number; created: number; deleted: number; updated: number }
  | { status: 'skipped'; reason: 'not_found' | 'stopped' | 'owner_inactive' }
  | { status: 'failed'; code: string };

const ROLE_ORDER: Readonly<Record<string, number>> = { inbox: 0, sent: 1, drafts: 2 };

export function backoffMinutes(failures: number): number {
  return (
    MAIL_BACKOFF_MINUTES[Math.min(Math.max(failures, 1), MAIL_BACKOFF_MINUTES.length) - 1] ?? 60
  );
}

function flagsOf(flags: readonly string[]) {
  const lower = new Set(flags.map((flag) => flag.toLowerCase()));
  return {
    isRead: lower.has('\\seen'),
    isStarred: lower.has('\\flagged'),
    isAnswered: lower.has('\\answered'),
    isDraft: lower.has('\\draft'),
    keywords: flags
      .filter((flag) => !flag.startsWith('\\') && /^[\x21-\x7e]{1,64}$/.test(flag))
      .slice(0, 50),
  };
}

export function createMailSync(deps: MailSyncDeps) {
  const { db, logger, publisher } = deps;
  const now = deps.now ?? (() => new Date());
  const connector = deps.connector ?? defaultMailImapConnector;

  async function policyFor(organizationId: string): Promise<ImapPolicy> {
    const [org] = await db
      .select({ cidrs: organizations.webhookPrivateCidrs })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return {
      allowedPorts: [...IMAP_ALLOWED_PORTS, ...(deps.imap.extraPorts ?? [])],
      lookup: deps.imap.lookup,
      timeouts: deps.imap.timeouts,
      strict: {
        privateCidrs: org?.cidrs ?? [],
        ...(deps.imap.allowLoopback ? { allowLoopback: true } : {}),
      },
      ...(deps.imap.testCa ? { testCa: deps.imap.testCa } : {}),
    };
  }

  function statusEvent(row: MailAccountRow): MailBusEventInput {
    return {
      organizationId: row.organizationId,
      accountId: row.id,
      event: {
        type: 'mail.account.status',
        accountId: row.id,
        syncState: row.syncState as MailSyncState,
        lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
        errorCode: row.lastErrorCode,
        initialProgress:
          row.syncState === 'initial_sync'
            ? { done: row.initialSyncDone, total: row.initialSyncTotal ?? 0 }
            : null,
      },
    };
  }

  async function updateAccount(row: MailAccountRow, changes: Partial<MailAccountRow>) {
    const [saved] = await db
      .update(mailAccounts)
      .set(changes)
      .where(
        and(
          eq(mailAccounts.organizationId, row.organizationId),
          eq(mailAccounts.id, row.id),
          isNull(mailAccounts.deletedAt),
          // Jangan menimpa jeda/putus yang terjadi selama sinkron berjalan.
          notInArray(mailAccounts.syncState, ['paused', 'deleting', 'owner_inactive']),
        ),
      )
      .returning();
    return saved ?? null;
  }

  /** Penerima pemberitahuan password ditolak: pemilik (pribadi) / pemegang Kelola + Owner/Admin. */
  async function authFailedRecipients(row: MailAccountRow): Promise<string[]> {
    if (row.kind === 'personal') return row.ownerUserId ? [row.ownerUserId] : [];
    const managers = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.organizationId, row.organizationId),
          inArray(users.role, ['owner', 'admin']),
          isNull(users.disabledAt),
        ),
      );
    const direct = await db
      .select({ id: mailAccountAccess.userId })
      .from(mailAccountAccess)
      .where(
        and(
          eq(mailAccountAccess.organizationId, row.organizationId),
          eq(mailAccountAccess.accountId, row.id),
          eq(mailAccountAccess.level, 'manage'),
          eq(mailAccountAccess.principalType, 'user'),
        ),
      );
    const viaDepartment = await db
      .select({ id: departmentMembers.userId })
      .from(mailAccountAccess)
      .innerJoin(
        departmentMembers,
        and(
          eq(departmentMembers.organizationId, mailAccountAccess.organizationId),
          eq(departmentMembers.departmentId, mailAccountAccess.departmentId),
        ),
      )
      .where(
        and(
          eq(mailAccountAccess.organizationId, row.organizationId),
          eq(mailAccountAccess.accountId, row.id),
          eq(mailAccountAccess.level, 'manage'),
        ),
      );
    return [
      ...new Set([
        ...managers.map((item) => item.id),
        ...direct.flatMap((item) => (item.id ? [item.id] : [])),
        ...viaDepartment.map((item) => item.id),
      ]),
    ].slice(0, 200);
  }

  async function recordFailure(row: MailAccountRow, code: string, diagnostic: string | null) {
    const at = now();
    const stop = AUTH_CODES.has(code) || code === 'secret_unavailable';
    const failures = row.consecutiveFailures + 1;
    const saved = await updateAccount(row, {
      syncState: stop ? 'auth_failed' : 'error',
      lastErrorCode: code,
      lastErrorAt: at,
      consecutiveFailures: failures,
      idleActive: false,
      // Login ditolak: berhenti mencoba (cegah akun terkunci penyedia).
      nextAttemptAt: stop ? null : new Date(at.getTime() + backoffMinutes(failures) * 60_000),
    });
    logger.warn({ accountId: row.id, code, diagnostic, failures }, 'Sinkron akun email gagal');
    if (!saved) return;
    await publisher.publish([statusEvent(saved)]);
    if (stop && row.syncState !== 'auth_failed') {
      const [audit] = await db
        .insert(auditLogs)
        .values({
          organizationId: row.organizationId,
          actorUserId: null,
          action: 'mail.account.auth_failed',
          targetType: 'mail_account',
          targetId: row.id,
          metadata: { kind: row.kind, address: row.emailAddress, code },
        })
        .returning({ id: auditLogs.id });
      // Review 9A-1 R6: paling banyak satu putaran pemberitahuan per akun per 24 jam ("Sinkron
      // sekarang" berulang tidak membanjiri Owner/Admin).
      const [recent] = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, row.organizationId),
            eq(auditLogs.action, 'mail.account.auth_failed'),
            eq(auditLogs.targetId, row.id),
            sql`${auditLogs.createdAt} > now() - interval '24 hours'`,
            audit ? sql`${auditLogs.id} <> ${audit.id}` : undefined,
          ),
        )
        .limit(1);
      if (deps.notify && !recent) {
        for (const recipientUserId of await authFailedRecipients(row)) {
          await deps
            .notify({
              organizationId: row.organizationId,
              recipientUserId,
              subjectUserId: recipientUserId,
              event: 'mail_account_auth_failed',
              occurredAt: at.toISOString(),
              ...(audit ? { auditLogId: audit.id } : {}),
            })
            .catch((err: unknown) => {
              logger.warn(
                { err, accountId: row.id },
                'Pemberitahuan password akun email gagal diantrekan',
              );
            });
        }
      }
    }
  }

  // ── Folder ────────────────────────────────────────────────────────────────

  async function syncFolderList(
    session: MailImapSession,
    row: MailAccountRow,
  ): Promise<MailFolderRow[]> {
    // Review 9A-1 R4: path/pemisah dari server yang tidak bisa disimpan (NUL, kosong, > 1.000
    // karakter) dilewati SEBELUM peran dibagikan — tidak menggagalkan sinkron seluruh akun.
    const listed = (await session.listFolders()).filter(
      (folder) =>
        folder.path.length > 0 &&
        folder.path.length <= 1000 &&
        !folder.path.includes('\u0000') &&
        !(folder.delimiter ?? '').includes('\u0000'),
    );
    const existing = await db
      .select()
      .from(mailFolders)
      .where(
        and(eq(mailFolders.organizationId, row.organizationId), eq(mailFolders.accountId, row.id)),
      );
    const byPath = new Map(existing.map((folder) => [folder.path, folder]));
    // Peran unik per akun: SPECIAL-USE menang atas tebakan nama, lalu urutan LIST.
    const roles = listed.map((folder) => ({ folder, ...mailFolderRoleOf(folder) }));
    const taken = new Set<string>();
    for (const pass of ['special_use', 'name_guess'] as const) {
      for (const entry of roles) {
        if (entry.source !== pass || !entry.role) continue;
        if (taken.has(entry.role)) {
          entry.role = null;
          entry.source = null;
        } else taken.add(entry.role);
      }
    }
    // Peran berpindah antar folder: lepas dulu peran lama supaya indeks unik tidak bentrok.
    const seenPaths = new Set<string>();
    for (const { folder, role } of roles) {
      seenPaths.add(folder.path);
      const current = byPath.get(folder.path);
      if (current && current.role !== null && current.role !== role) {
        await db
          .update(mailFolders)
          .set({ role: null, roleSource: null })
          .where(eq(mailFolders.id, current.id));
      }
    }
    for (const { folder, role, source } of roles) {
      const depth = folder.delimiter
        ? Math.min(folder.path.split(folder.delimiter).length - 1, 50)
        : 0;
      const values = {
        delimiter: folder.delimiter ? folder.delimiter.slice(0, 1) : null,
        name: mailFolderDisplayName(folder.path, folder.delimiter, role),
        role,
        roleSource: source,
        depth,
        selectable: folder.selectable,
        subscribed: folder.subscribed,
        syncEnabled:
          folder.selectable &&
          !(role && (MAIL_UNSYNCED_FOLDER_ROLES as readonly string[]).includes(role)),
        // LIST tanpa STATUS (review 9A-1 S2): hitungan hanya diganti bila server memberinya.
        ...(folder.status
          ? { totalCount: folder.status.messages, unreadCount: folder.status.unseen }
          : {}),
      };
      const current = byPath.get(folder.path);
      if (current) {
        await db.update(mailFolders).set(values).where(eq(mailFolders.id, current.id));
        if (current.role !== role) {
          await db
            .update(mailMessages)
            .set({ folderRole: role })
            .where(
              and(
                eq(mailMessages.organizationId, row.organizationId),
                eq(mailMessages.folderId, current.id),
              ),
            );
        }
      } else {
        await db
          .insert(mailFolders)
          .values({
            organizationId: row.organizationId,
            accountId: row.id,
            path: folder.path,
            ...values,
          })
          .onConflictDoNothing();
      }
    }
    // Folder yang tidak ada lagi di server → dihapus (pesannya ikut, cascade).
    const gone = existing
      .filter((folder) => !seenPaths.has(folder.path))
      .map((folder) => folder.id);
    if (gone.length > 0) {
      await db
        .delete(mailFolders)
        .where(
          and(eq(mailFolders.organizationId, row.organizationId), inArray(mailFolders.id, gone)),
        );
    }
    // Induk (berdasarkan path).
    const rows = await db
      .select()
      .from(mailFolders)
      .where(
        and(eq(mailFolders.organizationId, row.organizationId), eq(mailFolders.accountId, row.id)),
      );
    const idByPath = new Map(rows.map((folder) => [folder.path, folder.id]));
    for (const folder of rows) {
      const parentPath =
        folder.delimiter && folder.path.includes(folder.delimiter)
          ? folder.path.slice(0, folder.path.lastIndexOf(folder.delimiter))
          : null;
      const parentId = parentPath ? (idByPath.get(parentPath) ?? null) : null;
      if (parentId !== folder.parentId) {
        await db.update(mailFolders).set({ parentId }).where(eq(mailFolders.id, folder.id));
        folder.parentId = parentId;
      }
    }
    return rows;
  }

  // ── Pesan ─────────────────────────────────────────────────────────────────

  async function toMessageRow(
    row: MailAccountRow,
    folder: MailFolderRow,
    uidvalidity: number,
    message: MailServerMessage,
    identities: readonly string[],
  ): Promise<NewMailMessageRow> {
    const header = message.headers
      ? await parseMailHeaderBlock(message.headers, {
          trustedAuthServIds:
            row.trustedAuthServIds ?? defaultTrustedAuthServIds(row.imapHost ?? ''),
          identities,
        })
      : null;
    const flags = flagsOf(message.flags);
    const snippet = message.textPreview
      ? mailSnippetOf(decodeTextPreview(message.textPreview))
      : null;
    const outgoingFolder = folder.role === 'sent' || folder.role === 'drafts';
    const receivedAt = message.internalDate ?? header?.sentAt ?? now();
    return {
      organizationId: row.organizationId,
      accountId: row.id,
      folderId: folder.id,
      folderRole: folder.role,
      uid: message.uid,
      uidvalidity,
      messageIdHeader: header?.messageIdHeader ?? null,
      inReplyTo: header?.inReplyTo ?? null,
      references: header?.references ?? [],
      fromAddress: header?.from?.address ?? null,
      fromName: header?.from?.name ?? null,
      senderAddress: header?.senderAddress ?? null,
      replyTo: header && header.replyTo.length > 0 ? header.replyTo : null,
      to: header?.to ?? [],
      cc: header?.cc ?? [],
      bcc: outgoingFolder && header ? header.bcc : null,
      toCount: header?.toCount ?? 0,
      ccCount: header?.ccCount ?? 0,
      deliveredTo: header?.deliveredTo ?? null,
      subject: header?.subject ?? null,
      snippet,
      sentAt: header?.sentAt ?? null,
      receivedAt,
      ...flags,
      sizeBytes: Math.min(Math.max(message.size, 0), 2_147_483_647),
      hasAttachments: hasAttachmentParts(message.bodyStructure),
      senderVerification: header?.senderVerification ?? 'unverified',
      authDetails: header?.authDetails ?? null,
      warnings: [],
      bodyState: 'none',
      bodystructure: boundMailBodyStructure(message.bodyStructure),
    };
  }

  interface FolderOutcome {
    created: number;
    deleted: number;
    updated: number;
    events: MailBusEventInput[];
    resync: boolean;
    discovered: number;
    /** Masih ada header baru yang belum diambil (anggaran job habis). */
    truncated: boolean;
  }

  async function syncOneFolder(
    session: MailImapSession,
    row: MailAccountRow,
    folder: MailFolderRow,
    identities: readonly string[],
    onProgress: (fetched: number, discovered: number) => Promise<void>,
    budget: { remaining: number },
  ): Promise<FolderOutcome> {
    const outcome: FolderOutcome = {
      created: 0,
      deleted: 0,
      updated: 0,
      events: [],
      resync: false,
      discovered: 0,
      truncated: false,
    };
    const at = now();
    const status = await session.status(folder.path).catch(() => null);
    const selected = await session.select(folder.path);
    const scope = and(
      eq(mailMessages.organizationId, row.organizationId),
      eq(mailMessages.folderId, folder.id),
    );
    let local = folder;
    if (folder.uidvalidity !== null && folder.uidvalidity !== selected.uidValidity) {
      await db.delete(mailMessages).where(scope);
      outcome.resync = true;
      const [reset] = await db
        .update(mailFolders)
        .set({ uidvalidity: null, uidnext: null, highestModseq: null, oldestSyncedAt: null })
        .where(eq(mailFolders.id, folder.id))
        .returning();
      if (reset) local = reset;
    }
    const since =
      row.syncWindowDays === null ? null : new Date(at.getTime() - row.syncWindowDays * DAY_MS);
    const serverUids = await session.searchUids(since);
    const serverSet = new Set(serverUids);
    const localRows = await db
      .select({
        id: mailMessages.id,
        uid: mailMessages.uid,
        isRead: mailMessages.isRead,
        isStarred: mailMessages.isStarred,
        isAnswered: mailMessages.isAnswered,
        isDraft: mailMessages.isDraft,
        receivedAt: mailMessages.receivedAt,
        pendingAction: mailMessages.pendingAction,
      })
      .from(mailMessages)
      .where(and(scope, eq(mailMessages.uidvalidity, selected.uidValidity)));
    const localByUid = new Map(localRows.map((message) => [message.uid, message]));

    // 1. Email baru — dari yang TERBARU, per 200.
    const allFresh = serverUids.filter((uid) => !localByUid.has(uid)).sort((a, b) => b - a);
    outcome.discovered = allFresh.length;
    const fresh = allFresh.slice(0, Math.max(0, budget.remaining));
    outcome.truncated = fresh.length < allFresh.length;
    budget.remaining -= fresh.length;
    for (let index = 0; index < fresh.length; index += HEADER_BATCH) {
      const batch = fresh.slice(index, index + HEADER_BATCH);
      const fetched = await session.fetchHeaders(batch);
      const values: NewMailMessageRow[] = [];
      for (const message of fetched) {
        values.push(await toMessageRow(row, local, selected.uidValidity, message, identities));
      }
      if (values.length > 0) {
        const inserted = await db
          .insert(mailMessages)
          .values(values)
          .onConflictDoNothing({
            target: [mailMessages.folderId, mailMessages.uidvalidity, mailMessages.uid],
          })
          .returning({ id: mailMessages.id, receivedAt: mailMessages.receivedAt });
        outcome.created += inserted.length;
        for (const item of inserted) {
          outcome.events.push({
            organizationId: row.organizationId,
            accountId: row.id,
            event: {
              type: 'mail.message.created',
              accountId: row.id,
              folderId: folder.id,
              messageId: item.id,
              receivedAt: item.receivedAt.toISOString(),
            },
          });
        }
      }
      await onProgress(batch.length, 0);
    }

    // 2. Hilang di server (hanya dalam jendela; pesan dengan aksi tertunda dibiarkan).
    const vanished = localRows.filter(
      (message) =>
        !serverSet.has(message.uid) &&
        message.pendingAction === null &&
        (since === null || message.receivedAt >= since),
    );
    if (vanished.length > 0) {
      const ids = vanished.map((message) => message.id);
      for (let index = 0; index < ids.length; index += 1_000) {
        await db
          .delete(mailMessages)
          .where(and(scope, inArray(mailMessages.id, ids.slice(index, index + 1_000))));
      }
      outcome.deleted += vanished.length;
      for (const message of vanished) {
        outcome.events.push({
          organizationId: row.organizationId,
          accountId: row.id,
          event: {
            type: 'mail.message.deleted',
            accountId: row.id,
            folderId: folder.id,
            messageId: message.id,
          },
        });
      }
    }

    // 3. Bendera.
    const sweep =
      local.lastFullFlagSweepAt === null ||
      at.getTime() - local.lastFullFlagSweepAt.getTime() >= MAIL_FLAG_SWEEP_MS;
    const known = localRows
      .filter((message) => serverSet.has(message.uid))
      .map((message) => message.uid);
    let updates: { uid: number; flags: string[] }[] = [];
    if (known.length > 0) {
      if (session.capabilities.condstore && local.highestModseq && !sweep) {
        updates = await session.fetchFlags('all', local.highestModseq);
      } else {
        const targets = sweep ? known : [...known].sort((a, b) => b - a).slice(0, FLAG_RECENT);
        for (let index = 0; index < targets.length; index += FLAG_RECENT) {
          updates.push(...(await session.fetchFlags(targets.slice(index, index + FLAG_RECENT))));
        }
      }
    }
    for (const update of updates) {
      const current = localByUid.get(update.uid);
      if (!current || current.pendingAction !== null) continue;
      const next = flagsOf(update.flags);
      if (
        next.isRead !== current.isRead ||
        next.isStarred !== current.isStarred ||
        next.isAnswered !== current.isAnswered ||
        next.isDraft !== current.isDraft
      ) {
        await db
          .update(mailMessages)
          .set(next)
          .where(and(scope, eq(mailMessages.id, current.id)));
        outcome.updated += 1;
        outcome.events.push({
          organizationId: row.organizationId,
          accountId: row.id,
          event: {
            type: 'mail.message.updated',
            accountId: row.id,
            messageId: current.id,
            fields: ['flags'],
          },
        });
      }
    }

    // 4. Posisi & hitungan.
    const totalOnServer = status?.messages ?? selected.exists;
    const unread = status?.unseen ?? local.unreadCount;
    await db
      .update(mailFolders)
      .set({
        uidvalidity: selected.uidValidity,
        uidnext: selected.uidNext,
        highestModseq: selected.highestModseq,
        totalCount: totalOnServer,
        unreadCount: unread,
        oldestSyncedAt: since,
        hasOlderOnServer: since !== null && totalOnServer > serverUids.length,
        // Anggaran habis: folder tetap jatuh tempo supaya sisanya diambil job berikutnya.
        ...(outcome.truncated ? {} : { lastSyncedAt: at }),
        ...(sweep ? { lastFullFlagSweepAt: at } : {}),
      })
      .where(eq(mailFolders.id, folder.id));
    outcome.events.push({
      organizationId: row.organizationId,
      accountId: row.id,
      event: {
        type: 'mail.folder.counts',
        accountId: row.id,
        folderId: folder.id,
        unreadCount: Math.max(0, unread),
        totalCount: Math.max(0, totalOnServer),
      },
    });
    return outcome;
  }

  /** Sinkron satu akun (semua folder jatuh tempo) atau satu folder (`folderId`). */
  async function syncAccount(payload: {
    organizationId: string;
    accountId: string;
    force?: boolean;
    folderId?: string;
  }): Promise<MailSyncResult> {
    const [loaded] = await db
      .select()
      .from(mailAccounts)
      .where(
        and(
          eq(mailAccounts.organizationId, payload.organizationId),
          eq(mailAccounts.id, payload.accountId),
        ),
      )
      .limit(1);
    if (!loaded || loaded.deletedAt !== null) return { status: 'skipped', reason: 'not_found' };
    let row = loaded;
    if (STOPPED_STATES.includes(row.syncState as MailSyncState))
      return { status: 'skipped', reason: 'stopped' };
    if (row.kind === 'personal' && row.ownerUserId) {
      const [owner] = await db
        .select({ disabledAt: users.disabledAt })
        .from(users)
        .where(and(eq(users.organizationId, row.organizationId), eq(users.id, row.ownerUserId)))
        .limit(1);
      if (!owner || owner.disabledAt !== null) {
        const saved = await updateAccount(row, {
          syncState: 'owner_inactive',
          idleActive: false,
          nextAttemptAt: null,
        });
        if (saved) await publisher.publish([statusEvent(saved)]);
        return { status: 'skipped', reason: 'owner_inactive' };
      }
    }
    if (!deps.secretBox || !row.imapPasswordEncrypted) {
      await recordFailure(row, 'secret_unavailable', null);
      return { status: 'failed', code: 'secret_unavailable' };
    }
    let password;
    try {
      password = openMailAccountSecret(
        deps.secretBox,
        row,
        'imapPassword',
        row.imapPasswordEncrypted,
      );
    } catch {
      await recordFailure(row, 'secret_unavailable', null);
      return { status: 'failed', code: 'secret_unavailable' };
    }
    if (row.syncState === 'error' || row.syncState === 'ready') {
      const saved = await updateAccount(row, { syncState: 'syncing' });
      if (saved) row = saved;
    }

    const imapConfig = {
      host: row.imapHost ?? '',
      port: row.imapPort ?? 993,
      security: row.imapSecurity === 'starttls' ? ('starttls' as const) : ('ssl' as const),
      username: row.imapUsername ?? '',
      password,
    };
    const policy = await policyFor(row.organizationId);
    const totalMs = deps.imap.timeouts?.totalMs ?? MAIL_SYNC_TOTAL_MS;
    try {
      // Review 9A-1 S2: tenggat TOTAL yang memutus sambungan (server jahat/tarpit).
      return await withMailSession(
        (signal) => connector(imapConfig, policy, { signal }),
        totalMs,
        (session) => syncWithSession(session),
      );
    } catch (error) {
      const failure = classifyMailImapError(error);
      if (failure.code === 'unknown' && !(error as { code?: unknown } | null)?.code) {
        // Bukan galat IMAP (mis. database). Review 9A-1 R6: tanpa `err` mentah (galat Drizzle memuat
        // parameter kueri: subjek, alamat).
        logger.error(
          { accountId: row.id, errorName: error instanceof Error ? error.name : typeof error },
          'Sinkron akun email gagal (internal)',
        );
      }
      await recordFailure(row, failure.code, failure.diagnostic);
      return { status: 'failed', code: failure.code };
    }

    async function syncWithSession(session: MailImapSession): Promise<MailSyncResult> {
      const totals = { folders: 0, created: 0, deleted: 0, updated: 0 };
      const events: MailBusEventInput[] = [];
      let resync = false;
      {
        const at = now();
        const listStale =
          payload.force === true ||
          row.foldersSyncedAt === null ||
          at.getTime() - row.foldersSyncedAt.getTime() >= MAIL_FOLDER_LIST_STALE_MS;
        let folders: MailFolderRow[];
        if (listStale) {
          folders = await syncFolderList(session, row);
          const quota = await session.quota();
          const saved = await updateAccount(row, {
            foldersSyncedAt: at,
            capabilities: session.capabilities,
            quotaUsedBytes: quota?.usedBytes ?? null,
            quotaLimitBytes: quota?.limitBytes ?? null,
          });
          if (saved) row = saved;
        } else {
          folders = await db
            .select()
            .from(mailFolders)
            .where(
              and(
                eq(mailFolders.organizationId, row.organizationId),
                eq(mailFolders.accountId, row.id),
              ),
            );
        }
        const periodicMs = row.periodicSyncMinutes * 60_000;
        const initial = row.syncState === 'initial_sync';
        const due = folders
          .filter((folder) => folder.syncEnabled && folder.selectable)
          .filter((folder) =>
            payload.folderId
              ? folder.id === payload.folderId
              : payload.force === true ||
                initial ||
                folder.lastSyncedAt === null ||
                at.getTime() - folder.lastSyncedAt.getTime() >=
                  (folder.role === 'inbox' && !session.capabilities.idle
                    ? Math.min(periodicMs, MAIL_NO_IDLE_INBOX_POLL_MINUTES * 60_000)
                    : folder.role === 'inbox'
                      ? 0
                      : periodicMs) -
                    5_000,
          )
          .sort(
            (a, b) =>
              (ROLE_ORDER[a.role ?? ''] ?? 9) - (ROLE_ORDER[b.role ?? ''] ?? 9) ||
              a.path.localeCompare(b.path),
          );
        const identityRows = await db
          .select({ address: mailIdentities.address })
          .from(mailIdentities)
          .where(
            and(
              eq(mailIdentities.organizationId, row.organizationId),
              eq(mailIdentities.accountId, row.id),
            ),
          );
        const identities = [row.emailAddress, ...identityRows.map((item) => item.address)];
        let done = row.initialSyncDone;
        let total = row.initialSyncTotal ?? 0;
        const [stored] = await db
          .select({ value: sql<number>`count(*)::int` })
          .from(mailMessages)
          .where(
            and(
              eq(mailMessages.organizationId, row.organizationId),
              eq(mailMessages.accountId, row.id),
            ),
          );
        const quotaReached = Number(stored?.value ?? 0) >= MAIL_ACCOUNT_MESSAGES_MAX;
        const budget = { remaining: quotaReached ? 0 : MAIL_SYNC_HEADER_BUDGET };
        let truncated = false;
        for (const folder of due) {
          const outcome = await syncOneFolder(
            session,
            row,
            folder,
            identities,
            async (fetched) => {
              if (!initial) return;
              done += fetched;
              const saved = await updateAccount(row, {
                initialSyncDone: done,
                initialSyncTotal: Math.max(total, done),
              });
              if (saved) {
                row = saved;
                await publisher.publish([statusEvent(saved)]);
              }
            },
            budget,
          );
          if (initial) total += outcome.discovered;
          truncated ||= outcome.truncated;
          totals.folders += 1;
          totals.created += outcome.created;
          totals.deleted += outcome.deleted;
          totals.updated += outcome.updated;
          events.push(...outcome.events);
          resync ||= outcome.resync;
        }
        // Ringkasan akun dari hitungan folder (server).
        const [sum] = await db
          .select({
            messages: sql<number>`coalesce(sum(${mailFolders.totalCount}) filter (where ${mailFolders.syncEnabled}), 0)::bigint`,
            unread: sql<number>`coalesce(sum(${mailFolders.unreadCount}) filter (where ${mailFolders.syncEnabled} and (${mailFolders.role} is null or ${mailFolders.role} not in ('junk', 'trash'))), 0)::bigint`,
          })
          .from(mailFolders)
          .where(
            and(
              eq(mailFolders.organizationId, row.organizationId),
              eq(mailFolders.accountId, row.id),
            ),
          );
        const finishedAt = now();
        const nextMinutes = session.capabilities.idle
          ? row.periodicSyncMinutes
          : Math.min(row.periodicSyncMinutes, MAIL_NO_IDLE_INBOX_POLL_MINUTES);
        const more = truncated && !quotaReached;
        const saved = await updateAccount(row, {
          syncState: (payload.folderId || more) && initial ? 'initial_sync' : 'ready',
          lastSyncedAt: finishedAt,
          lastErrorCode: quotaReached ? 'mailbox_too_large' : null,
          lastErrorAt: quotaReached ? finishedAt : null,
          consecutiveFailures: 0,
          nextAttemptAt: new Date(
            finishedAt.getTime() + (more ? CONTINUE_DELAY_MS : nextMinutes * 60_000),
          ),
          messageCount: Number(sum?.messages ?? 0),
          unreadCount: Number(sum?.unread ?? 0),
          ...(initial && !payload.folderId
            ? { initialSyncDone: done, initialSyncTotal: Math.max(total, done) }
            : {}),
        });
        if (resync || events.length > EVENT_BUDGET) {
          await publisher.publish([
            {
              organizationId: row.organizationId,
              accountId: row.id,
              event: { type: 'mail.resync', accountId: row.id },
            },
            ...(saved ? [statusEvent(saved)] : []),
          ]);
        } else {
          await publisher.publish([...events, ...(saved ? [statusEvent(saved)] : [])]);
        }
        logger.info({ accountId: row.id, ...totals }, 'Akun email disinkron');
        return { status: 'synced', ...totals };
      }
    }
  }

  return { syncAccount, policyFor, statusEvent };
}

export type MailSync = ReturnType<typeof createMailSync>;

/** Kotak masuk akun (untuk IDLE). */
export async function inboxFolderOf(db: Database, organizationId: string, accountId: string) {
  const [folder] = await db
    .select({ id: mailFolders.id, path: mailFolders.path })
    .from(mailFolders)
    .where(
      and(
        eq(mailFolders.organizationId, organizationId),
        eq(mailFolders.accountId, accountId),
        eq(mailFolders.role, 'inbox'),
      ),
    )
    .limit(1);
  return folder ?? null;
}
