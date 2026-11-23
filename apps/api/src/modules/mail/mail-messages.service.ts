import { createHash } from 'node:crypto';

import {
  AppError,
  fetchRemoteFile,
  MAIL_BLANK_IMAGE,
  renderMailViewDocument,
  sniffRasterImage,
  type MailBusEventInput,
  type MailEventPublisher,
  type MediaStore,
  type RemoteFileRequest,
  type RemoteFileResult,
} from '@balesin/core';
import {
  accessibleMailAccountsOf,
  auditLogs,
  mailAccessUsersOf,
  mailAccounts,
  mailAttachments,
  mailCacheRoom,
  mailCacheUsage,
  mailFolders,
  mailGrantsOf,
  mailMessageBodies,
  mailMessages,
  mailRemoteImageAllow,
  mailRemoteImageCache,
  userSessions,
  type Database,
  type DbExecutor,
  type MailAccountRow,
  type MailFolderRow,
  type MailMessageRow,
} from '@balesin/db';
import {
  API_ROUTES,
  AUDIT_ACTIONS,
  MAIL_ACTION_MIN_LEVEL,
  MAIL_ATTACHMENT_BLOCKED_MESSAGE,
  MAIL_ATTACHMENT_DOWNLOAD_MAX_BYTES,
  MAIL_ATTACHMENT_PREVIEW_MAX_BYTES,
  MAIL_ATTACHMENT_TOO_LARGE_MESSAGE,
  MAIL_ATTACHMENT_WARN_MESSAGE,
  MAIL_BULK_MOVE_AUDIT_MIN,
  MAIL_CACHE_ACCOUNT_MAX_BYTES,
  MAIL_CACHE_FULL_MESSAGE,
  MAIL_CACHE_MESSAGE_MAX_BYTES,
  MAIL_CACHE_ORGANIZATION_MAX_BYTES,
  MAIL_DELETE_LIMIT_MESSAGE,
  MAIL_DELETE_PERMANENT_DAILY_MAX,
  MAIL_MOVE_ACTIONS,
  MAIL_REMOTE_IMAGE_CACHE_MIN_FILE_BYTES,
  MAIL_REMOTE_IMAGE_CACHE_ORGANIZATION_MAX_BYTES,
  MAIL_REMOTE_IMAGE_CACHE_ORGANIZATION_MAX_ENTRIES,
  MAIL_REMOTE_IMAGE_CACHE_TTL_MS,
  MAIL_REMOTE_IMAGE_MAX_BYTES,
  MAIL_REMOTE_IMAGE_SENDERS_MAX,
  MAIL_VERIFICATION_LABELS,
  MAIL_WARNING_MESSAGES,
  apiPath,
  hasPermission,
  mailLevelAtLeast,
  resolveMailAccess,
  type MailAccessLevel,
  type MailAccountKind,
  type MailAction,
  type MailActionRequest,
  type MailActionResponse,
  type MailAddressView,
  type MailAttachment,
  type MailAttachmentRisk,
  type MailBodyState,
  type MailFolderRole,
  type MailMessageDetail,
  type MailMessageListQuery,
  type MailMessageListResponse,
  type MailMessageSummary,
  type MailMessageViewResponse,
  type MailSenderVerification,
  type MailWarningType,
  type UserRole,
} from '@balesin/shared';
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { ClientInfo } from '../../http/client-info';
import { rateLimited } from '../../http/rate-limit';
import type { MailJobEnqueuer } from '../../queues/mail-queue';
import { recordAudit } from '../audit/audit';
import { ACCESS_RULES, type AccessDeniedRecorder } from '../auth/access-denied';
import type { AuthContext, SessionService } from '../auth/session.service';
import { avatarUrlOf, mailNotFound } from './mail.repo';
import type { MailViewTokens } from './mail-view-token';

/**
 * Modul Email tahap 9A bagian 2 — daftar, baca, aksi dua arah (docs/KONTRAK-API-EMAIL.md §7–§9,
 * penyimpangan §16).
 *
 * Aturan keamanan:
 *  - Hak per akun SELALU `resolveMailAccess` dibaca segar per permintaan; akun pribadi orang lain
 *    (termasuk untuk Owner) dan tanpa hak `read` = 404 di SEMUA rute (daftar, detail, view token,
 *    gambar, cid, sumber, lampiran, aksi).
 *  - Isi email = data tak tepercaya: HTML disanitasi di worker (profil tampilan, penjaga kerumitan
 *    dulu); disajikan HANYA lewat dokumen ber-token dengan CSP sendiri (`frame-ancestors` origin
 *    aplikasi, `sandbox`) untuk iframe tanpa skrip/same-origin.
 *  - Token tampilan diperiksa ulang tiap pemakaian: sesi asal masih sah, pengguna aktif, hak `read`.
 *  - Proksi gambar: URL dari `remote_images` (bukan dari klien), https saja, alamat privat SELALU
 *    ditolak, ≤ 5 MB, jenis dari isi (raster saja), tanpa cookie/Referer.
 *  - Lampiran: `attachment` + `nosniff` + `CSP: sandbox`, jenis dari isi, `blocked` = 403.
 *  - Isi/subjek/alamat/URL/nama berkas TIDAK PERNAH di-log.
 */

export interface MailMessagesServiceDeps {
  db: Database;
  accessDenied: AccessDeniedRecorder;
  publisher: MailEventPublisher;
  queue?: MailJobEnqueuer;
  store: MediaStore | null;
  tokens: MailViewTokens;
  sessions: Pick<SessionService, 'peek'>;
  /** Origin aplikasi (`APP_URL`) — CSP `frame-ancestors`/`img-src` dokumen tampilan. */
  appOrigin: string;
  /** HANYA tes: pengganti unduhan gambar luar. */
  fetchRemote?: (request: RemoteFileRequest) => Promise<RemoteFileResult>;
  /**
   * Cache proksi gambar luar 24 jam (review 9A-2 S5/R8). Bawaan aktif bila `store` ada; `false` HANYA
   * untuk tes yang menghitung unduhan.
   */
  imageCache?: boolean;
  /** Batas unduhan gambar luar bersamaan (review 9A-2 S5). Bawaan 8 per pengguna, 32 per proses. */
  imageConcurrency?: { perUser: number; perProcess: number };
  /**
   * Review 9A-2 R10 (sebagian): rem per pengguna sebelum mengantre pengambilan BARU dari server email
   * (isi/lampiran = satu LOGIN IMAP per job). Melempar 429 bila lewat batas.
   */
  serverFetchGate?: (userId: string) => Promise<void>;
  /** 9B (KONTRAK-API-EMAIL-TULIS §7, §11): kunci utas, presence, draf milikku di folder Draf. */
  compose?: {
    threadKey(accountId: string, threadRoot: string): string;
    composing(
      accountId: string,
      threadKey: string,
      excludeUserId: string,
    ): Promise<{ id: string; name: string }[]>;
    myDraftIds(
      organizationId: string,
      userId: string,
      serverMessageIds: readonly string[],
    ): Promise<Map<string, string>>;
  };
  now?: () => Date;
}

/**
 * Pemeriksaan sesudah token rute publik di-resolve (review 9A-2 S5): batas laju per PENGGUNA dan per
 * ORGANISASI sesi asal (bukan per token — email lain = token lain).
 */
export type MailTokenGuard = (actor: {
  organizationId: string;
  user: { id: string };
}) => Promise<void>;

export interface MailRequestContext {
  client: ClientInfo;
  log: { warn: (obj: object, msg: string) => void };
}

/** Subjek hak (sesi cookie ATAU sesi asal token tampilan). */
interface MailActor {
  organizationId: string;
  user: { id: string; role: UserRole };
}

