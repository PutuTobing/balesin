import type { MailIdentityApprovalState } from '@balesin/shared';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

import type { DbExecutor } from './client';
import { channels } from './schema/channels';
import { emailSettings } from './schema/email-settings';
import { mailAccounts, mailIdentities } from './schema/mail';

/**
 * Penjaga identitas pengirim menu Email yang dipakai api DAN worker (review keamanan 9B):
 *  - S2: kotak surat Email pengirim sistem = akun Email MANA PUN di organisasi → verifikasi alamat
 *    terkunci di SELURUH organisasi (salinan email ber-kode di Terkirim terbaca pembaca akun itu).
 *  - S3: identitas akun PRIBADI berdomain organisasi wajib disetujui Owner/Admin.
 * Semua query terfilter `organization_id`.
 */

/** Kotak surat Email pengirim sistem (alamat + login SMTP). */
export interface MailSystemSenderMailbox {
  address: string;
  host: string | null;
  username: string | null;
}

const norm = (value: string | null | undefined) => value?.trim().toLowerCase() ?? '';

/** Domain huruf kecil dari alamat, atau `null`. */
export function mailAddressDomain(address: string | null | undefined): string | null {
  const value = norm(address);
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  return value.slice(at + 1);
}

/**
 * Akun Email hidup yang kotak suratnya = kotak surat Email pengirim sistem: alamat akun / identitasnya =
 * alamat pengirim sistem, ATAU host + username SMTP/IMAP akun = host + username SMTP sistem.
 */
export async function mailAccountsMatchingSystemSender(
  db: DbExecutor,
  organizationId: string,
  sender: MailSystemSenderMailbox | null,
  options: { includeIdentities?: boolean } = {},
): Promise<string[]> {
  const includeIdentities = options.includeIdentities ?? true;
  if (!sender) return [];
  const address = norm(sender.address);
  const host = norm(sender.host);
  const username = norm(sender.username);
  const sameMailbox =
    host && username
      ? or(
          and(
            sql`lower(trim(${mailAccounts.smtpHost})) = ${host}`,
            sql`lower(trim(case when ${mailAccounts.smtpSameCredentials} then ${mailAccounts.imapUsername} else ${mailAccounts.smtpUsername} end)) = ${username}`,
          ),
          and(
            sql`lower(trim(${mailAccounts.imapHost})) = ${host}`,
            sql`lower(trim(${mailAccounts.imapUsername})) = ${username}`,
          ),
        )
      : undefined;
  const rows = await db
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(
      and(
        eq(mailAccounts.organizationId, organizationId),
        isNull(mailAccounts.deletedAt),
        or(
          address ? eq(mailAccounts.emailAddress, address) : undefined,
          address && includeIdentities
            ? sql`exists (select 1 from ${mailIdentities} where ${mailIdentities.organizationId} = ${mailAccounts.organizationId} and ${mailIdentities.accountId} = ${mailAccounts.id} and ${mailIdentities.address} = ${address})`
            : undefined,
          sameMailbox,
        ),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * Domain organisasi (review 9B S3): domain identitas akun Email BERSAMA yang hidup, alamat & alias
 * Channel Email, alamat Email pengirim sistem (+ `extraAddresses`, mis. cadangan env).
 */
export async function mailOrganizationDomains(
  db: DbExecutor,
  organizationId: string,
  extraAddresses: readonly (string | null | undefined)[] = [],
): Promise<Set<string>> {
  const domains = new Set<string>();
  const add = (address: string | null | undefined) => {
    const domain = mailAddressDomain(address);
    if (domain) domains.add(domain);
  };
  const shared = await db
    .select({ address: mailIdentities.address })
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
        eq(mailAccounts.kind, 'shared'),
        isNull(mailAccounts.deletedAt),
      ),
    );
  for (const row of shared) add(row.address);
  const sharedAccounts = await db
    .select({ address: mailAccounts.emailAddress })
    .from(mailAccounts)
    .where(
      and(
        eq(mailAccounts.organizationId, organizationId),
        eq(mailAccounts.kind, 'shared'),
        isNull(mailAccounts.deletedAt),
      ),
    );
  for (const row of sharedAccounts) add(row.address);
  const emailChannels = await db
    .select({ address: channels.emailAddress, aliases: channels.emailAliases })
    .from(channels)
    .where(
      and(
        eq(channels.organizationId, organizationId),
        eq(channels.type, 'email'),
        isNull(channels.deletedAt),
      ),
    );
  for (const row of emailChannels) {
    add(row.address);
    for (const alias of row.aliases) add(alias);
  }
  const [sender] = await db
    .select({ address: emailSettings.fromAddress })
    .from(emailSettings)
    .where(eq(emailSettings.organizationId, organizationId))
    .limit(1);
  add(sender?.address);
  for (const address of extraAddresses) add(address);
  return domains;
}

/** Keadaan persetujuan efektif satu identitas (perlu/tidaknya dihitung dari domain organisasi). */
export function mailIdentityApprovalStateOf(
  identity: { address: string; approvalState: string | null },
  accountKind: string,
  organizationDomains: ReadonlySet<string>,
): MailIdentityApprovalState {
  if (accountKind !== 'personal') return 'not_required';
  const domain = mailAddressDomain(identity.address);
  if (!domain || !organizationDomains.has(domain)) return 'not_required';
  if (identity.approvalState === 'approved') return 'approved';
  if (identity.approvalState === 'rejected') return 'rejected';
  return 'pending';
}

/** Boleh diverifikasi & dipakai mengirim (dari sisi persetujuan). */
export function mailIdentityApprovalAllows(state: MailIdentityApprovalState): boolean {
  return state === 'not_required' || state === 'approved';
}
