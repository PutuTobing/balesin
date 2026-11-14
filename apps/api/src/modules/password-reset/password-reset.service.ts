import { AppError, sha256Hex } from '@balesin/core';
import { newId, users, type Database } from '@balesin/db';
import {
  DEFAULT_PRODUCT_NAME,
  PASSWORD_RESET_VALID_MINUTES,
  TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS,
  type CompletePasswordResetRequest,
  type InspectPasswordResetResponse,
  type PasswordResetStatusResponse,
  type RequestPasswordResetResponse,
  type TwoFactorMethod,
} from '@balesin/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import type { BackgroundTasks } from '../../http/background-tasks';
import { ipRateLimitKey, type ClientInfo } from '../../http/client-info';
import { enforceRateLimit, type RateLimitRule, type RateLimiter } from '../../http/rate-limit';
import type { EmailNotifier } from '../../queues/email-queue';
import {
  claimAccountTokenAttempt,
  consumeAccountToken,
  findAccountTokenByHash,
  insertAccountToken,
  markAccountTokenUndelivered,
  revokeAccountToken,
  revokeLiveAccountTokens,
  type FoundAccountToken,
} from '../account-tokens/account-tokens.repo';
import {
  PUBLIC_TOKEN_IP_RULE,
  PUBLIC_TOKEN_RATE_MESSAGE,
  hashLinkToken,
  issueLinkToken,
  type TokenDelivery,
} from '../account-tokens/token-delivery';
import { AUDIT_ACTIONS, maskEmail, recordAudit } from '../audit/audit';
import { findUserForLogin } from '../auth/auth.repo';
import {
  ACCOUNT_LOCK_FLAG,
  LOGIN_ACCOUNT_RULE,
  LOGIN_SOURCE_RULE,
  SOURCE_LOCK_FLAG,
  loginAccountKey,
} from '../auth/login-rules';
import type { PasswordHasher } from '../auth/password-hasher';
import { checkPassword } from '../auth/password-policy';
import type { SessionService } from '../auth/session.service';
import {
  findInstallationOrganization,
  type InstallationOrganization,
} from '../installation/installation.repo';
import {
  backupCodeSummary,
  deleteChallenges,
  findTwoFactorUser,
  type TwoFactorUser,
} from '../two-factor/two-factor.repo';
import type { TwoFactorService } from '../two-factor/two-factor.service';

/**
 * Atur ulang password lewat email (SECURITY.md §1). Alur & error per kasus:
 * docs/KONTRAK-API-AUTH.md bagian "Atur ulang password".
 *
 * - Minta tautan: jawaban DAN waktunya sama untuk email terdaftar maupun tidak. Sebelum menjawab
 *   hanya dikerjakan hal yang sama untuk semua email (validasi, batas laju per IP dan per email
 *   yang DIKETIK, apakah email pengirim instalasi sudah diatur); pencarian akun, pembuatan token,
 *   dan pengantrean email dikerjakan SETELAH jawaban terkirim (`BackgroundTasks`).
 * - Token 256-bit, hanya hash-nya di database, sekali pakai, 30 menit, terikat ke email akun saat
 *   diminta (email akun berubah = tautan batal). Meminta tautan baru membatalkan yang lama.
 * - Akun ber-2FA: password baru WAJIB disertai kode autentikator atau kode cadangan — ember tebakan
 *   sama dengan langkah kedua saat masuk, 3 kode salah per tautan → tautan hangus. Atur ulang
 *   password tidak pernah menjadi jalan memotong 2FA.
 * - Selesai: SEMUA sesi dicabut, tantangan 2FA dibuang, cookie perangkat dikenal lama batal
 *   (`users.password_changed_at`), kunci login akun karena tebakan password dilepas (password yang
 *   ditebak sudah tidak berlaku), email "password diganti" dikirim. Tidak ada sesi baru.
 */

export interface PasswordResetContext {
  client: ClientInfo;
  log: FastifyBaseLogger;
  /** Cookie perangkat dikenal (memilih ember tebakan kode 2FA). */
  presentedDeviceToken?: string;
}

