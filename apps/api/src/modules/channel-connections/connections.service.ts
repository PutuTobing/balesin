import {
  AppError,
  constantTimeEqual,
  fallbackEmailSettings,
  isMetaApiError,
  isPlaintextLoginRejected,
  isTelegramApiError,
  metaSocialTestCode,
  newTelegramWebhookSecret,
  newWebhookVerifyToken,
  openChannelConnectionSecret,
  openMetaSocialCredentials,
  openMetaSocialSecret,
  openStoredEmailSettings,
  readMetaSocialTarget,
  sealChannelConnectionSecret,
  sealMetaSocialSecret,
  secretTail,
  telegramWebhookUrlUsable,
  testImapConnection,
  verifySmtpConnection,
  Secret,
  type HostLookup,
  type ImapPolicy,
  type MailTransportSettings,
  type MetaGraphClient,
  type PlaintextLoginPolicy,
  type SecretBox,
  type SmtpConnectionConfig,
  type SmtpFallbackConfig,
  type SmtpPolicy,
  type SmtpTimeouts,
  type TelegramBotClient,
} from '@balesin/core';
import {
  channels,
  contacts,
  emailMailboxStates,
  emailSettings,
  isPgError,
  lockEmailAddresses,
  mailAccounts,
  mailOrganizationDomains,
  newId,
  PG_ERROR_CODES,
  type Channel,
  type Database,
  type DbExecutor,
  type EmailMailboxState,
  type NewChannel,
} from '@balesin/db';
import {
  CONNECTION_TEST_MESSAGES,
  EMAIL_TEST_MESSAGES,
  MAX_CHANNELS_PER_ORGANIZATION,
  META_SOCIAL_WEBHOOK_FIELDS,
  TELEGRAM_WEBHOOK_WARNING,
  channelTypeInfos,
  type ChannelWebhookResponse,
  type ConnectionChannel,
  type ConnectionChannelListResponse,
  type ConnectionCheck,
  type ConnectionTestCode,
  type ConnectionTestResult,
  type CreateConnectionChannelRequest,
  type ErrorDetail,
  type IdentityConfirmation,
  type UpdateConnectionChannelRequest,
} from '@balesin/shared';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { EmailNotifier } from '../../queues/email-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import {
  noticeMetadata,
  queueChannelChangeNotices,
  type ChannelChangeActor,
} from '../channels/channel-change-notice';
import { webhookUrlWarning } from '../channels/channel-view';
import { recordChannelTest } from '../channels/channels.repo';
import type { ChannelContext } from '../channels/channels.service';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorService } from '../two-factor/two-factor.service';
import {
  claimAddressForOrganization,
  notifyRevokedClaims,
  type RevokedClaim,
} from '../mail/mail-compose.repo';
import { connectionWebhookUrl, isConnectionType, toConnectionChannel } from './connection-view';

/**
 * Channel selain WhatsApp (Fase 6, docs/KONTRAK-API-CHANNEL-LAIN.md): Telegram Bot, Email (IMAP +
 * SMTP), Messenger, Instagram DM. Pola sama dengan channel WhatsApp:
 *
 *  - Semua query terfilter organisasi pelaku; channel organisasi lain / jenis lain / ID asing = 404.
 *  - Membuat channel atau mengganti kredensial/tujuannya WAJIB konfirmasi identitas (semua peran,
 *    Owner juga) + `assertActorStillAuthorized` di transaksi akhir; Owner diberi tahu bila pelakunya
 *    Admin (`channel-change-notice`).
 *  - Rahasia dienkripsi `SecretBox` per kolom + ID channel; respons/log/audit hanya ekornya.
 *  - Panggilan keluar hanya ke host tetap (api.telegram.org, graph.facebook.com) atau host email yang
 *    diisi pengguna lewat penjaga `resolveMailHost` (port allowlist, link-local diblokir).
 *  - Messenger/Instagram dibuat NONAKTIF (butuh App Review Meta) dan hanya bisa diaktifkan setelah tes
 *    koneksi berhasil.
 */

export interface ConnectionsServiceDeps {
  db: Database;
  secretBox: SecretBox | null;
  meta: MetaGraphClient;
  telegram: TelegramBotClient;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  notifier: Pick<EmailNotifier, 'channelChanged' | 'securityNoticeAdmin'>;
  apiUrl: string;
  isProduction: boolean;
  imapPolicy: ImapPolicy;
  smtp: {
    allowedPorts: readonly number[];
    plaintextLogin: PlaintextLoginPolicy;
    lookup?: HostLookup;
    timeouts?: Partial<SmtpTimeouts>;
    fallback: SmtpFallbackConfig | null;
  };
  now?: () => Date;
}

export interface ConnectionsService {
  readonly canStoreSecrets: boolean;
  list(auth: AuthContext): Promise<ConnectionChannelListResponse>;
  get(auth: AuthContext, channelId: string): Promise<ConnectionChannel>;
  create(
    auth: AuthContext,
    input: CreateConnectionChannelRequest,
    context: ChannelContext,
  ): Promise<{ channel: ConnectionChannel; webhook: ChannelWebhookResponse | null }>;
  update(
    auth: AuthContext,
    channelId: string,
    input: UpdateConnectionChannelRequest,
    context: ChannelContext,
  ): Promise<ConnectionChannel>;
  setEnabled(
    auth: AuthContext,
    channelId: string,
    enabled: boolean,
    context: ChannelContext,
  ): Promise<ConnectionChannel>;
  remove(
    auth: AuthContext,
    channelId: string,
    confirmation: IdentityConfirmation,
    context: ChannelContext,
  ): Promise<void>;
  test(
    auth: AuthContext,
    channelId: string,
    context: ChannelContext,
  ): Promise<ConnectionTestResult>;
  webhook(auth: AuthContext, channelId: string): Promise<ChannelWebhookResponse>;
  rotateWebhook(
    auth: AuthContext,
    channelId: string,
    context: ChannelContext,
  ): Promise<{ channel: ConnectionChannel; webhook: ChannelWebhookResponse | null }>;
}

const NOT_FOUND_MESSAGE = 'Channel tidak ditemukan. Mungkin sudah dihapus.';
const NO_MASTER_KEY_MESSAGE =
  'Kredensial channel belum bisa disimpan karena BALESIN_MASTER_KEY belum diisi di berkas .env server. ' +
  'Isi dulu (lihat .env.example), jalankan ulang aplikasi, lalu coba lagi.';
const SECRET_UNAVAILABLE_MESSAGE =
  'Kredensial tersimpan channel ini tidak bisa dibuka (BALESIN_MASTER_KEY server berubah). Masukkan ulang kredensialnya.';
const CHANNEL_ID_FORMAT = z.uuid();
/** Tenggat total satu operasi yang memanggil layanan luar. */
export const CONNECTION_OPERATION_DEADLINE_MS = 30_000;

