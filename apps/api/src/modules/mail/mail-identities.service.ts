import {
  AppError,
  mailIdentityVerificationContext,
  mailMessageIdHash,
  newMailVerificationCode,
  newMailVerificationMessageId,
  type MailComposeKeys,
  type MailEventPublisher,
  type SecretBox,
} from '@balesin/core';
import {
  accessibleMailAccountsOf,
  lockEmailAddresses,
  mailAccounts,
  mailDrafts,
  mailIdentities,
  mailIdentityApprovalStateOf,
  mailOrganizationDomains,
  mailSignatures,
  users,
  type Database,
  type MailAccountRow,
  type MailIdentityRow,
} from '@balesin/db';
import {
  MAIL_ALIASES_PER_ACCOUNT_MAX,
  MAIL_COMPOSE_MESSAGES,
  MAIL_VERIFICATION_AUTO_CHECK_MINUTES,
  MAIL_VERIFICATION_LIMITS,
  MAIL_VERIFICATION_MAX_ATTEMPTS,
  MAIL_VERIFICATION_TTL_MINUTES,
  MAIL_VERIFICATION_UNAVAILABLE_MESSAGES,
  canMailSend,
  hasPermission,
  mailDomainOf,
  type CreateMailIdentityRequest,
  type MailComposeIdentityListResponse,
  type MailIdentity,
  type MailIdentityApprovalListResponse,
  type MailIdentityApprovalRequest,
  type MailVerificationUnavailableReason,
  type UpdateMailIdentityRequest,
} from '@balesin/shared';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { RateLimiter, RateLimitRule } from '../../http/rate-limit';
import type { EmailNotifier } from '../../queues/email-queue';
import type { MailJobEnqueuer } from '../../queues/mail-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { ACCESS_RULES, forbidByRule, type AccessDeniedRecorder } from '../auth/access-denied';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { findActiveOwners } from '../team/team.repo';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorService } from '../two-factor/two-factor.service';
import { createComposeAccess } from './mail-compose-access';
import {
  IDENTITY_RESET,
  addressHoldersOf,
  addressInUse,
  addressUsedElsewhere,
  claimAddressForOrganization,
  detailError,
  identitiesOf,
  identityUnavailableReason,
  loadIdentity,
  normalizeAddress,
  notifyApprovalRequest,
  notifyRevokedClaims,
  organizationVerificationBlock,
  recordApprovalRequest,
  systemSenderOf,
  toMailIdentity,
  type RevokedClaim,
  type SystemSenderFallback,
} from './mail-compose.repo';
import { avatarUrlOf, isUuid, loadAccountRow, mailNotFound } from './mail.repo';
import type { MailContext } from './mail.service';

/**
 * Identitas & verifikasi alamat pengirim (KONTRAK-API-EMAIL-TULIS §3). Aturan inti:
 *  - Email hanya dikirim dari identitas `verified` — utama & alias sama-sama wajib, TANPA jalan
 *    pintas Owner/Admin (menutup sisa risiko S4 review 9A-1).
 *  - Email verifikasi lewat Email pengirim SISTEM (rute MX asli), bukan SMTP akun yang bisa dikuasai
 *    pendaftar. Kotak surat akun = kotak surat pengirim sistem → `system_sender_conflict` (terkunci).
 *  - Bukti: `Message-ID` rahasia ditemukan di folder MASUK akun ini saat sinkron (dicocokkan LOKAL;
 *    nilainya tidak pernah dikirim ke server IMAP akun — review 9B S1) ATAU kode 6 digit.
 *  - Review 9B S2: kotak surat Email pengirim sistem = akun Email MANA PUN → verifikasi seluruh
 *    organisasi terkunci (`system_sender_conflict`).
 *  - Review 9B S3: identitas akun PRIBADI berdomain organisasi wajib disetujui Owner/Admin dulu.
 *  - Review 9B S4: klaim akun pribadi yang belum terverifikasi tidak menghalangi Owner/Admin.
 *  - Alamat identitas unik di organisasi (akun lain, Channel Email + alias, pengirim sistem) di bawah
 *    advisory lock `email-address:<org>:<alamat>`.
 *  - Alias akun bersama = `mail.accounts.manage` + konfirmasi identitas; akun pribadi = pemilik.
 * Kode & `Message-ID` tidak pernah keluar ke browser/log (HMAC/SHA-256 + salinan terenkripsi
 * sementara untuk worker).
 */

