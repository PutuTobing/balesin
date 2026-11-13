import { AppError, sha256Hex } from '@balesin/core';
import type { Database } from '@balesin/db';
import type { LoginRequest } from '@balesin/shared';
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
  DEVICE_LOCK_FLAG,
  LOCK_NOTICE_FLAG,
  LOCK_NOTICE_INTERVAL_SECONDS,
  LOGIN_ACCOUNT_RULE,
  LOGIN_DEVICE_RULE,
  LOGIN_IP_RULE,
  LOGIN_LOCK_SECONDS,
  LOGIN_SOURCE_RULE,
  SOURCE_LOCK_FLAG,
  type LockScope,
} from './login-rules';
import type { PasswordHasher } from './password-hasher';
import { findActiveSession } from './session.repo';
import type { AuthContext, IssuedSession, SessionService } from './session.service';
import type { TrustedDevices } from './trusted-device';

export interface RequestContext {
  client: ClientInfo;
  log: FastifyBaseLogger;
}

export interface LoginContext extends RequestContext {
  /** Token sesi yang sudah ada di cookie saat login (akan dicabut: rotasi sesi). */
  presentedToken?: string;
  /** Nilai cookie "perangkat dikenal" (lihat `trusted-device.ts`), bila ada. */
  presentedDeviceToken?: string;
}

/** Login berhasil: sesi baru + nilai baru cookie "perangkat dikenal". */
export interface LoginResult extends IssuedSession {
  deviceToken: string;
}

export interface AuthService {
  /**
   * Memeriksa email + password. Berhasil → sesi baru. Gagal → `INVALID_CREDENTIALS` (pesan
   * sama untuk email tidak terdaftar, password salah, dan akun nonaktif) atau `RATE_LIMITED`.
   */
  login(input: LoginRequest, context: LoginContext): Promise<LoginResult>;
  logout(auth: AuthContext, context: RequestContext): Promise<void>;
}

export interface AuthServiceDeps {
  db: Database;
  sessions: SessionService;
  hasher: PasswordHasher;
  limiter: RateLimiter;
  notifier: EmailNotifier;
  devices: TrustedDevices;
}