export interface PasswordResetService {
  status(): Promise<PasswordResetStatusResponse>;
  request(email: string, context: PasswordResetContext): Promise<RequestPasswordResetResponse>;
  inspect(token: string, context: PasswordResetContext): Promise<InspectPasswordResetResponse>;
  complete(
    input: { token: string; password: string; code?: string | undefined },
    context: PasswordResetContext,
  ): Promise<void>;
}

export interface PasswordResetServiceDeps {
  db: Database;
  hasher: PasswordHasher;
  limiter: RateLimiter;
  notifier: EmailNotifier;
  sessions: SessionService;
  twoFactor: TwoFactorService;
  delivery: TokenDelivery;
  background: BackgroundTasks;
}

/** Permintaan tautan per IP. */
export const PASSWORD_RESET_IP_RULE: RateLimitRule = {
  name: 'reset-ip',
  limit: 10,
  windowSeconds: 15 * 60,
};
/** Permintaan tautan per email yang DIKETIK (di-hash) — terdaftar atau tidak, sama. */
export const PASSWORD_RESET_EMAIL_RULE: RateLimitRule = {
  name: 'reset-email',
  limit: 3,
  windowSeconds: 60 * 60,
};

function invalid(message: string): AppError {
  return new AppError('TOKEN_INVALID', { message });
}

const GENERIC_INVALID =
  'Tautan atur ulang password ini tidak berlaku. Minta tautan baru dari halaman masuk ("Lupa password?").';

function invalidFor(state: FoundAccountToken['state'] | 'unknown'): AppError {
  switch (state) {
    case 'used':
      return invalid(
        'Tautan ini sudah dipakai. Kalau masih perlu mengganti password, minta tautan baru dari halaman masuk.',
      );
    case 'expired':
      return invalid(
        `Tautan atur ulang password sudah kedaluwarsa (berlaku ${PASSWORD_RESET_VALID_MINUTES} menit). Minta tautan baru dari halaman masuk.`,
      );
    default:
      return invalid(GENERIC_INVALID);
  }
}

function fieldError(field: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [{ location: 'body', field, message }],
  });
}

const WRONG_CODE =
  'Kode salah. Periksa kode terbaru di aplikasi autentikatormu (kode berganti tiap 30 detik), atau pakai kode cadangan.';