const VERIFY_IDENTITY_RULE: RateLimitRule = {
  name: 'mail-verifikasi-identitas',
  limit: MAIL_VERIFICATION_LIMITS.perIdentity,
  windowSeconds: MAIL_VERIFICATION_LIMITS.windowSeconds,
};
const VERIFY_USER_RULE: RateLimitRule = {
  name: 'mail-verifikasi-pengguna',
  limit: MAIL_VERIFICATION_LIMITS.perUser,
  windowSeconds: MAIL_VERIFICATION_LIMITS.windowSeconds,
};
const VERIFY_ORG_RULE: RateLimitRule = {
  name: 'mail-verifikasi-organisasi',
  limit: MAIL_VERIFICATION_LIMITS.perOrganization,
  windowSeconds: MAIL_VERIFICATION_LIMITS.windowSeconds,
};
export const VERIFY_CODE_RULE: RateLimitRule = {
  name: 'mail-kode-verifikasi',
  limit: 20,
  windowSeconds: 60 * 60,
};

const CONFIRM_ALIAS =
  'Masukkan password-mu (dan kode verifikasi dua langkah) untuk menambah alamat pengirim di akun email bersama.';
const CONFIRM_APPROVAL =
  'Masukkan password-mu (dan kode verifikasi dua langkah) untuk menyetujui atau menolak alamat pengirim akun pribadi.';
const APPROVALS_MAX = 200;
const VERIFY_CHECK_DELAY_MS = 60_000;

export interface MailIdentitiesServiceDeps {
  db: Database;
  secretBox: SecretBox | null;
  keys: MailComposeKeys;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  notifier: Pick<EmailNotifier, 'securityNoticeAdmin'>;
  accessDenied: AccessDeniedRecorder;
  publisher: MailEventPublisher;
  limiter: RateLimiter;
  queue?: MailJobEnqueuer;
  systemSenderFallback: SystemSenderFallback | null;
  now?: () => Date;
}

