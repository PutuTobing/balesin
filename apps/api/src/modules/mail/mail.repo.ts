import { AppError, maskedSecret } from '@balesin/core';
import {
  channels,
  mailAccessUsersOf,
  mailAccounts,
  mailFolders,
  mailGrantsOf,
  organizations,
  users,
  type DbExecutor,
  type MailAccountRow,
  type MailFolderRow,
} from '@balesin/db';
import {
  API_ROUTES,
  MAIL_FOLDER_ROLE_ORDER,
  MAIL_TEST_MESSAGES,
  apiPath,
  canMailAdminister,
  resolveMailAccess,
  type MailAccessLevel,
  type MailAccessUser,
  type MailAccount,
  type MailAccountColor,
  type MailAccountKind,
  type MailFolder,
  type MailFolderRole,
  type MailProvider,
  type MailSyncState,
  type MailSyncWindowDays,
  type MailTestCode,
  type RedactedMailAccount,
} from '@balesin/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AuthContext } from '../auth/session.service';

/**
 * Pemuat & bentuk respons akun Email (KONTRAK-API-EMAIL §4). Semua query terfilter organisasi.
 * Password tidak pernah keluar (hanya `••••` + ekor); `imap`/`smtp` hanya untuk pemegang hak ubah
 * server (`canMailAdminister`).
 */

const UUID = z.uuid();

export const MAIL_ACCOUNT_NOT_FOUND = 'Akun email tidak ditemukan. Mungkin sudah diputus.';

export function mailNotFound(): AppError {
  return new AppError('NOT_FOUND', { message: MAIL_ACCOUNT_NOT_FOUND });
}

export function isUuid(value: string): boolean {
  return UUID.safeParse(value).success;
}

/** Pelaku sebagai subjek `resolveMailAccess` (departemen dibaca segar). */
export async function viewerOf(db: DbExecutor, auth: AuthContext): Promise<MailAccessUser> {
  const subjects = await mailAccessUsersOf(db, auth.organizationId, [auth.user.id]);
  return (
    subjects.get(auth.user.id) ?? {
      id: auth.user.id,
      role: auth.user.role,
      active: false,
      departmentIds: [],
    }
  );
}

