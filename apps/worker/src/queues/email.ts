import {
  EMAIL_JOBS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  SecretDecryptionError,
  accountLockedEmailPayloadSchema,
  accountTokenDeliveryContext,
  accountTokenEmailPayloadSchema,
  channelChangedEmailPayloadSchema,
  emailSettingsChangedEmailPayloadSchema,
  fallbackEmailSettings,
  invitationDeliveryContext,
  invitationEmailPayloadSchema,
  openStoredEmailSettings,
  renderAccountLockedEmail,
  renderAdminAccountNoticeEmail,
  renderAdminTwoFactorNoticeEmail,
  renderChannelChangedEmail,
  renderEmailSettingsChangedEmail,
  renderEmailVerificationEmail,
  renderInvitationEmail,
  renderPasswordResetEmail,
  renderSecurityNoticeEmail,
  securityNoticeAdminEmailPayloadSchema,
  securityNoticeEmailPayloadSchema,
  sendSmtpMail,
  type EmailBrand,
  type EmailJobResult,
  type EventOrigin,
  type HostLookup,
  type Logger,
  type MailContent,
  type MailInlineImage,
  type MailTransportSettings,
  type PlaintextLoginPolicy,
  type SecretBox,
  type SmtpFallbackConfig,
  type SmtpFailureCode,
  type SmtpPolicy,
  type SmtpTimeouts,
} from '@balesin/core';
import {
  accountTokens,
  auditLogs,
  emailSettings,
  emailSettingsChangeNotices,
  organizationLogos,
  organizations,
  userInvitations,
  users,
  type Database,
} from '@balesin/db';
import {
  AUDIT_ACTIONS,
  BUSINESS_PROFILE_FIELDS,
  CHANNEL_CHANGE_AUDIT_ACTIONS,
  DEFAULT_PRODUCT_NAME,
  LOGIN_LOCK_MINUTES,
  LOGIN_MAX_FAILED_ATTEMPTS,
  buildTokenLink,
  channelChangeKindSchema,
  channelCredentialFieldSchema,
  hasPermission,
  invitationIssuerAuthorized,
  isTwoFactorRequired,
  userRoleSchema,
  type BusinessProfileField,
  type EmailDeliveryStatus,
  type UserRole,
} from '@balesin/shared';
import { UnrecoverableError, Worker } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { QueueConnectionOptions } from './system';

/**
 * Pemroses antrian `email`: mengirim email sistem lewat SMTP organisasi.
 *
 * Payload job hanya memuat ID. Alamat penerima, pengaturan SMTP, dan password-nya (dibuka dari
 * bentuk terenkripsi) diambil dari database DI SINI, tepat saat mengirim — tidak pernah
 * tersimpan di Redis dan tidak pernah masuk log. Begitu juga token tautan (undangan, atur ulang
 * password, verifikasi email): api menyimpan salinan terenkripsinya di baris tokennya, worker
 * membukanya, mengirim, lalu MENGHAPUS salinan itu (yang tersisa hanya hash).
 *
 * Tautan disusun dari `APP_URL` worker (`buildTokenLink`), tidak pernah dari data permintaan.
 *
 * Email belum diatur BUKAN kegagalan: job selesai dengan status `skipped`, supaya fitur yang
 * mengantre (mis. kunci akun) tetap jalan sebelum Owner mengisi pengaturan email.
 */

export interface EmailJob {
  id?: string;
  name: string;
  data: unknown;
  /** Percobaan yang sudah GAGAL sebelum ini (BullMQ). */
  attemptsMade?: number;
  opts?: { attempts?: number };
}

export interface EmailJobDeps {
  /** `APP_URL`: satu-satunya sumber alamat tautan di email. */
  appUrl: string;
  db: Database;
  /** `null` = `BALESIN_MASTER_KEY` kosong (hanya mungkin di development/test). */
  secretBox: SecretBox | null;
  /** Cadangan `SMTP_*` dari .env. */
  fallback: SmtpFallbackConfig | null;
  allowedPorts: readonly number[];
  /** Login "Tanpa enkripsi": `private-only` di production. Bawaan `private-only`. */
  plaintextLogin?: PlaintextLoginPolicy;
  logger: Logger;
  /** Bisa diganti di tes. */
  lookup?: HostLookup;
  timeouts?: Partial<SmtpTimeouts>;
}

/** Kegagalan yang tidak akan sembuh dengan mengulang: pengaturannya yang harus diperbaiki. */
const PERMANENT_FAILURES = new Set<SmtpFailureCode>([
  'host_blocked',
  'port_not_allowed',
  'auth_failed',
  'auth_unsupported',
  'insecure_login',
  'certificate_invalid',
  'sender_rejected',
  'recipient_rejected',
]);

type ResolvedTransport =
  | { kind: 'ready'; settings: MailTransportSettings; policy: SmtpPolicy }
  | { kind: 'not_configured' };

async function resolveTransport(
  organizationId: string,
  deps: EmailJobDeps,
): Promise<ResolvedTransport> {
  const basePolicy = {
    lookup: deps.lookup,
    timeouts: deps.timeouts,
    plaintextLogin: deps.plaintextLogin,
  };
  const [stored] = await deps.db
    .select()
    .from(emailSettings)
    .where(eq(emailSettings.organizationId, organizationId))
    .limit(1);

  if (stored) {
    const opened = openStoredEmailSettings(stored, deps.secretBox);
    if (!opened.ok) {
      // Master key hilang/berganti atau datanya rusak: mengulang tidak akan membantu.
      throw new UnrecoverableError(
        'Password email pengirim yang tersimpan tidak bisa dibuka (periksa BALESIN_MASTER_KEY)',
      );
    }
    return {
      kind: 'ready',
      settings: opened.settings,
      policy: { ...basePolicy, allowedPorts: deps.allowedPorts },
    };
  }
  if (deps.fallback) {
    return {
      kind: 'ready',
      settings: fallbackEmailSettings(deps.fallback),
      // Port cadangan ditentukan pengelola server lewat .env, jadi dipercaya.
      policy: { ...basePolicy, allowedPorts: [...deps.allowedPorts, deps.fallback.port] },
    };
  }
  return { kind: 'not_configured' };
}

