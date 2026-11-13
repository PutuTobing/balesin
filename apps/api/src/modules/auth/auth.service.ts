import { AppError, sha256Hex } from '@balesin/core';
import type { Database } from '@balesin/db';
import { LOGIN_MAX_FAILED_ATTEMPTS, type LoginRequest } from '@balesin/shared';
import type { FastifyBaseLogger } from 'fastify';

import { ipRateLimitKey, type ClientInfo } from '../../http/client-info';
import { enforceRateLimit, formatWait, rateLimited, type RateLimiter } from '../../http/rate-limit';
import type { EmailNotifier } from '../../queues/email-queue';
import { AUDIT_ACTIONS, maskEmail, recordAudit } from '../audit/audit';
import {
  findInstallationOrganization,
  type InstallationOrganization,
} from '../installation/installation.repo';
import { findUserForLogin, lockUser, markLoginSucceeded, type LoginUser } from './auth.repo';
import {
  ACCOUNT_LOCK_FLAG,
  LOGIN_ACCOUNT_RULE,
  LOGIN_IP_RULE,
  LOGIN_LOCK_SECONDS,
} from './login-rules';
import type { PasswordHasher } from './password-hasher';
import { findActiveSession } from './session.repo';
import type { AuthContext, IssuedSession, SessionService } from './session.service';

export interface RequestContext {
  client: ClientInfo;
  log: FastifyBaseLogger;
}

export interface LoginContext extends RequestContext {
  /** Token sesi yang sudah ada di cookie saat login (akan dicabut: rotasi sesi). */
  presentedToken?: string;
}

export interface AuthService {
  /**
   * Memeriksa email + password. Berhasil → sesi baru. Gagal → `INVALID_CREDENTIALS` (pesan
   * sama untuk email tidak terdaftar, password salah, dan akun nonaktif) atau `RATE_LIMITED`.
   */
  login(input: LoginRequest, context: LoginContext): Promise<IssuedSession>;
  logout(auth: AuthContext, context: RequestContext): Promise<void>;
}

export interface AuthServiceDeps {
  db: Database;
  sessions: SessionService;
  hasher: PasswordHasher;
  limiter: RateLimiter;
  notifier: EmailNotifier;
}

/** Alasan login gagal di metadata audit (tidak pernah dikirim ke klien). */
type LoginFailureReason = 'unknown_email' | 'wrong_password' | 'disabled' | 'locked';

