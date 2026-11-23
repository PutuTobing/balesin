import { AppError, type MailComposeKeys } from '@balesin/core';
import {
  channels,
  emailSettings,
  mailAccounts,
  mailIdentities,
  mailSettings,
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
  type MailAccessLevel,
  type MailCannotSendReason,
  type MailIdentity,
  type MailVerificationUnavailableReason,
  type UserRole,
} from '@balesin/shared';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';

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

export function verificationUnavailableReason(
  sender: SystemSender | null,
  account: Parameters<typeof systemSenderConflicts>[1],
  identityAddresses: readonly string[] = [],
): MailVerificationUnavailableReason | null {
  if (!sender) return 'system_sender_missing';
  return systemSenderConflicts(sender, account, identityAddresses)
    ? 'system_sender_conflict'
    : null;
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
  account: Pick<MailAccountRow, 'deletedAt' | 'syncState'>;
  unavailable: MailVerificationUnavailableReason | null;
}

export function cannotSendReasonOf(
  identity: Pick<MailIdentityRow, 'verificationState'>,
  context: Pick<IdentityViewContext, 'role' | 'level' | 'account'>,
): MailCannotSendReason | null {
  if (context.account.deletedAt !== null) return 'account_deleting';
  if (context.account.syncState === 'owner_inactive') return 'account_unavailable';
  if (!canMailSend(context.role, context.level)) return 'level_insufficient';
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
      available: context.unavailable === null,
      unavailableReason: context.unavailable,
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