async function deliver(
  organizationId: string,
  mail: MailContent,
  job: EmailJob,
  deps: EmailJobDeps,
): Promise<EmailJobResult> {
  return deliverVia(await resolveTransport(organizationId, deps), organizationId, mail, job, deps);
}

/** Mengirim lewat sambungan yang sudah ditentukan (mis. salinan pengaturan LAMA). */
async function deliverVia(
  transport: ResolvedTransport,
  organizationId: string,
  mail: MailContent,
  job: EmailJob,
  deps: EmailJobDeps,
): Promise<EmailJobResult> {
  if (transport.kind === 'not_configured') {
    deps.logger.info(
      { jobId: job.id, jobName: job.name, organizationId },
      'Email tidak dikirim: email pengirim belum diatur',
    );
    return { status: 'skipped', reason: 'email_not_configured' };
  }

  const result = await sendSmtpMail(
    transport.settings.connection,
    transport.settings.sender,
    mail,
    transport.policy,
  );
  if (result.ok) {
    deps.logger.info({ jobId: job.id, jobName: job.name, organizationId }, 'Email terkirim');
    return { status: 'sent' };
  }

  // Hanya kode: pesan ini tersimpan di Redis (`failedReason`) dan tidak boleh memuat balasan server.
  const message = `Email gagal dikirim (${result.code})`;
  deps.logger.warn(
    { jobId: job.id, jobName: job.name, organizationId, diagnostic: result.diagnostic },
    message,
  );
  throw PERMANENT_FAILURES.has(result.code) ? new UnrecoverableError(message) : new Error(message);
}

/** Percobaan ini yang terakhir (gagal di sini = job gagal permanen). */
function isFinalAttempt(job: EmailJob): boolean {
  return (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
}

/**
 * Mengirim email bertoken lalu mencatat hasilnya di baris tokennya (`settle`): terkirim, tidak
 * dikirim (email belum diatur), atau gagal permanen. Salinan token terenkripsi dihapus di
 * ketiga keadaan itu; hanya kegagalan sementara yang masih akan diulang yang menyimpannya.
 */
async function deliverTokenMail(
  organizationId: string,
  mail: MailContent,
  job: EmailJob,
  deps: EmailJobDeps,
  settle: (status: Extract<EmailDeliveryStatus, 'sent' | 'skipped' | 'failed'>) => Promise<void>,
): Promise<EmailJobResult> {
  let result: EmailJobResult;
  try {
    result = await deliver(organizationId, mail, job, deps);
  } catch (error) {
    if (error instanceof UnrecoverableError || isFinalAttempt(job)) await settle('failed');
    throw error;
  }
  await settle(result.status === 'sent' ? 'sent' : 'skipped');
  return result;
}

// ── Data dari database ──────────────────────────────────────────────────────

interface OrganizationBrand {
  brand: EmailBrand;
  timeZone: string;
  inlineImages: MailInlineImage[];
}

const LOGO_CID = 'logo@balesin';
/** Pengirim (ulang) terakhir undangan — penerbit token yang berlaku sekarang. */
const lastSender = alias(users, 'last_sender');
/** WebP tidak tampil di sebagian aplikasi email (mis. Outlook desktop): pakai nama produk saja. */
const EMAIL_LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/** Branding organisasi untuk template: nama produk, nama organisasi, warna, logo (inline `cid:`). */
export async function loadOrganizationBrand(
  db: Database,
  organizationId: string,
): Promise<OrganizationBrand | undefined> {
  const [row] = await db
    .select({
      name: organizations.name,
      productName: organizations.productName,
      brandColor: organizations.brandColor,
      timezone: organizations.timezone,
      logoType: organizationLogos.contentType,
      logoData: organizationLogos.data,
    })
    .from(organizations)
    .leftJoin(organizationLogos, eq(organizationLogos.organizationId, organizations.id))
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!row) return undefined;
  const extension = row.logoType ? EMAIL_LOGO_TYPES[row.logoType] : undefined;
  const inlineImages: MailInlineImage[] =
    extension && row.logoType && row.logoData
      ? [
          {
            cid: LOGO_CID,
            filename: `logo.${extension}`,
            contentType: row.logoType,
            content: row.logoData,
          },
        ]
      : [];
  return {
    brand: {
      productName: row.productName ?? DEFAULT_PRODUCT_NAME,
      organizationName: row.name,
      logoSrc: inlineImages.length > 0 ? `cid:${LOGO_CID}` : null,
      primaryColor: row.brandColor,
    },
    timeZone: row.timezone,
    inlineImages,
  };
}

/** Pengguna aktif di organisasi itu (payload hanya berisi ID). */
async function findActiveUser(organizationId: string, userId: string, deps: EmailJobDeps) {
  const [user] = await deps.db
    .select({
      email: users.email,
      name: users.name,
      role: users.role,
      disabledAt: users.disabledAt,
      totpEnabledAt: users.totpEnabledAt,
    })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)))
    .limit(1);
  return user && user.disabledAt === null ? user : undefined;
}

/** Nama + peran pengguna di organisasi itu, aktif maupun nonaktif (untuk menyebut pelaku). */
async function findUserAnyState(organizationId: string, userId: string, deps: EmailJobDeps) {
  const [user] = await deps.db
    .select({ name: users.name, role: users.role })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)))
    .limit(1);
  return user;
}