function accountLocked(retryAfterSeconds: number): AppError {
  return rateLimited(
    retryAfterSeconds,
    'Akun ini dikunci sementara karena terlalu banyak percobaan masuk yang gagal. ' +
      `Coba lagi dalam ${formatWait(retryAfterSeconds)}.`,
  );
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { db, sessions, hasher, limiter, notifier } = deps;

  /**
   * Tahap akhir login: mencabut sesi lama di browser ini, membuat sesi baru, mencatat audit.
   * Dipisah dari pemeriksaan password supaya langkah 2FA (butir roadmap berikutnya) bisa
   * disisipkan di antaranya: setelah password benar, pengguna yang wajib 2FA baru sampai ke
   * sini setelah kode TOTP-nya diverifikasi.
   */
  async function completeLogin(
    user: LoginUser,
    organization: InstallationOrganization,
    context: LoginContext,
    newPasswordHash: string | undefined,
  ): Promise<IssuedSession> {
    const previous = context.presentedToken
      ? await findActiveSession(db, sha256Hex(context.presentedToken))
      : undefined;

    return db.transaction(async (tx) => {
      if (previous) await sessions.revoke(tx, previous.organizationId, previous.id);
      await markLoginSucceeded(tx, organization.id, user.id, newPasswordHash);
      const issued = await sessions.issue(tx, {
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
        organization: {
          id: organization.id,
          name: organization.name,
          timezone: organization.timezone,
        },
        client: context.client,
      });
      await recordAudit(tx, {
        organizationId: organization.id,
        actorUserId: user.id,
        action: AUDIT_ACTIONS.loginSucceeded,
        targetType: 'session',
        targetId: issued.auth.sessionRef,
        metadata: { replacedPreviousSession: previous !== undefined },
        client: context.client,
      });
      return issued;
    });
  }

  /** Mengunci akun: penanda Redis (berlaku untuk email apa pun) + kolom database + audit + email. */
  async function lockAccount(
    accountKey: string,
    organization: InstallationOrganization | undefined,
    user: LoginUser | undefined,
    context: LoginContext,
  ): Promise<void> {
    await limiter.setFlag(ACCOUNT_LOCK_FLAG, accountKey, LOGIN_LOCK_SECONDS);
    await limiter.reset(LOGIN_ACCOUNT_RULE, accountKey);
    // Email tidak terdaftar / akun nonaktif: cukup penanda Redis, supaya dari luar terlihat sama.
    if (!organization || !user || user.disabledAt !== null) return;

    const lockedUntil = await db.transaction(async (tx) => {
      const until = await lockUser(tx, organization.id, user.id);
      await recordAudit(tx, {
        organizationId: organization.id,
        actorUserId: null,
        action: AUDIT_ACTIONS.accountLocked,
        targetType: 'user',
        targetId: user.id,
        metadata: {
          failedAttempts: LOGIN_MAX_FAILED_ATTEMPTS,
          lockedUntil: until?.toISOString() ?? null,
        },
        client: context.client,
      });
      return until;
    });
    if (!lockedUntil) return;

    // Pemberitahuan diantrekan tanpa ditunggu: Redis lambat, antrian penuh, atau email belum
    // diatur tidak boleh menggagalkan (atau memperlambat) jawaban login.
    void notifier
      .accountLocked({
        organizationId: organization.id,
        userId: user.id,
        lockedUntil: lockedUntil.toISOString(),
      })
      .catch((err: unknown) => {
        context.log.warn({ err, userId: user.id }, 'Gagal mengantre email kunci akun');
      });
  }

  return {
    async login(input, context) {
      const ipKey = ipRateLimitKey(context.client);
      // Dihitung per email yang DIKETIK, bukan per baris pengguna: email tidak terdaftar pun
      // "terkunci" dengan cara yang sama, jadi respons tidak membuka ada/tidaknya akun.
      const accountKey = sha256Hex(`login|${input.email}`).slice(0, 40);

      await enforceRateLimit(
        limiter,
        LOGIN_IP_RULE,
        ipKey,
        (wait) => `Terlalu banyak percobaan masuk dari jaringanmu. Coba lagi dalam ${wait}.`,
      );

      const organization = await findInstallationOrganization(db);
      const user = organization
        ? await findUserForLogin(db, organization.id, input.email)
        : undefined;

      /** Setiap percobaan yang ditolak tercatat di audit — juga yang ditolak karena akun terkunci. */
      const recordFailure = async (reason: LoginFailureReason, attemptCount?: number) => {
        if (!organization) return;
        await recordAudit(db, {
          organizationId: organization.id,
          actorUserId: null,
          action: AUDIT_ACTIONS.loginFailed,
          ...(user ? { targetType: 'user', targetId: user.id } : {}),
          metadata: {
            reason,
            email: maskEmail(input.email),
            ...(attemptCount === undefined ? {} : { attempt: attemptCount }),
          },
          client: context.client,
        });
      };

      // Penanda Redis berlaku untuk email apa pun (terdaftar atau tidak). Kolom database adalah
      // lapis kedua bila penanda itu hilang (Redis dikosongkan/restart tanpa data).
      const lockedFor = Math.max(
        await limiter.flagTtl(ACCOUNT_LOCK_FLAG, accountKey),
        user?.lockedForSeconds ?? 0,
      );
      if (lockedFor > 0) {
        await recordFailure('locked');
        throw accountLocked(lockedFor);
      }

      // Jatah diambil SEBELUM password diperiksa, secara atomik: serbuan permintaan bersamaan
      // tetap hanya mendapat 5 kali pemeriksaan password per jendela.
      const attempt = await limiter.consume(LOGIN_ACCOUNT_RULE, accountKey);
      if (!attempt.allowed) {
        await recordFailure('locked');
        throw accountLocked(attempt.retryAfterSeconds);
      }

      let passwordValid = false;
      if (user && user.disabledAt === null) {
        passwordValid = await hasher.verify(user.passwordHash, input.password);
      } else {
        // Waktu respons disamakan dengan akun sungguhan.
        await hasher.verifyDummy(input.password);
      }

      if (!organization || !user || user.disabledAt !== null || !passwordValid) {
        await recordFailure(
          !user ? 'unknown_email' : user.disabledAt ? 'disabled' : 'wrong_password',
          attempt.count,
        );
        if (attempt.count >= LOGIN_ACCOUNT_RULE.limit) {
          await lockAccount(accountKey, organization, user, context);
          throw accountLocked(LOGIN_LOCK_SECONDS);
        }
        throw new AppError('INVALID_CREDENTIALS');
      }

      // Berhasil: bukan percobaan gagal, jadi jatah IP dikembalikan dan hitungan akun dihapus.
      await limiter.refund(LOGIN_IP_RULE, ipKey);
      await limiter.reset(LOGIN_ACCOUNT_RULE, accountKey);

      const newPasswordHash = hasher.needsRehash(user.passwordHash)
        ? await hasher.hash(input.password)
        : undefined;
      return completeLogin(user, organization, context, newPasswordHash);
    },

    async logout(auth, context) {
      await db.transaction(async (tx) => {
        await sessions.revoke(tx, auth.organizationId, auth.sessionRef);
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.logout,
          targetType: 'session',
          targetId: auth.sessionRef,
          client: context.client,
        });
      });
    },
  };
}
