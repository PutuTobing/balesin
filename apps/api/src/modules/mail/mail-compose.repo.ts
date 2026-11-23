import { AppError, type MailComposeKeys } from '@balesin/core';
import {
  auditLogs,
  channels,
  emailSettings,
  mailAccounts,
  mailAccountsMatchingSystemSender,
  mailDrafts,
  mailIdentities,
  mailIdentityApprovalAllows,
  mailIdentityApprovalStateOf,
  mailSettings,
  users,
  type DbExecutor,
  type MailAccountRow,
  type MailIdentityRow,
} from '@balesin/db';
import {
  MAIL_ATTACHMENT_TOTAL_MB,
  MAIL_COMPOSE_MESSAGES,
  MAIL_RECIPIENTS_PER_EMAIL,
  MAIL_VERIFICATION_AUTO_CHECK_MINUTES,
  MAIL_VERIFICATION_MAX_ATTEMPTS,
  canMailSend,
  hasPermission,
  type MailAccessLevel,
  type MailCannotSendReason,
  type MailIdentity,
  type MailIdentityApprovalState,
  type MailVerificationUnavailableReason,
  type UserRole,
} from '@balesin/shared';
import { and, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import type { EmailNotifier } from '../../queues/email-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { normalizeRecipientAddress } from '../email-send/email-content';

/**
 * Pembantu bersama modul Email tahap 9B (KONTRAK-API-EMAIL-TULIS): bentuk respons identitas,
 * keadaan verifikasi, Email pengirim sistem (konflik verifikasi), larangan alamat ganda lintas akun/
 * channel/pengirim sistem, pengaturan batas. Semua query terfilter organisasi.
 */

export function detailError(
  code: 'VALIDATION_ERROR' | 'CONFLICT' | 'RATE_LIMITED' | 'TOKEN_INVALID',
  reason: string,
  message: string,
  field = 'body',
  extra: Record<string, unknown> = {},
  options: { retryAfterSeconds?: number } = {},
): AppError {
  return new AppError(code, {
    message,
    details: [{ location: 'body', field, message, reason, ...extra }],
    ...options,
  });
}

export function composeNotFound(message = 'Data tidak ditemukan.'): AppError {
  return new AppError('NOT_FOUND', { message });
}

/** Alamat → huruf kecil baku (validator 9.1: ASCII, punycode, ≤ 254), atau `null`. */
export function normalizeAddress(value: string): string | null {
  return normalizeRecipientAddress(value);
}

// ── Email pengirim sistem ─────────────────────────────────────────────────

export interface SystemSender {
  address: string;
  host: string;
  username: string | null;
}

export interface SystemSenderFallback {
  fromAddress: string;
  host: string;
  username: string | null;
}

/** Email pengirim sistem efektif (database lalu cadangan env), atau `null`. */
export async function systemSenderOf(
  db: DbExecutor,
  organizationId: string,
  fallback: SystemSenderFallback | null,
): Promise<SystemSender | null> {
  const [row] = await db
    .select({
      address: emailSettings.fromAddress,
      host: emailSettings.host,
      username: emailSettings.username,
    })
    .from(emailSettings)
    .where(eq(emailSettings.organizationId, organizationId))
    .limit(1);
  if (row) return { address: row.address.toLowerCase(), host: row.host, username: row.username };
  return fallback
    ? {
        address: fallback.fromAddress.toLowerCase(),
        host: fallback.host,
        username: fallback.username,
      }
    : null;
}

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * `system_sender_conflict` (§3.2): alamat Email pengirim sistem = alamat akun/identitas, ATAU kotak
 * surat SMTP sistem (host + username) = kotak surat akun ini (IMAP/SMTP). Salinan email verifikasi
 * (dan tautan reset password/undangan) bisa tersimpan otomatis di Terkirim akun itu.
 */
export function systemSenderConflicts(
  sender: SystemSender | null,
  account: Pick<
    MailAccountRow,
    | 'emailAddress'
    | 'imapHost'
    | 'imapUsername'
    | 'smtpHost'
    | 'smtpUsername'
    | 'smtpSameCredentials'
  >,
  identityAddresses: readonly string[] = [],
): boolean {
  if (!sender) return false;
  if (sameText(sender.address, account.emailAddress)) return true;
  if (identityAddresses.some((address) => sameText(address, sender.address))) return true;
  const smtpUser = account.smtpSameCredentials ? account.imapUsername : account.smtpUsername;
  const mailbox = (host: string | null, user: string | null) =>
    sameText(sender.host, host) && sameText(sender.username, user);
  return mailbox(account.smtpHost, smtpUser) || mailbox(account.imapHost, account.imapUsername);
}

/**
 * Alasan verifikasi tidak tersedia di TINGKAT ORGANISASI (review 9B S2): Email pengirim sistem belum
 * ada, atau kotak suratnya (alamat ATAU host + username) terhubung sebagai akun Email MANA PUN yang
 * hidup → salinan email ber-kode di Terkirim terbaca pembaca akun itu → SEMUA identitas terkunci.
 */
export async function organizationVerificationBlock(
  db: DbExecutor,
  organizationId: string,
  sender: SystemSender | null,
): Promise<'system_sender_missing' | 'system_sender_conflict' | null> {
  if (!sender) return 'system_sender_missing';
  const hits = await mailAccountsMatchingSystemSender(db, organizationId, sender);
  return hits.length > 0 ? 'system_sender_conflict' : null;
}

/** Alasan per identitas: blok organisasi dulu, lalu persetujuan (review 9B S3). */
export function identityUnavailableReason(
  organizationBlock: MailVerificationUnavailableReason | null,
  approval: MailIdentityApprovalState,
): MailVerificationUnavailableReason | null {
  if (organizationBlock) return organizationBlock;
  if (approval === 'pending') return 'approval_pending';
  if (approval === 'rejected') return 'approval_rejected';
  return null;
}

// ── Identitas ─────────────────────────────────────────────────────────────

export async function identitiesOf(
  db: DbExecutor,
  organizationId: string,
  accountIds: readonly string[],
): Promise<MailIdentityRow[]> {
  if (accountIds.length === 0) return [];
  return db
    .select()
    .from(mailIdentities)
    .where(
      and(
        eq(mailIdentities.organizationId, organizationId),
        sql`${mailIdentities.accountId} in ${[...new Set(accountIds)]}`,
      ),
    )
    .orderBy(sql`${mailIdentities.isPrimary} desc`, mailIdentities.address);
}

export async function loadIdentity(
  db: DbExecutor,
  organizationId: string,
  identityId: string,
  options: { forUpdate?: boolean } = {},
): Promise<MailIdentityRow | null> {
  const query = db
    .select()
    .from(mailIdentities)
    .where(
      and(eq(mailIdentities.organizationId, organizationId), eq(mailIdentities.id, identityId)),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row ?? null;
}

export interface IdentityViewContext {
  now: Date;
  role: UserRole;
  level: MailAccessLevel | null;
  account: Pick<MailAccountRow, 'deletedAt' | 'syncState' | 'kind'>;
  /** Blok tingkat organisasi (`organizationVerificationBlock`). */
  unavailable: MailVerificationUnavailableReason | null;
  /** Domain organisasi (`mailOrganizationDomains`) — persetujuan akun pribadi (review 9B S3). */
  domains: ReadonlySet<string>;
}

export function approvalOf(
  identity: Pick<MailIdentityRow, 'address' | 'approvalState'>,
  context: Pick<IdentityViewContext, 'account' | 'domains'>,
): MailIdentityApprovalState {
  return mailIdentityApprovalStateOf(identity, context.account.kind, context.domains);
}

export function cannotSendReasonOf(
  identity: Pick<MailIdentityRow, 'verificationState' | 'address' | 'approvalState'>,
  context: Pick<IdentityViewContext, 'role' | 'level' | 'account' | 'domains'>,
): MailCannotSendReason | null {
  if (context.account.deletedAt !== null) return 'account_deleting';
  if (context.account.syncState === 'owner_inactive') return 'account_unavailable';
  if (!canMailSend(context.role, context.level)) return 'level_insufficient';
  if (!mailIdentityApprovalAllows(approvalOf(identity, context))) return 'identity_not_approved';
  if (identity.verificationState !== 'verified') return 'identity_unverified';
  return null;
}

export function toMailIdentity(row: MailIdentityRow, context: IdentityViewContext): MailIdentity {
  const pending =
    row.verificationState === 'pending' && row.verificationExpiresAt
      ? {
          sentAt: row.verificationSentAt?.toISOString() ?? null,
          expiresAt: row.verificationExpiresAt.toISOString(),
          attemptsLeft: Math.max(0, MAIL_VERIFICATION_MAX_ATTEMPTS - row.verificationAttempts),
          autoCheckUntil: row.verificationSentAt
            ? new Date(
                row.verificationSentAt.getTime() + MAIL_VERIFICATION_AUTO_CHECK_MINUTES * 60_000,
              ).toISOString()
            : null,
        }
      : null;
  const reason = cannotSendReasonOf(row, context);
  const approval = approvalOf(row, context);
  const unavailable = identityUnavailableReason(context.unavailable, approval);
  return {
    id: row.id,
    accountId: row.accountId,
    address: row.address,
    displayName: row.displayName,
    isPrimary: row.isPrimary,
    replyTo: row.replyTo,
    verification: {
      state: row.verificationState as MailIdentity['verification']['state'],
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      method: (row.verifiedMethod as 'mailbox' | 'code' | null) ?? null,
      pending,
      available: unavailable === null,
      unavailableReason: unavailable,
    },
    approval: {
      state: approval,
      decidedAt:
        approval === 'approved' || approval === 'rejected'
          ? (row.approvalDecidedAt?.toISOString() ?? null)
          : null,
    },
    defaultSignatures: { new: row.defaultSignatureNewId, reply: row.defaultSignatureReplyId },
    canSend: reason === null,
    cannotSendReason: reason,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Field `verification_*` yang dikosongkan saat identitas kembali `unverified`. */
export const IDENTITY_RESET: Partial<MailIdentityRow> = {
  verificationState: 'unverified',
  verifiedAt: null,
  verifiedMethod: null,
  verificationSecretEncrypted: null,
  verificationCodeHash: null,
  verificationMessageIdHash: null,
  verificationSentAt: null,
  verificationExpiresAt: null,
  verificationAttempts: 0,
};

// ── Larangan alamat ganda (§3.3) ──────────────────────────────────────────

/**
 * Alamat sudah dipakai di tempat lain organisasi: identitas akun Email HIDUP lain (utama/alias),
 * alamat/alias Channel Email, atau alamat Email pengirim sistem. Panggil di bawah
 * `lockEmailAddresses` di transaksi akhir.
 */
export async function addressUsedElsewhere(
  db: DbExecutor,
  organizationId: string,
  address: string,
  options: { exceptIdentityId?: string; systemSender: SystemSender | null },
): Promise<boolean> {
  if (sameText(options.systemSender?.address, address)) return true;
  const [identity] = await db
    .select({ id: mailIdentities.id })
    .from(mailIdentities)
    .innerJoin(
      mailAccounts,
      and(
        eq(mailAccounts.organizationId, mailIdentities.organizationId),
        eq(mailAccounts.id, mailIdentities.accountId),
      ),
    )
    .where(
      and(
        eq(mailIdentities.organizationId, organizationId),
        eq(mailIdentities.address, address),
        isNull(mailAccounts.deletedAt),
        options.exceptIdentityId ? ne(mailIdentities.id, options.exceptIdentityId) : undefined,
      ),
    )
    .limit(1);
  if (identity) return true;
  const [channel] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.organizationId, organizationId),
        eq(channels.type, 'email'),
        isNull(channels.deletedAt),
        or(eq(channels.emailAddress, address), sql`${address} = any(${channels.emailAliases})`),
      ),
    )
    .limit(1);
  return channel !== undefined;
}

/** Alamat adalah identitas (utama/alias) akun Email hidup mana pun (arah sebaliknya, §3.3). */
export async function addressIsMailIdentity(
  db: DbExecutor,
  organizationId: string,
  address: string,
): Promise<boolean> {
  const [hit] = await db
    .select({ id: mailIdentities.id })
    .from(mailIdentities)
    .innerJoin(
      mailAccounts,
      and(
        eq(mailAccounts.organizationId, mailIdentities.organizationId),
        eq(mailAccounts.id, mailIdentities.accountId),
      ),
    )
    .where(
      and(
        eq(mailIdentities.organizationId, organizationId),
        eq(mailIdentities.address, address.trim().toLowerCase()),
        isNull(mailAccounts.deletedAt),
      ),
    )
    .limit(1);
  return hit !== undefined;
}

export function addressInUse(field = 'address'): AppError {
  return detailError('CONFLICT', 'address_in_use', MAIL_COMPOSE_MESSAGES.addressInUse, field);
}

// ── Pemegang alamat & prioritas organisasi (review 9B S4) ─────────────────

export type AddressHolder =
  | { kind: 'system_sender' }
  | { kind: 'channel'; channelId: string; channelName: string }
  | {
      kind: 'identity';
      identityId: string;
      accountId: string;
      accountKind: 'shared' | 'personal';
      accountName: string;
      address: string;
      isPrimary: boolean;
      verified: boolean;
      approvalState: string | null;
      ownerUserId: string | null;
      ownerName: string | null;
    };

/**
 * Semua pemegang `address` di organisasi: Email pengirim sistem, Channel Email (+ alias), identitas
 * (utama/alias) akun Email hidup. Panggil di bawah `lockEmailAddresses`.
 */
export async function addressHoldersOf(
  db: DbExecutor,
  organizationId: string,
  address: string,
  options: {
    systemSender: SystemSender | null;
    exceptIdentityId?: string;
    exceptAccountId?: string;
  },
): Promise<AddressHolder[]> {
  const holders: AddressHolder[] = [];
  if (sameText(options.systemSender?.address, address)) holders.push({ kind: 'system_sender' });
  const channelRows = await db
    .select({ id: channels.id, name: channels.name })
    .from(channels)
    .where(
      and(
        eq(channels.organizationId, organizationId),
        eq(channels.type, 'email'),
        isNull(channels.deletedAt),
        or(eq(channels.emailAddress, address), sql`${address} = any(${channels.emailAliases})`),
      ),
    );
  for (const row of channelRows) {
    holders.push({ kind: 'channel', channelId: row.id, channelName: row.name });
  }
  const identityRows = await db
    .select({
      identityId: mailIdentities.id,
      accountId: mailAccounts.id,
      accountKind: mailAccounts.kind,
      accountName: mailAccounts.displayName,
      address: mailIdentities.address,
      isPrimary: mailIdentities.isPrimary,
      state: mailIdentities.verificationState,
      approvalState: mailIdentities.approvalState,
      ownerUserId: mailAccounts.ownerUserId,
      ownerName: users.name,
    })
    .from(mailIdentities)
    .innerJoin(
      mailAccounts,
      and(
        eq(mailAccounts.organizationId, mailIdentities.organizationId),
        eq(mailAccounts.id, mailIdentities.accountId),
      ),
    )
    .leftJoin(
      users,
      and(
        eq(users.organizationId, mailAccounts.organizationId),
        eq(users.id, mailAccounts.ownerUserId),
      ),
    )
    .where(
      and(
        eq(mailIdentities.organizationId, organizationId),
        eq(mailIdentities.address, address),
        isNull(mailAccounts.deletedAt),
        options.exceptIdentityId ? ne(mailIdentities.id, options.exceptIdentityId) : undefined,
        options.exceptAccountId ? ne(mailAccounts.id, options.exceptAccountId) : undefined,
      ),
    );
  for (const row of identityRows) {
    holders.push({
      kind: 'identity',
      identityId: row.identityId,
      accountId: row.accountId,
      accountKind: row.accountKind === 'personal' ? 'personal' : 'shared',
      accountName: row.accountName,
      address: row.address,
      isPrimary: row.isPrimary,
      verified: row.state === 'verified',
      approvalState: row.approvalState,
      ownerUserId: row.ownerUserId,
      ownerName: row.ownerName,
    });
  }
  return holders;
}

/**
 * Klaim LEMAH (review 9B S4): identitas akun PRIBADI yang belum `verified`, atau yang persetujuannya
 * (S3) belum mengizinkan. Klaim lemah tidak boleh menghalangi Owner/Admin memakai alamat organisasi.
 */
export function isWeakClaim(holder: AddressHolder, domains: ReadonlySet<string>): boolean {
  if (holder.kind !== 'identity' || holder.accountKind !== 'personal') return false;
  if (!holder.verified) return true;
  return !mailIdentityApprovalAllows(mailIdentityApprovalStateOf(holder, 'personal', domains));
}

/**
 * 409 `address_in_use`. Untuk pemegang `mail.accounts.manage` (Owner/Admin) pesannya menyebut
 * pemegangnya (`cause`: `system_sender` · `channel` · `shared_identity` · `personal_identity`);
 * pengguna lain mendapat pesan umum (akun pribadi orang lain tidak dibocorkan).
 */
export function addressHeldError(
  role: UserRole,
  holder: AddressHolder | undefined,
  field = 'address',
): AppError {
  if (!holder || !hasPermission(role, 'mail.accounts.manage')) return addressInUse(field);
  const [cause, text] =
    holder.kind === 'system_sender'
      ? ['system_sender', 'sebagai Email pengirim sistem']
      : holder.kind === 'channel'
        ? ['channel', `oleh Channel Email "${holder.channelName}"`]
        : holder.accountKind === 'shared'
          ? ['shared_identity', `di akun email bersama "${holder.accountName}"`]
          : [
              'personal_identity',
              `sebagai alamat pengirim terverifikasi di akun email pribadi milik ${holder.ownerName ?? 'pengguna lain'}. Minta ia menghapusnya, atau nonaktifkan penggunanya lalu putus akunnya di Pengaturan → Akun email`,
            ];
  return detailError(
    'CONFLICT',
    'address_in_use',
    MAIL_COMPOSE_MESSAGES.addressHeldBy(text),
    field,
    { cause },
  );
}

export interface RevokedClaim {
  identityId: string;
  accountId: string;
  ownerUserId: string | null;
  address: string;
  auditLogId: string;
}

/**
 * Aksi Owner/Admin atas `address` (alias/akun bersama, Channel Email, Email pengirim sistem), review
 * 9B S4: pemegang KUAT → 409 (menyebut pemegangnya); klaim LEMAH akun pribadi dicabut — alias dihapus
 * (draf dipindah ke identitas utama), identitas utama direset `unverified` — + audit
 * `mail.identity.revoked`. Mengembalikan klaim yang dicabut (pemberitahuan ke pemiliknya dikirim
 * pemanggil SETELAH commit, `notifyRevokedClaims`). Panggil di transaksi, di bawah
 * `lockEmailAddresses`.
 */
export async function claimAddressForOrganization(
  tx: DbExecutor,
  input: {
    organizationId: string;
    actorUserId: string;
    role: UserRole;
    address: string;
    systemSender: SystemSender | null;
    domains: ReadonlySet<string>;
    client: ClientInfo;
    field?: string;
    /** Abaikan pemegang tertentu (mis. Channel Email yang sedang diubah, pengirim sistem sendiri). */
    ignore?: (holder: AddressHolder) => boolean;
    exceptIdentityId?: string;
    exceptAccountId?: string;
  },
): Promise<RevokedClaim[]> {
  const holders = (
    await addressHoldersOf(tx, input.organizationId, input.address, {
      systemSender: input.systemSender,
      ...(input.exceptIdentityId ? { exceptIdentityId: input.exceptIdentityId } : {}),
      ...(input.exceptAccountId ? { exceptAccountId: input.exceptAccountId } : {}),
    })
  ).filter((holder) => !input.ignore?.(holder));
  const strong = holders.find((holder) => !isWeakClaim(holder, input.domains));
  if (strong) throw addressHeldError(input.role, strong, input.field);
  const revoked: RevokedClaim[] = [];
  for (const holder of holders) {
    if (holder.kind !== 'identity') continue;
    if (holder.isPrimary) {
      await tx
        .update(mailIdentities)
        .set(IDENTITY_RESET)
        .where(
          and(
            eq(mailIdentities.organizationId, input.organizationId),
            eq(mailIdentities.id, holder.identityId),
          ),
        );
    } else {
      const [primary] = await tx
        .select({ id: mailIdentities.id })
        .from(mailIdentities)
        .where(
          and(
            eq(mailIdentities.organizationId, input.organizationId),
            eq(mailIdentities.accountId, holder.accountId),
            eq(mailIdentities.isPrimary, true),
          ),
        )
        .limit(1);
      if (primary) {
        await tx
          .update(mailDrafts)
          .set({ identityId: primary.id, version: sql`${mailDrafts.version} + 1` })
          .where(
            and(
              eq(mailDrafts.organizationId, input.organizationId),
              eq(mailDrafts.identityId, holder.identityId),
            ),
          );
      }
      await tx
        .delete(mailIdentities)
        .where(
          and(
            eq(mailIdentities.organizationId, input.organizationId),
            eq(mailIdentities.id, holder.identityId),
          ),
        );
    }
    const auditLogId = await recordAudit(tx, {
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: AUDIT_ACTIONS.mailIdentityRevoked,
      targetType: 'mail_account',
      targetId: holder.accountId,
      // Alamat organisasi (bukan isi kotak surat pribadi) — perlu untuk pemberitahuan pemiliknya.
      metadata: {
        accountId: holder.accountId,
        identityId: holder.identityId,
        kind: 'personal',
        address: input.address,
        isPrimary: holder.isPrimary,
        reason: 'revoked',
        actorRole: input.role,
      },
      client: input.client,
    });
    revoked.push({
      identityId: holder.identityId,
      accountId: holder.accountId,
      ownerUserId: holder.ownerUserId,
      address: input.address,
      auditLogId,
    });
  }
  return revoked;
}

/** Pemberitahuan klaim dicabut ke pemilik akun pribadi (usaha terbaik, setelah commit). */
export async function notifyRevokedClaims(
  notifier: Pick<EmailNotifier, 'securityNoticeAdmin'> | undefined,
  input: { organizationId: string; actorUserId: string; occurredAt: Date },
  revoked: readonly RevokedClaim[],
): Promise<void> {
  if (!notifier) return;
  for (const claim of revoked) {
    if (!claim.ownerUserId) continue;
    await notifier
      .securityNoticeAdmin({
        organizationId: input.organizationId,
        recipientUserId: claim.ownerUserId,
        subjectUserId: claim.ownerUserId,
        actorUserId: input.actorUserId,
        event: 'mail_identity_decided',
        occurredAt: input.occurredAt.toISOString(),
        auditLogId: claim.auditLogId,
      })
      .catch(() => undefined);
  }
}

// ── Pengaturan & kunci utas ───────────────────────────────────────────────

export interface ComposeLimits {
  maxRecipients: number;
  maxAttachmentBytes: number;
  maxAttachmentMb: number;
}

export async function composeLimitsOf(
  db: DbExecutor,
  organizationId: string,
): Promise<ComposeLimits> {
  const [row] = await db
    .select({
      maxRecipients: mailSettings.maxRecipientsPerEmail,
      maxMb: mailSettings.maxAttachmentTotalMb,
    })
    .from(mailSettings)
    .where(eq(mailSettings.organizationId, organizationId))
    .limit(1);
  const mb = row?.maxMb ?? MAIL_ATTACHMENT_TOTAL_MB.default;
  return {
    maxRecipients: row?.maxRecipients ?? MAIL_RECIPIENTS_PER_EMAIL.default,
    maxAttachmentBytes: mb * 1024 * 1024,
    maxAttachmentMb: mb,
  };
}

export function threadKeyOf(
  keys: MailComposeKeys,
  accountId: string,
  threadRoot: string | null,
): string | null {
  return threadRoot ? keys.threadKey(accountId, threadRoot) : null;
}

// ── Persetujuan identitas akun pribadi berdomain organisasi (review 9B S3) ──

/**
 * Identitas baru akun PRIBADI yang domainnya domain organisasi → audit
 * `mail.identity.approval_requested` (alamat organisasi ikut dicatat). `null` bila tidak perlu.
 */
export async function recordApprovalRequest(
  tx: DbExecutor,
  input: {
    organizationId: string;
    actorUserId: string;
    accountKind: string;
    accountId: string;
    identity: { id: string; address: string; isPrimary: boolean };
    domains: ReadonlySet<string>;
    client: ClientInfo;
  },
): Promise<string | null> {
  const state = mailIdentityApprovalStateOf(
    { address: input.identity.address, approvalState: null },
    input.accountKind,
    input.domains,
  );
  if (state !== 'pending') return null;
  return recordAudit(tx, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: AUDIT_ACTIONS.mailIdentityApprovalRequested,
    targetType: 'mail_account',
    targetId: input.accountId,
    metadata: {
      accountId: input.accountId,
      identityId: input.identity.id,
      kind: 'personal',
      address: input.identity.address,
      isPrimary: input.identity.isPrimary,
    },
    client: input.client,
  });
}