/** Seperti `findUserAnyState`, plus email (untuk menyebut pengguna yang sudah dinonaktifkan). */
async function findUserAnyStateWithEmail(
  organizationId: string,
  userId: string,
  deps: EmailJobDeps,
) {
  const [user] = await deps.db
    .select({ name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)))
    .limit(1);
  return user;
}

/** Peran lama → baru dari baris audit `user.role_changed` (bukan dari payload). */
async function findRoleChange(
  organizationId: string,
  auditLogId: string | undefined,
  deps: EmailJobDeps,
): Promise<{ from: UserRole; to: UserRole } | undefined> {
  if (!auditLogId) return undefined;
  const [row] = await deps.db
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.id, auditLogId)))
    .limit(1);
  const from = userRoleSchema.safeParse(row?.metadata.from);
  const to = userRoleSchema.safeParse(row?.metadata.to);
  return from.success && to.success ? { from: from.data, to: to.data } : undefined;
}

/** Jumlah akun + jendela dari baris audit `auth.password_reset.burst` (bukan dari payload). */
async function findResetBurst(
  organizationId: string,
  auditLogId: string | undefined,
  deps: EmailJobDeps,
): Promise<{ accounts: number; windowMinutes: number } | undefined> {
  if (!auditLogId) return undefined;
  const [row] = await deps.db
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.id, auditLogId)))
    .limit(1);
  const accounts = row?.metadata.accounts;
  const windowMinutes = row?.metadata.windowMinutes;
  return typeof accounts === 'number' && typeof windowMinutes === 'number'
    ? { accounts, windowMinutes }
    : undefined;
}

/** Rincian rem pengiriman dari baris audit (alasan rem / cakupan + batas). */
async function findSendingDetails(
  organizationId: string,
  auditLogId: string | undefined,
  deps: EmailJobDeps,
): Promise<
  | {
      reason?: string;
      scope?: 'user' | 'organization' | 'api_key';
      limit?: number;
      apiKeyName?: string;
    }
  | undefined
> {
  if (!auditLogId) return undefined;
  const [row] = await deps.db
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.id, auditLogId)))
    .limit(1);
  if (!row) return undefined;
  const { reason, scope, limit, apiKeyName } = row.metadata;
  return {
    ...(typeof reason === 'string' ? { reason: reason.slice(0, 200) } : {}),
    ...(scope === 'user' || scope === 'organization' || scope === 'api_key' ? { scope } : {}),
    ...(typeof apiKeyName === 'string' ? { apiKeyName: apiKeyName.slice(0, 80) } : {}),
    ...(typeof limit === 'number' ? { limit } : {}),
  };
}

/** Host tujuan + jumlah gagal beruntun webhook yang dinonaktifkan (dari baris audit). */
async function findWebhookDetails(
  organizationId: string,
  auditLogId: string | undefined,
  deps: EmailJobDeps,
): Promise<{ host?: string; failures?: number } | undefined> {
  if (!auditLogId) return undefined;
  const [row] = await deps.db
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.id, auditLogId)))
    .limit(1);
  if (!row) return undefined;
  const { host, failures } = row.metadata;
  return {
    ...(typeof host === 'string' ? { host: host.slice(0, 253) } : {}),
    ...(typeof failures === 'number' ? { failures } : {}),
  };
}

/** Tahap 9.1: rincian email API dari baris audit (nama template, alamat pengirim, batas). */
async function findEmailApiDetails(
  organizationId: string,
  auditLogId: string | undefined,
  deps: EmailJobDeps,
): Promise<
  | {
      templateName?: string;
      addedLinks?: number;
      addedNumbers?: number;
      senderAddress?: string;
      blockedReason?: string;
      previousLimit?: number;
      nextLimit?: number;
    }
  | undefined
> {
  if (!auditLogId) return undefined;
  const [row] = await deps.db
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.id, auditLogId)))
    .limit(1);
  if (!row) return undefined;
  const { name, addedLinks, addedNumbers, address, reason, previous, next } = row.metadata;
  return {
    ...(typeof name === 'string' ? { templateName: name.slice(0, 80) } : {}),
    ...(typeof addedLinks === 'number' ? { addedLinks } : {}),
    ...(typeof addedNumbers === 'number' ? { addedNumbers } : {}),
    ...(typeof address === 'string' ? { senderAddress: address.slice(0, 254) } : {}),
    ...(typeof reason === 'string' ? { blockedReason: reason.slice(0, 64) } : {}),
    ...(typeof previous === 'number' ? { previousLimit: previous } : {}),
    ...(typeof next === 'number' ? { nextLimit: next } : {}),
  };
}

/** IP + user agent dari baris audit kejadian (untuk "dari mana" di email keamanan). */
async function findAuditOrigin(
  organizationId: string,
  auditLogId: string | undefined,
  deps: EmailJobDeps,
): Promise<EventOrigin | undefined> {
  if (!auditLogId) return undefined;
  const [row] = await deps.db
    .select({ ip: auditLogs.ipAddress, userAgent: auditLogs.userAgent })
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.id, auditLogId)))
    .limit(1);
  return row ? { ip: row.ip, userAgent: row.userAgent } : undefined;
}

function openDeliveryToken(
  deps: EmailJobDeps,
  encrypted: string,
  context: Parameters<SecretBox['decrypt']>[1],
): string {
  if (!deps.secretBox) {
    throw new UnrecoverableError('Token tautan tidak bisa dibuka: BALESIN_MASTER_KEY kosong');
  }
  try {
    return deps.secretBox.decrypt(encrypted, context);
  } catch (error) {
    if (error instanceof SecretDecryptionError) {
      throw new UnrecoverableError('Token tautan tidak bisa dibuka (periksa BALESIN_MASTER_KEY)');
    }
    throw error;
  }
}

