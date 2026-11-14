import {
  EMAIL_JOBS,
  QUEUE_NAMES,
  QUEUE_PREFIX,
  accountLockedEmailPayloadSchema,
  fallbackEmailSettings,
  openStoredEmailSettings,
  renderAccountLockedEmail,
  renderSecurityNoticeEmail,
  securityNoticeEmailPayloadSchema,
  sendSmtpMail,
  type EmailJobResult,
  type HostLookup,
  type Logger,
  type MailContent,
  type MailTransportSettings,
  type PlaintextLoginPolicy,
  type SecretBox,
  type SmtpFallbackConfig,
  type SmtpFailureCode,
  type SmtpPolicy,
  type SmtpTimeouts,
} from '@balesin/core';
import { emailSettings, organizations, users, type Database } from '@balesin/db';
import {
  DEFAULT_PRODUCT_NAME,
  LOGIN_LOCK_MINUTES,
  LOGIN_MAX_FAILED_ATTEMPTS,
} from '@balesin/shared';
import { UnrecoverableError, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';

import type { QueueConnectionOptions } from './system';

/**
 * Pemroses antrian `email`: mengirim email sistem lewat SMTP organisasi.
 *
 * Payload job hanya memuat ID. Alamat penerima, pengaturan SMTP, dan password-nya (dibuka dari
 * bentuk terenkripsi) diambil dari database DI SINI, tepat saat mengirim — tidak pernah
 * tersimpan di Redis dan tidak pernah masuk log.
 *
 * Email belum diatur BUKAN kegagalan: job selesai dengan status `skipped`, supaya fitur yang
 * mengantre (mis. kunci akun) tetap jalan sebelum Owner mengisi pengaturan email.
 */

export interface EmailJob {
  id?: string;
  name: string;
  data: unknown;
}

export interface EmailJobDeps {
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
  const transport = await resolveTransport(organizationId, deps);
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

/** Penerima email akun: diambil dari database (payload hanya berisi ID). */
async function findRecipient(organizationId: string, userId: string, deps: EmailJobDeps) {
  const [recipient] = await deps.db
    .select({
      email: users.email,
      name: users.name,
      disabledAt: users.disabledAt,
      timezone: organizations.timezone,
      productName: organizations.productName,
    })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.organizationId))
    .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)))
    .limit(1);
  return recipient && recipient.disabledAt === null ? recipient : undefined;
}

async function sendAccountLocked(job: EmailJob, deps: EmailJobDeps): Promise<EmailJobResult> {
  const payload = accountLockedEmailPayloadSchema.safeParse(job.data);
  if (!payload.success) {
    throw new UnrecoverableError('Payload job email:account-locked tidak valid');
  }
  const { organizationId, userId, lockedUntil, scope } = payload.data;

  const recipient = await findRecipient(organizationId, userId, deps);
  if (!recipient) return { status: 'skipped', reason: 'recipient_unavailable' };

  const body = renderAccountLockedEmail({
    productName: recipient.productName ?? DEFAULT_PRODUCT_NAME,
    userName: recipient.name,
    failedAttempts: LOGIN_MAX_FAILED_ATTEMPTS,
    lockMinutes: LOGIN_LOCK_MINUTES,
    lockedUntil: new Date(lockedUntil),
    timeZone: recipient.timezone,
    scope,
  });
  return deliver(organizationId, { to: recipient.email, ...body }, job, deps);
}

/** 2FA diaktifkan/dinonaktifkan, kode cadangan dipakai — selalu ke pemilik akun sendiri. */
async function sendSecurityNotice(job: EmailJob, deps: EmailJobDeps): Promise<EmailJobResult> {
  const payload = securityNoticeEmailPayloadSchema.safeParse(job.data);
  if (!payload.success) {
    throw new UnrecoverableError('Payload job email:security-notice tidak valid');
  }
  const { organizationId, userId, event, occurredAt, backupCodesRemaining } = payload.data;

  const recipient = await findRecipient(organizationId, userId, deps);
  if (!recipient) return { status: 'skipped', reason: 'recipient_unavailable' };

  const body = renderSecurityNoticeEmail({
    productName: recipient.productName ?? DEFAULT_PRODUCT_NAME,
    userName: recipient.name,
    event,
    occurredAt: new Date(occurredAt),
    timeZone: recipient.timezone,
    ...(backupCodesRemaining === undefined ? {} : { backupCodesRemaining }),
  });
  return deliver(organizationId, { to: recipient.email, ...body }, job, deps);
}

/**
 * Memproses satu job email. Payload SELALU divalidasi; job tak dikenal atau payload rusak
 * gagal permanen. Kegagalan sementara (server tidak merespons, sambungan ditolak) dilempar
 * sebagai error biasa supaya BullMQ mengulang dengan jeda.
 */
export function processEmailJob(job: EmailJob, deps: EmailJobDeps): Promise<EmailJobResult> {
  if (job.name === EMAIL_JOBS.accountLocked) return sendAccountLocked(job, deps);
  if (job.name === EMAIL_JOBS.securityNotice) return sendSecurityNotice(job, deps);
  return Promise.reject(new UnrecoverableError(`Job "${job.name}" tidak dikenal di antrian email`));
}

/** Sisi konsumen antrian `email`. */
export function createEmailWorker(options: QueueConnectionOptions, deps: EmailJobDeps): Worker {
  return new Worker(QUEUE_NAMES.email, (job) => processEmailJob(job, deps), {
    connection: options.connection,
    prefix: options.prefix ?? QUEUE_PREFIX,
    concurrency: 5,
  });
}