const CONFIRM = {
  create: 'Masukkan password-mu (dan kode verifikasi dua langkah) untuk menambahkan channel.',
  credentials:
    'Masukkan password-mu (dan kode verifikasi dua langkah) untuk mengganti kredensial channel.',
  delete: 'Masukkan password-mu (dan kode verifikasi dua langkah) untuk menghapus channel.',
  aliases:
    'Masukkan password-mu (dan kode verifikasi dua langkah) untuk menambah alias alamat email channel.',
} as const;

const CONFLICT_MESSAGES: Readonly<Record<string, { field: string; message: string }>> = {
  channels_organization_id_tg_bot_id_live_unique: {
    field: 'botToken',
    message:
      'Bot Telegram ini sudah terhubung sebagai channel lain. Ubah atau hapus channel itu dulu.',
  },
  channels_organization_id_email_address_live_unique: {
    field: 'emailAddress',
    message:
      'Alamat email ini sudah terhubung sebagai channel lain. Ubah atau hapus channel itu dulu.',
  },
  channels_organization_id_meta_page_id_live_unique: {
    field: 'pageId',
    message: 'Halaman ini sudah terhubung sebagai channel lain. Ubah atau hapus channel itu dulu.',
  },
};

function notFound(): AppError {
  return new AppError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
}

/**
 * Fase 9 (KONTRAK-API-EMAIL §4.3, arah sebaliknya): alamat/alias Channel Email tidak boleh sudah menjadi
 * akun di menu Email. Advisory lock `email-address:<org>:<alamat>` yang SAMA dengan modul Email
 * dipegang di transaksi, jadi dua permintaan bersamaan tidak bisa sama-sama lolos.
 */
async function assertNotMailAccount(
  tx: DbExecutor,
  organizationId: string,
  addresses: readonly string[],
  actor: { auth: AuthContext; client: ChannelContext['client'] },
): Promise<RevokedClaim[]> {
  const list = [...new Set(addresses.filter((address) => address.length > 0))];
  if (list.length === 0) return [];
  await lockEmailAddresses(tx, organizationId, list);
  const [hit] = await tx
    .select({ id: mailAccounts.id })
    .from(mailAccounts)
    .where(
      and(
        eq(mailAccounts.organizationId, organizationId),
        inArray(mailAccounts.emailAddress, list),
        isNull(mailAccounts.deletedAt),
      ),
    )
    .limit(1);
  const mailAccountConflict = (message: string) =>
    new AppError('CONFLICT', {
      message,
      details: [
        { location: 'body', field: 'emailAddress', message, reason: 'address_is_mail_account' },
      ],
    });
  if (hit) {
    throw mailAccountConflict(
      'Alamat ini sudah terhubung sebagai akun di menu Email. Satu alamat hanya bisa dipakai di Inbox atau di menu Email. Putuskan dulu akunnya di Pengaturan → Akun email.',
    );
  }
  // 9B (KONTRAK-API-EMAIL-TULIS §3.3): alias (identitas) akun Email juga dihitung. Review 9B S4: klaim
  // akun PRIBADI yang belum terverifikasi/disetujui tidak menghalangi Channel Email — dicabut; pemegang
  // kuat → 409 yang menyebut pemegangnya.
  const [sender] = await tx
    .select({ address: emailSettings.fromAddress })
    .from(emailSettings)
    .where(eq(emailSettings.organizationId, organizationId))
    .limit(1);
  const domains = await mailOrganizationDomains(tx, organizationId);
  const revoked: RevokedClaim[] = [];
  for (const address of list) {
    try {
      revoked.push(
        ...(await claimAddressForOrganization(tx, {
          organizationId,
          actorUserId: actor.auth.user.id,
          role: actor.auth.user.role,
          address,
          systemSender: sender ? { address: sender.address, host: '', username: null } : null,
          domains,
          client: actor.client,
          field: 'emailAddress',
          // Channel/pengirim sistem beralamat sama sudah diatur aturannya sendiri (Fase 1/9.0).
          ignore: (holder) => holder.kind !== 'identity',
        })),
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'CONFLICT') {
        throw mailAccountConflict(error.message);
      }
      throw error;
    }
  }
  return revoked;
}

function bodyDetail(field: string, message: string): ErrorDetail {
  return { location: 'body', field, message };
}

function validation(field: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', { message, details: [bodyDetail(field, message)] });
}

function channelRequestFailed(message: string, retryAfterSeconds: number | null = null): AppError {
  return new AppError('CHANNEL_REQUEST_FAILED', {
    message,
    ...(retryAfterSeconds !== null ? { retryAfterSeconds } : {}),
  });
}

/** Galat Bot API Telegram saat memeriksa token → pesan untuk pengguna. */
function telegramTokenError(error: unknown): AppError {
  if (!isTelegramApiError(error)) throw error;
  if (error.kind === 'token_invalid') {
    return validation('botToken', CONNECTION_TEST_MESSAGES.telegram_token_invalid);
  }
  if (error.kind === 'rate_limited') {
    return channelRequestFailed(CONNECTION_TEST_MESSAGES.rate_limited, error.retryAfterSeconds);
  }
  if (error.kind === 'network') return channelRequestFailed(CONNECTION_TEST_MESSAGES.network_error);
  return channelRequestFailed(CONNECTION_TEST_MESSAGES.unexpected_response);
}

function telegramTestCode(error: unknown): ConnectionTestCode {
  if (!isTelegramApiError(error)) throw error;
  switch (error.kind) {
    case 'token_invalid':
      return 'telegram_token_invalid';
    case 'rate_limited':
      return 'rate_limited';
    case 'network':
      return 'network_error';
    case 'unexpected_response':
      return 'unexpected_response';
    default:
      return 'unknown';
  }
}