// ── Job ─────────────────────────────────────────────────────────────────────

async function sendAccountLocked(job: EmailJob, deps: EmailJobDeps): Promise<EmailJobResult> {
  const payload = accountLockedEmailPayloadSchema.safeParse(job.data);
  if (!payload.success) {
    throw new UnrecoverableError('Payload job email:account-locked tidak valid');
  }
  const { organizationId, userId, lockedUntil, scope, trigger } = payload.data;

  const recipient = await findActiveUser(organizationId, userId, deps);
  const branding = await loadOrganizationBrand(deps.db, organizationId);
  if (!recipient || !branding) return { status: 'skipped', reason: 'recipient_unavailable' };

  const body = renderAccountLockedEmail({
    brand: branding.brand,
    userName: recipient.name,
    failedAttempts: LOGIN_MAX_FAILED_ATTEMPTS,
    lockMinutes: LOGIN_LOCK_MINUTES,
    lockedUntil: new Date(lockedUntil),
    timeZone: branding.timeZone,
    scope,
    ...(trigger === undefined ? {} : { trigger }),
  });
  return deliver(
    organizationId,
    { to: recipient.email, ...body, inlineImages: branding.inlineImages },
    job,
    deps,
  );
}

/** 2FA diaktifkan/dinonaktifkan, kode cadangan dipakai, password diganti — ke pemilik akun. */
async function sendSecurityNotice(job: EmailJob, deps: EmailJobDeps): Promise<EmailJobResult> {
  const payload = securityNoticeEmailPayloadSchema.safeParse(job.data);
  if (!payload.success) {
    throw new UnrecoverableError('Payload job email:security-notice tidak valid');
  }
  const { organizationId, userId, event, occurredAt, backupCodesRemaining, auditLogId } =
    payload.data;

  const recipient = await findActiveUser(organizationId, userId, deps);
  const branding = await loadOrganizationBrand(deps.db, organizationId);
  if (!recipient || !branding) return { status: 'skipped', reason: 'recipient_unavailable' };
  const origin = await findAuditOrigin(organizationId, auditLogId, deps);
  // Pelaku (untuk "diatur ulang oleh …") dibaca dari database, tidak dari payload. Pelaku yang
  // sudah dinonaktifkan tetap disebut namanya: pemilik akun perlu tahu siapa.
  const actor = payload.data.actorUserId
    ? await findUserAnyState(organizationId, payload.data.actorUserId, deps)
    : undefined;

  const body = renderSecurityNoticeEmail({
    brand: branding.brand,
    userName: recipient.name,
    event,
    occurredAt: new Date(occurredAt),
    timeZone: branding.timeZone,
    ...(backupCodesRemaining === undefined ? {} : { backupCodesRemaining }),
    ...(origin ? { origin } : {}),
    ...(actor ? { actor: { name: actor.name, role: actor.role } } : {}),
    role: recipient.role,
  });
  return deliver(
    organizationId,
    { to: recipient.email, ...body, inlineImages: branding.inlineImages },
    job,
    deps,
  );
}

/**
 * Ke satu Owner/Admin: 2FA akun ber-peran wajib baru aktif, 2FA seseorang diatur ulang (hanya ke
 * Owner), atau akun ber-peran wajib yang belum mendaftar 2FA mengatur ulang password-nya.
 */
