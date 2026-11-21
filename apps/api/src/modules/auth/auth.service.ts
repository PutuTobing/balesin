import { AppError, sha256Hex } from '@balesin/core';
import type { Database } from '@balesin/db';
import {
  isTwoFactorRequired,
  type LoginRequest,
  type TwoFactorChallengeResponse,
  type TwoFactorMethod,
} from '@balesin/shared';
import type { FastifyBaseLogger } from 'fastify';

import { ipRateLimitKey, type ClientInfo } from '../../http/client-info';
import { rateLimited, type RateLimiter } from '../../http/rate-limit';
import type { EmailNotifier } from '../../queues/email-queue';
import { AUDIT_ACTIONS, maskEmail, recordAudit } from '../audit/audit';
import {
  findInstallationOrganization,
  type InstallationOrganization,
} from '../installation/installation.repo';
import type { TwoFactorService, VerifiedChallenge } from '../two-factor/two-factor.service';
import {
  findUserForLogin,
  lockUser,
  markLoginSucceeded,
  updatePasswordHash,
  type LoginUser,
} from './auth.repo';
import {
  ACCOUNT_LOCK_FLAG,
  DEVICE_LOCK_FLAG,
  LOCK_NOTICE_FLAG,
  LOCK_NOTICE_INTERVAL_SECONDS,
  LOGIN_ACCOUNT_RULE,
  LOGIN_DEVICE_RULE,
  LOGIN_IP_CONCURRENCY_RULE,
  LOGIN_IP_RULE,
  LOGIN_LOCK_SECONDS,
  LOGIN_SOURCE_RULE,
  SOURCE_LOCK_FLAG,
  loginAccountKey,
  type LockScope,
} from './login-rules';
import type { PasswordHasher } from './password-hasher';
import { findActiveSession } from './session.repo';
import type { AuthContext, IssuedSession, SessionService } from './session.service';
import {
  deviceIssueTime,
  deviceStillValid,
  latestDate,
  type TrustedDevices,
} from './trusted-device';

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

/**
 * Sesi baru hasil login. `deviceToken` (nilai baru cookie "perangkat dikenal") hanya ada bila
 * SEMUA langkah masuk sudah selesai — tidak untuk sesi terbatas "wajib mendaftar 2FA".
 */
export interface LoginResult extends IssuedSession {
  deviceToken: string | undefined;
}

/** Hasil `POST /auth/login`: sesi (penuh atau terbatas), atau tantangan langkah kedua. */
export type LoginOutcome =
  | { kind: 'session'; result: LoginResult }
  | { kind: 'two_factor_challenge'; challenge: TwoFactorChallengeResponse };

/** Langkah kedua berhasil: sesi penuh + keterangan kode yang dipakai. */
export interface TwoFactorLoginResult extends LoginResult {
  deviceToken: string;
  method: TwoFactorMethod;
  backupCodesRemaining: number;
}

export interface AuthService {
  /**
   * Memeriksa email + password. Berhasil → sesi penuh, sesi terbatas (peran wajib 2FA yang
   * belum mendaftar), atau tantangan langkah kedua (2FA aktif; BELUM ada sesi). Gagal →
   * `INVALID_CREDENTIALS` (pesan sama untuk email tidak terdaftar, password salah, dan akun
   * nonaktif) atau `RATE_LIMITED`.
   */
  login(input: LoginRequest, context: LoginContext): Promise<LoginOutcome>;
  /** Langkah kedua: tantangan + kode TOTP/kode cadangan → sesi penuh (rotasi sesi). */
  verifyTwoFactor(
    input: { challengeToken: string; code: string },
    context: LoginContext,
  ): Promise<TwoFactorLoginResult>;
  logout(auth: AuthContext, context: RequestContext): Promise<void>;
}

export interface AuthServiceDeps {
  db: Database;
  sessions: SessionService;
  hasher: PasswordHasher;
  limiter: RateLimiter;
  notifier: EmailNotifier;
  devices: TrustedDevices;
  twoFactor: TwoFactorService;
}

/** Ember batas laju + penanda kunci untuk tiap lingkup kunci. */
const LOCKS = {
  source: { flag: SOURCE_LOCK_FLAG, rule: LOGIN_SOURCE_RULE },
  account: { flag: ACCOUNT_LOCK_FLAG, rule: LOGIN_ACCOUNT_RULE },
  device: { flag: DEVICE_LOCK_FLAG, rule: LOGIN_DEVICE_RULE },
} as const;

/** Alasan login gagal di metadata audit (tidak pernah dikirim ke klien). */
type LoginFailureReason = 'unknown_email' | 'wrong_password' | 'disabled' | 'locked';

const IP_LIMIT_MESSAGE = 'Terlalu banyak percobaan masuk dari jaringanmu.';