export async function loadAccountRow(
  db: DbExecutor,
  organizationId: string,
  accountId: string,
  options: { forUpdate?: boolean; includeDeleted?: boolean } = {},
): Promise<MailAccountRow | null> {
  if (!isUuid(accountId)) return null;
  const query = db
    .select()
    .from(mailAccounts)
    .where(
      and(
        eq(mailAccounts.organizationId, organizationId),
        eq(mailAccounts.id, accountId),
        options.includeDeleted ? undefined : isNull(mailAccounts.deletedAt),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row ?? null;
}

export async function levelOf(
  db: DbExecutor,
  viewer: MailAccessUser,
  organizationId: string,
  row: Pick<MailAccountRow, 'id' | 'kind' | 'ownerUserId'>,
): Promise<MailAccessLevel | null> {
  const grants = await mailGrantsOf(db, organizationId, [row.id]);
  return resolveMailAccess(
    viewer,
    { kind: row.kind as MailAccountKind, ownerUserId: row.ownerUserId },
    grants.get(row.id) ?? [],
  );
}

export async function privateCidrsOf(db: DbExecutor, organizationId: string): Promise<string[]> {
  const [row] = await db
    .select({ cidrs: organizations.webhookPrivateCidrs })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.cidrs ?? [];
}

export function avatarUrlOf(row: Pick<MailAccountRow, 'id' | 'avatarSha256'>): string | null {
  if (!row.avatarSha256) return null;
  return `${apiPath(API_ROUTES.mail.accountAvatar, { accountId: row.id })}?v=${row.avatarSha256.slice(0, 8)}`;
}

function errorMessageOf(code: string | null): string | null {
  if (!code) return null;
  if (code === 'mailbox_too_large') {
    return 'Kotak surat terlalu besar untuk disinkron (maks. 500.000 email). Persempit jendela sinkron.';
  }
  return Object.hasOwn(MAIL_TEST_MESSAGES, code)
    ? MAIL_TEST_MESSAGES[code as MailTestCode]
    : 'Sinkron gagal karena sebab yang tidak dikenali. Coba lagi beberapa saat lagi.';
}

export interface OwnerRef {
  id: string;
  name: string;
  active: boolean;
}

export async function ownersOf(
  db: DbExecutor,
  organizationId: string,
  rows: readonly Pick<MailAccountRow, 'ownerUserId'>[],
): Promise<Map<string, OwnerRef>> {
  const ids = [...new Set(rows.map((row) => row.ownerUserId).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const found = await db
    .select({ id: users.id, name: users.name, disabledAt: users.disabledAt })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), inArray(users.id, ids)));
  return new Map(
    found.map((row) => [row.id, { id: row.id, name: row.name, active: row.disabledAt === null }]),
  );
}

export function toMailAccount(
  row: MailAccountRow,
  viewer: MailAccessUser,
  myLevel: MailAccessLevel | null,
  owner: OwnerRef | null,
): MailAccount {
  const administer = canMailAdminister(viewer, {
    kind: row.kind as MailAccountKind,
    ownerUserId: row.ownerUserId,
  });
  const state = row.syncState as MailSyncState;
  return {
    id: row.id,
    kind: row.kind as MailAccountKind,
    provider: row.provider as MailProvider,
    displayName: row.displayName,
    emailAddress: row.emailAddress,
    fromName: row.fromName,
    color: row.color as MailAccountColor,
    avatarUrl: avatarUrlOf(row),
    owner: row.kind === 'personal' ? owner : null,
    myLevel,
    redacted: false,
    imap: administer
      ? {
          host: row.imapHost ?? '',
          port: row.imapPort ?? 993,
          security: row.imapSecurity === 'starttls' ? 'starttls' : 'ssl',
          username: row.imapUsername,
          password: maskedSecret(row.imapPasswordTail) ?? '••••',
        }
      : null,
    smtp: administer
      ? {
          host: row.smtpHost ?? '',
          port: row.smtpPort ?? 465,
          security: row.smtpSecurity === 'starttls' ? 'starttls' : 'ssl',
          sameCredentials: row.smtpSameCredentials,
          username: row.smtpSameCredentials ? null : row.smtpUsername,
          password: row.smtpSameCredentials ? null : (maskedSecret(row.smtpPasswordTail) ?? '••••'),
        }
      : null,
    trustedAuthServIds: administer ? row.trustedAuthServIds : null,
    syncWindowDays: row.syncWindowDays as MailSyncWindowDays,
    periodicSyncMinutes: row.periodicSyncMinutes,
    sync: {
      state,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      lastErrorMessage: errorMessageOf(row.lastErrorCode),
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      idleActive: row.idleActive,
      initialProgress:
        state === 'initial_sync'
          ? { done: row.initialSyncDone, total: row.initialSyncTotal ?? 0 }
          : null,
      lastTest:
        row.lastTestAt !== null
          ? {
              testedAt: row.lastTestAt.toISOString(),
              incomingOk: row.lastTestIncomingOk === true,
              outgoingOk: row.lastTestOutgoingOk === true,
            }
          : null,
    },
    stats: {
      messageCount: Math.max(0, row.messageCount),
      unreadCount: Math.max(0, row.unreadCount),
      quota:
        row.quotaLimitBytes !== null && row.quotaLimitBytes > 0
          ? { usedBytes: row.quotaUsedBytes ?? 0, limitBytes: row.quotaLimitBytes }
          : null,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toRedactedMailAccount(row: MailAccountRow, owner: OwnerRef): RedactedMailAccount {
  return {
    id: row.id,
    kind: 'personal',
    provider: row.provider as MailProvider,
    displayName: row.displayName,
    emailAddress: row.emailAddress,
    color: row.color as MailAccountColor,
    avatarUrl: avatarUrlOf(row),
    owner,
    redacted: true,
    sync: {
      state: row.syncState as MailSyncState,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
    },
  };
}

// ── Larangan alamat ganda (dua arah) ──────────────────────────────────────

/** Alamat dipakai Channel Email hidup (alamat utama ATAU alias). */
export async function addressIsInboxChannel(
  db: DbExecutor,
  organizationId: string,
  address: string,
): Promise<boolean> {
  const [hit] = await db
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
  return hit !== undefined;
}

/** Alamat sudah akun Email hidup lain (selain `exceptId`). */
export async function addressIsMailAccount(
  db: DbExecutor,
  organizationId: string,
  address: string,
  exceptId?: string,
): Promise<boolean> {
  const [hit] = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(
      and(
        eq(mailAccounts.organizationId, organizationId),
        eq(mailAccounts.emailAddress, address),
        isNull(mailAccounts.deletedAt),
        exceptId ? sql`${mailAccounts.id} <> ${exceptId}` : undefined,
      ),
    )
    .limit(1);
  return hit !== undefined;
}

export function conflict(reason: string, message: string, field = 'emailAddress'): AppError {
  return new AppError('CONFLICT', {
    message,
    details: [{ location: 'body', field, message, reason }],
  });
}

export function inboxChannelConflict(canManageChannels: boolean): AppError {
  return conflict(
    'address_is_inbox_channel',
    `Alamat ini sudah dipakai sebagai Channel Email di Inbox. Satu alamat hanya bisa dipakai di Inbox atau di menu Email. ${
      canManageChannels ? 'Pengaturannya ada di Pengaturan → Channel.' : 'Hubungi Owner/Admin.'
    }`,
  );
}

export const ADDRESS_ALREADY_CONNECTED = 'Alamat ini sudah terhubung sebagai akun email.';

// ── Folder ────────────────────────────────────────────────────────────────

const HIDDEN_ROLES: readonly MailFolderRole[] = ['all', 'flagged'];

export function sortFolders(rows: readonly MailFolderRow[]): MailFolderRow[] {
  const rank = (row: MailFolderRow) =>
    row.role ? MAIL_FOLDER_ROLE_ORDER.indexOf(row.role as MailFolderRole) : 100;
  return [...rows]
    .filter((row) => !(row.role && HIDDEN_ROLES.includes(row.role as MailFolderRole)))
    .sort(
      (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'id', { sensitivity: 'base' }),
    );
}

export function toMailFolder(row: MailFolderRow): MailFolder {
  return {
    id: row.id,
    accountId: row.accountId,
    path: row.path,
    name: row.name,
    role: (row.role as MailFolderRole | null) ?? null,
    parentId: row.parentId,
    depth: row.depth,
    selectable: row.selectable,
    unreadCount: Math.max(0, row.unreadCount),
    totalCount: Math.max(0, row.totalCount),
    syncEnabled: row.syncEnabled,
    hasOlderOnServer: row.hasOlderOnServer,
  };
}

export async function foldersOf(
  db: DbExecutor,
  organizationId: string,
  accountIds: readonly string[],
): Promise<Map<string, MailFolder[]>> {
  const result = new Map<string, MailFolder[]>();
  if (accountIds.length === 0) return result;
  const rows = await db
    .select()
    .from(mailFolders)
    .where(
      and(
        eq(mailFolders.organizationId, organizationId),
        inArray(mailFolders.accountId, [...accountIds]),
      ),
    );
  const byAccount = new Map<string, MailFolderRow[]>();
  for (const row of rows)
    byAccount.set(row.accountId, [...(byAccount.get(row.accountId) ?? []), row]);
  for (const id of accountIds) {
    result.set(id, sortFolders(byAccount.get(id) ?? []).map(toMailFolder));
  }
  return result;
}