async function sendSecurityNoticeAdmin(job: EmailJob, deps: EmailJobDeps): Promise<EmailJobResult> {
  const payload = securityNoticeAdminEmailPayloadSchema.safeParse(job.data);
  if (!payload.success) {
    throw new UnrecoverableError('Payload job email:security-notice-admin tidak valid');
  }
  const { organizationId, recipientUserId, subjectUserId, event, occurredAt, auditLogId } =
    payload.data;

  const ownersOnly =
    event === 'two_factor_reset' ||
    event === 'role_changed' ||
    event === 'user_disabled' ||
    event === 'member_joined' ||
    event === 'password_reset_burst' ||
    event === 'sending_paused' ||
    event === 'sending_limit_reached' ||
    event === 'sending_auto_paused' ||
    event === 'webhook_disabled' ||
    event === 'email_template_risky' ||
    event === 'email_sender_blocked' ||
    event === 'email_sender_limit_raised' ||
    event === 'mail_account_changed' ||
    event === 'mail_access_changed';
  // Fase 9: password akun email ditolak → penerima dipilih pengantre (pemilik akun pribadi / pemegang
  // Kelola + Owner/Admin), cukup masih aktif.
  const anyActiveRecipient = event === 'mail_account_auth_failed';
  const recipient = await findActiveUser(organizationId, recipientUserId, deps);
  // Pengguna yang baru dinonaktifkan tetap disebut di email "dinonaktifkan".
  const subject =
    event === 'user_disabled' ||
    event === 'sending_paused' ||
    event === 'sending_limit_reached' ||
    event === 'sending_auto_paused' ||
    event === 'webhook_disabled' ||
    event === 'email_template_risky' ||
    event === 'email_sender_blocked' ||
    event === 'email_sender_limit_raised' ||
    event === 'mail_account_changed' ||
    event === 'mail_access_changed' ||
    event === 'mail_account_auth_failed'
      ? await findUserAnyStateWithEmail(organizationId, subjectUserId, deps)
      : await findActiveUser(organizationId, subjectUserId, deps);
  const branding = await loadOrganizationBrand(deps.db, organizationId);
  // Penerima diperiksa ulang saat mengirim: yang perannya sudah tidak berhak dilewati —
  // `team.manage` (Owner/Admin, matriks izin di @balesin/shared), atau khusus Owner untuk
  // pemberitahuan 2FA diatur ulang / perubahan tim oleh Admin.
  const recipientEligible =
    recipient !== undefined &&
    (anyActiveRecipient ||
      (ownersOnly ? recipient.role === 'owner' : hasPermission(recipient.role, 'team.manage')));
  const subjectEligible =
    subject !== undefined &&
    (event === 'two_factor_enabled' || event === 'password_reset_without_two_factor'
      ? isTwoFactorRequired(subject.role)
      : true);
  if (!recipient || !subject || !branding || !recipientEligible || !subjectEligible) {
    return { status: 'skipped', reason: 'recipient_unavailable' };
  }
  const origin = await findAuditOrigin(organizationId, auditLogId, deps);

  let body;
  if (event === 'two_factor_enabled') {
    body = renderAdminTwoFactorNoticeEmail({
      brand: branding.brand,
      timeZone: branding.timeZone,
      recipientName: recipient.name,
      subject: { name: subject.name, email: subject.email, role: subject.role },
      occurredAt: new Date(occurredAt),
      ...(origin ? { origin } : {}),
    });
  } else {
    const actor = payload.data.actorUserId
      ? await findUserAnyState(organizationId, payload.data.actorUserId, deps)
      : undefined;
    const roleChange =
      event === 'role_changed' ? await findRoleChange(organizationId, auditLogId, deps) : undefined;
    const burst =
      event === 'password_reset_burst'
        ? await findResetBurst(organizationId, auditLogId, deps)
        : undefined;
    const sending =
      event === 'sending_paused' ||
      event === 'sending_limit_reached' ||
      event === 'sending_auto_paused'
        ? await findSendingDetails(organizationId, auditLogId, deps)
        : undefined;
    const webhook =
      event === 'webhook_disabled'
        ? await findWebhookDetails(organizationId, auditLogId, deps)
        : undefined;
    const emailApi =
      event === 'email_template_risky' ||
      event === 'email_sender_blocked' ||
      event === 'email_sender_limit_raised' ||
      event === 'mail_account_changed' ||
      event === 'mail_access_changed' ||
      event === 'mail_account_auth_failed'
        ? await findEmailApiDetails(organizationId, auditLogId, deps)
        : undefined;
    body = renderAdminAccountNoticeEmail({
      brand: branding.brand,
      timeZone: branding.timeZone,
      recipientName: recipient.name,
      event,
      subject: { name: subject.name, email: subject.email, role: subject.role },
      occurredAt: new Date(occurredAt),
      ...(actor ? { actor: { name: actor.name, role: actor.role } } : {}),
      ...(roleChange ? { roleChange } : {}),
      ...(burst ? { burst } : {}),
      ...(sending ? { sending } : {}),
      ...(webhook ? { webhook } : {}),
      ...(emailApi ? { emailApi } : {}),
      ...(origin ? { origin } : {}),
    });
  }
  return deliver(
    organizationId,
    { to: recipient.email, ...body, inlineImages: branding.inlineImages },
    job,
    deps,
  );
}

/** Email undangan: token dari salinan terenkripsi di `user_invitations`. */
async function sendInvitation(job: EmailJob, deps: EmailJobDeps): Promise<EmailJobResult> {
  const payload = invitationEmailPayloadSchema.safeParse(job.data);
  if (!payload.success) {
    throw new UnrecoverableError('Payload job email:invitation tidak valid');
  }
  const { organizationId, invitationId, sendCount } = payload.data;

  const [row] = await deps.db
    .select({
      email: userInvitations.email,
      role: userInvitations.role,
      sendCount: userInvitations.sendCount,
      expiresAt: userInvitations.expiresAt,
      sealed: userInvitations.deliveryTokenEncrypted,
      open: sql<boolean>`${userInvitations.acceptedAt} is null and ${userInvitations.revokedAt} is null and ${userInvitations.expiresAt} > now()`,
      inviterName: users.name,
      senderRole: lastSender.role,
      senderDisabledAt: lastSender.disabledAt,
    })
    .from(userInvitations)
    .innerJoin(
      users,
      and(
        eq(users.organizationId, userInvitations.organizationId),
        eq(users.id, userInvitations.invitedByUserId),
      ),
    )
    .innerJoin(
      lastSender,
      and(
        eq(lastSender.organizationId, userInvitations.organizationId),
        eq(lastSender.id, userInvitations.lastSentByUserId),
      ),
    )
    .where(
      and(eq(userInvitations.organizationId, organizationId), eq(userInvitations.id, invitationId)),
    )
    .limit(1);

  /** Status + hapus salinan token — hanya untuk generasi token job ini. */
  const settle = async (status: 'sent' | 'skipped' | 'failed') => {
    await deps.db
      .update(userInvitations)
      .set({
        deliveryStatus: status,
        deliveryTokenEncrypted: null,
        ...(status === 'sent' ? { deliveredAt: sql`now()` } : {}),
      })
      .where(
        and(
          eq(userInvitations.organizationId, organizationId),
          eq(userInvitations.id, invitationId),
          eq(userInvitations.sendCount, sendCount),
        ),
      );
  };

  // Sudah diganti tautan baru (kirim ulang): job tautan baru yang mengirim.
  if (!row || row.sendCount !== sendCount) return { status: 'skipped', reason: 'no_longer_valid' };
  // Penerbit token ini (pembuat / pengirim ulang terakhir) sudah dinonaktifkan atau tidak lagi
  // boleh mengundang peran ini: undangan dianggap batal, sama seperti di API (review undangan R2).
  const issuerAuthorized = invitationIssuerAuthorized(row.role, {
    role: row.senderRole,
    disabledAt: row.senderDisabledAt,
  });
  const sealed = row.sealed;
  if (!row.open || sealed === null || !issuerAuthorized) {
    if (sealed !== null) await settle('skipped');
    return { status: 'skipped', reason: 'no_longer_valid' };
  }
  const branding = await loadOrganizationBrand(deps.db, organizationId);
  if (!branding) return { status: 'skipped', reason: 'recipient_unavailable' };

  let token: string;
  try {
    token = openDeliveryToken(
      deps,
      sealed,
      invitationDeliveryContext(organizationId, invitationId, sendCount),
    );
  } catch (error) {
    await settle('failed');
    throw error;
  }
  const body = renderInvitationEmail({
    brand: branding.brand,
    timeZone: branding.timeZone,
    inviterName: row.inviterName,
    role: row.role,
    email: row.email,
    link: buildTokenLink(deps.appUrl, 'invitation', token),
    expiresAt: row.expiresAt,
    twoFactorRequired: isTwoFactorRequired(row.role),
  });
  return deliverTokenMail(
    organizationId,
    { to: row.email, ...body, inlineImages: branding.inlineImages },
    job,
    deps,
    settle,
  );
}