/** UA peramban umum untuk proksi gambar (review 9A-2 R8: tanpa sidik produk). */
const REMOTE_IMAGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const IMAGE_CONCURRENCY = { perUser: 8, perProcess: 32 } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const UUID = z.uuid();
const isUuid = (value: string) => UUID.safeParse(value).success;
const OPENED_TOUCH_MS = 60 * 60 * 1000;

const MESSAGE_NOT_FOUND = 'Email tidak ditemukan. Mungkin sudah dipindah atau dihapus.';
const ATTACHMENT_NOT_FOUND = 'Lampiran tidak ditemukan.';
const TOKEN_INVALID = 'Tampilan email sudah kedaluwarsa. Muat ulang emailnya.';
const BODY_NOT_READY = 'Isi email masih dimuat. Coba lagi sebentar.';

const notFound = (message = MESSAGE_NOT_FOUND) => new AppError('NOT_FOUND', { message });
/** Token tampilan tidak sah/kedaluwarsa/sesi dicabut/hak hilang → 410 (web meminta token baru). */
const unauthenticated = () => new AppError('TOKEN_INVALID', { message: TOKEN_INVALID });
function validation(field: string, message: string, reason: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [{ location: 'query', field, message, reason }],
  });
}
function conflict(reason: string, message: string): AppError {
  return new AppError('CONFLICT', {
    message,
    details: [{ location: 'body', field: 'id', message, reason }],
  });
}

// ── Kursor (server saja) ────────────────────────────────────────────────────