export function createMailIdentitiesService(deps: MailIdentitiesServiceDeps) {
  const { db, keys, limiter, publisher } = deps;
  const now = deps.now ?? (() => new Date());
  const access = createComposeAccess({ db, accessDenied: deps.accessDenied });

  /** Blok verifikasi tingkat organisasi (S2) + domain organisasi (S3). */
  async function guardContext(organizationId: string) {
    const sender = await systemSenderOf(db, organizationId, deps.systemSenderFallback);
    const [unavailable, domains] = await Promise.all([
      organizationVerificationBlock(db, organizationId, sender),
      mailOrganizationDomains(db, organizationId),
    ]);
    return { sender, unavailable, domains };
  }

  async function viewAll(
    auth: AuthContext,
    account: MailAccountRow,
    level: Parameters<typeof toMailIdentity>[1]['level'],
  ): Promise<MailIdentity[]> {
    const rows = await identitiesOf(db, auth.organizationId, [account.id]);
    const { unavailable, domains } = await guardContext(auth.organizationId);
    return rows.map((row) =>
      toMailIdentity(row, {
        now: now(),
        role: auth.user.role,
        level,
        account,
        unavailable,
        domains,
      }),
    );
  }

  /**
   * Verifikasi boleh dimulai/diselesaikan: blok organisasi (S2), persetujuan (S3), dan — untuk akun
   * pribadi — alamatnya belum dipegang pemegang lain (S4: klaim yang dicabut tetap tertahan).
   */
  async function assertVerifiable(
    executor: Parameters<typeof loadIdentity>[0],
    auth: AuthContext,
    account: MailAccountRow,
    identity: MailIdentityRow,
    field: string,
  ): Promise<void> {
    const { sender, unavailable, domains } = await guardContext(auth.organizationId);
    const approval = mailIdentityApprovalStateOf(identity, account.kind, domains);
    const reason: MailVerificationUnavailableReason | null = identityUnavailableReason(
      unavailable,
      approval,
    );
    if (reason) {
      throw detailError(
        'CONFLICT',
        'verification_unavailable',
        MAIL_VERIFICATION_UNAVAILABLE_MESSAGES[reason],
        field,
        { cause: reason },
      );
    }
    if (account.kind === 'personal') {
      const holders = await addressHoldersOf(executor, auth.organizationId, identity.address, {
        systemSender: sender,
        exceptIdentityId: identity.id,
      });
      if (holders.length > 0) throw addressInUse(field);
    }
  }

  async function viewOne(auth: AuthContext, identityId: string): Promise<MailIdentity> {
    const identity = await loadIdentity(db, auth.organizationId, identityId);
    if (!identity) throw mailNotFound();
    const { row, level } = await access.load(auth, identity.accountId);
    const list = await viewAll(auth, row, level);
    const found = list.find((item) => item.id === identity.id);
    if (!found) throw mailNotFound();
    return found;
  }

  /** Identitas + akunnya + level pelaku (404 bila tidak ada / tanpa hak). */
  async function loadOwned(auth: AuthContext, identityId: string) {
    if (!isUuid(identityId)) throw mailNotFound();
    const identity = await loadIdentity(db, auth.organizationId, identityId);
    if (!identity) throw mailNotFound();
    const loaded = await access.load(auth, identity.accountId);
    return { identity, ...loaded };
  }

  /** Tambah/hapus alias: bersama = `mail.accounts.manage` (+ konfirmasi saat tambah); pribadi = pemilik. */
  async function requireAliasRight(
    auth: AuthContext,
    account: MailAccountRow,
    context: MailContext,
  ): Promise<void> {
    if (account.kind === 'personal') {
      // `load` sudah 404 untuk akun pribadi orang lain.
      if (account.ownerUserId !== auth.user.id) throw mailNotFound();
      return;
    }
    if (!hasPermission(auth.user.role, 'mail.accounts.manage')) {
      await forbidByRule(deps.accessDenied, {
        auth,
        rule: ACCESS_RULES.mailAccountLevel,
        client: context.client,
        details: { required: 'mail.accounts.manage' },
        message:
          'Hanya Owner/Admin yang bisa menambah atau menghapus alamat pengirim akun bersama.',
      });
    }
  }

  /** Owner/Admin (`mail.accounts.manage`) — selain itu 403 + catatan akses ditolak. */
  async function requireApprover(auth: AuthContext, context: MailContext): Promise<void> {
    if (hasPermission(auth.user.role, 'mail.accounts.manage')) return;
    await forbidByRule(deps.accessDenied, {
      auth,
      rule: ACCESS_RULES.mailAccountLevel,
      client: context.client,
      details: { required: 'mail.accounts.manage' },
      message: 'Hanya Owner/Admin yang bisa menyetujui alamat pengirim akun pribadi.',
    });
  }

  function publishIdentity(identity: MailIdentityRow) {
    return publisher.publish([
      {
        organizationId: identity.organizationId,
        accountId: identity.accountId,
        event: {
          type: 'mail.identity.updated',
          accountId: identity.accountId,
          identityId: identity.id,
          verificationState: identity.verificationState as 'unverified' | 'pending' | 'verified',
        },
      },
    ]);
  }

  function auditTargetMetadata(
    account: MailAccountRow,
    identity: Pick<MailIdentityRow, 'id' | 'address'>,
  ) {
    // Akun pribadi: ID saja (privasi kotak surat pribadi).
    return account.kind === 'personal'
      ? { accountId: account.id, identityId: identity.id, kind: 'personal' }
      : {
          accountId: account.id,
          identityId: identity.id,
          kind: 'shared',
          address: identity.address,
          accountAddress: account.emailAddress,
        };
  }

  async function consumeVerificationLimits(auth: AuthContext, identityId: string) {
    const checks: [RateLimitRule, string][] = [
      [VERIFY_IDENTITY_RULE, `${auth.organizationId}:${identityId}`],
      [VERIFY_USER_RULE, auth.user.id],
      [VERIFY_ORG_RULE, auth.organizationId],
    ];
    const taken: [RateLimitRule, string][] = [];
    for (const [rule, key] of checks) {
      const state = await limiter.consume(rule, key);
      taken.push([rule, key]);
      if (!state.allowed) {
        for (const [takenRule, takenKey] of taken) {
          await limiter.refund(takenRule, takenKey).catch(() => undefined);
        }
        throw detailError(
          'RATE_LIMITED',
          'verification_send_limit',
          MAIL_COMPOSE_MESSAGES.verificationSendLimit,
          'identityId',
          {},
          { retryAfterSeconds: state.retryAfterSeconds },
        );
      }
    }
  }

  const service = {
    /** Pilihan "Dari" di jendela tulis (§3.4): semua akun ber-level ≥ send + `mail.send`. */
    async composeIdentities(auth: AuthContext): Promise<MailComposeIdentityListResponse> {
      if (!hasPermission(auth.user.role, 'mail.send')) return { identities: [] };
      const levels = await accessibleMailAccountsOf(db, auth.organizationId, auth.user.id);
      const sendable = [...levels.entries()].filter(([, level]) =>
        canMailSend(auth.user.role, level),
      );
      if (sendable.length === 0) return { identities: [] };
      const accounts = await db
        .select()
        .from(mailAccounts)
        .where(
          and(
            eq(mailAccounts.organizationId, auth.organizationId),
            inArray(
              mailAccounts.id,
              sendable.map(([id]) => id),
            ),
            isNull(mailAccounts.deletedAt),
          ),
        );
      const rows = await identitiesOf(
        db,
        auth.organizationId,
        accounts.map((account) => account.id),
      );
      const { unavailable, domains } = await guardContext(auth.organizationId);
      const result: MailComposeIdentityListResponse['identities'] = [];
      for (const account of accounts.sort((a, b) =>
        a.displayName.localeCompare(b.displayName, 'id', { sensitivity: 'base' }),
      )) {
        const own = rows.filter((row) => row.accountId === account.id);
        for (const row of own) {
          result.push({
            ...toMailIdentity(row, {
              now: now(),
              role: auth.user.role,
              level: levels.get(account.id) ?? null,
              account,
              unavailable,
              domains,
            }),
            account: {
              id: account.id,
              displayName: account.displayName,
              color:
                account.color as MailComposeIdentityListResponse['identities'][number]['account']['color'],
              kind: account.kind as 'shared' | 'personal',
              avatarUrl: avatarUrlOf(account),
            },
          });
        }
      }
      return { identities: result };
    },

    async accountIdentities(auth: AuthContext, accountId: string) {
      const { row, level } = await access.load(auth, accountId);
      return { identities: await viewAll(auth, row, level) };
    },

    async create(
      auth: AuthContext,
      accountId: string,
      input: CreateMailIdentityRequest,
      context: MailContext,
    ): Promise<MailIdentity> {
      const { row: account } = await access.load(auth, accountId);
      await requireAliasRight(auth, account, context);
      const address = normalizeAddress(input.address);
      if (!address) {
        throw detailError(
          'VALIDATION_ERROR',
          'recipient_invalid',
          'Alamat email tidak valid. Contoh: tagihan@perusahaan.co.id',
          'address',
        );
      }
      const replyTo = input.replyTo ? normalizeAddress(input.replyTo) : null;
      if (input.replyTo && (!replyTo || mailDomainOf(replyTo) !== mailDomainOf(address))) {
        throw detailError(
          'VALIDATION_ERROR',
          'reply_to_not_allowed',
          MAIL_COMPOSE_MESSAGES.replyToNotAllowed,
          'replyTo',
        );
      }
      if (account.kind === 'shared') {
        await requireIdentityConfirmation(
          deps.twoFactor,
          auth,
          input.confirmation,
          'mail.identity.create',
          context,
          CONFIRM_ALIAS,
        );
      }
      const sender = await systemSenderOf(db, auth.organizationId, deps.systemSenderFallback);
      const domains = await mailOrganizationDomains(db, auth.organizationId);
      let revoked: RevokedClaim[] = [];
      let approvalAuditId: string | null = null;
      const created = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(
          tx,
          auth,
          account.kind === 'shared' ? 'mail.accounts.manage' : 'mail.private.own',
          context.log,
        );
        await lockEmailAddresses(tx, auth.organizationId, [address]);
        const locked = await loadAccountRow(tx, auth.organizationId, account.id, {
          forUpdate: true,
        });
        if (!locked) throw mailNotFound();
        if (account.kind === 'shared') {
          // Review 9B S4: alias BERSAMA (Owner/Admin) — klaim lemah akun pribadi dicabut, pemegang
          // kuat → 409 yang menyebut pemegangnya.
          revoked = await claimAddressForOrganization(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            role: auth.user.role,
            address,
            systemSender: sender,
            domains,
            client: context.client,
          });
        } else if (
          await addressUsedElsewhere(tx, auth.organizationId, address, { systemSender: sender })
        ) {
          throw addressInUse();
        }
        const [aliases] = await tx
          .select({ value: count() })
          .from(mailIdentities)
          .where(
            and(
              eq(mailIdentities.organizationId, auth.organizationId),
              eq(mailIdentities.accountId, account.id),
              eq(mailIdentities.isPrimary, false),
            ),
          );
        if ((aliases?.value ?? 0) >= MAIL_ALIASES_PER_ACCOUNT_MAX) {
          throw detailError('CONFLICT', 'alias_limit', MAIL_COMPOSE_MESSAGES.aliasLimit, 'address');
        }
        const [inserted] = await tx
          .insert(mailIdentities)
          .values({
            organizationId: auth.organizationId,
            accountId: account.id,
            address,
            displayName: input.displayName,
            isPrimary: false,
            replyTo,
            createdByUserId: auth.user.id,
          })
          .returning();
        if (!inserted) throw new Error('Identitas tidak tersimpan');
        approvalAuditId = await recordApprovalRequest(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          accountKind: account.kind,
          accountId: account.id,
          identity: inserted,
          domains,
          client: context.client,
        });
        const auditLogId = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.mailIdentityCreated,
          targetType: 'mail_account',
          targetId: account.id,
          metadata: { ...auditTargetMetadata(account, inserted), actorRole: auth.user.role },
          client: context.client,
        });
        if (account.kind === 'shared' && auth.user.role !== 'owner') {
          const owners = await findActiveOwners(tx, auth.organizationId, [auth.user.id]);
          for (const recipientUserId of owners) {
            await deps.notifier
              .securityNoticeAdmin({
                organizationId: auth.organizationId,
                recipientUserId,
                subjectUserId: auth.user.id,
                event: 'mail_identity_added',
                occurredAt: now().toISOString(),
                auditLogId,
              })
              .catch(() => undefined);
          }
        }
        return inserted;
      });
      await publishIdentity(created);
      await notifyRevokedClaims(
        deps.notifier,
        { organizationId: auth.organizationId, actorUserId: auth.user.id, occurredAt: now() },
        revoked,
      );
      const requested = approvalAuditId as string | null;
      if (requested) {
        await notifyApprovalRequest(db, deps.notifier, {
          organizationId: auth.organizationId,
          requesterUserId: auth.user.id,
          auditLogId: requested,
          occurredAt: now(),
        });
      }
      // Verifikasi langsung dimulai bila tersedia (usaha terbaik: gagal tidak menggagalkan pembuatan).
      try {
        await service.startVerification(auth, created.id, context);
      } catch {
        // `verification_unavailable` / batas — UI menampilkan tombol "Kirim kode".
      }
      return viewOne(auth, created.id);
    },

    async update(
      auth: AuthContext,
      identityId: string,
      input: UpdateMailIdentityRequest,
      context: MailContext,
    ): Promise<MailIdentity> {
      const { identity, row: account } = await loadOwned(auth, identityId);
      await access.require(auth, account.id, 'manage', context.client);
      const changes: Partial<MailIdentityRow> = {};
      const changedFields: string[] = [];
      if (input.displayName !== undefined && input.displayName !== identity.displayName) {
        changes.displayName = input.displayName;
        changedFields.push('displayName');
      }
      if (input.replyTo !== undefined) {
        const replyTo = input.replyTo === null ? null : normalizeAddress(input.replyTo);
        if (
          input.replyTo !== null &&
          (!replyTo || mailDomainOf(replyTo) !== mailDomainOf(identity.address))
        ) {
          throw detailError(
            'VALIDATION_ERROR',
            'reply_to_not_allowed',
            MAIL_COMPOSE_MESSAGES.replyToNotAllowed,
            'replyTo',
          );
        }
        if (replyTo !== identity.replyTo) {
          changes.replyTo = replyTo;
          changedFields.push('replyTo');
        }
      }
      for (const [field, column] of [
        ['defaultSignatureNewId', 'defaultSignatureNewId'],
        ['defaultSignatureReplyId', 'defaultSignatureReplyId'],
      ] as const) {
        const value = input[field];
        if (value === undefined || value === identity[column]) continue;
        if (value !== null) {
          // Hanya tanda tangan BERSAMA akun yang sama.
          const [signature] = await db
            .select({ id: mailSignatures.id })
            .from(mailSignatures)
            .where(
              and(
                eq(mailSignatures.organizationId, auth.organizationId),
                eq(mailSignatures.id, value),
                eq(mailSignatures.accountId, account.id),
                isNull(mailSignatures.ownerUserId),
              ),
            )
            .limit(1);
          if (!signature) {
            throw detailError(
              'VALIDATION_ERROR',
              'signature_not_found',
              'Tanda tangan bawaan harus tanda tangan bersama akun ini.',
              field,
            );
          }
        }
        changes[column] = value;
        changedFields.push(field);
      }
      if (changedFields.length === 0) return viewOne(auth, identity.id);
      await db.transaction(async (tx) => {
        await tx
          .update(mailIdentities)
          .set(changes)
          .where(
            and(
              eq(mailIdentities.organizationId, auth.organizationId),
              eq(mailIdentities.id, identity.id),
            ),
          );
        if (identity.isPrimary && changes.displayName) {
          await tx
            .update(mailAccounts)
            .set({ fromName: changes.displayName })
            .where(
              and(
                eq(mailAccounts.organizationId, auth.organizationId),
                eq(mailAccounts.id, account.id),
              ),
            );
        }
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.mailIdentityUpdated,
          targetType: 'mail_account',
          targetId: account.id,
          metadata: { ...auditTargetMetadata(account, identity), changedFields },
          client: context.client,
        });
      });
      return viewOne(auth, identity.id);
    },

    async remove(auth: AuthContext, identityId: string, context: MailContext) {
      const { identity, row: account } = await loadOwned(auth, identityId);
      await requireAliasRight(auth, account, context);
      if (identity.isPrimary) {
        throw detailError(
          'VALIDATION_ERROR',
          'primary_identity',
          MAIL_COMPOSE_MESSAGES.primaryIdentity,
          'identityId',
        );
      }
      const moved = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(
          tx,
          auth,
          account.kind === 'shared' ? 'mail.accounts.manage' : 'mail.private.own',
          context.log,
        );
        const [primary] = await tx
          .select({ id: mailIdentities.id })
          .from(mailIdentities)
          .where(
            and(
              eq(mailIdentities.organizationId, auth.organizationId),
              eq(mailIdentities.accountId, account.id),
              eq(mailIdentities.isPrimary, true),
            ),
          )
          .limit(1);
        if (!primary) throw mailNotFound();
        // Draf yang memakai alias ini dipindah ke identitas utama (transaksi yang sama).
        const drafts = await tx
          .update(mailDrafts)
          .set({ identityId: primary.id, version: sql`${mailDrafts.version} + 1` })
          .where(
            and(
              eq(mailDrafts.organizationId, auth.organizationId),
              eq(mailDrafts.identityId, identity.id),
            ),
          )
          .returning({ id: mailDrafts.id });
        await tx
          .delete(mailIdentities)
          .where(
            and(
              eq(mailIdentities.organizationId, auth.organizationId),
              eq(mailIdentities.id, identity.id),
            ),
          );
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.mailIdentityDeleted,
          targetType: 'mail_account',
          targetId: account.id,
          metadata: {
            ...auditTargetMetadata(account, identity),
            movedDrafts: drafts.length,
            actorRole: auth.user.role,
          },
          client: context.client,
        });
        return drafts.length;
      });
      await publishIdentity({ ...identity, verificationState: 'unverified' });
      return { deleted: true as const, movedDrafts: moved };
    },

    /** Mulai / kirim ulang verifikasi (§3.2 langkah 1). */
    async startVerification(auth: AuthContext, identityId: string, context: MailContext) {
      const { identity, row: account } = await loadOwned(auth, identityId);
      await access.require(auth, account.id, 'manage', context.client);
      if (identity.verificationState === 'verified') {
        throw detailError(
          'CONFLICT',
          'already_verified',
          MAIL_COMPOSE_MESSAGES.alreadyVerified,
          'identityId',
        );
      }
      await assertVerifiable(db, auth, account, identity, 'identityId');
      const box = deps.secretBox;
      if (!box) {
        throw new AppError('SERVICE_UNAVAILABLE', {
          message:
            'Kode verifikasi belum bisa dibuat karena BALESIN_MASTER_KEY belum diisi di berkas .env server.',
          details: [
            {
              location: 'body',
              field: 'identityId',
              message: 'BALESIN_MASTER_KEY kosong.',
              reason: 'master_key_missing',
            },
          ],
        });
      }
      await consumeVerificationLimits(auth, identity.id);
      const sender = await systemSenderOf(db, auth.organizationId, deps.systemSenderFallback);
      const domain = (sender?.address ?? identity.address).split('@')[1] ?? 'balesin.invalid';
      const code = newMailVerificationCode();
      const messageId = newMailVerificationMessageId(domain);
      const at = now();
      const updated = await db.transaction(async (tx) => {
        await lockEmailAddresses(tx, auth.organizationId, [identity.address]);
        const locked = await loadIdentity(tx, auth.organizationId, identity.id, {
          forUpdate: true,
        });
        if (!locked) throw mailNotFound();
        if (locked.verificationState === 'verified') {
          throw detailError(
            'CONFLICT',
            'already_verified',
            MAIL_COMPOSE_MESSAGES.alreadyVerified,
            'identityId',
          );
        }
        await assertVerifiable(tx, auth, account, locked, 'identityId');
        const [saved] = await tx
          .update(mailIdentities)
          .set({
            verificationState: 'pending',
            verifiedAt: null,
            verifiedMethod: null,
            verificationCodeHash: keys.hashVerificationCode(identity.id, code),
            verificationMessageIdHash: mailMessageIdHash(messageId),
            verificationSecretEncrypted: box.encrypt(
              JSON.stringify({ code, messageId }),
              mailIdentityVerificationContext(auth.organizationId, identity.id),
            ),
            verificationSentAt: null,
            verificationExpiresAt: new Date(at.getTime() + MAIL_VERIFICATION_TTL_MINUTES * 60_000),
            verificationAttempts: 0,
            verificationRequestedByUserId: auth.user.id,
          })
          .where(
            and(
              eq(mailIdentities.organizationId, auth.organizationId),
              eq(mailIdentities.id, identity.id),
            ),
          )
          .returning();
        if (!saved) throw mailNotFound();
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.mailIdentityVerificationStarted,
          targetType: 'mail_account',
          targetId: account.id,
          metadata: auditTargetMetadata(account, identity),
          client: context.client,
        });
        return saved;
      });
      // Tanpa produsen (tes) worker mengambilnya dari tick (salinan terenkripsi, `sent_at` kosong).
      await deps.queue
        ?.identityVerification?.({ organizationId: auth.organizationId, identityId: identity.id })
        .catch((err: unknown) => {
          context.log.warn({ err, identityId: identity.id }, 'Gagal mengantre email verifikasi');
        });
      await deps.queue
        ?.verifyCheck?.(
          { organizationId: auth.organizationId, accountId: account.id, identityId: identity.id },
          VERIFY_CHECK_DELAY_MS,
        )
        .catch(() => undefined);
      await publishIdentity(updated);
      const view = await viewOne(auth, identity.id);
      return { verification: view.verification };
    },

    /** Masukkan kode (§3.2 langkah 3, `verified_method: code`). */
    async confirm(auth: AuthContext, identityId: string, code: string, context: MailContext) {
      const { identity, row: account } = await loadOwned(auth, identityId);
      await access.require(auth, account.id, 'manage', context.client);
      const outcome = await db.transaction(async (tx) => {
        await lockEmailAddresses(tx, auth.organizationId, [identity.address]);
        const locked = await loadIdentity(tx, auth.organizationId, identity.id, {
          forUpdate: true,
        });
        if (!locked) throw mailNotFound();
        if (locked.verificationState === 'verified') {
          throw detailError(
            'CONFLICT',
            'already_verified',
            MAIL_COMPOSE_MESSAGES.alreadyVerified,
            'code',
          );
        }
        // Review 9B S2/S3/S4: kode TIDAK diterima selama verifikasi terkunci (kode mungkin sudah
        // terbaca lewat Terkirim pengirim sistem / alamat belum disetujui / sudah dipegang organisasi).
        await assertVerifiable(tx, auth, account, locked, 'code');
        if (
          locked.verificationState !== 'pending' ||
          !locked.verificationCodeHash ||
          !locked.verificationExpiresAt ||
          locked.verificationExpiresAt.getTime() <= now().getTime()
        ) {
          return { kind: 'expired' as const };
        }
        if (keys.verificationCodeMatches(locked.id, code, locked.verificationCodeHash)) {
          const [saved] = await tx
            .update(mailIdentities)
            .set({
              ...IDENTITY_RESET,
              verificationState: 'verified',
              verifiedAt: now(),
              verifiedMethod: 'code',
            })
            .where(eq(mailIdentities.id, locked.id))
            .returning();
          await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.mailIdentityVerified,
            targetType: 'mail_account',
            targetId: account.id,
            metadata: { ...auditTargetMetadata(account, locked), method: 'code' },
            client: context.client,
          });
          return { kind: 'verified' as const, row: saved ?? locked };
        }
        const attempts = locked.verificationAttempts + 1;
        if (attempts >= MAIL_VERIFICATION_MAX_ATTEMPTS) {
          const [saved] = await tx
            .update(mailIdentities)
            .set(IDENTITY_RESET)
            .where(eq(mailIdentities.id, locked.id))
            .returning();
          await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.mailIdentityVerificationFailed,
            targetType: 'mail_account',
            targetId: account.id,
            metadata: { ...auditTargetMetadata(account, locked), reason: 'attempts_exhausted' },
            client: context.client,
          });
          return { kind: 'invalid' as const, left: 0, row: saved ?? locked };
        }
        await tx
          .update(mailIdentities)
          .set({ verificationAttempts: attempts })
          .where(eq(mailIdentities.id, locked.id));
        return {
          kind: 'invalid' as const,
          left: MAIL_VERIFICATION_MAX_ATTEMPTS - attempts,
          row: null,
        };
      });
      if (outcome.kind === 'expired') {
        throw detailError(
          'TOKEN_INVALID',
          'verification_expired',
          MAIL_COMPOSE_MESSAGES.verificationExpired,
          'code',
        );
      }
      if (outcome.kind === 'invalid') {
        if (outcome.row) await publishIdentity(outcome.row);
        throw detailError(
          'VALIDATION_ERROR',
          'verification_code_invalid',
          MAIL_COMPOSE_MESSAGES.verificationCodeInvalid(outcome.left),
          'code',
          { attemptsLeft: outcome.left },
        );
      }
      await publishIdentity(outcome.row);
      return { identity: await viewOne(auth, identity.id) };
    },

    /** Review 9B S3 — daftar menunggu persetujuan (Owner/Admin, `mail.accounts.manage`). */
    async approvals(
      auth: AuthContext,
      context: MailContext,
    ): Promise<MailIdentityApprovalListResponse> {
      await requireApprover(auth, context);
      const { domains } = await guardContext(auth.organizationId);
      const rows = await db
        .select({
          identity: mailIdentities,
          ownerId: users.id,
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
            eq(mailIdentities.organizationId, auth.organizationId),
            eq(mailAccounts.kind, 'personal'),
            isNull(mailAccounts.deletedAt),
            isNull(mailIdentities.approvalState),
          ),
        )
        .orderBy(sql`${mailIdentities.createdAt} desc`)
        .limit(2_000);
      return {
        approvals: rows
          .filter(
            (row) => mailIdentityApprovalStateOf(row.identity, 'personal', domains) === 'pending',
          )
          .slice(0, APPROVALS_MAX)
          .map((row) => ({
            identityId: row.identity.id,
            accountId: row.identity.accountId,
            address: row.identity.address,
            displayName: row.identity.displayName,
            isPrimary: row.identity.isPrimary,
            owner: row.ownerId ? { id: row.ownerId, name: row.ownerName ?? '' } : null,
            createdAt: row.identity.createdAt.toISOString(),
          })),
      };
    },

    /**
     * Review 9B S3 — setujui/tolak identitas akun PRIBADI berdomain organisasi (Owner/Admin +
     * konfirmasi identitas). Admin tidak bisa memutuskan alamat akun pribadinya sendiri. Tolak = juga
     * kembali `unverified`. Audit + email ke pemilik akun.
     */
    async decideApproval(
      auth: AuthContext,
      identityId: string,
      input: MailIdentityApprovalRequest,
      context: MailContext,
    ): Promise<MailIdentity> {
      await requireApprover(auth, context);
      if (!isUuid(identityId)) throw mailNotFound();
      const identity = await loadIdentity(db, auth.organizationId, identityId);
      if (!identity) throw mailNotFound();
      const account = await loadAccountRow(db, auth.organizationId, identity.accountId);
      const { domains } = await guardContext(auth.organizationId);
      // Hanya identitas yang MEMANG perlu persetujuan yang terbuka untuk Owner/Admin (akun pribadi
      // lain tetap 404).
      if (
        !account ||
        account.deletedAt !== null ||
        mailIdentityApprovalStateOf(identity, account.kind, domains) === 'not_required'
      ) {
        throw mailNotFound();
      }
      if (account.ownerUserId === auth.user.id && auth.user.role !== 'owner') {
        await forbidByRule(deps.accessDenied, {
          auth,
          rule: ACCESS_RULES.mailAccountLevel,
          client: context.client,
          details: { required: 'owner' },
          message: 'Alamat pengirim akun pribadimu sendiri harus disetujui Owner.',
        });
      }
      await requireIdentityConfirmation(
        deps.twoFactor,
        auth,
        input.confirmation,
        'mail.identity.approval',
        context,
        CONFIRM_APPROVAL,
      );
      const approve = input.decision === 'approve';
      const at = now();
      const decided = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'mail.accounts.manage', context.log);
        const locked = await loadIdentity(tx, auth.organizationId, identity.id, {
          forUpdate: true,
        });
        if (!locked) throw mailNotFound();
        const [saved] = await tx
          .update(mailIdentities)
          .set({
            ...(approve ? {} : IDENTITY_RESET),
            approvalState: approve ? 'approved' : 'rejected',
            approvalDecidedAt: at,
            approvalDecidedByUserId: auth.user.id,
          })
          .where(
            and(
              eq(mailIdentities.organizationId, auth.organizationId),
              eq(mailIdentities.id, locked.id),
            ),
          )
          .returning();
        if (!saved) throw mailNotFound();
        const auditLogId = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: approve ? AUDIT_ACTIONS.mailIdentityApproved : AUDIT_ACTIONS.mailIdentityRejected,
          targetType: 'mail_account',
          targetId: account.id,
          metadata: {
            accountId: account.id,
            identityId: saved.id,
            kind: 'personal',
            address: saved.address,
            isPrimary: saved.isPrimary,
            reason: approve ? 'approved' : 'rejected',
            actorRole: auth.user.role,
          },
          client: context.client,
        });
        return { saved, auditLogId };
      });
      await publishIdentity(decided.saved);
      if (account.ownerUserId && account.ownerUserId !== auth.user.id) {
        await deps.notifier
          .securityNoticeAdmin({
            organizationId: auth.organizationId,
            recipientUserId: account.ownerUserId,
            subjectUserId: account.ownerUserId,
            actorUserId: auth.user.id,
            event: 'mail_identity_decided',
            occurredAt: at.toISOString(),
            auditLogId: decided.auditLogId,
          })
          .catch(() => undefined);
      }
      const view = toMailIdentity(decided.saved, {
        now: now(),
        role: auth.user.role,
        level: null,
        account,
        unavailable: (await guardContext(auth.organizationId)).unavailable,
        domains,
      });
      return view;
    },
  };
  return service;
}

export type MailIdentitiesService = ReturnType<typeof createMailIdentitiesService>;

export { MAIL_VERIFICATION_AUTO_CHECK_MINUTES };