/** Tautan atur ulang password / verifikasi email: token dari salinan terenkripsi di `account_tokens`. */
async function sendAccountToken(job: EmailJob, deps: EmailJobDeps): Promise<EmailJobResult> {
  const payload = accountTokenEmailPayloadSchema.safeParse(job.data);
  if (!payload.success) {
    throw new UnrecoverableError('Payload job email:account-token tidak valid');
  }
  const { organizationId, tokenId } = payload.data;

  const [row] = await deps.db
    .select({
      purpose: accountTokens.purpose,
      email: accountTokens.email,
      expiresAt: accountTokens.expiresAt,
      createdAt: accountTokens.createdAt,
      sealed: accountTokens.deliveryTokenEncrypted,
      requestedIp: accountTokens.requestedIp,
      requestedUserAgent: accountTokens.requestedUserAgent,
      live: sql<boolean>`${accountTokens.usedAt} is null and ${accountTokens.revokedAt} is null and ${accountTokens.expiresAt} > now()`,
      userName: users.name,
      userEmail: users.email,
      userDisabledAt: users.disabledAt,
      totpEnabledAt: users.totpEnabledAt,
    })
    .from(accountTokens)
    .innerJoin(
      users,
      and(
        eq(users.organizationId, accountTokens.organizationId),
        eq(users.id, accountTokens.userId),
      ),
    )
    .where(and(eq(accountTokens.organizationId, organizationId), eq(accountTokens.id, tokenId)))
    .limit(1);

  const settle = async (status: 'sent' | 'skipped' | 'failed') => {
    await deps.db
      .update(accountTokens)
      .set({
        deliveryStatus: status,
        deliveryTokenEncrypted: null,
        ...(status === 'sent' ? { deliveredAt: sql`now()` } : {}),
      })
      .where(and(eq(accountTokens.organizationId, organizationId), eq(accountTokens.id, tokenId)));
  };

  if (!row) return { status: 'skipped', reason: 'no_longer_valid' };
  // Atur ulang password hanya ke email akun SAAT INI: bila email akun sudah berubah, tautannya basi.
  const stale =
    !row.live ||
    row.sealed === null ||
    row.userDisabledAt !== null ||
    (row.purpose === 'password_reset' && row.userEmail !== row.email);
  const sealed = row.sealed;
  if (stale || sealed === null) {
    if (sealed !== null) await settle('skipped');
    return { status: 'skipped', reason: 'no_longer_valid' };
  }
  const branding = await loadOrganizationBrand(deps.db, organizationId);
  if (!branding) return { status: 'skipped', reason: 'recipient_unavailable' };

  let token: string;
  try {
    token = openDeliveryToken(deps, sealed, accountTokenDeliveryContext(organizationId, tokenId));
  } catch (error) {
    await settle('failed');
    throw error;
  }
  const body =
    row.purpose === 'password_reset'
      ? renderPasswordResetEmail({
          brand: branding.brand,
          timeZone: branding.timeZone,
          userName: row.userName,
          email: row.email,
          link: buildTokenLink(deps.appUrl, 'passwordReset', token),
          expiresAt: row.expiresAt,
          requestedAt: row.createdAt,
          origin: { ip: row.requestedIp, userAgent: row.requestedUserAgent },
          twoFactorEnabled: row.totpEnabledAt !== null,
        })
      : renderEmailVerificationEmail({
          brand: branding.brand,
          timeZone: branding.timeZone,
          userName: row.userName,
          email: row.email,
          link: buildTokenLink(deps.appUrl, 'emailVerification', token),
          expiresAt: row.expiresAt,
        });
  return deliverTokenMail(
    organizationId,
    { to: row.email, ...body, inlineImages: branding.inlineImages },
    job,
    deps,
    settle,
  );
}

/**
 * Ke satu Owner: email pengirim diubah pengguna lain (review RBAC S1). Dikirim lewat SALINAN
 * pengaturan sebelum perubahan; hanya bila salinan itu tidak bisa dipakai (tidak ada, gagal
 * permanen, atau percobaan terakhir gagal) baru lewat pengaturan yang berlaku sekarang. Begitu job
 * selesai, hitungan `pending_deliveries` turun; yang terakhir menghapus salinan teks sandi password.
 */