export function encodeMailCursor(receivedAt: Date, id: string): string {
  return Buffer.from(`${receivedAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeMailCursor(cursor: string): { receivedAt: Date; id: string } | null {
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const [at, id, extra] = text.split('|');
  if (!at || !id || extra !== undefined || !isUuid(id)) return null;
  const receivedAt = new Date(at);
  return Number.isNaN(receivedAt.getTime()) ? null : { receivedAt, id };
}

// ── Bentuk respons ──────────────────────────────────────────────────────────

const RISK_MESSAGES: Readonly<Record<MailAttachmentRisk, string | null>> = {
  ok: null,
  warn: MAIL_ATTACHMENT_WARN_MESSAGE,
  blocked: MAIL_ATTACHMENT_BLOCKED_MESSAGE,
};
const RASTER = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function summaryOf(
  row: MailMessageRow,
  account: Pick<MailAccountRow, 'id' | 'displayName' | 'color' | 'emailAddress'>,
): MailMessageSummary {
  return {
    id: row.id,
    accountId: row.accountId,
    folderId: row.folderId,
    folderRole: (row.folderRole as MailFolderRole | null) ?? null,
    account: {
      id: account.id,
      displayName: account.displayName,
      color: account.color as MailMessageSummary['account']['color'],
    },
    from: row.fromAddress ? { address: row.fromAddress, name: row.fromName } : null,
    to: row.to.slice(0, 10),
    toCount: row.toCount,
    ccCount: row.ccCount,
    subject: row.subject,
    snippet: row.snippet,
    receivedAt: row.receivedAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    isRead: row.isRead,
    isStarred: row.isStarred,
    isAnswered: row.isAnswered,
    hasAttachments: row.hasAttachments,
    sizeBytes: row.sizeBytes,
    deliveredTo: row.deliveredTo,
    deliveredToAlias: row.deliveredTo !== null && row.deliveredTo !== account.emailAddress,
    senderVerification: row.senderVerification as MailSenderVerification,
    warnings: row.warnings as MailWarningType[],
    pending: row.pendingAction !== null,
  };
}

function safeFileName(name: string | null, fallback: string): string {
  // eslint-disable-next-line no-control-regex -- karakter kendali justru dibuang.
  const base = (name ?? '').replace(/[\u0000-\u001f\u007f"\\/]+/g, '_').trim();
  return base.length > 0 ? base.slice(0, 200) : fallback;
}

function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface MailBinaryResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | NodeJS.ReadableStream | string;
}

export function createMailMessagesService(deps: MailMessagesServiceDeps) {
  const { db, accessDenied, publisher, tokens, sessions } = deps;
  const now = deps.now ?? (() => new Date());
  const fetchRemote = deps.fetchRemote ?? fetchRemoteFile;
  const appOrigin = deps.appOrigin.replace(/\/+$/, '');
  const imageCacheOn = deps.imageCache !== false && deps.store !== null;
  const imageConcurrency = deps.imageConcurrency ?? IMAGE_CONCURRENCY;
  // Review 9A-2 S5: unduhan gambar luar yang sedang berjalan (per pengguna & per proses). Lewat → 429
  // / 503 GIF kosong SEKETIKA (tidak diantre) supaya memori proses api tetap terbatas.
  const imageFetchesByUser = new Map<string, number>();
  let imageFetchesTotal = 0;

  async function levelFor(
    executor: DbExecutor,
    actor: MailActor,
    account: Pick<MailAccountRow, 'id' | 'kind' | 'ownerUserId'>,
  ): Promise<MailAccessLevel | null> {
    const users = await mailAccessUsersOf(executor, actor.organizationId, [actor.user.id]);
    const viewer = users.get(actor.user.id);
    if (!viewer) return null;
    const grants = await mailGrantsOf(executor, actor.organizationId, [account.id]);
    return resolveMailAccess(
      viewer,
      { kind: account.kind as MailAccountKind, ownerUserId: account.ownerUserId },
      grants.get(account.id) ?? [],
    );
  }

  /** Pesan + akun + hak; 404 bila tidak ada / akun diputus / tanpa hak (akun pribadi orang lain). */
  async function loadMessage(actor: MailActor, messageId: string) {
    if (!isUuid(messageId)) throw notFound();
    const [row] = await db
      .select({ message: mailMessages, account: mailAccounts })
      .from(mailMessages)
      .innerJoin(
        mailAccounts,
        and(
          eq(mailAccounts.organizationId, mailMessages.organizationId),
          eq(mailAccounts.id, mailMessages.accountId),
        ),
      )
      .where(
        and(
          eq(mailMessages.organizationId, actor.organizationId),
          eq(mailMessages.id, messageId),
          isNull(mailAccounts.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw notFound();
    const level = await levelFor(db, actor, row.account);
    if (!level) throw notFound();
    return { ...row, level };
  }

  async function bodyOf(organizationId: string, messageId: string) {
    const [body] = await db
      .select()
      .from(mailMessageBodies)
      .where(
        and(
          eq(mailMessageBodies.organizationId, organizationId),
          eq(mailMessageBodies.messageId, messageId),
        ),
      )
      .limit(1);
    return body ?? null;
  }

  async function senderAllowed(actor: MailActor, address: string | null): Promise<boolean> {
    if (!address) return false;
    const [row] = await db
      .select({ id: mailRemoteImageAllow.id })
      .from(mailRemoteImageAllow)
      .where(
        and(
          eq(mailRemoteImageAllow.organizationId, actor.organizationId),
          eq(mailRemoteImageAllow.userId, actor.user.id),
          eq(mailRemoteImageAllow.senderAddress, address),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async function requestBody(message: MailMessageRow, log: MailRequestContext['log']) {
    await db
      .update(mailMessages)
      .set({ bodyState: 'loading' })
      .where(
        and(
          eq(mailMessages.organizationId, message.organizationId),
          eq(mailMessages.id, message.id),
        ),
      );
    await deps.queue
      ?.fetchBody?.({
        organizationId: message.organizationId,
        accountId: message.accountId,
        messageId: message.id,
      })
      .catch((err: unknown) => {
        log.warn({ err, messageId: message.id }, 'Pengambilan isi email belum bisa diantrekan');
      });
  }

  function attachmentView(row: typeof mailAttachments.$inferSelect): MailAttachment {
    const type = row.detectedType ?? row.declaredType ?? 'application/octet-stream';
    const risk = row.risk as MailAttachmentRisk;
    return {
      id: row.id,
      filename: safeFileName(row.filename, row.isInline ? 'gambar' : 'lampiran'),
      contentType: type,
      sizeBytes: row.sizeBytes,
      isInline: row.isInline,
      risk,
      riskMessage: RISK_MESSAGES[risk],
      previewable:
        risk === 'ok' && RASTER.has(type) && row.sizeBytes <= MAIL_ATTACHMENT_PREVIEW_MAX_BYTES,
      cached: row.storageKey !== null,
    };
  }

  // ── Daftar ────────────────────────────────────────────────────────────────

  async function list(
    auth: AuthContext,
    query: MailMessageListQuery,
  ): Promise<MailMessageListResponse> {
    const levels = await accessibleMailAccountsOf(db, auth.organizationId, auth.user.id);
    const cursor = query.cursor ? decodeMailCursor(query.cursor) : null;
    if (query.cursor && !cursor)
      throw validation('cursor', 'Kursor daftar email tidak valid.', 'cursor_invalid');
    if (query.accountId && !levels.has(query.accountId)) throw mailNotFound();
    let folder: MailFolderRow | null = null;
    if (query.view === 'folder') {
      const [row] = await db
        .select()
        .from(mailFolders)
        .where(
          and(
            eq(mailFolders.organizationId, auth.organizationId),
            eq(mailFolders.id, query.folderId ?? ''),
          ),
        )
        .limit(1);
      if (!row || !levels.has(row.accountId)) throw notFound('Folder tidak ditemukan.');
      if (query.accountId && query.accountId !== row.accountId)
        throw notFound('Folder tidak ditemukan.');
      folder = row;
    }
    const accountIds = query.accountId ? [query.accountId] : [...levels.keys()];
    if (accountIds.length === 0) return { messages: [], nextCursor: null, olderOnServer: false };
    const limit = query.limit;
    const after = cursor
      ? sql`and (m.received_at, m.id) < (${cursor.receivedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
      : sql``;
    const visible = sql`and (m.pending_action is null or m.pending_action = 'flags')`;
    let keys: { id: string }[];
    if (query.view === 'folder' || query.view === 'inboxes') {
      const folderIds = folder
        ? [folder.id]
        : (
            await db
              .select({ id: mailFolders.id })
              .from(mailFolders)
              .where(
                and(
                  eq(mailFolders.organizationId, auth.organizationId),
                  inArray(mailFolders.accountId, accountIds),
                  eq(mailFolders.role, 'inbox'),
                ),
              )
          ).map((row) => row.id);
      if (folderIds.length === 0) return { messages: [], nextCursor: null, olderOnServer: false };
      const result = await db.execute<{ id: string }>(sql`
        select t.id from unnest(array[${sql.join(
          folderIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]) as k(folder_id)
        cross join lateral (
          select m.id, m.received_at from mail_messages m
          where m.organization_id = ${auth.organizationId} and m.folder_id = k.folder_id ${visible} ${after}
          order by m.received_at desc, m.id desc
          limit ${limit + 1}
        ) t
        order by t.received_at desc, t.id desc
        limit ${limit + 1}`);
      keys = result.rows;
    } else {
      const flag = query.view === 'unread' ? sql`not m.is_read` : sql`m.is_starred`;
      const result = await db.execute<{ id: string }>(sql`
        select t.id from unnest(array[${sql.join(
          accountIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]) as k(account_id)
        cross join lateral (
          select m.id, m.received_at from mail_messages m
          where m.organization_id = ${auth.organizationId} and m.account_id = k.account_id
            and ${flag} and m.folder_role is distinct from 'junk' and m.folder_role is distinct from 'trash'
            ${visible} ${after}
          order by m.received_at desc, m.id desc
          limit ${limit + 1}
        ) t
        order by t.received_at desc, t.id desc
        limit ${limit + 1}`);
      keys = result.rows;
    }
    const page = keys.slice(0, limit).map((row) => row.id);
    if (page.length === 0) {
      return { messages: [], nextCursor: null, olderOnServer: folder?.hasOlderOnServer ?? false };
    }
    const rows = await db
      .select({ message: mailMessages, account: mailAccounts })
      .from(mailMessages)
      .innerJoin(
        mailAccounts,
        and(
          eq(mailAccounts.organizationId, mailMessages.organizationId),
          eq(mailAccounts.id, mailMessages.accountId),
        ),
      )
      .where(
        and(eq(mailMessages.organizationId, auth.organizationId), inArray(mailMessages.id, page)),
      )
      .orderBy(desc(mailMessages.receivedAt), desc(mailMessages.id));
    const shown = rows.filter(
      (row) => levels.has(row.account.id) && row.account.deletedAt === null,
    );
    // 9B: salinan draf MILIKKU di folder Draf → `draftId` (draf orang lain = email biasa).
    const draftHeaders = shown.flatMap((row) =>
      row.message.folderRole === 'drafts' && row.message.messageIdHeader
        ? [row.message.messageIdHeader]
        : [],
    );
    const myDrafts =
      deps.compose && draftHeaders.length > 0
        ? await deps.compose.myDraftIds(auth.organizationId, auth.user.id, draftHeaders)
        : new Map<string, string>();
    const messages = shown.map((row) => {
      const summary = summaryOf(row.message, row.account);
      const draftId = row.message.messageIdHeader
        ? myDrafts.get(row.message.messageIdHeader)
        : undefined;
      return draftId ? { ...summary, draftId } : summary;
    });
    const last = rows.at(-1)?.message;
    return {
      messages,
      nextCursor: keys.length > limit && last ? encodeMailCursor(last.receivedAt, last.id) : null,
      olderOnServer: folder?.hasOlderOnServer ?? false,
    };
  }

  // ── Detail ────────────────────────────────────────────────────────────────

  async function detail(
    auth: AuthContext,
    messageId: string,
    context: MailRequestContext,
  ): Promise<{ message: MailMessageDetail }> {
    const { message, account, level } = await loadMessage(auth, messageId);
    let body = await bodyOf(auth.organizationId, message.id);
    let state = message.bodyState as MailBodyState;
    if (!body || state === 'none' || state === 'error' || state === 'loading') {
      if (!body || state !== 'loading') {
        // GET tidak menandai dibaca; hanya meminta isi diambil (kontrak §8, keputusan #5).
        await deps.serverFetchGate?.(auth.user.id);
        await requestBody(message, context.log);
      } else {
        await deps.queue
          ?.fetchBody?.({
            organizationId: message.organizationId,
            accountId: message.accountId,
            messageId: message.id,
          })
          .catch(() => undefined);
      }
      state = 'loading';
      body = null;
    } else if (
      !body.lastOpenedAt ||
      now().getTime() - body.lastOpenedAt.getTime() > OPENED_TOUCH_MS
    ) {
      await db
        .update(mailMessageBodies)
        .set({ lastOpenedAt: now() })
        .where(eq(mailMessageBodies.messageId, message.id));
    }
    const attachmentRows = body
      ? await db
          .select()
          .from(mailAttachments)
          .where(
            and(
              eq(mailAttachments.organizationId, auth.organizationId),
              eq(mailAttachments.messageId, message.id),
            ),
          )
          .orderBy(asc(mailAttachments.partId))
      : [];
    const auth_ = message.authDetails;
    const verification = message.senderVerification as MailSenderVerification;
    const warnings = message.warnings as MailWarningType[];
    const outgoing = message.folderRole === 'sent' || message.folderRole === 'drafts';
    const replyTo: MailAddressView[] = message.replyTo ?? [];
    return {
      message: {
        ...summaryOf(message, account),
        to: message.to,
        cc: message.cc,
        bcc: outgoing ? (message.bcc ?? []) : null,
        replyTo,
        messageIdHeader: message.messageIdHeader,
        myLevel: level,
        receivedVia: {
          accountId: account.id,
          displayName: account.displayName,
          address: message.deliveredTo ?? account.emailAddress,
        },
        verification: {
          result: verification,
          label: MAIL_VERIFICATION_LABELS[verification],
          spf: auth_?.spf ?? null,
          dkim: auth_?.dkim ?? null,
          dmarc: auth_?.dmarc ?? null,
          authServId: auth_?.authServId ?? null,
        },
        warningDetails: warnings.map((type) => ({ type, message: MAIL_WARNING_MESSAGES[type] })),
        body: {
          state,
          hasHtml: body?.htmlSanitized != null,
          text: body?.text ?? null,
          remoteImages: {
            count: body?.remoteImages.length ?? 0,
            senderAllowed: await senderAllowed(auth, message.fromAddress),
            autoBlocked: verification === 'fail',
          },
        },
        attachments: attachmentRows.map(attachmentView),
        ...(await composeExtras(auth, message, account)),
      },
    };
  }

  /** 9B: `threadKey` + rekan yang sedang membalas (akun bersama saja). */
  async function composeExtras(
    auth: AuthContext,
    message: { threadRoot: string | null },
    account: { id: string; kind: string },
  ) {
    if (!deps.compose || !message.threadRoot) return { threadKey: null, composing: [] };
    const threadKey = deps.compose.threadKey(account.id, message.threadRoot);
    const users =
      account.kind === 'shared'
        ? await deps.compose.composing(account.id, threadKey, auth.user.id).catch(() => [])
        : [];
    return { threadKey, composing: users.map((user) => ({ user })) };
  }

  // ── Dokumen tampilan ber-token ────────────────────────────────────────────

  async function createView(
    auth: AuthContext,
    messageId: string,
    images: 'auto' | 'show',
  ): Promise<MailMessageViewResponse> {
    const { message } = await loadMessage(auth, messageId);
    const body = await bodyOf(auth.organizationId, message.id);
    if (!body || (message.bodyState !== 'ready' && message.bodyState !== 'too_large')) {
      throw conflict('body_not_ready', BODY_NOT_READY);
    }
    const count = body.remoteImages.length;
    // Review 9A-2 R9: "selalu tampilkan" otomatis HANYA untuk pengirim yang lolos verifikasi (`pass`)
    // — `From` tanpa SPF/DKIM/DMARC tepercaya mudah dipalsukan (pelacakan buka + permintaan keluar).
    const allowed =
      images === 'show' ||
      (message.senderVerification === 'pass' && (await senderAllowed(auth, message.fromAddress)));
    const shown = count > 0 && allowed;
    const issued = tokens.issue(
      { messageId: message.id, sessionRef: auth.sessionRef, images: shown },
      now(),
    );
    return {
      url: apiPath(API_ROUTES.mail.view, { token: issued.token }),
      expiresAt: issued.expiresAt.toISOString(),
      remoteImages: { count, shown },
    };
  }

  /** Token → sesi asal masih sah + hak `read` masih ada + pesan & isi masih ada. Selain itu 401. */
  async function resolveToken(token: string) {
    const claims = tokens.verify(token, now());
    if (!claims) throw unauthenticated();
    const [session] = await db
      .select({ tokenHash: userSessions.tokenHash, organizationId: userSessions.organizationId })
      .from(userSessions)
      .where(eq(userSessions.id, claims.sessionRef))
      .limit(1);
    if (!session) throw unauthenticated();
    const snapshot = await sessions.peek(session.tokenHash);
    if (!snapshot || snapshot.organizationId !== session.organizationId) throw unauthenticated();
    if (snapshot.twoFactor.enrollmentRequired) throw unauthenticated();
    const actor: MailActor = {
      organizationId: snapshot.organizationId,
      user: { id: snapshot.user.id, role: snapshot.user.role },
    };
    let loaded;
    try {
      loaded = await loadMessage(actor, claims.messageId);
    } catch {
      throw unauthenticated();
    }
    return { claims, actor, ...loaded };
  }

  const viewHeaders = (contentType: string) => ({
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, no-store',
  });

  /** CSP dokumen tampilan (kontrak §8): tanpa skrip, gambar hanya dari aplikasi, sandbox. */
  function documentCsp(): string {
    return [
      "default-src 'none'",
      `img-src 'self' ${appOrigin} data:`,
      "style-src 'unsafe-inline'",
      'font-src data:',
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors 'self' ${appOrigin}`,
      'sandbox allow-popups allow-popups-to-escape-sandbox',
    ].join('; ');
  }

  async function viewDocument(token: string, guard?: MailTokenGuard): Promise<MailBinaryResponse> {
    const { claims, message, actor } = await resolveToken(token);
    await guard?.(actor);
    const body = await bodyOf(actor.organizationId, message.id);
    if (!body) throw unauthenticated();
    const inline = await db
      .select({ id: mailAttachments.id, contentId: mailAttachments.contentId })
      .from(mailAttachments)
      .where(
        and(
          eq(mailAttachments.organizationId, actor.organizationId),
          eq(mailAttachments.messageId, message.id),
          sql`${mailAttachments.contentId} is not null`,
          sql`${mailAttachments.storageKey} is not null`,
        ),
      );
    const base = apiPath(API_ROUTES.mail.view, { token });
    const html = renderMailViewDocument({
      html: body.htmlSanitized,
      text: body.text,
      imagesBase: claims.images ? `${base}/images` : null,
      cidUrls: new Map(
        inline.flatMap((row) => (row.contentId ? [[row.contentId, `${base}/cid/${row.id}`]] : [])),
      ),
    });
    return {
      status: 200,
      headers: {
        ...viewHeaders('text/html; charset=utf-8'),
        'content-security-policy': documentCsp(),
        'cross-origin-resource-policy': 'same-origin',
      },
      body: html,
    };
  }

  const blankImage = (status: number): MailBinaryResponse => ({
    status,
    headers: {
      ...viewHeaders('image/gif'),
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'cross-origin',
    },
    body: Buffer.from(MAIL_BLANK_IMAGE.slice(MAIL_BLANK_IMAGE.indexOf(',') + 1), 'base64'),
  });

  const imageHeaders = (type: string) => ({
    ...viewHeaders(type),
    'content-disposition': 'inline',
    'content-security-policy': "default-src 'none'; sandbox",
    // Dokumen iframe ber-origin opak: gambar harus boleh dimuat lintas origin (token tetap wajib).
    'cross-origin-resource-policy': 'cross-origin',
  });

  /** Cache gambar luar (24 jam, per akun + `sha256(url)`); `null` = belum ada / kedaluwarsa / hilang. */
  async function cachedImage(organizationId: string, accountId: string, urlHash: string) {
    if (!imageCacheOn) return null;
    const [row] = await db
      .select()
      .from(mailRemoteImageCache)
      .where(
        and(
          eq(mailRemoteImageCache.organizationId, organizationId),
          eq(mailRemoteImageCache.accountId, accountId),
          eq(mailRemoteImageCache.urlHash, urlHash),
        ),
      )
      .limit(1);
    if (!row || row.expiresAt.getTime() <= now().getTime()) return null;
    const file = await openStored(row.storageKey);
    return file ? { row, file } : null;
  }

  /** Simpan hasil unduhan ke cache selama kuota cache gambar organisasi masih cukup. */
  async function rememberImage(
    organizationId: string,
    accountId: string,
    urlHash: string,
    body: Buffer,
    type: string,
  ) {
    if (!imageCacheOn || !deps.store) return;
    const at = now();
    // Review 9A-2 P2-S8: SEMUA baris dihitung (yang kedaluwarsa tetap memakai disk sampai retensi
    // memangkasnya), tiap berkas minimal satu blok 4 KB, plus batas jumlah entri. Penuh → tidak
    // disimpan (gambar tetap disajikan dengan batas S5 yang sama).
    const [usage] = await db
      .select({
        entries: sql<string>`count(*)`,
        total: sql<string>`coalesce(sum(greatest(${mailRemoteImageCache.sizeBytes}, ${MAIL_REMOTE_IMAGE_CACHE_MIN_FILE_BYTES})), 0)`,
      })
      .from(mailRemoteImageCache)
      .where(eq(mailRemoteImageCache.organizationId, organizationId));
    if (Number(usage?.entries ?? 0) >= MAIL_REMOTE_IMAGE_CACHE_ORGANIZATION_MAX_ENTRIES) return;
    const cost = Math.max(body.length, MAIL_REMOTE_IMAGE_CACHE_MIN_FILE_BYTES);
    if (Number(usage?.total ?? 0) + cost > MAIL_REMOTE_IMAGE_CACHE_ORGANIZATION_MAX_BYTES) return;
    const saved = await deps.store.save('mail', body);
    const expiresAt = new Date(at.getTime() + MAIL_REMOTE_IMAGE_CACHE_TTL_MS);
    const [previous] = await db
      .select({ storageKey: mailRemoteImageCache.storageKey })
      .from(mailRemoteImageCache)
      .where(
        and(
          eq(mailRemoteImageCache.accountId, accountId),
          eq(mailRemoteImageCache.urlHash, urlHash),
        ),
      )
      .limit(1);
    try {
      await db
        .insert(mailRemoteImageCache)
        .values({
          organizationId,
          accountId,
          urlHash,
          storageKey: saved.storageKey,
          contentType: type,
          sizeBytes: saved.sizeBytes,
          fetchedAt: at,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [mailRemoteImageCache.accountId, mailRemoteImageCache.urlHash],
          set: {
            storageKey: saved.storageKey,
            contentType: type,
            sizeBytes: saved.sizeBytes,
            fetchedAt: at,
            expiresAt,
            updatedAt: sql`now()`,
          },
        });
    } catch {
      // Akun diputus di tengah jalan (FK) dsb.: cache bukan kebenaran — cukup buang berkasnya.
      await deps.store.remove(saved.storageKey).catch(() => undefined);
      return;
    }
    if (previous && previous.storageKey !== saved.storageKey) {
      await deps.store.remove(previous.storageKey).catch(() => undefined);
    }
  }

  /** Jatah unduhan bersamaan; `null` = dapat (wajib `release`), selain itu status penolakan. */
  function acquireImageSlot(userId: string): { release: () => void } | 429 | 503 {
    const mine = imageFetchesByUser.get(userId) ?? 0;
    if (mine >= imageConcurrency.perUser) return 429;
    if (imageFetchesTotal >= imageConcurrency.perProcess) return 503;
    imageFetchesByUser.set(userId, mine + 1);
    imageFetchesTotal += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        imageFetchesTotal -= 1;
        const left = (imageFetchesByUser.get(userId) ?? 1) - 1;
        if (left <= 0) imageFetchesByUser.delete(userId);
        else imageFetchesByUser.set(userId, left);
      },
    };
  }

  async function viewImage(
    token: string,
    index: number,
    guard?: MailTokenGuard,
  ): Promise<MailBinaryResponse> {
    const { claims, message, actor } = await resolveToken(token);
    await guard?.(actor);
    if (!claims.images) {
      throw new AppError('FORBIDDEN', { message: 'Gambar luar email ini belum diizinkan tampil.' });
    }
    const body = await bodyOf(actor.organizationId, message.id);
    const url = body?.remoteImages[index];
    if (!url) throw notFound('Gambar tidak ditemukan.');
    // URL dari daftar yang disimpan sanitizer (bukan dari klien) → bukan proksi terbuka.
    if (!/^https:\/\//i.test(url)) return blankImage(415);
    // Review 9A-2 S5/R8: cache 24 jam per akun — membuka ulang tidak mengunduh (dan tidak memberi tahu
    // pengirim) lagi.
    const urlHash = createHash('sha256').update(url).digest('hex');
    const cached = await cachedImage(actor.organizationId, message.accountId, urlHash);
    if (cached) {
      return {
        status: 200,
        headers: {
          ...imageHeaders(cached.row.contentType),
          'content-length': String(cached.file.sizeBytes),
        },
        body: cached.file.stream,
      };
    }
    const slot = acquireImageSlot(actor.user.id);
    if (slot === 429 || slot === 503) {
      const busy = blankImage(slot);
      return { ...busy, headers: { ...busy.headers, 'retry-after': '2' } };
    }
    let result: RemoteFileResult;
    try {
      result = await fetchRemote({
        url,
        privateCidrs: [],
        maxBytes: MAIL_REMOTE_IMAGE_MAX_BYTES,
        timeoutMs: 8_000,
        maxRedirects: 3,
        userAgent: REMOTE_IMAGE_USER_AGENT,
        // Bukan raster dari 12 byte pertama → diputus tanpa menampung sisanya.
        acceptHead: { bytes: 12, accept: (head) => sniffRasterImage(head) !== null },
        headers: { accept: 'image/png,image/jpeg,image/gif,image/webp;q=0.9,*/*;q=0.1' },
      });
    } finally {
      slot.release();
    }
    if (!result.ok) {
      return blankImage(
        result.error === 'too_large' ? 413 : result.error === 'content_rejected' ? 415 : 502,
      );
    }
    const type = sniffRasterImage(result.body);
    if (!type) return blankImage(415);
    await rememberImage(actor.organizationId, message.accountId, urlHash, result.body, type);
    return { status: 200, headers: imageHeaders(type), body: result.body };
  }

  async function openStored(storageKey: string) {
    if (!deps.store) return null;
    try {
      return await deps.store.open(storageKey);
    } catch {
      return null;
    }
  }

  async function viewCid(
    token: string,
    attachmentId: string,
    guard?: MailTokenGuard,
  ): Promise<MailBinaryResponse> {
    const { message, actor } = await resolveToken(token);
    await guard?.(actor);
    if (!isUuid(attachmentId)) return blankImage(404);
    const [row] = await db
      .select()
      .from(mailAttachments)
      .where(
        and(
          eq(mailAttachments.organizationId, actor.organizationId),
          eq(mailAttachments.messageId, message.id),
          eq(mailAttachments.id, attachmentId),
        ),
      )
      .limit(1);
    if (!row?.storageKey || row.risk === 'blocked' || !RASTER.has(row.detectedType ?? '')) {
      return blankImage(404);
    }
    const file = await openStored(row.storageKey);
    if (!file) return blankImage(404);
    return {
      status: 200,
      headers: {
        ...viewHeaders(row.detectedType ?? 'application/octet-stream'),
        'content-disposition': 'inline',
        'content-length': String(file.sizeBytes),
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'cross-origin',
      },
      body: file.stream,
    };
  }

  // ── Sumber (header mentah) ────────────────────────────────────────────────

  async function source(
    auth: AuthContext,
    messageId: string,
    download: boolean,
  ): Promise<MailBinaryResponse> {
    const { message } = await loadMessage(auth, messageId);
    const body = await bodyOf(auth.organizationId, message.id);
    if (!body?.rawHeaders)
      throw conflict(
        'body_not_ready',
        'Header email belum tersedia. Buka emailnya dulu, lalu coba lagi.',
      );
    return {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-store',
        ...(download
          ? { 'content-disposition': contentDisposition('attachment', 'header-email.txt') }
          : {}),
      },
      body: body.rawHeaders,
    };
  }

  // ── Lampiran ──────────────────────────────────────────────────────────────

  async function loadAttachment(auth: AuthContext, attachmentId: string) {
    if (!isUuid(attachmentId)) throw notFound(ATTACHMENT_NOT_FOUND);
    const [row] = await db
      .select()
      .from(mailAttachments)
      .where(
        and(
          eq(mailAttachments.organizationId, auth.organizationId),
          eq(mailAttachments.id, attachmentId),
        ),
      )
      .limit(1);
    if (!row) throw notFound(ATTACHMENT_NOT_FOUND);
    let loaded;
    try {
      loaded = await loadMessage(auth, row.messageId);
    } catch {
      throw notFound(ATTACHMENT_NOT_FOUND);
    }
    return { attachment: row, ...loaded };
  }

  async function attachment(
    auth: AuthContext,
    attachmentId: string,
    options: { confirm: boolean; preview: boolean },
    context: MailRequestContext,
  ): Promise<MailBinaryResponse | { status: 202; state: 'loading' }> {
    const { attachment: row, message } = await loadAttachment(auth, attachmentId);
    if (row.risk === 'blocked') {
      throw new AppError('FORBIDDEN', {
        message: MAIL_ATTACHMENT_BLOCKED_MESSAGE,
        details: [
          {
            location: 'params',
            field: 'attachmentId',
            message: MAIL_ATTACHMENT_BLOCKED_MESSAGE,
            reason: 'attachment_blocked',
          },
        ],
      });
    }
    const limit = options.preview
      ? MAIL_ATTACHMENT_PREVIEW_MAX_BYTES
      : MAIL_ATTACHMENT_DOWNLOAD_MAX_BYTES;
    if (row.sizeBytes > limit * (row.storageKey ? 1 : 1.4)) {
      throw new AppError('PAYLOAD_TOO_LARGE', { message: MAIL_ATTACHMENT_TOO_LARGE_MESSAGE });
    }
    if (options.preview) {
      const type = row.detectedType ?? row.declaredType ?? '';
      if (
        row.risk !== 'ok' ||
        !(RASTER.has(type) || (row.detectedType === null && type.startsWith('image/')))
      ) {
        throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
          message: 'Pratinjau hanya untuk gambar PNG, JPEG, GIF, atau WebP.',
        });
      }
    } else if (row.risk === 'warn' && !options.confirm) {
      throw conflict('attachment_needs_confirmation', MAIL_ATTACHMENT_WARN_MESSAGE);
    }
    const file = row.storageKey ? await openStored(row.storageKey) : null;
    if (!file) {
      // Review 9A-2 S7: kuota cache dicek SEBELUM mengantre (worker juga memeriksa ulang).
      const room = mailCacheRoom(
        await mailCacheUsage(db, {
          organizationId: auth.organizationId,
          accountId: message.accountId,
          messageId: message.id,
        }),
        {
          account: MAIL_CACHE_ACCOUNT_MAX_BYTES,
          organization: MAIL_CACHE_ORGANIZATION_MAX_BYTES,
          message: MAIL_CACHE_MESSAGE_MAX_BYTES,
        },
      );
      if (Math.floor((row.sizeBytes * 3) / 4) > room) {
        throw conflict('cache_full', MAIL_CACHE_FULL_MESSAGE);
      }
      await deps.serverFetchGate?.(auth.user.id);
      if (row.storageKey) {
        await db
          .update(mailAttachments)
          .set({ storageKey: null, fetchedAt: null, expiresAt: null })
          .where(eq(mailAttachments.id, row.id));
      }
      await deps.queue
        ?.fetchAttachment?.({
          organizationId: auth.organizationId,
          accountId: message.accountId,
          attachmentId: row.id,
        })
        .catch((err: unknown) => {
          context.log.warn(
            { err, attachmentId: row.id },
            'Pengambilan lampiran email belum bisa diantrekan',
          );
        });
      return { status: 202, state: 'loading' };
    }
    const type = row.detectedType ?? 'application/octet-stream';
    if (options.preview && !RASTER.has(type)) {
      file.stream.destroy();
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
        message: 'Pratinjau hanya untuk gambar PNG, JPEG, GIF, atau WebP.',
      });
    }
    const filename = safeFileName(row.filename, 'lampiran');
    return {
      status: 200,
      headers: {
        'content-type': options.preview
          ? type
          : RASTER.has(type) || type === 'application/pdf'
            ? type
            : 'application/octet-stream',
        'content-length': String(file.sizeBytes),
        'content-disposition': contentDisposition(
          options.preview ? 'inline' : 'attachment',
          filename,
        ),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-store',
      },
      body: file.stream,
    };
  }

  // ── "Selalu tampilkan gambar dari pengirim ini" ───────────────────────────

  async function remoteImageSenders(auth: AuthContext) {
    const rows = await db
      .select({
        address: mailRemoteImageAllow.senderAddress,
        createdAt: mailRemoteImageAllow.createdAt,
      })
      .from(mailRemoteImageAllow)
      .where(
        and(
          eq(mailRemoteImageAllow.organizationId, auth.organizationId),
          eq(mailRemoteImageAllow.userId, auth.user.id),
        ),
      )
      .orderBy(asc(mailRemoteImageAllow.senderAddress));
    return {
      senders: rows.map((row) => ({
        address: row.address,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async function addRemoteImageSender(auth: AuthContext, address: string) {
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ total: count() })
        .from(mailRemoteImageAllow)
        .where(
          and(
            eq(mailRemoteImageAllow.organizationId, auth.organizationId),
            eq(mailRemoteImageAllow.userId, auth.user.id),
          ),
        );
      if ((existing?.total ?? 0) >= MAIL_REMOTE_IMAGE_SENDERS_MAX) {
        throw conflict(
          'limit_reached',
          `Maksimal ${String(MAIL_REMOTE_IMAGE_SENDERS_MAX)} pengirim di daftar "selalu tampilkan gambar".`,
        );
      }
      await tx
        .insert(mailRemoteImageAllow)
        .values({
          organizationId: auth.organizationId,
          userId: auth.user.id,
          senderAddress: address,
        })
        .onConflictDoNothing({
          target: [mailRemoteImageAllow.userId, mailRemoteImageAllow.senderAddress],
        });
    });
    return remoteImageSenders(auth);
  }

  async function removeRemoteImageSender(auth: AuthContext, address: string) {
    await db
      .delete(mailRemoteImageAllow)
      .where(
        and(
          eq(mailRemoteImageAllow.organizationId, auth.organizationId),
          eq(mailRemoteImageAllow.userId, auth.user.id),
          eq(mailRemoteImageAllow.senderAddress, address),
        ),
      );
    return remoteImageSenders(auth);
  }

  // ── Aksi dua arah ─────────────────────────────────────────────────────────

  /** Folder peran (archive/trash/junk/inbox) akun; archive/trash dibuat lokal bila tidak ada. */
  async function roleFolder(
    executor: DbExecutor,
    account: MailAccountRow,
    role: 'archive' | 'trash' | 'junk' | 'inbox',
  ): Promise<MailFolderRow | null> {
    const folders = await executor
      .select()
      .from(mailFolders)
      .where(
        and(
          eq(mailFolders.organizationId, account.organizationId),
          eq(mailFolders.accountId, account.id),
        ),
      );
    const found = folders.find((folder) => folder.role === role);
    if (found) return found;
    if (role !== 'archive' && role !== 'trash') return null;
    // Namespace server: cPanel/Dovecot memakai awalan `INBOX.` untuk folder sendiri.
    const inbox = folders.find((folder) => folder.role === 'inbox');
    const delimiter =
      inbox?.delimiter ?? folders.find((folder) => folder.delimiter)?.delimiter ?? '.';
    const prefixed = folders.some(
      (folder) =>
        folder.role !== 'inbox' && folder.path.toUpperCase().startsWith(`INBOX${delimiter}`),
    );
    const name = role === 'archive' ? 'Archive' : 'Trash';
    const path = prefixed ? `INBOX${delimiter}${name}` : name;
    const existing = folders.find((folder) => folder.path === path);
    if (existing) return existing;
    const [created] = await executor
      .insert(mailFolders)
      .values({
        organizationId: account.organizationId,
        accountId: account.id,
        path,
        delimiter,
        name: role === 'archive' ? 'Arsip' : 'Sampah',
        role,
        roleSource: 'created',
        depth: prefixed ? 1 : 0,
        parentId: prefixed ? (inbox?.id ?? null) : null,
      })
      .onConflictDoNothing()
      .returning();
    return created ?? null;
  }

  /**
   * Review 9A-2 R11: jumlah permintaan pindah pengguna ini dalam sejam terakhir (termasuk yang ini),
   * penghitung di memori proses — hanya untuk memutuskan perlu dicatat di audit; batas keras tetap
   * 120 permintaan/menit per pengguna di rute.
   */
  const moveRequests = new Map<string, number[]>();
  function moveRequestsLastHour(auth: AuthContext): number {
    const nowMs = now().getTime();
    const recent = (moveRequests.get(auth.user.id) ?? []).filter(
      (at) => nowMs - at < 60 * 60 * 1000,
    );
    recent.push(nowMs);
    moveRequests.set(auth.user.id, recent.slice(-1_000));
    if (moveRequests.size > 10_000) moveRequests.clear();
    return recent.length;
  }

  async function act(
    auth: AuthContext,
    input: MailActionRequest,
    context: MailRequestContext,
  ): Promise<MailActionResponse> {
    const action: MailAction = input.action;
    const ids = [...new Set(input.messageIds)];
    const results = new Map<string, MailActionResponse['results'][number]>();
    const fail = (id: string, code: string, message: string) => {
      results.set(id, { id, ok: false, error: { code, message } });
    };
    const validIds = ids.filter((id) => {
      if (isUuid(id)) return true;
      fail(id, 'NOT_FOUND', MESSAGE_NOT_FOUND);
      return false;
    });
    const moving = MAIL_MOVE_ACTIONS.includes(action);
    if (moving && !hasPermission(auth.user.role, 'mail.send')) {
      await accessDenied.recordRule({
        auth,
        rule: ACCESS_RULES.mailAccountLevel,
        client: context.client,
        details: { action, permission: 'mail.send' },
      });
      throw new AppError('FORBIDDEN', {
        message: 'Peranmu tidak bisa memindah atau menghapus email.',
      });
    }
    const levels = await accessibleMailAccountsOf(db, auth.organizationId, auth.user.id);
    let target: MailFolderRow | null = null;
    if (action === 'move') {
      const [row] = await db
        .select()
        .from(mailFolders)
        .where(
          and(
            eq(mailFolders.organizationId, auth.organizationId),
            eq(mailFolders.id, input.targetFolderId ?? ''),
          ),
        )
        .limit(1);
      if (!row || !levels.has(row.accountId)) throw notFound('Folder tujuan tidak ditemukan.');
      if (!row.selectable)
        throw validation(
          'targetFolderId',
          'Folder ini tidak bisa menampung email.',
          'folder_not_selectable',
        );
      target = row;
    }
    const rows =
      validIds.length === 0
        ? []
        : await db
            .select({ message: mailMessages, account: mailAccounts })
            .from(mailMessages)
            .innerJoin(
              mailAccounts,
              and(
                eq(mailAccounts.organizationId, mailMessages.organizationId),
                eq(mailAccounts.id, mailMessages.accountId),
              ),
            )
            .where(
              and(
                eq(mailMessages.organizationId, auth.organizationId),
                inArray(mailMessages.id, validIds),
                isNull(mailAccounts.deletedAt),
              ),
            );
    const byId = new Map(rows.map((row) => [row.message.id, row]));
    let forbidden = false;
    const accepted: { message: MailMessageRow; account: MailAccountRow }[] = [];
    for (const id of validIds) {
      const row = byId.get(id);
      const level = row ? levels.get(row.account.id) : undefined;
      if (
        !row ||
        !level ||
        (row.message.pendingAction !== null && row.message.pendingAction !== 'flags')
      ) {
        fail(id, 'NOT_FOUND', MESSAGE_NOT_FOUND);
        continue;
      }
      if (!mailLevelAtLeast(level, MAIL_ACTION_MIN_LEVEL[action])) {
        forbidden = true;
        fail(id, 'FORBIDDEN', 'Hak aksesmu di akun email ini tidak cukup untuk tindakan ini.');
        continue;
      }
      const role = row.message.folderRole;
      if (action === 'move' && target && target.accountId !== row.account.id) {
        fail(id, 'VALIDATION_ERROR', 'Email hanya bisa dipindah ke folder di akun yang sama.');
        continue;
      }
      if (action === 'trash' && role === 'trash') {
        fail(id, 'VALIDATION_ERROR', 'Email ini sudah di Sampah. Pakai "Hapus permanen".');
        continue;
      }
      if (action === 'delete_permanently' && role !== 'trash' && role !== 'junk') {
        fail(id, 'VALIDATION_ERROR', 'Hapus permanen hanya untuk email di Sampah atau Spam.');
        continue;
      }
      accepted.push(row);
    }
    if (forbidden) {
      await accessDenied.recordRule({
        auth,
        rule: ACCESS_RULES.mailAccountLevel,
        client: context.client,
        details: { action, required: MAIL_ACTION_MIN_LEVEL[action] },
      });
    }

    const events: MailBusEventInput[] = [];
    const touchedFolders = new Set<string>();
    const touchedAccounts = new Map<string, string>();
    const movedAccounts = new Set<string>();
    let movedCount = 0;
    const at = now();
    const deleteLimit = await db.transaction(async (tx) => {
      // Review 9A-2 R11 + P2-R13: rem hapus permanen per pengguna per 24 jam (dihitung dari audit
      // log). Kunci advisory per pengguna (dilepas saat transaksi selesai) + hitung ulang di DALAM
      // transaksi: permintaan paralel antre, dan masing-masing melihat audit hapus yang sudah
      // di-commit permintaan sebelumnya.
      if (action === 'delete_permanently' && accepted.length > 0) {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`mail-delete:${auth.user.id}`}, 0))`,
        );
        const [row] = await tx
          .select({
            total: sql<string>`coalesce(sum((${auditLogs.metadata} ->> 'count')::int), 0)`,
          })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.organizationId, auth.organizationId),
              eq(auditLogs.actorUserId, auth.user.id),
              eq(auditLogs.action, AUDIT_ACTIONS.mailMessagesDeletedPermanently),
              sql`${auditLogs.createdAt} > ${new Date(now().getTime() - DAY_MS)}`,
            ),
          );
        const deletedLast24h = Number(row?.total ?? 0);
        if (deletedLast24h + accepted.length > MAIL_DELETE_PERMANENT_DAILY_MAX) {
          return { deletedLast24h };
        }
      }
      const deletedByFolder = new Map<
        string,
        { accountId: string; folderId: string; count: number }
      >();
      for (const { message, account } of accepted) {
        const revert = message.pendingRevert ?? {
          isRead: message.isRead,
          isStarred: message.isStarred,
        };
        const base = { pendingActionAt: at, pendingRevert: revert };
        let destination: MailFolderRow | null = null;
        let pending: 'flags' | 'move' | 'delete' = 'flags';
        const flags: { isRead?: boolean; isStarred?: boolean } = {};
        switch (action) {
          case 'mark_read':
            flags.isRead = true;
            break;
          case 'mark_unread':
            flags.isRead = false;
            break;
          case 'star':
            flags.isStarred = true;
            break;
          case 'unstar':
            flags.isStarred = false;
            break;
          case 'move':
            destination = target;
            pending = 'move';
            break;
          case 'archive':
            destination = await roleFolder(tx, account, 'archive');
            pending = 'move';
            break;
          case 'trash':
            destination = await roleFolder(tx, account, 'trash');
            pending = 'move';
            break;
          case 'spam':
            destination =
              message.folderRole === 'junk' ? null : await roleFolder(tx, account, 'junk');
            if (!destination && message.folderRole !== 'junk') {
              fail(message.id, 'CONFLICT', 'Akun ini tidak punya folder Spam.');
              continue;
            }
            pending = 'move';
            break;
          case 'not_spam':
            destination =
              message.folderRole === 'junk' ? await roleFolder(tx, account, 'inbox') : null;
            pending = 'move';
            break;
          case 'delete_permanently':
            pending = 'delete';
            break;
        }
        if (pending === 'move' && (!destination || destination.id === message.folderId)) {
          // Sudah di folder tujuan (mis. spam di Spam): tidak ada yang berubah.
          if (!destination && action !== 'spam' && action !== 'not_spam') {
            fail(message.id, 'CONFLICT', 'Folder tujuan tidak tersedia.');
            continue;
          }
          results.set(message.id, { id: message.id, ok: true });
          continue;
        }
        if (pending === 'flags') {
          const changedRead = flags.isRead !== undefined && flags.isRead !== message.isRead;
          const changedStar =
            flags.isStarred !== undefined && flags.isStarred !== message.isStarred;
          if (!changedRead && !changedStar) {
            results.set(message.id, { id: message.id, ok: true });
            continue;
          }
          await tx
            .update(mailMessages)
            .set({
              ...flags,
              ...base,
              pendingAction: sql`coalesce(${mailMessages.pendingAction}, 'flags')`,
            })
            .where(
              and(
                eq(mailMessages.organizationId, auth.organizationId),
                eq(mailMessages.id, message.id),
              ),
            );
          if (changedRead) {
            await tx
              .update(mailFolders)
              .set({
                unreadCount: sql`greatest(0, ${mailFolders.unreadCount} + ${flags.isRead ? -1 : 1})`,
              })
              .where(
                and(
                  eq(mailFolders.organizationId, auth.organizationId),
                  eq(mailFolders.id, message.folderId),
                ),
              );
            touchedFolders.add(message.folderId);
          }
          events.push({
            organizationId: auth.organizationId,
            accountId: account.id,
            event: {
              type: 'mail.message.updated',
              accountId: account.id,
              messageId: message.id,
              fields: ['flags'],
            },
          });
        } else {
          await tx
            .update(mailMessages)
            .set({
              ...base,
              pendingAction: pending,
              pendingTargetFolderId: pending === 'move' ? (destination?.id ?? null) : null,
            })
            .where(
              and(
                eq(mailMessages.organizationId, auth.organizationId),
                eq(mailMessages.id, message.id),
              ),
            );
          const unread = message.isRead ? 0 : 1;
          await tx
            .update(mailFolders)
            .set({
              totalCount: sql`greatest(0, ${mailFolders.totalCount} - 1)`,
              unreadCount: sql`greatest(0, ${mailFolders.unreadCount} - ${unread})`,
            })
            .where(
              and(
                eq(mailFolders.organizationId, auth.organizationId),
                eq(mailFolders.id, message.folderId),
              ),
            );
          touchedFolders.add(message.folderId);
          if (destination) {
            await tx
              .update(mailFolders)
              .set({
                totalCount: sql`${mailFolders.totalCount} + 1`,
                unreadCount: sql`${mailFolders.unreadCount} + ${unread}`,
              })
              .where(
                and(
                  eq(mailFolders.organizationId, auth.organizationId),
                  eq(mailFolders.id, destination.id),
                ),
              );
            touchedFolders.add(destination.id);
          }
          if (pending === 'move') {
            movedCount += 1;
            movedAccounts.add(account.id);
          }
          if (pending === 'delete') {
            const key = message.folderId;
            const entry = deletedByFolder.get(key) ?? {
              accountId: account.id,
              folderId: key,
              count: 0,
            };
            entry.count += 1;
            deletedByFolder.set(key, entry);
          }
          events.push({
            organizationId: auth.organizationId,
            accountId: account.id,
            event: {
              type: 'mail.message.updated',
              accountId: account.id,
              messageId: message.id,
              fields: ['folder'],
            },
          });
        }
        touchedAccounts.set(account.id, account.organizationId);
        results.set(message.id, { id: message.id, ok: true });
      }
      for (const entry of deletedByFolder.values()) {
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.mailMessagesDeletedPermanently,
          targetType: 'mail_account',
          targetId: entry.accountId,
          metadata: { accountId: entry.accountId, folderId: entry.folderId, count: entry.count },
          client: context.client,
        });
      }
      // Review 9A-2 R11: pindah/Sampah/Spam MASSAL tercatat (tanpa subjek/alamat): ≥ 10 email sekali
      // minta, atau setiap permintaan pindah setelah > 60 permintaan dalam sejam.
      if (movedCount > 0) {
        const recentMoves = moveRequestsLastHour(auth);
        if (movedCount >= MAIL_BULK_MOVE_AUDIT_MIN || recentMoves > 60) {
          await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.mailMessagesMoved,
            targetType: 'user',
            targetId: auth.user.id,
            metadata: {
              action,
              count: movedCount,
              accountIds: [...movedAccounts],
              targetFolderId: target?.id ?? null,
            },
            client: context.client,
          });
        }
      }
      return null;
    });
    if (deleteLimit) {
      // Di luar transaksi aksi: transaksi di atas tidak mengubah apa pun saat batas tercapai.
      await recordAudit(db, {
        organizationId: auth.organizationId,
        actorUserId: auth.user.id,
        action: AUDIT_ACTIONS.mailMessagesDeleteLimitReached,
        targetType: 'user',
        targetId: auth.user.id,
        metadata: { requested: accepted.length, deletedLast24h: deleteLimit.deletedLast24h },
        client: context.client,
      });
      throw rateLimited(60 * 60, MAIL_DELETE_LIMIT_MESSAGE);
    }
    if (touchedFolders.size > 0) {
      const counts = await db
        .select({
          id: mailFolders.id,
          accountId: mailFolders.accountId,
          unreadCount: mailFolders.unreadCount,
          totalCount: mailFolders.totalCount,
        })
        .from(mailFolders)
        .where(
          and(
            eq(mailFolders.organizationId, auth.organizationId),
            inArray(mailFolders.id, [...touchedFolders]),
          ),
        );
      for (const folder of counts) {
        events.push({
          organizationId: auth.organizationId,
          accountId: folder.accountId,
          event: {
            type: 'mail.folder.counts',
            accountId: folder.accountId,
            folderId: folder.id,
            unreadCount: Math.max(0, folder.unreadCount),
            totalCount: Math.max(0, folder.totalCount),
          },
        });
      }
    }
    if (events.length > 0) await publisher.publish(events);
    for (const [accountId, organizationId] of touchedAccounts) {
      await deps.queue?.action?.({ organizationId, accountId }).catch((err: unknown) => {
        // Tick worker (30 dtk) mengambil aksi tertunda yang antreannya terlewat.
        context.log.warn({ err, accountId }, 'Aksi email belum bisa diantrekan');
      });
    }
    const ordered = ids.map(
      (id) =>
        results.get(id) ?? {
          id,
          ok: false,
          error: { code: 'NOT_FOUND', message: MESSAGE_NOT_FOUND },
        },
    );
    return { results: ordered, applied: ordered.filter((item) => item.ok).length };
  }

  return {
    list,
    detail,
    createView,
    viewDocument,
    viewImage,
    viewCid,
    source,
    attachment,
    remoteImageSenders,
    addRemoteImageSender,
    removeRemoteImageSender,
    act,
    /** Untuk tes. */
    avatarUrlOf,
  };
}

export type MailMessagesService = ReturnType<typeof createMailMessagesService>;