export function createPasswordResetService(deps: PasswordResetServiceDeps): PasswordResetService {
  const { db, hasher, limiter, notifier, sessions, twoFactor, delivery, background } = deps;

  async function availableFor(): Promise<InstallationOrganization | undefined> {
    const organization = await findInstallationOrganization(db);
    if (!organization) return undefined;
    return (await delivery.emailAvailable(db, organization.id)) ? organization : undefined;
  }

  /** Dikerjakan SETELAH jawaban terkirim: apa pun hasilnya, jawabannya sudah sama. */
  async function issue(
    organization: InstallationOrganization,
    email: string,
    context: PasswordResetContext,
  ): Promise<void> {
    const user = await findUserForLogin(db, organization.id, email);
    if (!user || user.disabledAt !== null) {
      await recordAudit(db, {
        organizationId: organization.id,
        actorUserId: null,
        action: AUDIT_ACTIONS.passwordResetRequested,
        ...(user ? { targetType: 'user', targetId: user.id } : {}),
        metadata: { email: maskEmail(email), matched: false, ...(user ? { disabled: true } : {}) },
        client: context.client,
      });
      return;
    }
    const { token, tokenHash } = issueLinkToken();
    const tokenId = newId();
    await db.transaction(async (tx) => {
      const replaced = await revokeLiveAccountTokens(
        tx,
        organization.id,
        user.id,
        'password_reset',
      );
      await insertAccountToken(tx, {
        id: tokenId,
        organizationId: organization.id,
        userId: user.id,
        purpose: 'password_reset',
        tokenHash,
        email: user.email,
        lifetimeMinutes: PASSWORD_RESET_VALID_MINUTES,
        deliveryTokenEncrypted: delivery.sealAccountToken(organization.id, tokenId, token),
        client: context.client,
      });
      await recordAudit(tx, {
        organizationId: organization.id,
        actorUserId: null,
        action: AUDIT_ACTIONS.passwordResetRequested,
        targetType: 'user',
        targetId: user.id,
        metadata: { matched: true, tokenRef: tokenId, replacedPrevious: replaced > 0 },
        client: context.client,
      });
    });
    try {
      await notifier.accountToken({ organizationId: organization.id, tokenId });
    } catch (err) {
      context.log.warn({ err, tokenRef: tokenId }, 'Gagal mengantre email atur ulang password');
      await markAccountTokenUndelivered(db, organization.id, tokenId);
    }
  }

  /** Token sah + pengguna aktif dengan email yang sama seperti saat tautan dibuat. */
  async function lookup(
    token: string,
    context: PasswordResetContext,
  ): Promise<{ row: FoundAccountToken; user: TwoFactorUser }> {
    const ipKey = ipRateLimitKey(context.client);
    await enforceRateLimit(limiter, PUBLIC_TOKEN_IP_RULE, ipKey, () => PUBLIC_TOKEN_RATE_MESSAGE);
    const row = await findAccountTokenByHash(db, hashLinkToken(token));
    if (!row || row.purpose !== 'password_reset') throw invalidFor('unknown');
    const user = await findTwoFactorUser(db, row.organizationId, row.userId);
    const reason =
      row.state !== 'usable'
        ? row.state
        : !user || user.disabledAt !== null
          ? 'user_unavailable'
          : user.email !== row.email
            ? 'email_changed'
            : undefined;
    if (reason || !user) {
      await recordAudit(db, {
        organizationId: row.organizationId,
        actorUserId: null,
        action: AUDIT_ACTIONS.passwordResetFailed,
        targetType: 'user',
        targetId: row.userId,
        metadata: { reason: reason ?? 'user_unavailable', tokenRef: row.id },
        client: context.client,
      });
      throw invalidFor(row.state === 'usable' ? 'unknown' : row.state);
    }
    await limiter.refund(PUBLIC_TOKEN_IP_RULE, ipKey);
    return { row, user };
  }

  async function methodsFor(user: TwoFactorUser): Promise<TwoFactorMethod[]> {
    if (user.totpEnabledAt === null) return [];
    const summary = await backupCodeSummary(db, user.organizationId, user.id);
    return summary.remaining > 0 ? ['totp', 'backup_code'] : ['totp'];
  }

  return {
    async status() {
      return { available: (await availableFor()) !== undefined };
    },

    async request(email, context) {
      await enforceRateLimit(
        limiter,
        PASSWORD_RESET_IP_RULE,
        ipRateLimitKey(context.client),
        () => 'Terlalu banyak permintaan atur ulang password dari jaringanmu.',
      );
      // Per email yang DIKETIK: email tak terdaftar dihitung sama persis dengan akun sungguhan.
      await enforceRateLimit(
        limiter,
        PASSWORD_RESET_EMAIL_RULE,
        sha256Hex(`reset|${email}`).slice(0, 40),
        () => 'Terlalu banyak permintaan atur ulang password untuk email ini.',
      );
      const organization = await availableFor();
      if (!organization) {
        // Keadaan instalasi (email pengirim belum diatur), sama untuk email apa pun.
        throw new AppError('SERVICE_UNAVAILABLE', {
          message:
            'Atur ulang password lewat email belum tersedia karena email pengirim belum diatur. Minta Owner atau Admin di tempatmu untuk membantu.',
        });
      }
      background.run('atur-ulang-password', () => issue(organization, email, context), context.log);
      return { status: 'accepted', validMinutes: PASSWORD_RESET_VALID_MINUTES };
    },

    async inspect(token, context) {
      const { row, user } = await lookup(token, context);
      const methods = await methodsFor(user);
      return {
        email: row.email,
        expiresAt: row.expiresAt.toISOString(),
        twoFactorRequired: user.totpEnabledAt !== null,
        methods,
      };
    },

    async complete(input: CompletePasswordResetRequest, context) {
      const { row, user } = await lookup(input.token, context);
      const organizationId = row.organizationId;

      // Kebijakan password dulu (tanpa efek samping): kode 2FA tidak terbakar karena password ditolak.
      const verdict = checkPassword(input.password, {
        email: user.email,
        name: user.name,
        organizationName: row.organization.name,
        productName: row.organization.productName ?? DEFAULT_PRODUCT_NAME,
      });
      if (!verdict.acceptable) throw fieldError('password', verdict.message);

      let method: TwoFactorMethod | null = null;
      let backupCodeId: string | undefined;
      if (user.totpEnabledAt !== null) {
        if (input.code === undefined) {
          throw fieldError(
            'code',
            'Akunmu memakai verifikasi dua langkah. Masukkan kode dari aplikasi autentikator atau salah satu kode cadangan.',
          );
        }
        const attempt = await claimAccountTokenAttempt(
          db,
          organizationId,
          row.id,
          TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS,
        );
        if (attempt === undefined) throw invalidFor('unknown');
        const check = await twoFactor.verifySecondFactor(user, input.code, 'password_reset', {
          client: context.client,
          log: context.log,
          ...(context.presentedDeviceToken
            ? { presentedDeviceToken: context.presentedDeviceToken }
            : {}),
        });
        if (!check.ok) {
          if (attempt >= TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS) {
            await revokeAccountToken(db, organizationId, row.id);
            throw invalid(
              `Kode salah ${TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS} kali. Tautan ini tidak berlaku lagi — minta tautan atur ulang password yang baru.`,
            );
          }
          throw fieldError(
            'code',
            `${WRONG_CODE} Sisa ${TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS - attempt} percobaan.`,
          );
        }
        method = check.method;
        if (check.method === 'backup_code') backupCodeId = check.backupCodeId;
      }

      const passwordHash = await hasher.hash(input.password);
      const twoFactorContext = { client: context.client, log: context.log };
      const { auditLogId, revokedSessions, backupCodesRemaining } = await db.transaction(
        async (tx) => {
          if (!(await consumeAccountToken(tx, organizationId, row.id))) throw invalidFor('unknown');
          let remaining: number | undefined;
          if (backupCodeId !== undefined) {
            remaining = await twoFactor.consumeBackupCode(
              tx,
              user,
              backupCodeId,
              'password_reset',
              twoFactorContext,
            );
            if (remaining === undefined) throw fieldError('code', WRONG_CODE);
          }
          await tx
            .update(users)
            .set({
              passwordHash,
              passwordChangedAt: sql`now()`,
              lockedUntil: null,
              // Tautan sampai lewat email = alamat ini terbukti milik pemilik akun.
              emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`,
            })
            .where(and(eq(users.organizationId, organizationId), eq(users.id, user.id)));
          const revoked = await sessions.revokeAllForUser(tx, organizationId, user.id);
          await deleteChallenges(tx, organizationId, user.id);
          const auditId = await recordAudit(tx, {
            organizationId,
            actorUserId: user.id,
            action: AUDIT_ACTIONS.passwordResetCompleted,
            targetType: 'user',
            targetId: user.id,
            metadata: { tokenRef: row.id, twoFactor: method, revokedSessions: revoked },
            client: context.client,
          });
          return { auditLogId: auditId, revokedSessions: revoked, backupCodesRemaining: remaining };
        },
      );
      context.log.info(
        { userId: user.id, revokedSessions },
        'Password diatur ulang; semua sesi dicabut',
      );

      // Kunci login karena tebakan password dilepas: tebakan itu untuk password lama. Kunci
      // perangkat lama tidak perlu — cookie perangkat lama sudah tidak diakui. Kunci langkah
      // kedua (2FA) TIDAK dilepas.
      const accountKey = loginAccountKey(user.email);
      const sourceKey = sha256Hex(`login|${user.email}|${ipRateLimitKey(context.client)}`).slice(
        0,
        40,
      );
      await limiter.clearFlag(ACCOUNT_LOCK_FLAG, accountKey);
      await limiter.reset(LOGIN_ACCOUNT_RULE, accountKey);
      await limiter.clearFlag(SOURCE_LOCK_FLAG, sourceKey);
      await limiter.reset(LOGIN_SOURCE_RULE, sourceKey);

      const notify = (promise: Promise<void>) =>
        void promise.catch((err: unknown) => {
          context.log.warn({ err, userId: user.id }, 'Gagal mengantre email pemberitahuan');
        });
      notify(
        notifier.securityNotice({
          organizationId,
          userId: user.id,
          event: 'password_changed',
          occurredAt: new Date().toISOString(),
          auditLogId,
        }),
      );
      if (backupCodesRemaining !== undefined) {
        twoFactor.notifyBackupCodeUsed(user, backupCodesRemaining, context.log);
      }
    },
  };
}