export function createConnectionsService(deps: ConnectionsServiceDeps): ConnectionsService {
  const { db, secretBox, meta, telegram, twoFactor, notifier, apiUrl } = deps;
  const now = deps.now ?? (() => new Date());

  const actorOf = (auth: AuthContext): ChannelChangeActor => ({
    userId: auth.user.id,
    role: auth.user.role,
  });
  const notifyOwners = (tx: DbExecutor, auth: AuthContext, auditLogId: string) =>
    queueChannelChangeNotices(tx, notifier, {
      organizationId: auth.organizationId,
      actor: actorOf(auth),
      auditLogId,
    });

  function requireBox(): SecretBox {
    if (!secretBox) throw new AppError('SERVICE_UNAVAILABLE', { message: NO_MASTER_KEY_MESSAGE });
    return secretBox;
  }

  /**
   * Review 9.0 R7: alias = "alamat sendiri" (email darinya dilewati) — alamat yang sudah menjadi
   * kontak email di organisasi ini (pelanggan) tidak boleh dijadikan alias, supaya email pelanggan
   * tidak bisa dibisukan diam-diam.
   */
  async function assertAliasesNotContacts(organizationId: string, aliases: readonly string[]) {
    if (aliases.length === 0) return;
    const [hit] = await db
      .select({ address: contacts.externalUserId })
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, organizationId),
          eq(contacts.channelType, 'email'),
          inArray(contacts.externalUserId, [...aliases]),
        ),
      )
      .limit(1);
    if (hit) {
      throw validation(
        'aliases',
        `Alamat ${hit.address ?? ''} sudah tercatat sebagai kontak pelanggan, jadi tidak bisa dijadikan alias channel.`,
      );
    }
  }

  function confirm(
    auth: AuthContext,
    confirmation: IdentityConfirmation | undefined,
    action: string,
    message: string,
    context: ChannelContext,
  ) {
    return requireIdentityConfirmation(twoFactor, auth, confirmation, action, context, message);
  }

  async function mailboxOf(row: Channel): Promise<EmailMailboxState | null> {
    if (row.type !== 'email') return null;
    const [state] = await db
      .select()
      .from(emailMailboxStates)
      .where(
        and(
          eq(emailMailboxStates.organizationId, row.organizationId),
          eq(emailMailboxStates.channelId, row.id),
        ),
      )
      .limit(1);
    return state ?? null;
  }

  async function view(row: Channel): Promise<ConnectionChannel> {
    return toConnectionChannel(row, apiUrl, await mailboxOf(row));
  }

  async function load(auth: AuthContext, channelId: string): Promise<Channel> {
    if (!CHANNEL_ID_FORMAT.safeParse(channelId).success) throw notFound();
    const [row] = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.organizationId, auth.organizationId),
          eq(channels.id, channelId),
          isNull(channels.deletedAt),
        ),
      )
      .limit(1);
    if (!row || !isConnectionType(row.type)) throw notFound();
    return row;
  }

  async function updateRow(
    tx: DbExecutor,
    auth: AuthContext,
    channelId: string,
    changes: Partial<NewChannel>,
  ): Promise<Channel> {
    const [row] = await tx
      .update(channels)
      .set({ ...changes, updatedByUserId: auth.user.id })
      .where(
        and(
          eq(channels.organizationId, auth.organizationId),
          eq(channels.id, channelId),
          isNull(channels.deletedAt),
        ),
      )
      .returning();
    if (!row) throw notFound();
    return row;
  }

  function rethrowConflict(error: unknown): never {
    for (const [constraint, detail] of Object.entries(CONFLICT_MESSAGES)) {
      if (isPgError(error, PG_ERROR_CODES.uniqueViolation, constraint)) {
        throw new AppError('CONFLICT', {
          message: detail.message,
          details: [bodyDetail(detail.field, detail.message)],
        });
      }
    }
    throw error;
  }

  function open(
    row: Channel,
    kind: Parameters<typeof openChannelConnectionSecret>[2],
    sealed: string | null,
  ) {
    if (!secretBox || sealed === null) return null;
    try {
      return openChannelConnectionSecret(secretBox, row, kind, sealed);
    } catch {
      return null;
    }
  }

  function requireOpen(
    row: Channel,
    kind: Parameters<typeof openChannelConnectionSecret>[2],
    sealed: string | null,
  ): Secret<string> {
    const secret = open(row, kind, sealed);
    if (!secret) throw new AppError('SERVICE_UNAVAILABLE', { message: SECRET_UNAVAILABLE_MESSAGE });
    return secret;
  }

  // ── Telegram ──────────────────────────────────────────────────────────────

  /** Pasang webhook (secret tersimpan baris ini). `false` = alamat tidak bisa dipakai Telegram. */
  async function registerTelegramWebhook(row: Channel): Promise<boolean> {
    const url = connectionWebhookUrl(apiUrl, 'telegram', row.id);
    if (!telegramWebhookUrlUsable(url)) return false;
    const token = requireOpen(row, 'telegramBotToken', row.tgBotTokenEncrypted);
    const secret = requireOpen(row, 'telegramWebhookSecret', row.tgWebhookSecretEncrypted);
    await telegram.setWebhook(
      token,
      { url, secretToken: secret.reveal() },
      AbortSignal.timeout(CONNECTION_OPERATION_DEADLINE_MS),
    );
    await db
      .update(channels)
      .set({ tgWebhookRegisteredAt: now() })
      .where(and(eq(channels.organizationId, row.organizationId), eq(channels.id, row.id)));
    return true;
  }

  // ── Email ─────────────────────────────────────────────────────────────────

  async function assertSmtpAllowed(
    smtp: {
      host: string;
      security: string;
      username: string;
    },
    field: string,
  ): Promise<void> {
    if (smtp.security === 'none' && deps.isProduction) {
      throw validation(
        `${field}.security`,
        'SMTP keluar channel email wajib terenkripsi. Pilih SSL/TLS (port 465) atau STARTTLS (port 587).',
      );
    }
    if (
      smtp.security === 'none' &&
      (await isPlaintextLoginRejected(
        { host: smtp.host, security: 'none', username: smtp.username },
        {
          plaintextLogin: deps.smtp.plaintextLogin,
          lookup: deps.smtp.lookup,
          timeouts: deps.smtp.timeouts,
        },
      ))
    ) {
      throw validation(`${field}.security`, EMAIL_TEST_MESSAGES.insecure_login);
    }
  }

  /** SMTP keluar yang dipakai channel email (`system` = Pengaturan → Email pengirim / cadangan). */
  async function smtpTransportOf(
    row: Channel,
  ): Promise<
    | { ok: true; transport: MailTransportSettings; policy: SmtpPolicy }
    | { ok: false; code: 'smtp_not_configured' | 'secret_unavailable' }
  > {
    const basePolicy = {
      plaintextLogin: deps.smtp.plaintextLogin,
      lookup: deps.smtp.lookup,
      timeouts: deps.smtp.timeouts,
    };
    if (row.emailSmtpMode === 'custom') {
      const password = open(row, 'emailSmtpPassword', row.emailSmtpPasswordEncrypted);
      if (!password) return { ok: false, code: 'secret_unavailable' };
      const connection: SmtpConnectionConfig = {
        host: row.emailSmtpHost ?? '',
        port: row.emailSmtpPort ?? 465,
        security: (row.emailSmtpSecurity ?? 'ssl') as SmtpConnectionConfig['security'],
        username: row.emailSmtpUsername,
        password,
      };
      return {
        ok: true,
        transport: {
          connection,
          sender: {
            fromName: row.emailFromName ?? row.name,
            fromAddress: row.emailAddress ?? '',
            replyTo: null,
          },
        },
        policy: { ...basePolicy, allowedPorts: deps.smtp.allowedPorts },
      };
    }
    const [stored] = await db
      .select()
      .from(emailSettings)
      .where(eq(emailSettings.organizationId, row.organizationId))
      .limit(1);
    if (stored) {
      const opened = openStoredEmailSettings(stored, secretBox);
      if (!opened.ok) return { ok: false, code: 'secret_unavailable' };
      return {
        ok: true,
        transport: opened.settings,
        policy: { ...basePolicy, allowedPorts: deps.smtp.allowedPorts },
      };
    }
    if (deps.smtp.fallback) {
      return {
        ok: true,
        transport: fallbackEmailSettings(deps.smtp.fallback),
        policy: {
          ...basePolicy,
          allowedPorts: [...deps.smtp.allowedPorts, deps.smtp.fallback.port],
        },
      };
    }
    return { ok: false, code: 'smtp_not_configured' };
  }

  // ── Uji koneksi per jenis ─────────────────────────────────────────────────

  async function runTest(row: Channel): Promise<ConnectionCheck[]> {
    const check = (
      name: ConnectionCheck['name'],
      code: ConnectionTestCode,
      message?: string,
    ): ConnectionCheck => ({
      name,
      ok: code === 'ok',
      code,
      message: message ?? CONNECTION_TEST_MESSAGES[code],
    });
    const signal = AbortSignal.timeout(CONNECTION_OPERATION_DEADLINE_MS);
    switch (row.type) {
      case 'telegram': {
        const token = open(row, 'telegramBotToken', row.tgBotTokenEncrypted);
        if (!token) return [check('bot', 'secret_unavailable')];
        try {
          const me = await telegram.getMe(token, signal);
          if (me.id !== row.tgBotId) return [check('bot', 'telegram_token_invalid')];
        } catch (error) {
          return [check('bot', telegramTestCode(error))];
        }
        const expected = connectionWebhookUrl(apiUrl, 'telegram', row.id);
        try {
          const info = await telegram.getWebhookInfo(token, signal);
          let code: ConnectionTestCode = 'ok';
          if (info.url === '') code = 'telegram_webhook_not_registered';
          else if (info.url !== expected) code = 'telegram_webhook_url_mismatch';
          else if (
            info.last_error_date !== undefined &&
            now().getTime() / 1000 - info.last_error_date < 60 * 60
          ) {
            code = 'telegram_webhook_failing';
          }
          return [check('bot', 'ok', 'Token bot diterima Telegram.'), check('webhook', code)];
        } catch (error) {
          return [
            check('bot', 'ok', 'Token bot diterima Telegram.'),
            check('webhook', telegramTestCode(error)),
          ];
        }
      }
      case 'email': {
        const checks: ConnectionCheck[] = [];
        const password = open(row, 'emailImapPassword', row.emailImapPasswordEncrypted);
        if (!password) {
          checks.push(check('incoming', 'secret_unavailable'));
        } else {
          const imap = await testImapConnection(
            {
              host: row.emailImapHost ?? '',
              port: row.emailImapPort ?? 993,
              security: row.emailImapSecurity === 'starttls' ? 'starttls' : 'ssl',
              username: row.emailImapUsername ?? '',
              password,
              folder: row.emailImapFolder ?? 'INBOX',
            },
            deps.imapPolicy,
          );
          checks.push(
            imap.ok
              ? check('incoming', 'ok', 'Kotak masuk (IMAP) tersambung dan folder ditemukan.')
              : check('incoming', imap.code),
          );
        }
        const smtp = await smtpTransportOf(row);
        if (!smtp.ok) {
          checks.push(check('outgoing', smtp.code));
        } else {
          const result = await verifySmtpConnection(smtp.transport.connection, smtp.policy);
          checks.push(
            result.ok
              ? check('outgoing', 'ok', 'SMTP keluar tersambung. Balasan bisa dikirim.')
              : check('outgoing', 'smtp_failed', EMAIL_TEST_MESSAGES[result.code]),
          );
        }
        return checks;
      }
      case 'messenger':
      case 'instagram': {
        if (!secretBox) return [check('page', 'secret_unavailable')];
        let credentials;
        try {
          credentials = openMetaSocialCredentials(secretBox, row);
        } catch {
          return [check('page', 'secret_unavailable')];
        }
        const step = { current: 'page' as 'page' | 'instagram' };
        try {
          const target = await readMetaSocialTarget(
            meta,
            credentials,
            {
              pageId: row.metaPageId ?? '',
              instagramAccountId: row.type === 'instagram' ? row.metaIgAccountId : null,
            },
            signal,
          );
          step.current = 'instagram';
          const checks = [
            check(
              'page',
              'ok',
              target.pageName ? `Halaman "${target.pageName}" terbaca.` : 'Halaman terbaca.',
            ),
          ];
          if (row.type === 'instagram') {
            checks.push(
              check(
                'instagram',
                'ok',
                target.instagramUsername
                  ? `Akun Instagram @${target.instagramUsername} terbaca.`
                  : 'Akun Instagram terbaca.',
              ),
            );
          }
          return checks;
        } catch (error) {
          if (!isMetaApiError(error)) throw error;
          // Pembacaan Halaman lolos lalu akun IG gagal: galatnya milik langkah Instagram.
          const failedStep = error.operation === 'social_instagram.read' ? 'instagram' : 'page';
          return [check(failedStep, metaSocialTestCode(error.kind, failedStep))];
        }
      }
      default:
        throw notFound();
    }
  }

  function webhookViewOf(row: Channel): ChannelWebhookResponse {
    if (row.type !== 'messenger' && row.type !== 'instagram') throw notFound();
    const box = requireBox();
    if (row.metaVerifyTokenEncrypted === null || row.metaVerifyTokenRotatedAt === null)
      throw notFound();
    let verifyToken: string;
    try {
      verifyToken = openMetaSocialSecret(
        box,
        row,
        'verifyToken',
        row.metaVerifyTokenEncrypted,
      ).reveal();
    } catch {
      throw new AppError('SERVICE_UNAVAILABLE', {
        message:
          'Verify token tersimpan tidak bisa dibuka (BALESIN_MASTER_KEY server berubah). Buat ulang verify token, lalu pasang lagi di Meta.',
      });
    }
    return {
      channelId: row.id,
      callbackUrl: connectionWebhookUrl(apiUrl, row.type, row.id),
      verifyToken,
      verifyTokenRotatedAt: row.metaVerifyTokenRotatedAt.toISOString(),
      subscribeFields: [...META_SOCIAL_WEBHOOK_FIELDS],
      warning: webhookUrlWarning(apiUrl),
    };
  }

  return {
    canStoreSecrets: secretBox !== null,

    async list(auth) {
      const rows = await db
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.organizationId, auth.organizationId),
            isNull(channels.deletedAt),
            inArray(channels.type, ['telegram', 'email', 'messenger', 'instagram']),
          ),
        )
        .orderBy(asc(channels.createdAt), asc(channels.id));
      const states = rows.some((row) => row.type === 'email')
        ? await db
            .select()
            .from(emailMailboxStates)
            .where(eq(emailMailboxStates.organizationId, auth.organizationId))
        : [];
      const byChannel = new Map(states.map((state) => [state.channelId, state]));
      return {
        channels: rows.map((row) =>
          toConnectionChannel(row, apiUrl, byChannel.get(row.id) ?? null),
        ),
        types: channelTypeInfos(),
        canStoreSecrets: secretBox !== null,
        maxChannels: MAX_CHANNELS_PER_ORGANIZATION,
      };
    },

    async get(auth, channelId) {
      return view(await load(auth, channelId));
    },

    async create(auth, input, context) {
      const box = requireBox();
      await confirm(auth, input.confirmation, 'channel.create', CONFIRM.create, context);
      const id = newId();
      const owner = { id, organizationId: auth.organizationId };
      const createdAt = now();
      const values: NewChannel = {
        id,
        organizationId: auth.organizationId,
        type: input.type,
        name: input.name,
        credentialsUpdatedAt: createdAt,
        createdByUserId: auth.user.id,
        updatedByUserId: auth.user.id,
      };
      const auditDetails: Record<string, unknown> = { type: input.type, name: input.name };

      switch (input.type) {
        case 'telegram': {
          const token = new Secret(input.botToken);
          let me: { id: string; username: string | null };
          try {
            me = await telegram.getMe(token, AbortSignal.timeout(CONNECTION_OPERATION_DEADLINE_MS));
          } catch (error) {
            throw telegramTokenError(error);
          }
          if (!input.botToken.startsWith(`${me.id}:`)) {
            throw validation('botToken', CONNECTION_TEST_MESSAGES.telegram_token_invalid);
          }
          Object.assign(values, {
            tgBotId: me.id,
            tgBotUsername:
              me.username && /^[A-Za-z0-9_]{1,64}$/.test(me.username) ? me.username : null,
            tgBotTokenEncrypted: sealChannelConnectionSecret(
              box,
              owner,
              'telegramBotToken',
              input.botToken,
            ),
            tgBotTokenTail: secretTail(input.botToken),
            tgWebhookSecretEncrypted: sealChannelConnectionSecret(
              box,
              owner,
              'telegramWebhookSecret',
              newTelegramWebhookSecret(),
            ),
            // Token yang lolos getMe = sudah teruji.
            lastTestOk: true,
            lastTestCode: 'ok',
            lastTestedAt: createdAt,
          } satisfies Partial<NewChannel>);
          Object.assign(auditDetails, { botId: me.id, botUsername: values.tgBotUsername });
          break;
        }
        case 'email': {
          await assertAliasesNotContacts(
            auth.organizationId,
            (input.aliases ?? []).filter((alias) => alias !== input.emailAddress),
          );
          if (input.smtp.mode === 'custom') {
            if (input.smtp.password === undefined) {
              throw validation('smtp.password', 'Password SMTP wajib diisi.');
            }
            await assertSmtpAllowed(input.smtp, 'smtp');
          }
          Object.assign(values, {
            emailAddress: input.emailAddress,
            emailFromName: input.fromName,
            emailImapHost: input.imap.host,
            emailImapPort: input.imap.port,
            emailImapSecurity: input.imap.security,
            emailImapUsername: input.imap.username,
            emailImapPasswordEncrypted: sealChannelConnectionSecret(
              box,
              owner,
              'emailImapPassword',
              input.imap.password,
            ),
            emailImapPasswordTail: secretTail(input.imap.password),
            emailImapFolder: input.imap.folder ?? 'INBOX',
            emailPollIntervalMinutes: input.pollIntervalMinutes ?? 2,
            emailMarkAsRead: input.markAsRead ?? true,
            emailTrustedAuthServIds: input.trustedAuthServIds ?? null,
            emailAliases: (input.aliases ?? []).filter((alias) => alias !== input.emailAddress),
            emailSmtpMode: input.smtp.mode,
            ...(input.smtp.mode === 'custom' && input.smtp.password !== undefined
              ? {
                  emailSmtpHost: input.smtp.host,
                  emailSmtpPort: input.smtp.port,
                  emailSmtpSecurity: input.smtp.security,
                  emailSmtpUsername: input.smtp.username,
                  emailSmtpPasswordEncrypted: sealChannelConnectionSecret(
                    box,
                    owner,
                    'emailSmtpPassword',
                    input.smtp.password,
                  ),
                  emailSmtpPasswordTail: secretTail(input.smtp.password),
                }
              : {}),
          } satisfies Partial<NewChannel>);
          Object.assign(auditDetails, {
            emailAddress: input.emailAddress,
            imapHost: input.imap.host,
            smtpMode: input.smtp.mode,
            smtpHost: input.smtp.mode === 'custom' ? input.smtp.host : null,
          });
          break;
        }
        case 'messenger':
        case 'instagram': {
          Object.assign(values, {
            // Bawaan nonaktif: butuh App Review Meta; diaktifkan setelah tes koneksi berhasil.
            enabled: false,
            disabledAt: createdAt,
            metaPageId: input.pageId,
            metaIgAccountId: input.type === 'instagram' ? input.instagramAccountId : null,
            metaPageTokenEncrypted: sealMetaSocialSecret(
              box,
              owner,
              'pageToken',
              input.pageAccessToken,
            ),
            metaPageTokenTail: secretTail(input.pageAccessToken),
            metaAppSecretEncrypted: sealMetaSocialSecret(box, owner, 'appSecret', input.appSecret),
            metaAppSecretTail: secretTail(input.appSecret),
            metaVerifyTokenEncrypted: sealMetaSocialSecret(
              box,
              owner,
              'verifyToken',
              newWebhookVerifyToken(),
            ),
            metaVerifyTokenRotatedAt: createdAt,
          } satisfies Partial<NewChannel>);
          Object.assign(auditDetails, {
            pageId: input.pageId,
            instagramAccountId: input.type === 'instagram' ? input.instagramAccountId : null,
          });
          break;
        }
      }

      let revoked: RevokedClaim[] = [];
      const row = await db
        .transaction(async (tx) => {
          await assertActorStillAuthorized(tx, auth, 'channels.manage', context.log);
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`channels-create|${auth.organizationId}`}, 0))`,
          );
          const [counted] = await tx
            .select({ total: count() })
            .from(channels)
            .where(
              and(eq(channels.organizationId, auth.organizationId), isNull(channels.deletedAt)),
            );
          if ((counted?.total ?? 0) >= MAX_CHANNELS_PER_ORGANIZATION) {
            throw new AppError('CONFLICT', {
              message: `Batas ${MAX_CHANNELS_PER_ORGANIZATION} channel per organisasi sudah tercapai. Hapus channel yang tidak dipakai dulu.`,
            });
          }
          if (input.type === 'email') {
            revoked = await assertNotMailAccount(
              tx,
              auth.organizationId,
              [input.emailAddress, ...(input.aliases ?? [])],
              { auth, client: context.client },
            );
          }
          const [inserted] = await tx.insert(channels).values(values).returning();
          if (!inserted) throw new Error('Channel tidak tersimpan');
          if (input.type === 'email') {
            await tx.insert(emailMailboxStates).values({
              channelId: id,
              organizationId: auth.organizationId,
            });
          }
          const auditLogId = await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.channelCreated,
            targetType: 'channel',
            targetId: id,
            metadata: { ...auditDetails, ...noticeMetadata(actorOf(auth), 'created') },
            client: context.client,
          });
          await notifyOwners(tx, auth, auditLogId);
          return inserted;
        })
        .catch(rethrowConflict);
      await notifyRevokedClaims(
        notifier,
        { organizationId: auth.organizationId, actorUserId: auth.user.id, occurredAt: now() },
        revoked,
      );

      let current = row;
      if (row.type === 'telegram') {
        try {
          if (await registerTelegramWebhook(row)) current = await load(auth, row.id);
        } catch (error) {
          // Channel tetap tersimpan; webhook bisa dipasang ulang dari Pengaturan.
          context.log.warn(
            { channelRef: row.id, kind: isTelegramApiError(error) ? error.kind : 'internal' },
            'Webhook Telegram belum terpasang saat channel dibuat',
          );
        }
      }
      return {
        channel: await view(current),
        webhook: row.type === 'messenger' || row.type === 'instagram' ? webhookViewOf(row) : null,
      };
    },

    async update(auth, channelId, input, context) {
      const row = await load(auth, channelId);
      if (row.type !== input.type) {
        throw validation('type', 'Jenis channel tidak sama dengan channel yang diubah.');
      }
      const changes: Partial<NewChannel> = {};
      const credentialFields: string[] = [];
      /** Review 9.0 R7: ada alias baru → konfirmasi identitas (sekali, bersama kredensial bila ada). */
      let aliasesAdded = false;
      const plainFields: string[] = [];
      if (input.name !== undefined && input.name !== row.name) {
        changes.name = input.name;
        plainFields.push('name');
      }
      const owner = { id: row.id, organizationId: auth.organizationId };
      let resetMailbox = false;
      let reRegisterTelegram = false;

      switch (input.type) {
        case 'telegram': {
          if (input.botToken !== undefined) {
            const stored = open(row, 'telegramBotToken', row.tgBotTokenEncrypted);
            if (!stored || !constantTimeEqual(input.botToken, stored.reveal())) {
              const box = requireBox();
              let me;
              try {
                me = await telegram.getMe(
                  new Secret(input.botToken),
                  AbortSignal.timeout(CONNECTION_OPERATION_DEADLINE_MS),
                );
              } catch (error) {
                throw telegramTokenError(error);
              }
              if (me.id !== row.tgBotId) {
                throw validation(
                  'botToken',
                  'Token ini milik bot lain. Untuk memakai bot lain, hapus channel ini lalu tambahkan channel baru.',
                );
              }
              Object.assign(changes, {
                tgBotTokenEncrypted: sealChannelConnectionSecret(
                  box,
                  owner,
                  'telegramBotToken',
                  input.botToken,
                ),
                tgBotTokenTail: secretTail(input.botToken),
                tgBotUsername: me.username ?? row.tgBotUsername,
                tgWebhookSecretEncrypted: sealChannelConnectionSecret(
                  box,
                  owner,
                  'telegramWebhookSecret',
                  newTelegramWebhookSecret(),
                ),
                tgWebhookRegisteredAt: null,
              } satisfies Partial<NewChannel>);
              credentialFields.push('botToken');
              reRegisterTelegram = true;
            }
          }
          break;
        }
        case 'email': {
          if (input.fromName !== undefined && input.fromName !== row.emailFromName) {
            changes.emailFromName = input.fromName;
            plainFields.push('fromName');
          }
          if (
            input.pollIntervalMinutes !== undefined &&
            input.pollIntervalMinutes !== row.emailPollIntervalMinutes
          ) {
            changes.emailPollIntervalMinutes = input.pollIntervalMinutes;
            plainFields.push('pollIntervalMinutes');
          }
          if (input.markAsRead !== undefined && input.markAsRead !== row.emailMarkAsRead) {
            changes.emailMarkAsRead = input.markAsRead;
            plainFields.push('markAsRead');
          }
          // Review Fase 6 R1: daftar server tepercaya menentukan label "terverifikasi" — perubahan
          // diperlakukan seperti kredensial (konfirmasi identitas + pemberitahuan Owner).
          if (
            input.trustedAuthServIds !== undefined &&
            JSON.stringify(input.trustedAuthServIds) !== JSON.stringify(row.emailTrustedAuthServIds)
          ) {
            changes.emailTrustedAuthServIds = input.trustedAuthServIds;
            credentialFields.push('trustedAuthServIds');
          }
          if (input.emailAddress !== undefined && input.emailAddress !== row.emailAddress) {
            changes.emailAddress = input.emailAddress;
            credentialFields.push('emailAddress');
          }
          // Tahap 9.0: alias bukan kredensial (status tes tidak direset); alamat utama dibuang.
          // Review 9.0 R7: MENAMBAH alias = konfirmasi identitas + alias bukan alamat kontak pelanggan.
          const mainAddress = changes.emailAddress ?? row.emailAddress;
          const aliases =
            input.aliases !== undefined
              ? input.aliases.filter((alias) => alias !== mainAddress)
              : row.emailAliases.filter((alias) => alias !== mainAddress);
          if (JSON.stringify(aliases) !== JSON.stringify(row.emailAliases)) {
            const added = aliases.filter((alias) => !row.emailAliases.includes(alias));
            await assertAliasesNotContacts(auth.organizationId, added);
            if (added.length > 0) aliasesAdded = true;
            changes.emailAliases = aliases;
            plainFields.push('aliases');
          }
          if (input.imap) {
            const imap = input.imap;
            const target =
              imap.host !== row.emailImapHost ||
              imap.port !== row.emailImapPort ||
              imap.security !== row.emailImapSecurity ||
              imap.username !== row.emailImapUsername;
            const folderChanged = (imap.folder ?? 'INBOX') !== row.emailImapFolder;
            if (target && imap.password === undefined) {
              throw validation(
                'imap.password',
                'Isi ulang password IMAP karena host, port, keamanan, atau username berubah.',
              );
            }
            const stored = open(row, 'emailImapPassword', row.emailImapPasswordEncrypted);
            const passwordChanged =
              imap.password !== undefined &&
              (!stored || !constantTimeEqual(imap.password, stored.reveal()));
            if (target || folderChanged || passwordChanged) {
              const box = requireBox();
              Object.assign(changes, {
                emailImapHost: imap.host,
                emailImapPort: imap.port,
                emailImapSecurity: imap.security,
                emailImapUsername: imap.username,
                emailImapFolder: imap.folder ?? 'INBOX',
                ...(passwordChanged && imap.password !== undefined
                  ? {
                      emailImapPasswordEncrypted: sealChannelConnectionSecret(
                        box,
                        owner,
                        'emailImapPassword',
                        imap.password,
                      ),
                      emailImapPasswordTail: secretTail(imap.password),
                    }
                  : {}),
              } satisfies Partial<NewChannel>);
              credentialFields.push('imap');
              resetMailbox = target || folderChanged;
            }
          }
          if (input.smtp) {
            const smtp = input.smtp;
            if (smtp.mode === 'system') {
              if (row.emailSmtpMode !== 'system') {
                Object.assign(changes, {
                  emailSmtpMode: 'system',
                  emailSmtpHost: null,
                  emailSmtpPort: null,
                  emailSmtpSecurity: null,
                  emailSmtpUsername: null,
                  emailSmtpPasswordEncrypted: null,
                  emailSmtpPasswordTail: null,
                } satisfies Partial<NewChannel>);
                credentialFields.push('smtp');
              }
            } else {
              const target =
                row.emailSmtpMode !== 'custom' ||
                smtp.host !== row.emailSmtpHost ||
                smtp.port !== row.emailSmtpPort ||
                smtp.security !== row.emailSmtpSecurity ||
                smtp.username !== row.emailSmtpUsername;
              if (target && smtp.password === undefined) {
                throw validation(
                  'smtp.password',
                  'Isi ulang password SMTP karena host, port, keamanan, atau username berubah.',
                );
              }
              const stored = open(row, 'emailSmtpPassword', row.emailSmtpPasswordEncrypted);
              const passwordChanged =
                smtp.password !== undefined &&
                (!stored || !constantTimeEqual(smtp.password, stored.reveal()));
              if (target || passwordChanged) {
                await assertSmtpAllowed(smtp, 'smtp');
                const box = requireBox();
                Object.assign(changes, {
                  emailSmtpMode: 'custom',
                  emailSmtpHost: smtp.host,
                  emailSmtpPort: smtp.port,
                  emailSmtpSecurity: smtp.security,
                  emailSmtpUsername: smtp.username,
                  ...(passwordChanged && smtp.password !== undefined
                    ? {
                        emailSmtpPasswordEncrypted: sealChannelConnectionSecret(
                          box,
                          owner,
                          'emailSmtpPassword',
                          smtp.password,
                        ),
                        emailSmtpPasswordTail: secretTail(smtp.password),
                      }
                    : {}),
                } satisfies Partial<NewChannel>);
                credentialFields.push('smtp');
              }
            }
          }
          break;
        }
        case 'messenger':
        case 'instagram': {
          if (input.pageId !== undefined && input.pageId !== row.metaPageId) {
            changes.metaPageId = input.pageId;
            credentialFields.push('pageId');
          }
          if (
            input.type === 'instagram' &&
            input.instagramAccountId !== undefined &&
            input.instagramAccountId !== row.metaIgAccountId
          ) {
            changes.metaIgAccountId = input.instagramAccountId;
            credentialFields.push('instagramAccountId');
          }
          for (const [field, kind, sealed] of [
            ['pageAccessToken', 'pageToken', row.metaPageTokenEncrypted],
            ['appSecret', 'appSecret', row.metaAppSecretEncrypted],
          ] as const) {
            const value = input[field];
            if (value === undefined) continue;
            let stored: Secret<string> | null = null;
            if (secretBox && sealed) {
              try {
                stored = openMetaSocialSecret(secretBox, row, kind, sealed);
              } catch {
                stored = null;
              }
            }
            if (stored && constantTimeEqual(value, stored.reveal())) continue;
            const box = requireBox();
            if (kind === 'pageToken') {
              changes.metaPageTokenEncrypted = sealMetaSocialSecret(box, owner, kind, value);
              changes.metaPageTokenTail = secretTail(value);
            } else {
              changes.metaAppSecretEncrypted = sealMetaSocialSecret(box, owner, kind, value);
              changes.metaAppSecretTail = secretTail(value);
            }
            credentialFields.push(field);
          }
          break;
        }
      }

      if (credentialFields.length === 0 && plainFields.length === 0) return view(row);
      if (aliasesAdded && credentialFields.length === 0) {
        await confirm(auth, input.confirmation, 'channel.aliases', CONFIRM.aliases, context);
      }
      if (credentialFields.length > 0) {
        await confirm(
          auth,
          input.confirmation,
          'channel.credentials',
          CONFIRM.credentials,
          context,
        );
        Object.assign(changes, {
          credentialsUpdatedAt: now(),
          lastTestOk: null,
          lastTestCode: null,
          lastTestedAt: null,
        } satisfies Partial<NewChannel>);
        // Kredensial Meta baru belum teruji: channel sosial yang aktif dinonaktifkan sampai dites.
        if ((row.type === 'messenger' || row.type === 'instagram') && row.enabled) {
          Object.assign(changes, {
            enabled: false,
            disabledAt: now(),
          } satisfies Partial<NewChannel>);
        }
      }

      let revoked: RevokedClaim[] = [];
      const updated = await db
        .transaction(async (tx) => {
          await assertActorStillAuthorized(tx, auth, 'channels.manage', context.log);
          if (
            row.type === 'email' &&
            (changes.emailAddress !== undefined || changes.emailAliases !== undefined)
          ) {
            const previous = new Set([row.emailAddress ?? '', ...row.emailAliases]);
            revoked = await assertNotMailAccount(
              tx,
              auth.organizationId,
              [
                changes.emailAddress ?? row.emailAddress ?? '',
                ...(changes.emailAliases ?? row.emailAliases),
              ].filter((address) => !previous.has(address)),
              { auth, client: context.client },
            );
          }
          const next = await updateRow(tx, auth, row.id, changes);
          if (resetMailbox) {
            await tx
              .update(emailMailboxStates)
              .set({ uidValidity: null, lastUid: 0, nextPollAt: now(), consecutiveFailures: 0 })
              .where(
                and(
                  eq(emailMailboxStates.organizationId, auth.organizationId),
                  eq(emailMailboxStates.channelId, row.id),
                ),
              );
          }
          const credentialsChanged = credentialFields.length > 0;
          const auditLogId = await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.channelUpdated,
            targetType: 'channel',
            targetId: row.id,
            // Hanya NAMA isian — nilai rahasia tidak pernah dicatat.
            metadata: {
              type: row.type,
              changedFields: [...plainFields, ...credentialFields],
              name: next.name,
              previousName: plainFields.includes('name') ? row.name : null,
              ...(credentialsChanged
                ? noticeMetadata(actorOf(auth), 'credentials_changed')
                : { actorRole: auth.user.role }),
            },
            client: context.client,
          });
          if (credentialsChanged) await notifyOwners(tx, auth, auditLogId);
          return next;
        })
        .catch(rethrowConflict);
      await notifyRevokedClaims(
        notifier,
        { organizationId: auth.organizationId, actorUserId: auth.user.id, occurredAt: now() },
        revoked,
      );

      let current = updated;
      if (reRegisterTelegram) {
        try {
          if (await registerTelegramWebhook(updated)) current = await load(auth, row.id);
        } catch (error) {
          context.log.warn(
            { channelRef: row.id, kind: isTelegramApiError(error) ? error.kind : 'internal' },
            'Webhook Telegram belum terpasang ulang setelah token diganti',
          );
        }
      }
      return view(current);
    },

    async setEnabled(auth, channelId, enabled, context) {
      const row = await load(auth, channelId);
      if (row.enabled === enabled) return view(row);
      if (
        enabled &&
        (row.type === 'messenger' || row.type === 'instagram') &&
        row.lastTestOk !== true
      ) {
        throw new AppError('CONFLICT', {
          message:
            'Jalankan tes koneksi sampai berhasil dulu. Messenger dan Instagram butuh aplikasi Meta yang sudah lolos App Review.',
        });
      }
      const updated = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'channels.manage', context.log);
        const next = await updateRow(tx, auth, row.id, {
          enabled,
          disabledAt: enabled ? null : now(),
        });
        if (enabled && row.type === 'email') {
          await tx
            .update(emailMailboxStates)
            .set({ nextPollAt: now(), consecutiveFailures: 0 })
            .where(
              and(
                eq(emailMailboxStates.organizationId, auth.organizationId),
                eq(emailMailboxStates.channelId, row.id),
              ),
            );
        }
        const auditLogId = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: enabled ? AUDIT_ACTIONS.channelEnabled : AUDIT_ACTIONS.channelDisabled,
          targetType: 'channel',
          targetId: row.id,
          metadata: {
            type: row.type,
            name: row.name,
            ...noticeMetadata(actorOf(auth), enabled ? 'enabled' : 'disabled'),
          },
          client: context.client,
        });
        await notifyOwners(tx, auth, auditLogId);
        return next;
      });
      return view(updated);
    },

    async remove(auth, channelId, confirmation, context) {
      const row = await load(auth, channelId);
      await confirm(auth, confirmation, 'channel.delete', CONFIRM.delete, context);
      // Telegram: lepas webhook dulu (selagi token masih ada) — usaha terbaik.
      if (row.type === 'telegram') {
        const token = open(row, 'telegramBotToken', row.tgBotTokenEncrypted);
        if (token) {
          await telegram
            .deleteWebhook(token, AbortSignal.timeout(10_000))
            .catch((error: unknown) => {
              context.log.warn(
                { channelRef: row.id, kind: isTelegramApiError(error) ? error.kind : 'internal' },
                'Webhook Telegram tidak bisa dilepas saat channel dihapus',
              );
            });
        }
      }
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'channels.manage', context.log);
        // Semua rahasia dimusnahkan; baris tetap untuk rujukan riwayat percakapan.
        await updateRow(tx, auth, row.id, {
          deletedAt: now(),
          enabled: false,
          disabledAt: row.disabledAt ?? now(),
          tgBotTokenEncrypted: null,
          tgBotTokenTail: null,
          tgWebhookSecretEncrypted: null,
          emailImapPasswordEncrypted: null,
          emailImapPasswordTail: null,
          emailSmtpPasswordEncrypted: null,
          emailSmtpPasswordTail: null,
          metaPageTokenEncrypted: null,
          metaPageTokenTail: null,
          metaAppSecretEncrypted: null,
          metaAppSecretTail: null,
          metaVerifyTokenEncrypted: null,
        });
        const auditLogId = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.channelDeleted,
          targetType: 'channel',
          targetId: row.id,
          metadata: { type: row.type, name: row.name, ...noticeMetadata(actorOf(auth), 'deleted') },
          client: context.client,
        });
        await notifyOwners(tx, auth, auditLogId);
      });
    },

    async test(auth, channelId, context) {
      const row = await load(auth, channelId);
      const checks = await runTest(row);
      const failed = checks.find((check) => !check.ok);
      const code: ConnectionTestCode = failed?.code ?? 'ok';
      const ok = failed === undefined;
      const testedAt = now();
      await db.transaction(async (tx) => {
        const recorded = await recordChannelTest(
          tx,
          auth.organizationId,
          row.id,
          row.credentialsUpdatedAt,
          {
            ok,
            code,
            testedAt,
            number: null,
          },
        );
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.channelTested,
          targetType: 'channel',
          targetId: row.id,
          metadata: {
            type: row.type,
            code,
            checks: checks.map((check) => `${check.name}:${check.code}`),
            recorded: recorded !== undefined,
          },
          client: context.client,
        });
      });
      context.log.info({ channelRef: row.id, type: row.type, code }, 'Tes koneksi channel selesai');
      return {
        ok,
        code,
        message: failed ? failed.message : CONNECTION_TEST_MESSAGES.ok,
        testedAt: testedAt.toISOString(),
        checks,
      };
    },

    async webhook(auth, channelId) {
      return webhookViewOf(await load(auth, channelId));
    },

    async rotateWebhook(auth, channelId, context) {
      const box = requireBox();
      const row = await load(auth, channelId);
      if (row.type === 'email') {
        throw new AppError('CONFLICT', {
          message:
            'Channel email tidak memakai webhook — email diambil langsung dari kotak masuk (IMAP).',
        });
      }
      if (row.type === 'telegram') {
        const url = connectionWebhookUrl(apiUrl, 'telegram', row.id);
        if (!telegramWebhookUrlUsable(url)) {
          throw new AppError('CONFLICT', { message: TELEGRAM_WEBHOOK_WARNING });
        }
      }
      const owner = { id: row.id, organizationId: auth.organizationId };
      const updated = await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'channels.manage', context.log);
        const next = await updateRow(
          tx,
          auth,
          row.id,
          row.type === 'telegram'
            ? {
                tgWebhookSecretEncrypted: sealChannelConnectionSecret(
                  box,
                  owner,
                  'telegramWebhookSecret',
                  newTelegramWebhookSecret(),
                ),
                tgWebhookRegisteredAt: null,
              }
            : {
                metaVerifyTokenEncrypted: sealMetaSocialSecret(
                  box,
                  owner,
                  'verifyToken',
                  newWebhookVerifyToken(),
                ),
                metaVerifyTokenRotatedAt: now(),
              },
        );
        const auditLogId = await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.channelVerifyTokenRotated,
          targetType: 'channel',
          targetId: row.id,
          metadata: {
            type: row.type,
            name: row.name,
            ...noticeMetadata(actorOf(auth), 'verify_token_rotated'),
          },
          client: context.client,
        });
        await notifyOwners(tx, auth, auditLogId);
        return next;
      });
      if (updated.type === 'telegram') {
        try {
          await registerTelegramWebhook(updated);
        } catch (error) {
          if (isTelegramApiError(error)) {
            throw error.kind === 'token_invalid'
              ? channelRequestFailed(CONNECTION_TEST_MESSAGES.telegram_token_invalid)
              : channelRequestFailed(
                  error.kind === 'rate_limited'
                    ? CONNECTION_TEST_MESSAGES.rate_limited
                    : CONNECTION_TEST_MESSAGES.network_error,
                  error.retryAfterSeconds,
                );
          }
          throw error;
        }
        return { channel: await view(await load(auth, row.id)), webhook: null };
      }
      return { channel: await view(updated), webhook: webhookViewOf(updated) };
    },
  };
}
