import {
  AppError,
  defaultMailImapConnector,
  defaultMailSmtpVerifier,
  openMailAccountSecret,
  sealMailAccountSecret,
  secretTail,
  testMailIncoming,
  testMailOutgoing,
  Secret,
  type HostLookup,
  type ImapPolicy,
  type ImapTimeouts,
  type MailEventPublisher,
  type MailImapConnector,
  type MailSmtpVerifier,
  type MediaStore,
  type SecretBox,
  type SmtpPolicy,
  type SmtpTimeouts,
} from '@balesin/core';
import {
  accessibleMailAccountsOf,
  departments,
  lockEmailAddresses,
  mailAccountAccess,
  mailAccountAvatars,
  mailAccounts,
  mailFolders,
  mailIdentities,
  mailMessages,
  mailSettings,
  mailDraftAttachments,
  mailDrafts,
  mailOutbox,
  emailSenderSettings,
  newId,
  mailOrganizationDomains,
  users,
  type Database,
  type DbExecutor,
  type MailAccountRow,
  type NewMailAccountRow,
} from '@balesin/db';
import {
  MAIL_ACCOUNTS_PER_ORGANIZATION_MAX,
  MAIL_ATTACHMENT_TOTAL_MB,
  MAIL_COMPOSE_MESSAGES,
  MAIL_RECIPIENTS_PER_EMAIL,
  MAIL_CACHE_RETENTION_DAYS,
  MAIL_DEFAULT_SYNC_WINDOW_DAYS,
  MAIL_IMAP_PORTS,
  MAIL_INCOMING_OK_MESSAGE,
  MAIL_OUTGOING_OK_MESSAGE,
  MAIL_PERSONAL_ACCOUNTS_PER_USER_MAX,
  MAIL_PORT_NOT_ALLOWED_MESSAGE,
  MAIL_PROVIDER_CARDS,
  MAIL_SMTP_PORTS,
  MAIL_TEST_MESSAGES,
  canMailAdminister,
  hasPermission,
  isMailImplicitManager,
  mailFolderRoleOf,
  mailLevelAtLeast,
  mailMenuVisible,
  mailPortAllowed,
  type CreateMailAccountRequest,
  type DetectMailAccountResponse,
  type IdentityConfirmation,
  type MailAccessLevel,
  type MailAccessUser,
  type MailAccount,
  type MailAccountKind,
  type MailAccountListResponse,
  type MailFolder,
  type MailIncomingTestResult,
  type MailOutgoingTestResult,
  type MailSettings,
  type MailSettingsAccountListResponse,
  type MailSidebarResponse,
  type MailSyncWindowDays,
  type MailTestTarget,
  type TestMailAccountRequest,
  type TestMailAccountResponse,
  type UpdateMailAccountRequest,
  type UpdateMailSettingsRequest,
  type ErrorDetail,
} from '@balesin/shared';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { EmailNotifier } from '../../queues/email-queue';
import type { MailJobEnqueuer } from '../../queues/mail-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { ACCESS_RULES, forbidByRule, type AccessDeniedRecorder } from '../auth/access-denied';
import { assertActorStillAuthorized, authorityChanged } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { findActiveOwners } from '../team/team.repo';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorContext, TwoFactorService } from '../two-factor/two-factor.service';
import { processMailAvatar } from './mail-avatar';
import {
  IDENTITY_RESET,
  addressHeldError,
  addressHoldersOf,
  addressIsMailIdentity,
  claimAddressForOrganization,
  isWeakClaim,
  notifyApprovalRequest,
  notifyRevokedClaims,
  recordApprovalRequest,
  systemSenderConflicts,
  systemSenderOf,
  type AddressHolder,
  type RevokedClaim,
  type SystemSenderFallback,
} from './mail-compose.repo';
import { detectMailAccount, type MailDetectionOptions } from './mail-detection';
import {
  ADDRESS_ALREADY_CONNECTED,
  addressIsInboxChannel,
  addressIsMailAccount,
  avatarUrlOf,
  conflict,
  foldersOf,
  inboxChannelConflict,
  levelOf,
  loadAccountRow,
  mailNotFound,
  ownersOf,
  privateCidrsOf,
  toMailAccount,
  toRedactedMailAccount,
  viewerOf,
} from './mail.repo';

/**
 * Akun Email (Fase 9 tahap 9A, docs/KONTRAK-API-EMAIL.md §4): wizard (deteksi, tes Masuk/Keluar),
 * simpan kredensial terenkripsi, tampilan, status sinkron, sinkron sekarang/jeda/lanjut/putuskan,
 * foto, Pengaturan email, folder & sidebar.
 *
 * Aturan keamanan:
 *  - Hak per akun SELALU dari `resolveMailAccess` (dibaca segar per permintaan). Akun pribadi orang
 *    lain = 404 untuk semua rute isi, termasuk Owner; Owner/Admin hanya melihat metadata `redacted`
 *    di `GET /settings/mail-accounts`.
 *  - Ubah server/kredensial/putuskan: bersama = `mail.accounts.manage`, pribadi = pemilik; wajib
 *    konfirmasi identitas + `assertActorStillAuthorized` di transaksi akhir.
 *  - Buat/ubah server wajib lolos tes Masuk & Keluar di permintaan yang sama (502 bila gagal).
 *  - Host IMAP/SMTP lewat penjaga KETAT (privat hanya allowlist organisasi), port & TLS dibatasi.
 *  - Larangan alamat ganda dua arah dengan Channel Email (advisory lock `email-address:<org>:<alamat>`).
 *  - Password tidak pernah keluar/di-log; audit tanpa username IMAP.
 */

export interface MailServiceDeps {
  db: Database;
  secretBox: SecretBox | null;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  notifier: Pick<EmailNotifier, 'securityNoticeAdmin'>;
  accessDenied: AccessDeniedRecorder;
  publisher: MailEventPublisher;
  queue?: MailJobEnqueuer;
  imap: {
    lookup?: HostLookup;
    testCa?: string;
    timeouts?: Partial<ImapTimeouts>;
    /** HANYA tes: port server tiruan. */
    extraPorts?: readonly number[];
    /** HANYA tes: server tiruan di loopback. */
    allowLoopback?: boolean;
  };
  smtp: {
    lookup?: HostLookup;
    testCa?: string;
    timeouts?: Partial<SmtpTimeouts>;
    extraPorts?: readonly number[];
  };
  detection?: Omit<MailDetectionOptions, 'privateCidrs' | 'allowLoopback'>;
  connector?: MailImapConnector;
  smtpVerifier?: MailSmtpVerifier;
  /** 9B: cadangan Email pengirim sistem dari env (peringatan `system_sender_conflict`). */
  systemSenderFallback?: SystemSenderFallback | null;
  /** 9B: berkas lampiran draf & `.eml` outbox dihapus saat akun diputus. */
  store?: MediaStore | null;
  now?: () => Date;
}

export type MailContext = TwoFactorContext;

const NO_MASTER_KEY_MESSAGE =
  'Kredensial akun email belum bisa disimpan karena BALESIN_MASTER_KEY belum diisi di berkas .env server. Isi dulu, jalankan ulang aplikasi, lalu coba lagi.';

const CONFIRM = {
  create:
    'Masukkan password-mu (dan kode verifikasi dua langkah) untuk menghubungkan akun email bersama.',
  credentials:
    'Masukkan password-mu (dan kode verifikasi dua langkah) untuk mengganti server atau password akun email.',
  delete: 'Masukkan password-mu (dan kode verifikasi dua langkah) untuk memutus akun email.',
} as const;

const PERSONAL_OWNER_ONLY = 'Akun pribadi hanya bisa diubah atau diputus pemiliknya.';
const ACCOUNT_DELETING = 'Akun ini sedang diputus.';

function validation(field: string, message: string, reason?: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [{ location: 'body', field, message, ...(reason ? { reason } : {}) }],
  });
}

const sameServer = (
  a: { host: string; port: number; security: string; username: string },
  b: { host: string | null; port: number | null; security: string | null; username: string | null },
) =>
  a.host === b.host && a.port === b.port && a.security === b.security && a.username === b.username;