async function sendEmailSettingsChanged(
  job: EmailJob,
  deps: EmailJobDeps,
): Promise<EmailJobResult> {
  const payload = emailSettingsChangedEmailPayloadSchema.safeParse(job.data);
  if (!payload.success) {
    throw new UnrecoverableError('Payload job email:email-settings-changed tidak valid');
  }
  const { organizationId, recipientUserId, noticeId } = payload.data;
  const [notice] = await deps.db
    .select()
    .from(emailSettingsChangeNotices)
    .where(
      and(
        eq(emailSettingsChangeNotices.organizationId, organizationId),
        eq(emailSettingsChangeNotices.id, noticeId),
      ),
    )
    .limit(1);
  // Job diantrekan sebelum transaksi penyimpanan selesai: baris bisa belum terlihat. Diulang.
  if (!notice) throw new Error('Pemberitahuan perubahan email pengirim belum tersedia');

  const settle = async () => {
    await deps.db
      .update(emailSettingsChangeNotices)
      .set({
        pendingDeliveries: sql`greatest(${emailSettingsChangeNotices.pendingDeliveries} - 1, 0)`,
        previousPasswordEncrypted: sql`case when ${emailSettingsChangeNotices.pendingDeliveries} <= 1 then null else ${emailSettingsChangeNotices.previousPasswordEncrypted} end`,
        updatedAt: sql`now()`,
      })
      .where(eq(emailSettingsChangeNotices.id, notice.id));
  };

  const recipient = await findActiveUser(organizationId, recipientUserId, deps);
  const [actor] = await deps.db
    .select({ name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.id, notice.actorUserId)))
    .limit(1);
  const branding = await loadOrganizationBrand(deps.db, organizationId);
  // Penerima diperiksa ulang saat mengirim: yang sudah bukan Owner dilewati.
  if (!recipient || recipient.role !== 'owner' || !actor || !branding) {
    await settle();
    return { status: 'skipped', reason: 'recipient_unavailable' };
  }
  const origin = await findAuditOrigin(organizationId, notice.auditLogId, deps);
  const body = renderEmailSettingsChangedEmail({
    brand: branding.brand,
    timeZone: branding.timeZone,
    recipientName: recipient.name,
    actor,
    previous:
      notice.previousHost !== null && notice.previousPort !== null && notice.previousFromAddress
        ? {
            host: notice.previousHost,
            port: notice.previousPort,
            fromAddress: notice.previousFromAddress,
          }
        : null,
    next: { host: notice.newHost, port: notice.newPort, fromAddress: notice.newFromAddress },
    occurredAt: notice.createdAt,
    ...(origin ? { origin } : {}),
    recipientIsActor: recipientUserId === notice.actorUserId,
  });
  const mail: MailContent = { to: recipient.email, ...body, inlineImages: branding.inlineImages };

  const previous = previousTransport(notice, deps);
  let result: EmailJobResult | undefined;
  try {
    if (previous) {
      try {
        result = await deliverVia(previous, organizationId, mail, job, deps);
      } catch (error) {
        if (!(error instanceof UnrecoverableError) && !isFinalAttempt(job)) throw error;
        deps.logger.warn(
          { jobId: job.id, jobName: job.name, organizationId },
          'Pengaturan email lama tidak bisa dipakai; pemberitahuan dikirim lewat pengaturan sekarang',
        );
      }
    }
    result ??= await deliver(organizationId, mail, job, deps);
  } catch (error) {
    if (error instanceof UnrecoverableError || isFinalAttempt(job)) await settle();
    throw error;
  }
  await settle();
  return result;
}

/** Salinan pengaturan sebelum perubahan, siap dipakai mengirim; `undefined` bila tidak ada/tidak terbuka. */
function previousTransport(
  notice: typeof emailSettingsChangeNotices.$inferSelect,
  deps: EmailJobDeps,
): ResolvedTransport | undefined {
  if (
    notice.previousHost === null ||
    notice.previousPort === null ||
    notice.previousSecurity === null ||
    notice.previousFromAddress === null ||
    notice.previousFromName === null
  ) {
    return undefined;
  }
  // Teks sandinya sama persis dengan `email_settings` (konteks organisasi + tujuan), jadi
  // dibuka dengan cara yang sama. Password sudah dihapus (job lain selesai) = login tidak lengkap.
  const opened = openStoredEmailSettings(
    {
      organizationId: notice.organizationId,
      fromName: notice.previousFromName,
      fromAddress: notice.previousFromAddress,
      replyTo: notice.previousReplyTo,
      host: notice.previousHost,
      port: notice.previousPort,
      security: notice.previousSecurity,
      username: notice.previousPasswordEncrypted === null ? null : notice.previousUsername,
      passwordEncrypted: notice.previousPasswordEncrypted,
    },
    deps.secretBox,
  );
  if (!opened.ok) return undefined;
  return {
    kind: 'ready',
    settings: opened.settings,
    policy: {
      lookup: deps.lookup,
      timeouts: deps.timeouts,
      plaintextLogin: deps.plaintextLogin,
      allowedPorts: deps.allowedPorts,
    },
  };
}

/**
 * Ke satu Owner: channel dibuat / kredensial atau ID-nya diganti / verify token dibuat ulang /
 * dinonaktifkan / dihapus oleh pengguna SELAIN Owner. Semua rincian (pelaku, channel, perubahan,
 * waktu, IP/perangkat) dibaca dari baris audit kejadiannya — payload hanya ID, dan audit tidak
 * pernah memuat token/App Secret/verify token.
 */