function accountLocked(retryAfterSeconds: number): AppError {
  return rateLimited(
    retryAfterSeconds,
    // Tanpa durasi: halaman masuk menampilkan hitung mundur dari `Retry-After`.
    'Akun ini dikunci sementara karena terlalu banyak percobaan masuk yang gagal.',
  );
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { db, sessions, hasher, limiter, notifier, devices, twoFactor } = deps;

  /**
   * Tahap akhir login: mencabut sesi lama di browser ini (rotasi), membuat sesi baru, mencatat
   * audit. Dipanggil setelah password benar (akun tanpa 2FA), atau setelah langkah kedua 2FA
   * berhasil (`twoFactorLogin` terisi: tantangan ditutup — dan kode cadangan, bila itu yang
   * dipakai, ditandai terpakai — di transaksi yang sama, sehingga dua permintaan bersamaan dengan
   * kode benar hanya menghasilkan satu sesi dan tidak membakar kode cadangan).
   */
  async function completeLogin(
    user: LoginUser,
    organization: { id: string; name: string; timezone: string },
    context: LoginContext,
    options: {
      newPasswordHash?: string | undefined;
      twoFactorLogin?: VerifiedChallenge;
    } = {},
  ): Promise<LoginResult & { backupCodesRemaining: number }> {
    const previous = context.presentedToken
      ? await findActiveSession(db, sha256Hex(context.presentedToken))
      : undefined;
    const twoFactorEnabled = user.totpEnabledAt !== null;

    const { session: issued, backupCodesRemaining } = await db.transaction(async (tx) => {
      const remaining = options.twoFactorLogin
        ? await twoFactor.completeChallenge(tx, options.twoFactorLogin, context)
        : 0;
      if (previous) await sessions.revoke(tx, previous.organizationId, previous.id);
      await markLoginSucceeded(tx, organization.id, user.id, options.newPasswordHash);
      const session = await sessions.issue(tx, {
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
        organization: {
          id: organization.id,
          name: organization.name,
          timezone: organization.timezone,
        },
        client: context.client,
        twoFactorEnabled,
        twoFactorVerified: options.twoFactorLogin !== undefined,
      });
      await recordAudit(tx, {
        organizationId: organization.id,
        actorUserId: user.id,
        action: AUDIT_ACTIONS.loginSucceeded,
        targetType: 'session',
        targetId: session.auth.sessionRef,
        metadata: {
          replacedPreviousSession: previous !== undefined,
          twoFactor: options.twoFactorLogin?.method ?? null,
          ...(session.auth.twoFactor.enrollmentRequired
            ? { twoFactorEnrollmentRequired: true }
            : {}),
        },
        client: context.client,
      });
      return { session, backupCodesRemaining: remaining };
    });
    if (options.twoFactorLogin) {
      twoFactor.afterLogin(options.twoFactorLogin, backupCodesRemaining, context);
    }
    // Cookie perangkat dikenal hanya diterbitkan setelah SEMUA langkah masuk selesai: tidak untuk
    // sesi terbatas yang masih wajib mendaftar 2FA (diterbitkan saat 2FA-nya aktif).
    return {
      ...issued,
      deviceToken: issued.auth.twoFactor.enrollmentRequired
        ? undefined
        : devices.issue(
            user.id,
            deviceIssueTime(latestDate(user.totpEnabledAt, user.passwordChangedAt)),
          ),
      backupCodesRemaining,
    };
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
    scope: Exclude<LockScope, 'two_factor'>,
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
            // Kunci Redis ember yang dikunci (hash, bukan rahasia) — supaya Owner/Admin bisa
            // membuka kunci akun ini (`team` unlock). Hanya untuk akun sungguhan: hash email yang
            // tidak terdaftar tidak disimpan.
            ...(user ? { lockRef: bucketKey } : { email: maskEmail(context.email) }),
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

  /** Satu percobaan gagal dari IP ini (hanya hasil gagal yang menghabiskan jatah per IP). */
  async function countIpFailure(ipKey: string) {
    await limiter.consume(LOGIN_IP_RULE, ipKey);
  }

  /** Langkah password; jatah per IP & slot serentak sudah diurus `login`. */
  async function checkPassword(
    input: LoginRequest,
    context: LoginContext,
    ipKey: string,
  ): Promise<LoginOutcome> {
    // Dihitung per email yang DIKETIK, bukan per baris pengguna: email tidak terdaftar pun
    // "terkunci" dengan cara yang sama, jadi respons tidak membuka ada/tidaknya akun.
    const accountKey = loginAccountKey(input.email);
    const sourceKey = sha256Hex(`login|${input.email}|${ipKey}`).slice(0, 40);
    const lockContext = { ...context, email: input.email };

    const organization = await findInstallationOrganization(db);
    const user = organization
      ? await findUserForLogin(db, organization.id, input.email)
      : undefined;

    // Perangkat dikenal: cookie bertanda tangan milik AKUN INI (bukan akun lain) yang terbit
    // setelah password terakhir diganti (atur ulang password membatalkan semua cookie lama).
    const presentedDevice = devices.verify(context.presentedDeviceToken);
    const device =
      presentedDevice &&
      user &&
      presentedDevice.userId === user.id &&
      deviceStillValid(presentedDevice, user.passwordChangedAt)
        ? presentedDevice
        : undefined;
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
      await countIpFailure(ipKey);
      await recordFailure('locked');
      throw accountLocked(lockedFor);
    }

    // Jatah diambil SEBELUM password diperiksa, secara atomik: serbuan permintaan bersamaan
    // tetap hanya mendapat 5 kali pemeriksaan password per ember.
    const primaryRule = device ? LOGIN_DEVICE_RULE : LOGIN_SOURCE_RULE;
    const primaryKey = device ? deviceKey : sourceKey;
    const attempt = await limiter.consume(primaryRule, primaryKey);
    if (!attempt.allowed) {
      await countIpFailure(ipKey);
      await recordFailure('locked');
      throw accountLocked(attempt.retryAfterSeconds);
    }
    const accountAttempt = device
      ? undefined
      : await limiter.consume(LOGIN_ACCOUNT_RULE, accountKey);
    if (accountAttempt && !accountAttempt.allowed) {
      await limiter.refund(primaryRule, primaryKey);
      await countIpFailure(ipKey);
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
      await countIpFailure(ipKey);
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

    // Berhasil: bukan percobaan gagal (jatah per IP memang tidak disentuh). Jatah akun
    // dikembalikan; hitungan ember asal / perangkat dihapus. Hitungan akun TIDAK dihapus —
    // tebakan tersebar dari tempat lain tidak boleh "diputihkan" oleh login pemilik akun.
    await limiter.reset(primaryRule, primaryKey);
    if (accountAttempt) await limiter.refund(LOGIN_ACCOUNT_RULE, accountKey);

    const newPasswordHash = hasher.needsRehash(user.passwordHash)
      ? await hasher.hash(input.password)
      : undefined;

    // 2FA aktif: password benar belum berarti masuk. Belum ada sesi; yang diberikan hanya
    // tantangan sekali pakai untuk langkah kedua (`verifyTwoFactor`).
    if (user.totpEnabledAt !== null) {
      await twoFactor.assertNotLocked(user, context);
      if (newPasswordHash) {
        await updatePasswordHash(db, organization.id, user.id, newPasswordHash);
      }
      return {
        kind: 'two_factor_challenge',
        challenge: await twoFactor.issueChallenge(user, organization.id, context),
      };
    }

    // Peran wajib 2FA yang belum mendaftar dan sudah lewat batas waktu pendaftaran (review
    // undangan R3): password benar, tetapi tidak ada sesi pendaftaran lagi sampai Owner/Admin
    // membukanya (403 `TWO_FACTOR_ENROLLMENT_EXPIRED`, tercatat di audit).
    await twoFactor.assertEnrollmentOpen(user, 'login', context);

    // Tanpa 2FA aktif. Peran wajib 2FA mendapat sesi TERBATAS (hanya untuk mendaftar 2FA,
    // lihat `SessionService.issue`); peran lain mendapat sesi penuh.
    if (isTwoFactorRequired(user.role) && !twoFactor.available) {
      context.log.warn(
        { userId: user.id },
        'Peran wajib 2FA masuk tanpa BALESIN_MASTER_KEY: pendaftaran 2FA tidak bisa dilakukan',
      );
    }
    return {
      kind: 'session',
      result: await completeLogin(user, organization, context, { newPasswordHash }),
    };
  }

  return {
    async login(input, context) {
      const ipKey = ipRateLimitKey(context.client);
      // Per IP hanya percobaan GAGAL yang dihitung: diperiksa dulu tanpa dinaikkan, dinaikkan oleh
      // `countIpFailure`. Login sah serentak dari satu IP kantor (NAT) tidak saling menghabiskan.
      const failures = await limiter.peek(LOGIN_IP_RULE, ipKey);
      if (!failures.allowed) throw rateLimited(failures.retryAfterSeconds, IP_LIMIT_MESSAGE);
      // Serbuan paralel: paling banyak `LOGIN_IP_CONCURRENCY_RULE.limit` pemeriksaan password
      // berjalan bersamaan per IP (hitungan gagal baru naik setelah hasilnya diketahui).
      const slot = await limiter.consume(LOGIN_IP_CONCURRENCY_RULE, ipKey);
      try {
        if (!slot.allowed) throw rateLimited(slot.retryAfterSeconds, IP_LIMIT_MESSAGE);
        return await checkPassword(input, context, ipKey);
      } finally {
        await limiter.refund(LOGIN_IP_CONCURRENCY_RULE, ipKey).catch((err: unknown) => {
          // Jendela semafor yang pendek memulihkan jatah sendiri.
          context.log.warn({ err }, 'Gagal mengembalikan slot login serentak per IP');
        });
      }
    },

    async verifyTwoFactor(input, context) {
      const verified = await twoFactor.verifyChallenge(input, context);
      const result = await completeLogin(verified.user, verified.organization, context, {
        twoFactorLogin: verified,
      });
      if (!result.deviceToken) throw new Error('Login 2FA selesai tanpa cookie perangkat');
      return {
        ...result,
        deviceToken: result.deviceToken,
        method: verified.method,
        backupCodesRemaining: result.backupCodesRemaining,
      };
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