export function createMailService(deps: MailServiceDeps) {
  const { db, secretBox, twoFactor, accessDenied, publisher } = deps;
  const now = deps.now ?? (() => new Date());
  const connector = deps.connector ?? defaultMailImapConnector;
  const smtpVerifier = deps.smtpVerifier ?? defaultMailSmtpVerifier;

  function requireBox(): SecretBox {
    if (!secretBox) throw new AppError('SERVICE_UNAVAILABLE', { message: NO_MASTER_KEY_MESSAGE });
    return secretBox;
  }

  function confirm(
    auth: AuthContext,
    confirmation: IdentityConfirmation | undefined,
    action: string,
    message: string,
    context: MailContext,
  ) {
    return requireIdentityConfirmation(twoFactor, auth, confirmation, action, context, message);
  }

  async function policies(organizationId: string): Promise<{ imap: ImapPolicy; smtp: SmtpPolicy }> {
    const privateCidrs = await privateCidrsOf(db, organizationId);
    const strict = {
      privateCidrs,
      ...(deps.imap.allowLoopback ? { allowLoopback: true } : {}),
    };
    return {
      imap: {
        allowedPorts: [
          MAIL_IMAP_PORTS.ssl,
          MAIL_IMAP_PORTS.starttls,
          ...(deps.imap.extraPorts ?? []),
        ],
        lookup: deps.imap.lookup,
        timeouts: deps.imap.timeouts,
        strict,
        ...(deps.imap.testCa ? { testCa: deps.imap.testCa } : {}),
      },
      smtp: {
        allowedPorts: [
          MAIL_SMTP_PORTS.ssl,
          MAIL_SMTP_PORTS.starttls,
          ...(deps.smtp.extraPorts ?? []),
        ],
        plaintextLogin: 'private-only',
        lookup: deps.smtp.lookup,
        timeouts: deps.smtp.timeouts,
        strict,
        ...(deps.smtp.testCa ? { testCa: deps.smtp.testCa } : {}),
      },
    };
  }

  function assertPorts(
    imap: { port: number; security: 'ssl' | 'starttls' } | undefined,
    smtp: { port: number; security: 'ssl' | 'starttls' } | undefined,
  ) {
    if (imap && !mailPortAllowed('imap', imap.port, imap.security, deps.imap.extraPorts)) {
      throw validation('imap.port', MAIL_PORT_NOT_ALLOWED_MESSAGE, 'port_not_allowed');
    }
    if (smtp && !mailPortAllowed('smtp', smtp.port, smtp.security, deps.smtp.extraPorts)) {
      throw validation('smtp.port', MAIL_PORT_NOT_ALLOWED_MESSAGE, 'port_not_allowed');
    }
  }

  /** Muat akun + hak pelaku; 404 bila tidak ada/tanpa hak (akun pribadi orang lain = 404). */
  async function loadWithLevel(auth: AuthContext, accountId: string) {
    const viewer = await viewerOf(db, auth);
    const row = await loadAccountRow(db, auth.organizationId, accountId);
    if (!row) throw mailNotFound();
    const level = await levelOf(db, viewer, auth.organizationId, row);
    if (!level) throw mailNotFound();
    return { viewer, row, level };
  }

  async function requireLevel(
    auth: AuthContext,
    accountId: string,
    minimum: MailAccessLevel,
    context: MailContext,
  ) {
    const loaded = await loadWithLevel(auth, accountId);
    if (!mailLevelAtLeast(loaded.level, minimum)) {
      await forbidByRule(accessDenied, {
        auth,
        rule: ACCESS_RULES.mailAccountLevel,
        client: context.client,
        details: { required: minimum, level: loaded.level },
        message: 'Hak aksesmu di akun email ini tidak cukup untuk tindakan ini.',
      });
    }
    return loaded;
  }

  /** Hak ubah server/kredensial/putuskan. Akun pribadi orang lain → 404 (tidak terbuka). */
  async function requireAdminister(auth: AuthContext, accountId: string, context: MailContext) {
    const viewer = await viewerOf(db, auth);
    const row = await loadAccountRow(db, auth.organizationId, accountId);
    if (!row) throw mailNotFound();
    const account = { kind: row.kind as MailAccountKind, ownerUserId: row.ownerUserId };
    if (!canMailAdminister(viewer, account)) {
      const level = await levelOf(db, viewer, auth.organizationId, row);
      if (!level) throw mailNotFound();
      await forbidByRule(accessDenied, {
        auth,
        rule:
          row.kind === 'personal'
            ? ACCESS_RULES.mailPersonalOwnerOnly
            : ACCESS_RULES.mailAccountLevel,
        client: context.client,
        message:
          row.kind === 'personal'
            ? PERSONAL_OWNER_ONLY
            : 'Hanya Owner/Admin yang bisa mengubah server, password, atau akses akun email bersama.',
      });
    }
    return { viewer, row };
  }

  /**
   * 409 `address_already_connected`. Review 9A-1 S4: pemegang `mail.accounts.manage` diberi tahu
   * pemilik akun PRIBADI yang memakai alamat itu (metadata yang sama sudah terlihat di Pengaturan →
   * Akun email) supaya bisa ditindaklanjuti (minta diputus / nonaktifkan pengguna).
   */
  async function alreadyConnected(auth: AuthContext, address: string): Promise<AppError> {
    if (hasPermission(auth.user.role, 'mail.accounts.manage')) {
      const [holder] = await db
        .select({ kind: mailAccounts.kind, ownerName: users.name, ownerId: users.id })
        .from(mailAccounts)
        .leftJoin(
          users,
          and(
            eq(users.organizationId, mailAccounts.organizationId),
            eq(users.id, mailAccounts.ownerUserId),
          ),
        )
        .where(
          and(
            eq(mailAccounts.organizationId, auth.organizationId),
            eq(mailAccounts.emailAddress, address),
            isNull(mailAccounts.deletedAt),
          ),
        )
        .limit(1);
      if (holder?.kind === 'personal' && holder.ownerName && holder.ownerId !== auth.user.id) {
        return conflict(
          'address_already_connected',
          `Alamat ini sudah terhubung sebagai akun email pribadi milik ${holder.ownerName}. Minta ia memutusnya, atau nonaktifkan penggunanya lalu putus akunnya di Pengaturan → Akun email.`,
        );
      }
    }
    return conflict('address_already_connected', ADDRESS_ALREADY_CONNECTED);
  }

  /**
   * Review 9B S2: kotak surat Email pengirim sistem (alamat ATAU host + username SMTP/IMAP) TIDAK boleh
   * dihubungkan sebagai akun Email (pribadi maupun bersama) — salinan tautan reset password, undangan,
   * dan kode verifikasi di Terkirim terbaca pembaca akun itu. 409 `system_sender_mailbox`.
   */
  async function assertNotSystemSenderMailbox(
    executor: DbExecutor,
    organizationId: string,
    candidate: Parameters<typeof systemSenderConflicts>[1],
  ): Promise<void> {
    const sender = await systemSenderOf(
      executor,
      organizationId,
      deps.systemSenderFallback ?? null,
    );
    if (systemSenderConflicts(sender, candidate)) {
      throw conflict('system_sender_mailbox', MAIL_COMPOSE_MESSAGES.systemSenderMailbox);
    }
  }

  /** Pemegang Channel/pengirim sistem sudah ditangani pemeriksaan sendiri (pesan lebih jelas). */
  const handledElsewhere = (holder: AddressHolder) =>
    holder.kind === 'system_sender' || holder.kind === 'channel';

  /**
   * Larangan alamat ganda untuk alamat akun (9B §3.3). Akun PRIBADI: pemegang apa pun → 409 umum.
   * Akun BERSAMA (Owner/Admin, review 9B S4): klaim lemah akun pribadi tidak menghalangi — dicabut di
   * transaksi (`revoke`), pemegang kuat → 409 yang menyebut pemegangnya.
   */
  async function guardAccountAddress(
    executor: DbExecutor,
    auth: AuthContext,
    kind: string,
    address: string,
    client: MailContext['client'] | null,
  ): Promise<RevokedClaim[]> {
    if (kind === 'personal') {
      if (await addressIsMailIdentity(executor, auth.organizationId, address)) {
        throw conflict('address_in_use', MAIL_COMPOSE_MESSAGES.addressInUse);
      }
      return [];
    }
    const sender = await systemSenderOf(
      executor,
      auth.organizationId,
      deps.systemSenderFallback ?? null,
    );
    const domains = await mailOrganizationDomains(executor, auth.organizationId);
    if (!client) {
      const holders = await addressHoldersOf(executor, auth.organizationId, address, {
        systemSender: sender,
      });
      const strong = holders.find(
        (holder) => !handledElsewhere(holder) && !isWeakClaim(holder, domains),
      );
      if (strong) throw addressHeldError(auth.user.role, strong, 'emailAddress');
      return [];
    }
    return claimAddressForOrganization(executor, {
      organizationId: auth.organizationId,
      actorUserId: auth.user.id,
      role: auth.user.role,
      address,
      systemSender: sender,
      domains,
      client,
      field: 'emailAddress',
      ignore: handledElsewhere,
    });
  }

  /**
   * 9B: peringatan akun — `system_sender_conflict` (kotak surat ini juga Email pengirim sistem:
   * verifikasi terkunci & salinan email keamanan bisa terbaca pembaca akun) dan `identity_unverified`
   * (identitas utama belum terverifikasi → belum bisa mengirim).
   */
  async function warningsOf(
    organizationId: string,
    rows: readonly MailAccountRow[],
  ): Promise<Map<string, MailAccount['warnings']>> {
    const result = new Map<string, MailAccount['warnings']>();
    if (rows.length === 0) return result;
    const sender = await systemSenderOf(db, organizationId, deps.systemSenderFallback ?? null);
    const identities = await db
      .select({
        accountId: mailIdentities.accountId,
        address: mailIdentities.address,
        isPrimary: mailIdentities.isPrimary,
        state: mailIdentities.verificationState,
      })
      .from(mailIdentities)
      .where(
        and(
          eq(mailIdentities.organizationId, organizationId),
          inArray(
            mailIdentities.accountId,
            rows.map((row) => row.id),
          ),
        ),
      );
    for (const row of rows) {
      const own = identities.filter((identity) => identity.accountId === row.id);
      const warnings: MailAccount['warnings'] = [];
      if (
        systemSenderConflicts(
          sender,
          row,
          own.map((identity) => identity.address),
        )
      ) {
        warnings.push('system_sender_conflict');
      }
      if (own.some((identity) => identity.isPrimary && identity.state !== 'verified')) {
        warnings.push('identity_unverified');
      }
      result.set(row.id, warnings);
    }
    return result;
  }

  async function view(auth: AuthContext, row: MailAccountRow, viewer?: MailAccessUser) {
    const subject = viewer ?? (await viewerOf(db, auth));
    const level = await levelOf(db, subject, auth.organizationId, row);
    const owners = await ownersOf(db, auth.organizationId, [row]);
    const warnings = await warningsOf(auth.organizationId, [row]);
    return toMailAccount(
      row,
      subject,
      level,
      row.ownerUserId ? (owners.get(row.ownerUserId) ?? null) : null,
      warnings.get(row.id) ?? [],
    );
  }

  function statusEvent(row: MailAccountRow) {
    return {
      organizationId: row.organizationId,
      accountId: row.id,
      event: {
        type: 'mail.account.status' as const,
        accountId: row.id,
        syncState: row.syncState as MailAccount['sync']['state'],
        lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
        errorCode: row.lastErrorCode,
        initialProgress:
          row.syncState === 'initial_sync'
            ? { done: row.initialSyncDone, total: row.initialSyncTotal ?? 0 }
            : null,
      },
    };
  }

  async function enqueueSync(
    row: Pick<MailAccountRow, 'id' | 'organizationId'>,
    log: MailContext['log'],
  ) {
    await deps.queue
      ?.sync({ organizationId: row.organizationId, accountId: row.id, force: true })
      .catch((err: unknown) => {
        // Tick worker (30 dtk) tetap mengambilnya dari `next_attempt_at`.
        log.warn({ err, accountId: row.id }, 'Sinkron akun email belum bisa diantrekan');
      });
  }

  async function notifyOwners(
    executor: DbExecutor,
    auth: AuthContext,
    event: 'mail_account_changed' | 'mail_access_changed',
    auditLogId: string,
  ) {
    if (auth.user.role === 'owner') return;
    const owners = await findActiveOwners(executor, auth.organizationId, [auth.user.id]);
    for (const recipientUserId of owners) {
      await deps.notifier
        .securityNoticeAdmin({
          organizationId: auth.organizationId,
          recipientUserId,
          subjectUserId: auth.user.id,
          event,
          occurredAt: now().toISOString(),
          auditLogId,
        })
        .catch(() => undefined);
    }
  }

  // ── Tes koneksi ──────────────────────────────────────────────────────────

  interface ResolvedServers {
    imap: {
      host: string;
      port: number;
      security: 'ssl' | 'starttls';
      username: string;
      password: Secret<string>;
    } | null;
    smtp: {
      host: string;
      port: number;
      security: 'ssl' | 'starttls';
      sameCredentials: boolean;
      username: string;
      password: Secret<string>;
    } | null;
  }

  function openStored(
    row: MailAccountRow,
    kind: 'imapPassword' | 'smtpPassword',
  ): Secret<string> | null {
    const sealed = kind === 'imapPassword' ? row.imapPasswordEncrypted : row.smtpPasswordEncrypted;
    if (!secretBox || !sealed) return null;
    try {
      return openMailAccountSecret(secretBox, row, kind, sealed);
    } catch {
      return null;
    }
  }

  /** Server untuk tes/simpan: isian baru, atau yang tersimpan bila password kosong & server sama. */
  function resolveServers(
    input: Pick<TestMailAccountRequest, 'imap' | 'smtp'>,
    stored: MailAccountRow | null,
  ): ResolvedServers & { secretUnavailable: ('imap' | 'smtp')[] } {
    const secretUnavailable: ('imap' | 'smtp')[] = [];
    let imap: ResolvedServers['imap'] = null;
    /**
     * Review 9A-1 S1: password yang DIBUKA DARI DATABASE hanya boleh dikirim ke tujuan yang persis
     * sama dengan saat disimpan (host, port, keamanan, username — IMAP, dan SMTP bila
     * `smtp_same_credentials`). Tujuan lain → 400 `password_required`.
     */
    let imapFromStore = false;
    if (input.imap) {
      let password: Secret<string> | null = input.imap.password
        ? new Secret(input.imap.password)
        : null;
      if (!password) {
        if (
          !stored ||
          !sameServer(input.imap, {
            host: stored.imapHost,
            port: stored.imapPort,
            security: stored.imapSecurity,
            username: stored.imapUsername,
          })
        ) {
          throw validation(
            'imap.password',
            'Server berubah — isi ulang password-nya.',
            'password_required',
          );
        }
        password = openStored(stored, 'imapPassword');
        if (!password) secretUnavailable.push('imap');
        imapFromStore = true;
      }
      if (password) imap = { ...input.imap, password };
    } else if (stored) {
      imapFromStore = true;
      const password = openStored(stored, 'imapPassword');
      if (!password) secretUnavailable.push('imap');
      else
        imap = {
          host: stored.imapHost ?? '',
          port: stored.imapPort ?? 993,
          security: stored.imapSecurity === 'starttls' ? 'starttls' : 'ssl',
          username: stored.imapUsername ?? '',
          password,
        };
    }
    let smtp: ResolvedServers['smtp'] = null;
    if (input.smtp) {
      if (input.smtp.sameCredentials) {
        if (
          imapFromStore &&
          (!stored ||
            !stored.smtpSameCredentials ||
            !sameServer(
              { ...input.smtp, username: imap?.username ?? stored.imapUsername ?? '' },
              {
                host: stored.smtpHost,
                port: stored.smtpPort,
                security: stored.smtpSecurity,
                username: stored.imapUsername,
              },
            ))
        ) {
          throw validation(
            'smtp.password',
            'Server berubah — isi ulang password-nya.',
            'password_required',
          );
        }
        if (imap)
          smtp = {
            ...input.smtp,
            sameCredentials: true,
            username: imap.username,
            password: imap.password,
          };
        else if (!secretUnavailable.includes('smtp')) secretUnavailable.push('smtp');
      } else {
        const username = input.smtp.username;
        if (!username) throw validation('smtp.username', 'Username SMTP wajib diisi.');
        let password: Secret<string> | null = input.smtp.password
          ? new Secret(input.smtp.password)
          : null;
        if (!password) {
          if (
            !stored ||
            stored.smtpSameCredentials ||
            !sameServer(
              { ...input.smtp, username },
              {
                host: stored.smtpHost,
                port: stored.smtpPort,
                security: stored.smtpSecurity,
                username: stored.smtpUsername,
              },
            )
          ) {
            throw validation(
              'smtp.password',
              'Server berubah — isi ulang password-nya.',
              'password_required',
            );
          }
          password = openStored(stored, 'smtpPassword');
          if (!password) secretUnavailable.push('smtp');
        }
        if (password) smtp = { ...input.smtp, sameCredentials: false, username, password };
      }
    } else if (stored) {
      const same = stored.smtpSameCredentials;
      const password = same ? (imap?.password ?? null) : openStored(stored, 'smtpPassword');
      if (!password) secretUnavailable.push('smtp');
      else
        smtp = {
          host: stored.smtpHost ?? '',
          port: stored.smtpPort ?? 465,
          security: stored.smtpSecurity === 'starttls' ? 'starttls' : 'ssl',
          sameCredentials: same,
          username: same
            ? (imap?.username ?? stored.imapUsername ?? '')
            : (stored.smtpUsername ?? ''),
          password,
        };
    }
    return { imap, smtp, secretUnavailable };
  }

  async function runTests(
    organizationId: string,
    servers: ReturnType<typeof resolveServers>,
    targets: readonly MailTestTarget[],
    syncWindowDays: MailSyncWindowDays,
  ): Promise<TestMailAccountResponse> {
    const policy = await policies(organizationId);
    const incoming = async (): Promise<MailIncomingTestResult | null> => {
      if (!targets.includes('incoming')) return null;
      if (!servers.imap) {
        return {
          ok: false,
          code: 'secret_unavailable',
          message: MAIL_TEST_MESSAGES.secret_unavailable,
          durationMs: 0,
          details: null,
        };
      }
      const outcome = await testMailIncoming(servers.imap, policy.imap, {
        syncWindowDays,
        roleOf: (folder) => mailFolderRoleOf(folder).role,
        connector,
        now,
      });
      if (!outcome.ok) {
        return {
          ok: false,
          code: outcome.code,
          message: MAIL_TEST_MESSAGES[outcome.code],
          durationMs: outcome.durationMs,
          details: null,
        };
      }
      const { capabilities: _capabilities, ...details } = outcome.details;
      return {
        ok: true,
        code: outcome.code,
        message:
          outcome.code === 'imap_quota_full'
            ? `${MAIL_INCOMING_OK_MESSAGE} ${MAIL_TEST_MESSAGES.imap_quota_full}`
            : MAIL_INCOMING_OK_MESSAGE,
        durationMs: outcome.durationMs,
        details: {
          ...details,
          specialFolders: details.specialFolders.filter(
            (role): role is 'sent' | 'drafts' | 'junk' | 'trash' | 'archive' =>
              ['sent', 'drafts', 'junk', 'trash', 'archive'].includes(role),
          ),
        },
      };
    };
    const outgoing = async (): Promise<MailOutgoingTestResult | null> => {
      if (!targets.includes('outgoing')) return null;
      if (!servers.smtp) {
        return {
          ok: false,
          code: 'secret_unavailable',
          message: MAIL_TEST_MESSAGES.secret_unavailable,
          durationMs: 0,
        };
      }
      const result = await testMailOutgoing(servers.smtp, policy.smtp, smtpVerifier);
      return {
        ok: result.ok,
        code: result.code,
        message: result.ok ? MAIL_OUTGOING_OK_MESSAGE : MAIL_TEST_MESSAGES[result.code],
        durationMs: result.durationMs,
      };
    };
    const [incomingResult, outgoingResult] = await Promise.all([incoming(), outgoing()]);
    return { testedAt: now().toISOString(), incoming: incomingResult, outgoing: outgoingResult };
  }

  function assertTestsPassed(result: TestMailAccountResponse) {
    const details: ErrorDetail[] = [];
    if (result.incoming && !result.incoming.ok) {
      details.push({
        location: 'body',
        field: 'imap',
        message: result.incoming.message,
        reason: result.incoming.code,
      });
    }
    if (result.outgoing && !result.outgoing.ok) {
      details.push({
        location: 'body',
        field: 'smtp',
        message: result.outgoing.message,
        reason: result.outgoing.code,
      });
    }
    if (details.length > 0) {
      throw new AppError('CHANNEL_REQUEST_FAILED', {
        message:
          details.length === 2
            ? 'Tes Masuk dan Keluar gagal. Periksa pengaturan server, lalu coba lagi.'
            : (details[0]?.message ?? 'Tes koneksi gagal.'),
        details,
      });
    }
  }

  // ── Grant awal (akun bersama) ────────────────────────────────────────────

  async function validateGrants(
    executor: DbExecutor,
    organizationId: string,
    grants: CreateMailAccountRequest['access'],
  ) {
    const userIds = grants.flatMap((grant) =>
      grant.principalType === 'user' ? [grant.userId] : [],
    );
    const departmentIds = grants.flatMap((grant) =>
      grant.principalType === 'department' ? [grant.departmentId] : [],
    );
    if (userIds.length > 0) {
      const found = await executor
        .select({ id: users.id, role: users.role, disabledAt: users.disabledAt })
        .from(users)
        .where(and(eq(users.organizationId, organizationId), inArray(users.id, userIds)));
      const byId = new Map(found.map((row) => [row.id, row]));
      for (const id of userIds) {
        const row = byId.get(id);
        if (!row || row.disabledAt !== null) {
          throw validation(
            'access',
            'Ada pengguna yang tidak ditemukan atau sudah nonaktif.',
            'principal_invalid',
          );
        }
        if (isMailImplicitManager(row.role)) {
          throw validation(
            'access',
            'Owner dan Admin otomatis punya hak Kelola di semua akun bersama.',
            'grant_for_admin',
          );
        }
      }
    }
    if (departmentIds.length > 0) {
      const found = await executor
        .select({ id: departments.id })
        .from(departments)
        .where(
          and(
            eq(departments.organizationId, organizationId),
            inArray(departments.id, departmentIds),
          ),
        );
      if (found.length !== new Set(departmentIds).size) {
        throw validation('access', 'Ada departemen yang tidak ditemukan.', 'principal_invalid');
      }
    }
  }

  // ── Rute ─────────────────────────────────────────────────────────────────

  const service = {
    providers: () => ({ providers: [...MAIL_PROVIDER_CARDS] }),

    async detect(auth: AuthContext, emailAddress: string): Promise<DetectMailAccountResponse> {
      return detectMailAccount(emailAddress, {
        ...deps.detection,
        privateCidrs: await privateCidrsOf(db, auth.organizationId),
        ...(deps.imap.allowLoopback ? { allowLoopback: true } : {}),
      });
    },

    async test(
      auth: AuthContext,
      input: TestMailAccountRequest,
      context: MailContext,
    ): Promise<TestMailAccountResponse> {
      assertPorts(input.imap, input.smtp);
      let stored: MailAccountRow | null = null;
      if (input.accountId) {
        stored = (await requireAdminister(auth, input.accountId, context)).row;
      } else if (
        (input.targets.includes('incoming') && !input.imap?.password) ||
        (input.targets.includes('outgoing') &&
          (!input.smtp ||
            (!input.smtp.sameCredentials && !input.smtp.password) ||
            (input.smtp.sameCredentials && !input.imap?.password)))
      ) {
        throw validation(
          'imap.password',
          'Isi server dan password untuk dites.',
          'password_required',
        );
      }
      const servers = resolveServers(input, stored);
      const window =
        input.syncWindowDays !== undefined
          ? input.syncWindowDays
          : ((stored?.syncWindowDays ?? MAIL_DEFAULT_SYNC_WINDOW_DAYS) as MailSyncWindowDays);
      const result = await runTests(auth.organizationId, servers, input.targets, window);
      if (stored) {
        await db
          .update(mailAccounts)
          .set({
            lastTestAt: now(),
            ...(result.incoming ? { lastTestIncomingOk: result.incoming.ok } : {}),
            ...(result.outgoing ? { lastTestOutgoingOk: result.outgoing.ok } : {}),
          })
          .where(
            and(
              eq(mailAccounts.organizationId, auth.organizationId),
              eq(mailAccounts.id, stored.id),
            ),
          );
      }
      return result;
    },

    async testStored(auth: AuthContext, accountId: string, context: MailContext) {
      // Level `manage` cukup (kontrak §4): kredensial tersimpan dipakai di server dan tidak pernah
      // keluar — hasilnya hanya kode tes. Mengganti server tetap butuh hak ubah server.
      const { row } = await requireLevel(auth, accountId, 'manage', context);
      const servers = resolveServers({}, row);
      const result = await runTests(
        auth.organizationId,
        servers,
        ['incoming', 'outgoing'],
        (row.syncWindowDays ?? null) as MailSyncWindowDays,
      );
      await db
        .update(mailAccounts)
        .set({
          lastTestAt: now(),
          lastTestIncomingOk: result.incoming?.ok ?? null,
          lastTestOutgoingOk: result.outgoing?.ok ?? null,
        })
        .where(
          and(eq(mailAccounts.organizationId, auth.organizationId), eq(mailAccounts.id, row.id)),
        );
      return result;
    },

    async create(
      auth: AuthContext,
      input: CreateMailAccountRequest,
      context: MailContext,
    ): Promise<MailAccount> {
      const box = requireBox();
      const personal = input.kind === 'personal';
      if (personal && input.access.length > 0) {
        throw validation(
          'access',
          'Akun pribadi tidak bisa dibagikan.',
          'personal_account_no_access',
        );
      }
      assertPorts(input.imap, input.smtp);
      if (!input.smtp.sameCredentials && (!input.smtp.username || !input.smtp.password)) {
        throw validation(
          'smtp.password',
          'Isi username dan password SMTP, atau pakai kredensial IMAP.',
        );
      }
      if (!personal) {
        await confirm(auth, input.confirmation, 'mail.account.create', CONFIRM.create, context);
        await validateGrants(db, auth.organizationId, input.access);
      }
      const address = input.emailAddress;
      if (await addressIsInboxChannel(db, auth.organizationId, address)) {
        throw inboxChannelConflict(hasPermission(auth.user.role, 'channels.manage'));
      }
      if (await addressIsMailAccount(db, auth.organizationId, address)) {
        throw await alreadyConnected(auth, address);
      }
      // Review 9B S2: kotak surat Email pengirim sistem tidak boleh jadi akun Email.
      await assertNotSystemSenderMailbox(db, auth.organizationId, {
        emailAddress: address,
        imapHost: input.imap.host,
        imapUsername: input.imap.username,
        smtpHost: input.smtp.host,
        smtpUsername: input.smtp.sameCredentials ? null : (input.smtp.username ?? null),
        smtpSameCredentials: input.smtp.sameCredentials,
      });
      // 9B §3.3 + review 9B S4: alamat yang sudah jadi alias akun lain juga ditolak (klaim lemah akun
      // pribadi tidak menghalangi akun bersama).
      await guardAccountAddress(db, auth, input.kind, address, null);

      const servers = resolveServers(input, null);
      const tested = await runTests(
        auth.organizationId,
        servers,
        ['incoming', 'outgoing'],
        input.syncWindowDays,
      );
      assertTestsPassed(tested);

      const id = newId();
      const owner = { id, organizationId: auth.organizationId };
      const createdAt = now();
      const values: NewMailAccountRow = {
        id,
        organizationId: auth.organizationId,
        kind: input.kind,
        ownerUserId: personal ? auth.user.id : null,
        provider: input.provider,
        displayName: input.displayName,
        emailAddress: address,
        fromName: input.fromName,
        color: input.color,
        imapHost: input.imap.host,
        imapPort: input.imap.port,
        imapSecurity: input.imap.security,
        imapUsername: input.imap.username,
        imapPasswordEncrypted: sealMailAccountSecret(
          box,
          owner,
          'imapPassword',
          input.imap.password,
        ),
        imapPasswordTail: secretTail(input.imap.password),
        smtpHost: input.smtp.host,
        smtpPort: input.smtp.port,
        smtpSecurity: input.smtp.security,
        smtpSameCredentials: input.smtp.sameCredentials,
        smtpUsername: input.smtp.sameCredentials ? null : (input.smtp.username ?? null),
        smtpPasswordEncrypted:
          !input.smtp.sameCredentials && input.smtp.password
            ? sealMailAccountSecret(box, owner, 'smtpPassword', input.smtp.password)
            : null,
        smtpPasswordTail:
          !input.smtp.sameCredentials && input.smtp.password
            ? secretTail(input.smtp.password)
            : null,
        trustedAuthServIds: input.trustedAuthServIds ?? null,
        syncWindowDays: input.syncWindowDays,
        syncState: 'initial_sync',
        nextAttemptAt: createdAt,
        lastTestAt: createdAt,
        lastTestIncomingOk: true,
        lastTestOutgoingOk: true,
        quotaUsedBytes: tested.incoming?.details?.quota?.usedBytes ?? null,
        quotaLimitBytes: tested.incoming?.details?.quota?.limitBytes ?? null,
        initialSyncTotal: tested.incoming?.details?.estimatedInitialSync ?? null,
        createdByUserId: auth.user.id,
      };

      let revoked: RevokedClaim[] = [];
      let approvalAuditId: string | null = null;
      const row = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(
          tx,
          auth,
          personal ? 'mail.private.own' : 'mail.accounts.manage',
          context.log,
        );
        await lockEmailAddresses(tx, auth.organizationId, [address]);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`mail-accounts|${auth.organizationId}`}, 0))`,
        );
        if (await addressIsInboxChannel(tx, auth.organizationId, address)) {
          throw inboxChannelConflict(hasPermission(auth.user.role, 'channels.manage'));
        }
        if (await addressIsMailAccount(tx, auth.organizationId, address)) {
          throw await alreadyConnected(auth, address);
        }
        await assertNotSystemSenderMailbox(tx, auth.organizationId, {
          emailAddress: address,
          imapHost: input.imap.host,
          imapUsername: input.imap.username,
          smtpHost: input.smtp.host,
          smtpUsername: input.smtp.sameCredentials ? null : (input.smtp.username ?? null),
          smtpSameCredentials: input.smtp.sameCredentials,
        });
        revoked = await guardAccountAddress(tx, auth, input.kind, address, context.client);
        const [total] = await tx
          .select({ value: count() })
          .from(mailAccounts)
          .where(
            and(
              eq(mailAccounts.organizationId, auth.organizationId),
              isNull(mailAccounts.deletedAt),
            ),
          );
        const [mine] = await tx
          .select({ value: count() })
          .from(mailAccounts)
          .where(
            and(
              eq(mailAccounts.organizationId, auth.organizationId),
              eq(mailAccounts.ownerUserId, auth.user.id),
              isNull(mailAccounts.deletedAt),
            ),
          );
        if (
          (total?.value ?? 0) >= MAIL_ACCOUNTS_PER_ORGANIZATION_MAX ||
          (personal && (mine?.value ?? 0) >= MAIL_PERSONAL_ACCOUNTS_PER_USER_MAX)
        ) {
          throw conflict(
            'limit_reached',
            'Maksimal 50 akun email per organisasi / 5 akun pribadi per pengguna.',
            'kind',
          );
        }
        if (!personal) await validateGrants(tx, auth.organizationId, input.access);
        const [inserted] = await tx.insert(mailAccounts).values(values).returning();
        if (!inserted) throw new Error('Akun email tidak tersimpan');
        const [primary] = await tx
          .insert(mailIdentities)
          .values({
            organizationId: auth.organizationId,
            accountId: id,
            address,
            displayName: input.fromName,
            isPrimary: true,
            // Review 9A-1 S4: login IMAP tidak membuktikan alamat (server bisa milik pendaftar sendiri).
            // Verifikasi (email uji ke alamat itu) menyusul 9B sebelum dipakai sebagai pengirim.
            verifiedAt: null,
          })
          .returning();
        // Review 9B S3: akun PRIBADI berdomain organisasi → menunggu persetujuan Owner/Admin.
        if (personal && primary) {
          approvalAuditId = await recordApprovalRequest(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            accountKind: 'personal',
            accountId: id,
            identity: primary,
            domains: await mailOrganizationDomains(tx, auth.organizationId),
            client: context.client,
          });
        }
        if (input.access.length > 0) {
          await tx.insert(mailAccountAccess).values(
            input.access.map((grant) => ({
              organizationId: auth.organizationId,
              accountId: id,
              principalType: grant.principalType,
              userId: grant.principalType === 'user' ? grant.userId : null,
              departmentId: grant.principalType === 'department' ? grant.departmentId : null,
              level: grant.level,
              grantedByUserId: auth.user.id,
            })),
          );
        }
        const auditLogId = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.mailAccountCreated,
          targetType: 'mail_account',
          targetId: id,
          metadata: {
            kind: input.kind,
            provider: input.provider,
            address,
            ...(personal
              ? {}
              : {
                  imapHost: input.imap.host,
                  smtpHost: input.smtp.host,
                  grants: input.access.length,
                }),
            actorRole: auth.user.role,
          },
          client: context.client,
        });
        if (!personal) await notifyOwners(tx, auth, 'mail_account_changed', auditLogId);
        return inserted;
      });
      await publisher.publish([statusEvent(row)]);
      if (input.access.length > 0) await publishAccessChanged(auth.organizationId, input.access);
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
      await enqueueSync(row, context.log);
      return view(auth, row);
    },

    async list(auth: AuthContext): Promise<MailAccountListResponse> {
      const viewer = await viewerOf(db, auth);
      const levels = await accessibleMailAccountsOf(db, auth.organizationId, auth.user.id);
      const rows = levels.size
        ? await db
            .select()
            .from(mailAccounts)
            .where(
              and(
                eq(mailAccounts.organizationId, auth.organizationId),
                inArray(mailAccounts.id, [...levels.keys()]),
                isNull(mailAccounts.deletedAt),
              ),
            )
        : [];
      const owners = await ownersOf(db, auth.organizationId, rows);
      const warnings = await warningsOf(auth.organizationId, rows);
      return {
        accounts: rows
          .sort((a, b) => a.displayName.localeCompare(b.displayName, 'id', { sensitivity: 'base' }))
          .map((row) =>
            toMailAccount(
              row,
              viewer,
              levels.get(row.id) ?? null,
              row.ownerUserId ? (owners.get(row.ownerUserId) ?? null) : null,
              warnings.get(row.id) ?? [],
            ),
          ),
        canConnectPersonal: hasPermission(auth.user.role, 'mail.private.own'),
        canManageShared: hasPermission(auth.user.role, 'mail.accounts.manage'),
      };
    },

    async settingsList(auth: AuthContext): Promise<MailSettingsAccountListResponse> {
      const viewer = await viewerOf(db, auth);
      const manager = hasPermission(auth.user.role, 'mail.accounts.manage');
      const levels = await accessibleMailAccountsOf(db, auth.organizationId, auth.user.id);
      const rows = await db
        .select()
        .from(mailAccounts)
        .where(
          and(eq(mailAccounts.organizationId, auth.organizationId), isNull(mailAccounts.deletedAt)),
        );
      const owners = await ownersOf(db, auth.organizationId, rows);
      const warnings = await warningsOf(auth.organizationId, rows);
      const accounts: MailSettingsAccountListResponse['accounts'] = [];
      for (const row of rows.sort((a, b) => a.displayName.localeCompare(b.displayName, 'id'))) {
        const owner = row.ownerUserId ? (owners.get(row.ownerUserId) ?? null) : null;
        if (row.kind === 'personal') {
          if (row.ownerUserId === auth.user.id) {
            accounts.push(
              toMailAccount(
                row,
                viewer,
                levels.get(row.id) ?? null,
                owner,
                warnings.get(row.id) ?? [],
              ),
            );
          } else if (manager && owner) {
            accounts.push(toRedactedMailAccount(row, owner));
          }
          continue;
        }
        const level = levels.get(row.id) ?? null;
        if (level === 'manage') {
          accounts.push(toMailAccount(row, viewer, level, null, warnings.get(row.id) ?? []));
        }
      }
      return {
        accounts,
        canConnectPersonal: hasPermission(auth.user.role, 'mail.private.own'),
        canManageShared: manager,
      };
    },

    async get(auth: AuthContext, accountId: string): Promise<MailAccount> {
      const { viewer, row } = await loadWithLevel(auth, accountId);
      return view(auth, row, viewer);
    },

    async update(
      auth: AuthContext,
      accountId: string,
      input: UpdateMailAccountRequest,
      context: MailContext,
    ): Promise<MailAccount> {
      const { viewer, row } = await requireLevel(auth, accountId, 'manage', context);
      const serverChange =
        input.imap !== undefined ||
        input.smtp !== undefined ||
        input.emailAddress !== undefined ||
        input.trustedAuthServIds !== undefined;
      const changes: Partial<NewMailAccountRow> = {};
      const plainFields: string[] = [];
      const credentialFields: string[] = [];
      if (input.displayName !== undefined && input.displayName !== row.displayName) {
        changes.displayName = input.displayName;
        plainFields.push('displayName');
      }
      if (input.color !== undefined && input.color !== row.color) {
        changes.color = input.color;
        plainFields.push('color');
      }
      if (input.fromName !== undefined && input.fromName !== row.fromName) {
        changes.fromName = input.fromName;
        plainFields.push('fromName');
      }
      if (input.syncWindowDays !== undefined && input.syncWindowDays !== row.syncWindowDays) {
        changes.syncWindowDays = input.syncWindowDays;
        plainFields.push('syncWindowDays');
      }
      if (
        input.periodicSyncMinutes !== undefined &&
        input.periodicSyncMinutes !== row.periodicSyncMinutes
      ) {
        changes.periodicSyncMinutes = input.periodicSyncMinutes;
        plainFields.push('periodicSyncMinutes');
      }
      if (input.sentCopyMode !== undefined && input.sentCopyMode !== row.sentCopyMode) {
        changes.sentCopyMode = input.sentCopyMode;
        plainFields.push('sentCopyMode');
      }
      if (
        input.warnExternalRecipients !== undefined &&
        input.warnExternalRecipients !== row.warnExternalRecipients
      ) {
        changes.warnExternalRecipients = input.warnExternalRecipients;
        plainFields.push('warnExternalRecipients');
      }
      let resetMailbox = false;
      // 9B §3.2: alamat, host/username IMAP, atau host/username SMTP berubah = SEMUA identitas akun
      // kembali `unverified` (kotak surat lain = bukti lama tidak berlaku).
      let resetIdentities = false;
      if (serverChange) {
        const box = requireBox();
        if (
          !canMailAdminister(viewer, {
            kind: row.kind as MailAccountKind,
            ownerUserId: row.ownerUserId,
          })
        ) {
          await forbidByRule(accessDenied, {
            auth,
            rule:
              row.kind === 'personal'
                ? ACCESS_RULES.mailPersonalOwnerOnly
                : ACCESS_RULES.mailAccountLevel,
            client: context.client,
            message:
              row.kind === 'personal'
                ? PERSONAL_OWNER_ONLY
                : 'Hanya Owner/Admin yang bisa mengubah server atau password akun email bersama.',
          });
        }
        assertPorts(input.imap, input.smtp);
        await confirm(
          auth,
          input.confirmation,
          'mail.account.credentials',
          CONFIRM.credentials,
          context,
        );
        const address = input.emailAddress ?? row.emailAddress;
        if (address !== row.emailAddress) {
          if (await addressIsInboxChannel(db, auth.organizationId, address)) {
            throw inboxChannelConflict(hasPermission(auth.user.role, 'channels.manage'));
          }
          if (await addressIsMailAccount(db, auth.organizationId, address, row.id)) {
            throw await alreadyConnected(auth, address);
          }
          await guardAccountAddress(db, auth, row.kind, address, null);
          changes.emailAddress = address;
          credentialFields.push('emailAddress');
          resetMailbox = true;
        }
        const servers = resolveServers({ imap: input.imap, smtp: input.smtp }, row);
        const tested = await runTests(
          auth.organizationId,
          servers,
          ['incoming', 'outgoing'],
          (changes.syncWindowDays ?? row.syncWindowDays) as MailSyncWindowDays,
        );
        assertTestsPassed(tested);
        const owner = { id: row.id, organizationId: row.organizationId };
        if (input.imap) {
          if (input.imap.host !== row.imapHost || input.imap.username !== row.imapUsername)
            resetMailbox = true;
          Object.assign(changes, {
            imapHost: input.imap.host,
            imapPort: input.imap.port,
            imapSecurity: input.imap.security,
            imapUsername: input.imap.username,
            ...(input.imap.password
              ? {
                  imapPasswordEncrypted: sealMailAccountSecret(
                    box,
                    owner,
                    'imapPassword',
                    input.imap.password,
                  ),
                  imapPasswordTail: secretTail(input.imap.password),
                }
              : {}),
          } satisfies Partial<NewMailAccountRow>);
          credentialFields.push(input.imap.password ? 'imap.password' : 'imap');
        }
        if (input.smtp) {
          const nextSmtpUser = input.smtp.sameCredentials
            ? (input.imap?.username ?? row.imapUsername)
            : (input.smtp.username ?? null);
          const currentSmtpUser = row.smtpSameCredentials ? row.imapUsername : row.smtpUsername;
          if (input.smtp.host !== row.smtpHost || nextSmtpUser !== currentSmtpUser) {
            resetIdentities = true;
          }
          Object.assign(changes, {
            smtpHost: input.smtp.host,
            smtpPort: input.smtp.port,
            smtpSecurity: input.smtp.security,
            smtpSameCredentials: input.smtp.sameCredentials,
            ...(input.smtp.sameCredentials
              ? { smtpUsername: null, smtpPasswordEncrypted: null, smtpPasswordTail: null }
              : {
                  smtpUsername: input.smtp.username ?? null,
                  ...(input.smtp.password
                    ? {
                        smtpPasswordEncrypted: sealMailAccountSecret(
                          box,
                          owner,
                          'smtpPassword',
                          input.smtp.password,
                        ),
                        smtpPasswordTail: secretTail(input.smtp.password),
                      }
                    : {}),
                }),
          } satisfies Partial<NewMailAccountRow>);
          credentialFields.push(input.smtp.password ? 'smtp.password' : 'smtp');
        }
        if (input.trustedAuthServIds !== undefined) {
          changes.trustedAuthServIds = input.trustedAuthServIds;
          credentialFields.push('trustedAuthServIds');
        }
        Object.assign(changes, {
          lastTestAt: now(),
          lastTestIncomingOk: true,
          lastTestOutgoingOk: true,
          // Kredensial baru: pulih dari `auth_failed`/`error`, coba segera.
          ...(['auth_failed', 'error'].includes(row.syncState) ? { syncState: 'syncing' } : {}),
          consecutiveFailures: 0,
          lastErrorCode: null,
          lastErrorAt: null,
          nextAttemptAt: now(),
          ...(resetMailbox
            ? {
                syncState: 'initial_sync',
                initialSyncDone: 0,
                foldersSyncedAt: null,
                messageCount: 0,
                unreadCount: 0,
              }
            : {}),
        } satisfies Partial<NewMailAccountRow>);
      }
      if (resetMailbox) resetIdentities = true;
      if (plainFields.length === 0 && credentialFields.length === 0) return view(auth, row, viewer);
      // Review 9B S2: kotak surat hasil ubahan tidak boleh = kotak surat Email pengirim sistem.
      const candidate = {
        emailAddress: changes.emailAddress ?? row.emailAddress,
        imapHost: changes.imapHost ?? row.imapHost,
        imapUsername: changes.imapUsername ?? row.imapUsername,
        smtpHost: changes.smtpHost !== undefined ? changes.smtpHost : row.smtpHost,
        smtpUsername: changes.smtpUsername !== undefined ? changes.smtpUsername : row.smtpUsername,
        smtpSameCredentials: changes.smtpSameCredentials ?? row.smtpSameCredentials,
      };
      // Hanya bila kotak suratnya berganti (akun lama yang bentrok tetap bisa diperbarui password-nya).
      if (resetIdentities) await assertNotSystemSenderMailbox(db, auth.organizationId, candidate);
      let revoked: RevokedClaim[] = [];

      const updated = await db.transaction(async (tx) => {
        if (credentialFields.length > 0) {
          await assertActorStillAuthorized(
            tx,
            auth,
            row.kind === 'personal' ? 'mail.private.own' : 'mail.accounts.manage',
            context.log,
          );
          await lockEmailAddresses(tx, auth.organizationId, [
            changes.emailAddress ?? row.emailAddress,
          ]);
          if (changes.emailAddress) {
            if (await addressIsInboxChannel(tx, auth.organizationId, changes.emailAddress)) {
              throw inboxChannelConflict(hasPermission(auth.user.role, 'channels.manage'));
            }
            if (await addressIsMailAccount(tx, auth.organizationId, changes.emailAddress, row.id)) {
              throw await alreadyConnected(auth, changes.emailAddress);
            }
            revoked = await guardAccountAddress(
              tx,
              auth,
              row.kind,
              changes.emailAddress,
              context.client,
            );
          }
          if (resetIdentities)
            await assertNotSystemSenderMailbox(tx, auth.organizationId, candidate);
        }
        const locked = await loadAccountRow(tx, auth.organizationId, row.id, { forUpdate: true });
        if (!locked) throw mailNotFound();
        const [saved] = await tx
          .update(mailAccounts)
          .set(changes)
          .where(
            and(eq(mailAccounts.organizationId, auth.organizationId), eq(mailAccounts.id, row.id)),
          )
          .returning();
        if (!saved) throw mailNotFound();
        if (resetMailbox) {
          await tx
            .delete(mailFolders)
            .where(
              and(
                eq(mailFolders.organizationId, auth.organizationId),
                eq(mailFolders.accountId, row.id),
              ),
            );
        }
        if (changes.emailAddress || changes.fromName) {
          await tx
            .update(mailIdentities)
            .set({
              // Review 9B S3: alamat baru = keputusan persetujuan lama gugur.
              ...(changes.emailAddress
                ? {
                    address: changes.emailAddress,
                    approvalState: null,
                    approvalDecidedAt: null,
                    approvalDecidedByUserId: null,
                  }
                : {}),
              ...(changes.fromName ? { displayName: changes.fromName } : {}),
            })
            .where(
              and(
                eq(mailIdentities.organizationId, auth.organizationId),
                eq(mailIdentities.accountId, row.id),
                eq(mailIdentities.isPrimary, true),
              ),
            );
        }
        if (resetIdentities) {
          // Review 9A-1 S4 + 9B §3.2: kotak surat lain = verifikasi lama (utama & alias) gugur.
          await tx
            .update(mailIdentities)
            .set(IDENTITY_RESET)
            .where(
              and(
                eq(mailIdentities.organizationId, auth.organizationId),
                eq(mailIdentities.accountId, row.id),
              ),
            );
        }
        if (credentialFields.length > 0) {
          // 9B: kredensial disimpan ulang = pengirim akun yang `blocked` (login SMTP ditolak) dilepas.
          await tx
            .update(emailSenderSettings)
            .set({ state: 'ok', blockedReason: null, blockedAt: null })
            .where(
              and(
                eq(emailSenderSettings.organizationId, auth.organizationId),
                eq(emailSenderSettings.mailAccountId, row.id),
                eq(emailSenderSettings.state, 'blocked'),
              ),
            );
        }
        if (plainFields.length > 0) {
          await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.mailAccountUpdated,
            targetType: 'mail_account',
            targetId: row.id,
            metadata: { kind: row.kind, address: saved.emailAddress, changedFields: plainFields },
            client: context.client,
          });
        }
        if (credentialFields.length > 0) {
          const auditLogId = await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.mailAccountCredentialsUpdated,
            targetType: 'mail_account',
            targetId: row.id,
            metadata: {
              kind: row.kind,
              address: saved.emailAddress,
              changedFields: credentialFields,
              ...(row.kind === 'shared'
                ? { imapHost: saved.imapHost, smtpHost: saved.smtpHost }
                : {}),
              actorRole: auth.user.role,
            },
            client: context.client,
          });
          if (row.kind === 'shared')
            await notifyOwners(tx, auth, 'mail_account_changed', auditLogId);
        }
        return saved;
      });
      await notifyRevokedClaims(
        deps.notifier,
        { organizationId: auth.organizationId, actorUserId: auth.user.id, occurredAt: now() },
        revoked,
      );
      if (credentialFields.length > 0) {
        await publisher.publish([statusEvent(updated)]);
        await enqueueSync(updated, context.log);
      }
      return view(auth, updated, viewer);
    },

    async syncNow(auth: AuthContext, accountId: string, context: MailContext) {
      const { row } = await requireLevel(auth, accountId, 'manage', context);
      if (row.syncState === 'paused' || row.syncState === 'owner_inactive') {
        throw conflict(
          'account_paused',
          row.syncState === 'paused'
            ? 'Sinkron akun ini sedang dijeda. Lanjutkan dulu.'
            : 'Pemilik akun pribadi ini nonaktif, jadi sinkron berhenti.',
          'accountId',
        );
      }
      const [saved] = await db
        .update(mailAccounts)
        .set({
          nextAttemptAt: now(),
          foldersSyncedAt: null,
          ...(['auth_failed', 'error'].includes(row.syncState)
            ? { syncState: 'syncing', consecutiveFailures: 0 }
            : {}),
        })
        .where(
          and(
            eq(mailAccounts.organizationId, auth.organizationId),
            eq(mailAccounts.id, row.id),
            isNull(mailAccounts.deletedAt),
          ),
        )
        .returning();
      if (!saved) throw mailNotFound();
      await publisher.publish([statusEvent(saved)]);
      await enqueueSync(saved, context.log);
      return { queued: true as const };
    },

    async setPaused(auth: AuthContext, accountId: string, paused: boolean, context: MailContext) {
      const { viewer, row } = await requireLevel(auth, accountId, 'manage', context);
      if (row.syncState === 'owner_inactive') {
        throw conflict(
          'account_paused',
          'Pemilik akun pribadi ini nonaktif, jadi sinkron berhenti.',
          'accountId',
        );
      }
      if (paused === (row.syncState === 'paused')) return view(auth, row, viewer);
      const saved = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(mailAccounts)
          .set(
            paused
              ? { syncState: 'paused', syncPausedByUserId: auth.user.id, idleActive: false }
              : {
                  syncState: 'syncing',
                  syncPausedByUserId: null,
                  nextAttemptAt: now(),
                  consecutiveFailures: 0,
                },
          )
          .where(
            and(
              eq(mailAccounts.organizationId, auth.organizationId),
              eq(mailAccounts.id, row.id),
              isNull(mailAccounts.deletedAt),
            ),
          )
          .returning();
        if (!updated) throw mailNotFound();
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: paused ? AUDIT_ACTIONS.mailAccountPaused : AUDIT_ACTIONS.mailAccountResumed,
          targetType: 'mail_account',
          targetId: row.id,
          metadata: { kind: row.kind, address: row.emailAddress },
          client: context.client,
        });
        return updated;
      });
      await publisher.publish([statusEvent(saved)]);
      if (!paused) await enqueueSync(saved, context.log);
      return view(auth, saved, viewer);
    },

    async remove(
      auth: AuthContext,
      accountId: string,
      confirmation: IdentityConfirmation | undefined,
      context: MailContext,
    ) {
      const viewer = await viewerOf(db, auth);
      const row = await loadAccountRow(db, auth.organizationId, accountId, {
        includeDeleted: true,
      });
      if (!row) throw mailNotFound();
      const account = { kind: row.kind as MailAccountKind, ownerUserId: row.ownerUserId };
      let allowed = canMailAdminister(viewer, account);
      let ownerInactive = false;
      if (
        !allowed &&
        row.kind === 'personal' &&
        hasPermission(auth.user.role, 'mail.accounts.manage')
      ) {
        const owners = await ownersOf(db, auth.organizationId, [row]);
        ownerInactive = owners.get(row.ownerUserId ?? '')?.active === false;
        allowed = ownerInactive;
        if (!allowed) {
          await forbidByRule(accessDenied, {
            auth,
            rule: ACCESS_RULES.mailPersonalOwnerOnly,
            client: context.client,
            message: PERSONAL_OWNER_ONLY,
          });
        }
      }
      if (!allowed) {
        const level = await levelOf(db, viewer, auth.organizationId, row);
        if (!level) throw mailNotFound();
        await forbidByRule(accessDenied, {
          auth,
          rule: ACCESS_RULES.mailAccountLevel,
          client: context.client,
          message: 'Hanya Owner/Admin yang bisa memutus akun email bersama.',
        });
      }
      if (row.deletedAt !== null) throw conflict('account_deleting', ACCOUNT_DELETING, 'accountId');
      await confirm(auth, confirmation, 'mail.account.delete', CONFIRM.delete, context);
      const affected = await affectedUsersOf(db, auth.organizationId, row.id, row);
      const orphanFiles: string[] = [];
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(
          tx,
          auth,
          row.kind === 'personal' && !ownerInactive ? 'mail.private.own' : 'mail.accounts.manage',
          context.log,
        );
        const locked = await loadAccountRow(tx, auth.organizationId, row.id, { forUpdate: true });
        if (!locked) throw conflict('account_deleting', ACCOUNT_DELETING, 'accountId');
        if (ownerInactive) {
          // Review 9A-1 R6: pemilik bisa diaktifkan lagi di antara pemeriksaan & transaksi.
          const [ownerNow] = await tx
            .select({ disabledAt: users.disabledAt })
            .from(users)
            .where(
              and(
                eq(users.organizationId, auth.organizationId),
                eq(users.id, row.ownerUserId ?? ''),
              ),
            )
            .for('update');
          if (ownerNow && ownerNow.disabledAt === null) {
            context.log.warn(
              { userId: auth.user.id, accountId: row.id },
              'Pemilik akun email pribadi aktif lagi di tengah permintaan putus akun',
            );
            throw authorityChanged(PERSONAL_OWNER_ONLY);
          }
        }
        // Kredensial dimusnahkan SEKETIKA; isi cache dihapus bertahap oleh job.
        await tx
          .update(mailAccounts)
          .set({
            deletedAt: now(),
            syncState: 'deleting',
            idleActive: false,
            imapPasswordEncrypted: null,
            imapPasswordTail: null,
            smtpPasswordEncrypted: null,
            smtpPasswordTail: null,
            nextAttemptAt: now(),
          })
          .where(
            and(eq(mailAccounts.organizationId, auth.organizationId), eq(mailAccounts.id, row.id)),
          );
        await tx
          .delete(mailAccountAccess)
          .where(
            and(
              eq(mailAccountAccess.organizationId, auth.organizationId),
              eq(mailAccountAccess.accountId, row.id),
            ),
          );
        // 9B: email yang belum terkirim dibatalkan; draf & lampirannya dibuang (berkas setelah commit).
        await tx
          .update(mailOutbox)
          .set({ status: 'canceled', canceledAt: now(), holdReason: null })
          .where(
            and(
              eq(mailOutbox.organizationId, auth.organizationId),
              eq(mailOutbox.accountId, row.id),
              inArray(mailOutbox.status, ['pending', 'queued']),
            ),
          );
        const files = await tx
          .select({ key: mailDraftAttachments.storageKey })
          .from(mailDraftAttachments)
          .innerJoin(mailDrafts, eq(mailDrafts.id, mailDraftAttachments.draftId))
          .where(
            and(
              eq(mailDrafts.organizationId, auth.organizationId),
              eq(mailDrafts.accountId, row.id),
            ),
          );
        for (const file of files) if (file.key) orphanFiles.push(file.key);
        await tx
          .delete(mailDrafts)
          .where(
            and(
              eq(mailDrafts.organizationId, auth.organizationId),
              eq(mailDrafts.accountId, row.id),
            ),
          );
        await tx
          .delete(mailIdentities)
          .where(
            and(
              eq(mailIdentities.organizationId, auth.organizationId),
              eq(mailIdentities.accountId, row.id),
            ),
          );
        const auditLogId = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.mailAccountDeleted,
          targetType: 'mail_account',
          targetId: row.id,
          metadata: {
            kind: row.kind,
            address: row.emailAddress,
            ...(ownerInactive ? { ownerInactive: true } : {}),
            actorRole: auth.user.role,
          },
          client: context.client,
        });
        if (row.kind === 'shared') await notifyOwners(tx, auth, 'mail_account_changed', auditLogId);
      });
      for (const key of orphanFiles) await deps.store?.remove(key).catch(() => undefined);
      await publisher.publish([
        {
          organizationId: auth.organizationId,
          accountId: row.id,
          event: {
            type: 'mail.account.status',
            accountId: row.id,
            syncState: 'deleting',
            lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
            errorCode: null,
            initialProgress: null,
          },
        },
        ...(affected.length > 0
          ? [
              {
                organizationId: auth.organizationId,
                userIds: affected,
                event: { type: 'mail.access.changed' as const },
              },
            ]
          : []),
      ]);
      await deps.queue
        ?.purge({ organizationId: auth.organizationId, accountId: row.id })
        .catch((err: unknown) => {
          context.log.warn(
            { err, accountId: row.id },
            'Pemutusan akun email belum bisa diantrekan',
          );
        });
      return { deleting: true as const };
    },

    // ── Foto akun ──────────────────────────────────────────────────────────

    async putAvatar(auth: AuthContext, accountId: string, image: string, context: MailContext) {
      const { row } = await requireLevel(auth, accountId, 'manage', context);
      const avatar = await processMailAvatar(image);
      await db.transaction(async (tx) => {
        await tx
          .insert(mailAccountAvatars)
          .values({
            accountId: row.id,
            organizationId: auth.organizationId,
            contentType: 'image/png',
            data: avatar.data,
            sha256: avatar.sha256,
          })
          .onConflictDoUpdate({
            target: mailAccountAvatars.accountId,
            set: { data: avatar.data, sha256: avatar.sha256, updatedAt: now() },
          });
        await tx
          .update(mailAccounts)
          .set({ avatarSha256: avatar.sha256 })
          .where(
            and(eq(mailAccounts.organizationId, auth.organizationId), eq(mailAccounts.id, row.id)),
          );
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.mailAccountAvatarUpdated,
          targetType: 'mail_account',
          targetId: row.id,
          metadata: { kind: row.kind, address: row.emailAddress, change: 'set' },
          client: context.client,
        });
      });
      return { avatarUrl: avatarUrlOf({ id: row.id, avatarSha256: avatar.sha256 }) };
    },

    async deleteAvatar(auth: AuthContext, accountId: string, context: MailContext) {
      const { row } = await requireLevel(auth, accountId, 'manage', context);
      await db.transaction(async (tx) => {
        await tx
          .delete(mailAccountAvatars)
          .where(
            and(
              eq(mailAccountAvatars.organizationId, auth.organizationId),
              eq(mailAccountAvatars.accountId, row.id),
            ),
          );
        await tx
          .update(mailAccounts)
          .set({ avatarSha256: null })
          .where(
            and(eq(mailAccounts.organizationId, auth.organizationId), eq(mailAccounts.id, row.id)),
          );
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.mailAccountAvatarUpdated,
          targetType: 'mail_account',
          targetId: row.id,
          metadata: { kind: row.kind, address: row.emailAddress, change: 'removed' },
          client: context.client,
        });
      });
      return { avatarUrl: null };
    },

    /** Gambar foto: hak ≥ `read`, atau `mail.accounts.manage` untuk metadata akun pribadi orang lain. */
    async avatar(auth: AuthContext, accountId: string) {
      const viewer = await viewerOf(db, auth);
      const row = await loadAccountRow(db, auth.organizationId, accountId);
      if (!row) throw mailNotFound();
      const level = await levelOf(db, viewer, auth.organizationId, row);
      const metadataViewer =
        row.kind === 'personal' && hasPermission(auth.user.role, 'mail.accounts.manage');
      if (!level && !metadataViewer) throw mailNotFound();
      const [image] = await db
        .select({ data: mailAccountAvatars.data, sha256: mailAccountAvatars.sha256 })
        .from(mailAccountAvatars)
        .where(
          and(
            eq(mailAccountAvatars.organizationId, auth.organizationId),
            eq(mailAccountAvatars.accountId, row.id),
          ),
        )
        .limit(1);
      if (!image) throw new AppError('NOT_FOUND', { message: 'Akun ini belum punya foto.' });
      return image;
    },

    // ── Pengaturan email ───────────────────────────────────────────────────

    async settings(auth: AuthContext): Promise<MailSettings> {
      const [row] = await db
        .select()
        .from(mailSettings)
        .where(eq(mailSettings.organizationId, auth.organizationId))
        .limit(1);
      return {
        cacheRetentionDays: row?.cacheRetentionDays ?? MAIL_CACHE_RETENTION_DAYS.default,
        defaultSyncWindowDays: (row
          ? row.defaultSyncWindowDays
          : MAIL_DEFAULT_SYNC_WINDOW_DAYS) as MailSyncWindowDays,
        maxRecipientsPerEmail: row?.maxRecipientsPerEmail ?? MAIL_RECIPIENTS_PER_EMAIL.default,
        maxAttachmentTotalMb: row?.maxAttachmentTotalMb ?? MAIL_ATTACHMENT_TOTAL_MB.default,
      };
    },

    async updateSettings(
      auth: AuthContext,
      request: UpdateMailSettingsRequest,
      context: MailContext,
    ): Promise<MailSettings> {
      const before = await service.settings(auth);
      const { confirmation, ...rest } = request;
      const input: MailSettings = {
        cacheRetentionDays: rest.cacheRetentionDays,
        defaultSyncWindowDays: rest.defaultSyncWindowDays,
        maxRecipientsPerEmail: rest.maxRecipientsPerEmail ?? before.maxRecipientsPerEmail,
        maxAttachmentTotalMb: rest.maxAttachmentTotalMb ?? before.maxAttachmentTotalMb,
      };
      // 9B §12.1: MENAIKKAN batas penerima/lampiran = melonggarkan rem → konfirmasi identitas.
      const loosened =
        input.maxRecipientsPerEmail > before.maxRecipientsPerEmail ||
        input.maxAttachmentTotalMb > before.maxAttachmentTotalMb;
      if (loosened) {
        await confirm(
          auth,
          confirmation,
          'settings.mail.limits',
          'Masukkan password-mu (dan kode verifikasi dua langkah) untuk menaikkan batas kirim email.',
          context,
        );
      }
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'mail.accounts.manage', context.log);
        if (!loosened) {
          // Pemeriksaan "tidak melonggarkan" diulang dengan baris terkunci (balapan dua permintaan).
          const [locked] = await tx
            .select({
              maxRecipients: mailSettings.maxRecipientsPerEmail,
              maxMb: mailSettings.maxAttachmentTotalMb,
            })
            .from(mailSettings)
            .where(eq(mailSettings.organizationId, auth.organizationId))
            .for('update');
          const currentRecipients = locked?.maxRecipients ?? MAIL_RECIPIENTS_PER_EMAIL.default;
          const currentMb = locked?.maxMb ?? MAIL_ATTACHMENT_TOTAL_MB.default;
          if (
            input.maxRecipientsPerEmail > currentRecipients ||
            input.maxAttachmentTotalMb > currentMb
          ) {
            throw new AppError('CONFLICT', {
              message: 'Pengaturan email baru saja diubah orang lain. Muat ulang lalu coba lagi.',
            });
          }
        }
        await tx
          .insert(mailSettings)
          .values({
            organizationId: auth.organizationId,
            cacheRetentionDays: input.cacheRetentionDays,
            defaultSyncWindowDays: input.defaultSyncWindowDays,
            maxRecipientsPerEmail: input.maxRecipientsPerEmail,
            maxAttachmentTotalMb: input.maxAttachmentTotalMb,
            updatedByUserId: auth.user.id,
          })
          .onConflictDoUpdate({
            target: mailSettings.organizationId,
            set: {
              cacheRetentionDays: input.cacheRetentionDays,
              defaultSyncWindowDays: input.defaultSyncWindowDays,
              maxRecipientsPerEmail: input.maxRecipientsPerEmail,
              maxAttachmentTotalMb: input.maxAttachmentTotalMb,
              updatedByUserId: auth.user.id,
              updatedAt: now(),
            },
          });
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.settingsMailUpdated,
          metadata: { previous: before, next: input, loosened },
          client: context.client,
        });
      });
      return input;
    },

    // ── Folder & sidebar ───────────────────────────────────────────────────

    async folders(auth: AuthContext, accountId: string): Promise<{ folders: MailFolder[] }> {
      const { row } = await loadWithLevel(auth, accountId);
      const map = await foldersOf(db, auth.organizationId, [row.id]);
      return { folders: map.get(row.id) ?? [] };
    },

    async sidebar(auth: AuthContext): Promise<MailSidebarResponse> {
      const levels = await accessibleMailAccountsOf(db, auth.organizationId, auth.user.id);
      const ids = [...levels.keys()];
      if (ids.length === 0) {
        return {
          unified: { unreadCount: 0 },
          unread: { count: 0 },
          starred: { count: 0 },
          accounts: [],
        };
      }
      const rows = await db
        .select()
        .from(mailAccounts)
        .where(
          and(
            eq(mailAccounts.organizationId, auth.organizationId),
            inArray(mailAccounts.id, ids),
            isNull(mailAccounts.deletedAt),
          ),
        );
      const folders = await foldersOf(db, auth.organizationId, ids);
      const [counts] = await db
        .select({
          unread: sql<number>`count(*) filter (where not ${mailMessages.isRead})::int`,
          starred: sql<number>`count(*) filter (where ${mailMessages.isStarred})::int`,
        })
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.organizationId, auth.organizationId),
            inArray(mailMessages.accountId, ids),
            sql`(${mailMessages.isStarred} or not ${mailMessages.isRead})`,
            sql`${mailMessages.folderRole} is distinct from 'junk' and ${mailMessages.folderRole} is distinct from 'trash'`,
            // Bagian 2: aksi bendera tertunda tetap dihitung; pindah/hapus tertunda tidak.
            sql`(${mailMessages.pendingAction} is null or ${mailMessages.pendingAction} = 'flags')`,
          ),
        );
      let unified = 0;
      for (const list of folders.values()) {
        for (const folder of list) if (folder.role === 'inbox') unified += folder.unreadCount;
      }
      return {
        unified: { unreadCount: unified },
        unread: { count: counts?.unread ?? 0 },
        starred: { count: counts?.starred ?? 0 },
        accounts: rows
          .sort((a, b) => a.displayName.localeCompare(b.displayName, 'id', { sensitivity: 'base' }))
          .map((row) => ({
            account: {
              id: row.id,
              displayName: row.displayName,
              emailAddress: row.emailAddress,
              color: row.color as MailAccount['color'],
              avatarUrl: avatarUrlOf(row),
              myLevel: levels.get(row.id) ?? 'read',
              sync: { state: row.syncState as MailAccount['sync']['state'] },
            },
            folders: folders.get(row.id) ?? [],
          })),
      };
    },

    /** `navigation.mail` untuk respons sesi (kontrak §1). */
    async navigation(auth: AuthContext): Promise<{ mail: boolean }> {
      if (!hasPermission(auth.user.role, 'mail.view')) return { mail: false };
      const levels = await accessibleMailAccountsOf(db, auth.organizationId, auth.user.id);
      return { mail: mailMenuVisible(auth.user.role, levels.size) };
    },
  };

  async function publishAccessChanged(
    organizationId: string,
    grants: CreateMailAccountRequest['access'],
  ) {
    const userIds = await usersOfPrincipals(db, organizationId, grants);
    if (userIds.length > 0) {
      await publisher.publish([
        { organizationId, userIds, event: { type: 'mail.access.changed' } },
      ]);
    }
  }

  return service;
}

export type MailService = ReturnType<typeof createMailService>;

/** Pengguna yang tercakup daftar principal (pengguna langsung + anggota departemen). */
export async function usersOfPrincipals(
  db: DbExecutor,
  organizationId: string,
  grants: readonly (
    | { principalType: 'user'; userId: string }
    | { principalType: 'department'; departmentId: string }
  )[],
): Promise<string[]> {
  const ids = new Set<string>();
  const departmentIds: string[] = [];
  for (const grant of grants) {
    if (grant.principalType === 'user') ids.add(grant.userId);
    else departmentIds.push(grant.departmentId);
  }
  if (departmentIds.length > 0) {
    const rows = await db.execute<{ user_id: string }>(
      sql`select user_id from department_members where organization_id = ${organizationId} and department_id in (${sql.join(
        departmentIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
    for (const row of rows.rows) ids.add(row.user_id);
  }
  return [...ids].slice(0, 1_000);
}

/** Semua pengguna yang mungkin punya hak atas akun ini (untuk `mail.access.changed`). */
export async function affectedUsersOf(
  db: DbExecutor,
  organizationId: string,
  accountId: string,
  row: Pick<MailAccountRow, 'kind' | 'ownerUserId'>,
): Promise<string[]> {
  if (row.kind === 'personal') return row.ownerUserId ? [row.ownerUserId] : [];
  const grants = await db
    .select({
      principalType: mailAccountAccess.principalType,
      userId: mailAccountAccess.userId,
      departmentId: mailAccountAccess.departmentId,
    })
    .from(mailAccountAccess)
    .where(
      and(
        eq(mailAccountAccess.organizationId, organizationId),
        eq(mailAccountAccess.accountId, accountId),
      ),
    );
  const managers = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.organizationId, organizationId),
        inArray(users.role, ['owner', 'admin']),
        isNull(users.disabledAt),
      ),
    );
  const fromGrants = await usersOfPrincipals(
    db,
    organizationId,
    grants.map((grant) =>
      grant.principalType === 'user'
        ? { principalType: 'user' as const, userId: grant.userId ?? '' }
        : { principalType: 'department' as const, departmentId: grant.departmentId ?? '' },
    ),
  );
  return [...new Set([...fromGrants, ...managers.map((manager) => manager.id)])].slice(0, 1_000);
}