async function sendChannelChanged(job: EmailJob, deps: EmailJobDeps): Promise<EmailJobResult> {
  const payload = channelChangedEmailPayloadSchema.safeParse(job.data);
  if (!payload.success) {
    throw new UnrecoverableError('Payload job email:channel-changed tidak valid');
  }
  const { organizationId, recipientUserId, auditLogId } = payload.data;
  const [audit] = await deps.db
    .select({
      action: auditLogs.action,
      actorUserId: auditLogs.actorUserId,
      metadata: auditLogs.metadata,
      ip: auditLogs.ipAddress,
      userAgent: auditLogs.userAgent,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.id, auditLogId)))
    .limit(1);
  if (!audit) {
    // Job diantrekan sebelum transaksi penyimpanan selesai: baris bisa belum terlihat (diulang).
    // Masih tidak ada di percobaan terakhir = perubahannya dibatalkan; tidak ada yang dilaporkan.
    if (isFinalAttempt(job)) return { status: 'skipped', reason: 'no_longer_valid' };
    throw new Error('Baris audit perubahan channel belum tersedia');
  }
  const change = channelChangeKindSchema.safeParse(audit.metadata.change);
  if (
    !change.success ||
    CHANNEL_CHANGE_AUDIT_ACTIONS[change.data] !== audit.action ||
    audit.metadata.ownersNotified !== true
  ) {
    throw new UnrecoverableError('Baris audit bukan perubahan channel yang diberitahukan');
  }
  // Profil bisnis: audit dicatat SEBELUM dikirim ke Meta. Bila Meta menolaknya, tidak ada yang
  // berubah — tidak ada yang perlu dilaporkan.
  if (
    change.data === 'business_profile_changed' &&
    (await profileUpdateFailed(organizationId, auditLogId, deps))
  ) {
    return { status: 'skipped', reason: 'no_longer_valid' };
  }

  const recipient = await findActiveUser(organizationId, recipientUserId, deps);
  const branding = await loadOrganizationBrand(deps.db, organizationId);
  // Penerima diperiksa ulang saat mengirim: yang sudah bukan Owner (atau nonaktif) dilewati.
  if (!recipient || recipient.role !== 'owner' || !branding) {
    return { status: 'skipped', reason: 'recipient_unavailable' };
  }
  // Pelaku yang sudah dinonaktifkan tetap disebut: Owner perlu tahu siapa.
  const actor = audit.actorUserId
    ? await findUserAnyStateWithEmail(organizationId, audit.actorUserId, deps)
    : undefined;
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  const changedFields = Array.isArray(audit.metadata.changedFields)
    ? audit.metadata.changedFields.flatMap((field) => {
        const parsed = channelCredentialFieldSchema.safeParse(field);
        return parsed.success ? [parsed.data] : [];
      })
    : [];

  const body = renderChannelChangedEmail({
    brand: branding.brand,
    timeZone: branding.timeZone,
    recipientName: recipient.name,
    actor: actor ?? null,
    change: change.data,
    channel: {
      name: text(audit.metadata.name) ?? 'Tanpa nama',
      phoneNumberId: text(audit.metadata.phoneNumberId),
    },
    changedFields,
    previousPhoneNumberId: text(audit.metadata.previousPhoneNumberId),
    ...(change.data === 'business_profile_changed'
      ? { profileChanges: profileChangesOf(audit.metadata) }
      : {}),
    occurredAt: audit.createdAt,
    origin: { ip: audit.ip, userAgent: audit.userAgent },
  });
  return deliver(
    organizationId,
    { to: recipient.email, ...body, inlineImages: branding.inlineImages },
    job,
    deps,
  );
}

/** Ada baris audit "Meta menolak perubahan profil bisnis" untuk perubahan `auditLogId`. */
async function profileUpdateFailed(
  organizationId: string,
  auditLogId: string,
  deps: EmailJobDeps,
): Promise<boolean> {
  const [row] = await deps.db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        eq(auditLogs.action, AUDIT_ACTIONS.channelBusinessProfileUpdateFailed),
        sql`${auditLogs.metadata} ->> 'auditLogId' = ${auditLogId}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Isian profil bisnis yang diubah + nilai lama → baru dari metadata audit (data publik). */
function profileChangesOf(
  metadata: Record<string, unknown>,
): Array<{ field: BusinessProfileField; previous: string | null; next: string }> {
  const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const previous = record(metadata.previous);
  const next = record(metadata.next) ?? {};
  const changed = Array.isArray(metadata.changedFields) ? metadata.changedFields : [];
  return BUSINESS_PROFILE_FIELDS.filter((field) => changed.includes(field)).map((field) => {
    const before = previous?.[field];
    const after = next[field];
    return {
      field,
      previous: typeof before === 'string' ? before : null,
      next: typeof after === 'string' ? after : '',
    };
  });
}

const PROCESSORS: Record<string, (job: EmailJob, deps: EmailJobDeps) => Promise<EmailJobResult>> = {
  [EMAIL_JOBS.accountLocked]: sendAccountLocked,
  [EMAIL_JOBS.securityNotice]: sendSecurityNotice,
  [EMAIL_JOBS.securityNoticeAdmin]: sendSecurityNoticeAdmin,
  [EMAIL_JOBS.invitation]: sendInvitation,
  [EMAIL_JOBS.accountToken]: sendAccountToken,
  [EMAIL_JOBS.emailSettingsChanged]: sendEmailSettingsChanged,
  [EMAIL_JOBS.channelChanged]: sendChannelChanged,
};

/**
 * Memproses satu job email. Payload SELALU divalidasi; job tak dikenal atau payload rusak
 * gagal permanen. Kegagalan sementara (server tidak merespons, sambungan ditolak) dilempar
 * sebagai error biasa supaya BullMQ mengulang dengan jeda.
 */
export function processEmailJob(job: EmailJob, deps: EmailJobDeps): Promise<EmailJobResult> {
  const processor = Object.hasOwn(PROCESSORS, job.name) ? PROCESSORS[job.name] : undefined;
  if (!processor) {
    return Promise.reject(
      new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian email`),
    );
  }
  return processor(job, deps);
}

/** Sisi konsumen antrian `email`. */
export function createEmailWorker(options: QueueConnectionOptions, deps: EmailJobDeps): Worker {
  return new Worker(QUEUE_NAMES.email, (job) => processEmailJob(job, deps), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    concurrency: 5,
  });
}