/** Ember batas laju + penanda kunci untuk tiap lingkup kunci. */
const LOCKS = {
  source: { flag: SOURCE_LOCK_FLAG, rule: LOGIN_SOURCE_RULE },
  account: { flag: ACCOUNT_LOCK_FLAG, rule: LOGIN_ACCOUNT_RULE },
  device: { flag: DEVICE_LOCK_FLAG, rule: LOGIN_DEVICE_RULE },
} as const;

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
  const { db, sessions, hasher, limiter, notifier, devices } = deps;

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
  ): Promise<LoginResult> {
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
      // Cookie perangkat dikenal hanya diterbitkan setelah SEMUA langkah masuk selesai
      // (nanti termasuk 2FA), dan diperbarui setiap login berhasil.
      return { ...issued, deviceToken: devices.issue(user.id) };
    });
  }

  /**
   * Memasang kunci untuk satu lingkup, mencatat audit, dan (paling banyak sekali per jam per
   * akun) mengantre email pemberitahuan.
   *
   * Langkah yang sama dijalankan untuk email terdaftar maupun tidak (penanda Redis, satu
   * transaksi audit, penanda pemberitahuan), supaya waktu jawaban percobaan yang memicu kunci
   * tidak membuka ada/tidaknya akun (temuan R1). Hanya kunci lingkup `account` yang ikut
   * menulis `users.locked_until` — kolom itu sekadar catatan untuk tampilan admin, TIDAK dipakai
   * untuk memutuskan login.
   */
  async function lock(
    scope: LockScope,
    bucketKey: string,
    accountKey: string,
    organization: InstallationOrganization | undefined,
    user: LoginUser | undefined,
    context: LoginContext & { email: string },
  ): Promise<void> {
    const { flag, rule } = LOCKS[scope];
    await limiter.setFlag(flag, bucketKey, LOGIN_LOCK_SECONDS);
    await limiter.reset(rule, bucketKey);

    const realUser = user && user.disabledAt === null ? user : undefined;
    let lockedUntil = new Date(Date.now() + LOGIN_LOCK_SECONDS * 1000);
    if (organization) {
      const fallbackUntil = lockedUntil;
      lockedUntil = await db.transaction(async (tx) => {
        const until =
          scope === 'account' && realUser
            ? ((await lockUser(tx, organization.id, realUser.id)) ?? fallbackUntil)
            : fallbackUntil;
        await recordAudit(tx, {
          organizationId: organization.id,
          actorUserId: null,
          action: AUDIT_ACTIONS.accountLocked,
          ...(user ? { targetType: 'user', targetId: user.id } : {}),
          metadata: {
            scope,
            failedAttempts: rule.limit,
            lockedUntil: until.toISOString(),
            ...(user ? {} : { email: maskEmail(context.email) }),
          },
          client: context.client,
        });
        return until;
      });
    }

    // Paling banyak satu email per jam per akun: pemicu kunci berulang tidak membanjiri korban.
    const shouldNotify = await limiter.claimFlag(
      LOCK_NOTICE_FLAG,
      accountKey,
      LOCK_NOTICE_INTERVAL_SECONDS,
    );
    if (!shouldNotify || !organization || !realUser) return;

    // Diantrekan tanpa ditunggu: Redis lambat, antrian penuh, atau email belum diatur tidak
    // boleh menggagalkan (atau memperlambat) jawaban login.
    void notifier
      .accountLocked({
        organizationId: organization.id,
        userId: realUser.id,
        lockedUntil: lockedUntil.toISOString(),
        scope,
      })
      .catch((err: unknown) => {
        context.log.warn({ err, userId: realUser.id }, 'Gagal mengantre email kunci akun');
      });
  }

  return {
    async login(input, context) {
      const ipKey = ipRateLimitKey(context.client);
      // Dihitung per email yang DIKETIK, bukan per baris pengguna: email tidak terdaftar pun
      // "terkunci" dengan cara yang sama, jadi respons tidak membuka ada/tidaknya akun.
      const accountKey = sha256Hex(`login|${input.email}`).slice(0, 40);
      const sourceKey = sha256Hex(`login|${input.email}|${ipKey}`).slice(0, 40);
      const lockContext = { ...context, email: input.email };

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

      // Perangkat dikenal: cookie bertanda tangan milik AKUN INI (bukan akun lain).
      const presentedDevice = devices.verify(context.presentedDeviceToken);
      const device =
        presentedDevice && user && presentedDevice.userId === user.id ? presentedDevice : undefined;
      const deviceKey = device ? sha256Hex(`${accountKey}|${device.deviceKey}`).slice(0, 40) : '';

      /** Setiap percobaan yang ditolak tercatat di audit — juga yang ditolak karena terkunci. */
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
            trustedDevice: device !== undefined,
            ...(attemptCount === undefined ? {} : { attempt: attemptCount }),
          },
          client: context.client,
        });
      };

      // Kunci yang berlaku: perangkat dikenal hanya terkena kuncinya sendiri; selain itu kunci
      // asal (email + IP) dan kunci akun (tebakan dari banyak IP). Kolom `users.locked_until`
      // sengaja TIDAK dipakai di sini (lihat `lock`).
      const lockedFor = device
        ? await limiter.flagTtl(DEVICE_LOCK_FLAG, deviceKey)
        : Math.max(
            await limiter.flagTtl(SOURCE_LOCK_FLAG, sourceKey),
            await limiter.flagTtl(ACCOUNT_LOCK_FLAG, accountKey),
          );
      if (lockedFor > 0) {
        await recordFailure('locked');
        throw accountLocked(lockedFor);
      }

      // Jatah diambil SEBELUM password diperiksa, secara atomik: serbuan permintaan bersamaan
      // tetap hanya mendapat 5 kali pemeriksaan password per ember.
      const primaryRule = device ? LOGIN_DEVICE_RULE : LOGIN_SOURCE_RULE;
      const primaryKey = device ? deviceKey : sourceKey;
      const attempt = await limiter.consume(primaryRule, primaryKey);
      if (!attempt.allowed) {
        await recordFailure('locked');
        throw accountLocked(attempt.retryAfterSeconds);
      }
      const accountAttempt = device
        ? undefined
        : await limiter.consume(LOGIN_ACCOUNT_RULE, accountKey);
      if (accountAttempt && !accountAttempt.allowed) {
        await limiter.refund(primaryRule, primaryKey);
        await recordFailure('locked');
        throw accountLocked(accountAttempt.retryAfterSeconds);
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
        let locked = false;
        if (attempt.count >= primaryRule.limit) {
          const scope = device ? 'device' : 'source';
          await lock(scope, primaryKey, accountKey, organization, user, lockContext);
          locked = true;
        }
        if (accountAttempt && accountAttempt.count >= LOGIN_ACCOUNT_RULE.limit) {
          await lock('account', accountKey, accountKey, organization, user, lockContext);
          locked = true;
        }
        if (locked) throw accountLocked(LOGIN_LOCK_SECONDS);
        throw new AppError('INVALID_CREDENTIALS');
      }

      // Berhasil: bukan percobaan gagal. Jatah IP dan akun dikembalikan; hitungan ember asal /
      // perangkat dihapus. Hitungan akun TIDAK dihapus — tebakan tersebar dari tempat lain tidak
      // boleh "diputihkan" oleh login pemilik akun.
      await limiter.refund(LOGIN_IP_RULE, ipKey);
      await limiter.reset(primaryRule, primaryKey);
      if (accountAttempt) await limiter.refund(LOGIN_ACCOUNT_RULE, accountKey);

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