const APPROVAL_NOTICE_WINDOW_MS = 60 * 60 * 1000;

/** Email "menunggu persetujuan" ke semua Owner/Admin aktif selain peminta (usaha terbaik). */
export async function notifyApprovalRequest(
  db: DbExecutor,
  notifier: Pick<EmailNotifier, 'securityNoticeAdmin'> | undefined,
  input: { organizationId: string; requesterUserId: string; auditLogId: string; occurredAt: Date },
): Promise<void> {
  if (!notifier) return;
  // Review 9B putaran 2 P2-S1: tambah-hapus alias berulang tidak boleh membanjiri Owner/Admin dan
  // menghabiskan kuota SMTP pengirim sistem. Maks. 1 email per peminta per jam; permintaan lain
  // tetap tampil di daftar "menunggu persetujuan" (sumber kebenaran: audit, tanpa Redis).
  const since = new Date(input.occurredAt.getTime() - APPROVAL_NOTICE_WINDOW_MS);
  const [recent] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, input.organizationId),
        eq(auditLogs.actorUserId, input.requesterUserId),
        eq(auditLogs.action, AUDIT_ACTIONS.mailIdentityApprovalRequested),
        gte(auditLogs.createdAt, since),
      ),
    );
  if ((recent?.count ?? 0) > 1) return;
  const recipients = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, input.organizationId),
        inArray(users.role, ['owner', 'admin']),
        isNull(users.disabledAt),
        ne(users.id, input.requesterUserId),
      ),
    );
  for (const recipient of recipients) {
    await notifier
      .securityNoticeAdmin({
        organizationId: input.organizationId,
        recipientUserId: recipient.id,
        subjectUserId: input.requesterUserId,
        event: 'mail_identity_approval_requested',
        occurredAt: input.occurredAt.toISOString(),
        auditLogId: input.auditLogId,
      })
      .catch(() => undefined);
  }
}
