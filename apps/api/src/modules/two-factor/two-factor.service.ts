import {
  AppError,
  constantTimeEqual,
  generateTotpSecret,
  matchTotp,
  randomToken,
  sanitizeTotpLabelPart,
  SecretDecryptionError,
  sha256Hex,
  totpUri,
  type LockTrigger,
  type SecretBox,
  type SecretContext,
  type SecurityNoticeEmailPayload,
} from '@balesin/core';
import type { Database, DbExecutor } from '@balesin/db';
import {
  DEFAULT_PRODUCT_NAME,
  TOTP_CODE_LENGTH,
  TOTP_PERIOD_SECONDS,
  TWO_FACTOR_CHALLENGE_MINUTES,
  TWO_FACTOR_ENROLLMENT_PENDING_MAX_MINUTES,
  TWO_FACTOR_ENROLLMENT_PENDING_MINUTES,
  isTwoFactorRequired,
  twoFactorCodeKind,
  type BackupCodes,
  type StartTwoFactorEnrollmentResponse,
  type TwoFactorChallengeResponse,
  type TwoFactorMethod,
  type TwoFactorStatusResponse,
  type UserRole,
} from '@balesin/shared';
import type { FastifyBaseLogger } from 'fastify';

import { ipRateLimitKey, type ClientInfo } from '../../http/client-info';
import {
  enforceRateLimit,
  rateLimited,
  type RateLimitRule,
  type RateLimiter,
} from '../../http/rate-limit';
import type { EmailNotifier } from '../../queues/email-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import {
  LOCK_NOTICE_FLAG,
  LOCK_NOTICE_INTERVAL_SECONDS,
  loginAccountKey,
} from '../auth/login-rules';
import type { PasswordHasher } from '../auth/password-hasher';
import type { AuthContext, IssuedSession, SessionService } from '../auth/session.service';
import {
  deviceIssueTime,
  deviceStillValid,
  trustedDeviceThreshold,
  type TrustedDevices,
} from '../auth/trusted-device';
import { generateBackupCodes } from './backup-codes';
import { isEnrollmentClosed } from './enrollment-window';
import {
  activateTotp,
  backupCodeSummary,
  claimChallengeAttempt,
  claimTotpStep,
  closeChallenge,
  deactivateTotp,
  deleteBackupCodes,
  deleteChallenges,
  findChallenge,
  findOtherAdministrators,
  findSessionClient,
  findTotpIssuer,
  findTwoFactorUser,
  insertChallenge,
  isPendingSecretFresh,
  markBackupCodeUsed,
  replaceBackupCodes,
  savePendingSecret,
  unusedBackupCodes,
  type TwoFactorUser,
} from './two-factor.repo';
import {
  CHALLENGE_MAX_ATTEMPTS,
  TWO_FACTOR_ACCOUNT_LOCK_FLAG,
  TWO_FACTOR_ACCOUNT_RULE,
  TWO_FACTOR_DAILY_LOCK_FLAG,
  TWO_FACTOR_DAILY_RULE,
  TWO_FACTOR_DEVICE_LOCK_FLAG,
  TWO_FACTOR_DEVICE_RULE,
  TWO_FACTOR_ENROLL_RULE,
  TWO_FACTOR_IP_RULE,
  TWO_FACTOR_LOCK_SECONDS,
  TWO_FACTOR_REAUTH_RULE,
} from './two-factor-rules';

/**
 * Verifikasi dua langkah (SECURITY.md §1): pendaftaran TOTP, langkah kedua saat masuk, kode
 * cadangan, dan pengelolaan oleh pengguna sendiri. Rincian alur: docs/KONTRAK-API-AUTH.md.
 *
 * Rahasia TOTP hanya ada di database dalam bentuk terenkripsi (`SecretBox`, konteks organisasi +
 * tujuan + ID pengguna) dan hanya dibuka di memori saat memeriksa kode. Tidak pernah dicatat di
 * log atau audit; hanya dikirim ke pengguna SEKALI saat pendaftaran dimulai.
 */

/** Penanda Redis "audit pendaftaran 2FA ditutup sudah ditulis menit ini" per pengguna. */
const ENROLLMENT_EXPIRED_AUDIT_FLAG = 'audit-daftar-2fa-ditutup';

/** Tujuan kotak rahasia (`SecretContext.purpose`). */
const ACTIVE_SECRET_PURPOSE = 'users.totp_secret';
const PENDING_SECRET_PURPOSE = 'users.totp_pending_secret';

export interface TwoFactorContext {
  client: ClientInfo;
  log: FastifyBaseLogger;
  /** Nilai cookie "perangkat dikenal", bila ada (memilih ember batas laju). */
  presentedDeviceToken?: string;
}

/**
 * Hasil langkah kedua yang kodenya benar — diteruskan ke `completeLogin`, yang memanggil
 * `completeChallenge` di dalam transaksi penerbitan sesi.
 */
export interface VerifiedChallenge {
  challengeId: string;
  user: TwoFactorUser;
  organization: { id: string; name: string; timezone: string };
  method: TwoFactorMethod;
  /**
   * Kode cadangan yang cocok. BELUM ditandai terpakai: penandaannya ada di transaksi yang sama
   * dengan penutupan tantangan + penerbitan sesi, supaya kode cadangan tidak terbakar bila
   * permintaan lain (mis. kode TOTP serentak) lebih dulu menutup tantangan (temuan R2).
   */
  backupCodeId?: string;
}

export interface EnrollmentCompleted {
  issued: IssuedSession;
  deviceToken: string;
  backupCodes: BackupCodes;
}

export interface TwoFactorService {
  /** Bisa menyimpan rahasia (`BALESIN_MASTER_KEY` terisi). */
  readonly available: boolean;
  /**
   * Dipanggil login setelah password benar: 429 bila langkah kedua akun ini sedang dikunci
   * (percobaan itu juga tercatat di audit).
   */
  assertNotLocked(user: LockSubject, context: TwoFactorContext): Promise<void>;
  /** Tantangan langkah kedua untuk pengguna yang password-nya baru saja benar. */
  issueChallenge(
    user: LockSubject,
    organizationId: string,
    context: TwoFactorContext,
  ): Promise<TwoFactorChallengeResponse>;
  /**
   * Memeriksa kode untuk sebuah tantangan. Berhasil → data untuk menerbitkan sesi (lihat
   * `completeChallenge`). Gagal → 400 (kode salah), 401 `TWO_FACTOR_CHALLENGE_INVALID`, atau 429.
   */
  verifyChallenge(
    input: { challengeToken: string; code: string },
    context: TwoFactorContext,
  ): Promise<VerifiedChallenge>;
  /**
   * Di DALAM transaksi penerbitan sesi: menutup tantangan (hanya satu permintaan yang bisa) dan,
   * bila kode cadangan yang dipakai, menandainya terpakai + audit. Mengembalikan sisa kode
   * cadangan yang dihitung setelah perubahan itu.
   */
  completeChallenge(
    executor: DbExecutor,
    verified: VerifiedChallenge,
    context: TwoFactorContext,
  ): Promise<number>;
  /** Setelah transaksi berhasil: email pemberitahuan bila kode cadangan dipakai. */
  afterLogin(
    verified: VerifiedChallenge,
    backupCodesRemaining: number,
    context: TwoFactorContext,
  ): void;
  status(auth: AuthContext): Promise<TwoFactorStatusResponse>;
  startEnrollment(
    auth: AuthContext,
    input: { password?: string | undefined },
    context: TwoFactorContext,
  ): Promise<StartTwoFactorEnrollmentResponse>;
  confirmEnrollment(
    auth: AuthContext,
    input: { code: string },
    context: TwoFactorContext,
  ): Promise<EnrollmentCompleted>;
  regenerateBackupCodes(
    auth: AuthContext,
    input: { password: string; code: string },
    context: TwoFactorContext,
  ): Promise<BackupCodes>;
  disable(
    auth: AuthContext,
    input: { password: string; code: string },
    context: TwoFactorContext,
  ): Promise<void>;
  /**
   * Kode 2FA untuk aksi DI LUAR login yang tidak boleh menjadi jalan memotong 2FA (atur ulang
   * password). Memakai ember tebakan yang SAMA dengan langkah kedua saat masuk (akun / perangkat
   * dikenal): kode salah ke-5 mengunci langkah kedua akun 15 menit + email kunci. 429 bila sedang
   * dikunci. Kode TOTP yang benar langsung dipakai (tidak bisa diputar ulang); kode cadangan yang
   * benar hanya DITEMUKAN — tandai terpakai dengan `consumeBackupCode` di transaksi aksinya.
   */
  verifySecondFactor(
    user: TwoFactorUser,
    code: string,
    trigger: Extract<LockTrigger, 'password_reset'>,
    context: TwoFactorContext,
  ): Promise<SecondFactorCheck>;
  /** Menandai kode cadangan terpakai + audit. `undefined` = sudah dipakai permintaan lain. */
  consumeBackupCode(
    executor: DbExecutor,
    user: Pick<TwoFactorUser, 'id' | 'organizationId'>,
    codeId: string,
    usage: 'password_reset',
    context: TwoFactorContext,
  ): Promise<number | undefined>;
  /** Email "kode cadangan dipakai" (diantrekan tanpa ditunggu). */
  notifyBackupCodeUsed(
    user: Pick<TwoFactorUser, 'id' | 'organizationId'>,
    remaining: number,
    log: FastifyBaseLogger,
  ): void;
  /**
   * Konfirmasi ulang identitas PELAKU untuk aksi sensitif di luar halaman 2FA (kelola pengguna lain,
   * keluarkan semua sesi): password, dan kode autentikator/kode cadangan bila 2FA pelaku aktif.
   * Ember salah-password dan salah-kode sama dengan halaman Keamanan akun. 400 field `password`/
   * `code` bila salah, 429 bila terkunci.
   */
  confirmIdentity(
    auth: AuthContext,
    input: { password: string; code?: string | undefined },
    action: string,
    context: TwoFactorContext,
  ): Promise<{ method: TwoFactorMethod | null }>;
  /**
   * 403 `TWO_FACTOR_ENROLLMENT_EXPIRED` (+ audit) bila akun ber-peran wajib ini sudah lewat batas
   * waktu pendaftaran 2FA (`enrollment-window.ts`). Dipanggil login (password benar, 2FA belum
   * aktif) dan saat mulai mendaftar.
   */
  assertEnrollmentOpen(
    user: { id: string; organizationId: string; role: UserRole; totpEnabledAt: Date | null },
    usage: 'login' | 'enrollment',
    context: TwoFactorContext,
  ): Promise<void>;
}

/** Hasil `verifySecondFactor`. */
export type SecondFactorCheck =
  | { ok: true; method: 'totp' }
  | { ok: true; method: 'backup_code'; backupCodeId: string }
  | { ok: false };

/** Bagian pengguna yang cukup untuk memilih ember kunci dan mengirim pemberitahuan. */
export interface LockSubject {
  id: string;
  organizationId: string;
  email: string;
  /** Cookie perangkat dikenal hanya diakui bila terbit SETELAH waktu ini (temuan S1). */
  totpEnabledAt: Date | null;
  /** …dan setelah password terakhir diganti (atur ulang password, review 2FA G.3). */
  passwordChangedAt: Date | null;
}

export interface TwoFactorServiceDeps {
  db: Database;
  /** `null` = `BALESIN_MASTER_KEY` kosong (hanya mungkin di development/test). */
  secretBox: SecretBox | null;
  hasher: PasswordHasher;
  limiter: RateLimiter;
  notifier: EmailNotifier;
  sessions: SessionService;
  devices: TrustedDevices;
}

/** Ember batas laju kode salah untuk satu percobaan. */
interface CodeBucket {
  rule: RateLimitRule;
  flag: string;
  key: string;
  trustedDevice: boolean;
}

/**
 * Hasil pemeriksaan kode. Kode TOTP yang benar langsung "dipakai" (langkahnya dicatat); kode
 * cadangan yang benar hanya DITEMUKAN (`backupCodeId`) — penandaannya dilakukan pemanggil.
 */
type CodeCheck =
  | { ok: true; method: 'totp' }
  | { ok: true; method: 'backup_code'; backupCodeId: string }
  | { ok: false; method: TwoFactorMethod; reason: 'wrong_code' | 'replayed' };

const WRONG_CODE_MESSAGE =
  'Kode salah. Periksa kode terbaru di aplikasi autentikatormu (kode berganti tiap 30 detik), atau pakai kode cadangan.';

function codeError(message: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [{ location: 'body', field: 'code', message }],
  });
}

function passwordError(message: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    message,
    details: [{ location: 'body', field: 'password', message }],
  });
}

function lockedError(retryAfterSeconds: number): AppError {
  return rateLimited(
    retryAfterSeconds,
    // Tanpa durasi: web menampilkan hitung mundur dari `Retry-After` (kritikus 2FA S3).
    'Terlalu banyak kode verifikasi yang salah untuk akun ini.',
  );
}

function conflict(message: string): AppError {
  return new AppError('CONFLICT', { message });
}

/** Token tantangan hanya berlaku dari browser + jaringan yang sama dengan saat password dimasukkan. */
function challengeBinding(client: ClientInfo): string {
  return sha256Hex(`2fa-tantangan|${ipRateLimitKey(client)}|${client.userAgent ?? ''}`);
}

function secretContext(organizationId: string, userId: string, purpose: string): SecretContext {
  return { organizationId, purpose, subjectId: userId };
}

/**
 * Rahasia pendaftaran terikat ke pengguna DAN sesi yang memulainya (ikut AAD). Akibatnya:
 * - memuat ulang layar pendaftaran di sesi yang sama memakai ulang rahasia yang sama (entri yang
 *   sudah dipindai di aplikasi autentikator tetap berlaku);
 * - sesi lain milik pengguna yang sama tidak bisa membuka (apalagi menerima) rahasia itu, jadi
 *   orang yang kebetulan tahu password tidak bisa ikut "melihat" rahasia yang sedang dipindai
 *   pemilik akun — ia hanya bisa memulai pendaftaran baru (yang membatalkan milik pemilik).
 */
function pendingSecretContext(
  organizationId: string,
  userId: string,
  sessionRef: string,
): SecretContext {
  return {
    organizationId,
    purpose: PENDING_SECRET_PURPOSE,
    subjectId: `${userId}|sesi:${sessionRef}`,
  };
}

/** Membuka rahasia; `undefined` bila tidak bisa dibuka dengan konteks ini (bukan error server). */
function tryOpen(box: SecretBox, encrypted: string, context: SecretContext): string | undefined {
  try {
    return box.decrypt(encrypted, context);
  } catch (error) {
    if (error instanceof SecretDecryptionError) return undefined;
    throw error;
  }
}

/** `ABCDEFGH…` → `ABCD EFGH …` untuk diketik manual. */
function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

export function createTwoFactorService(deps: TwoFactorServiceDeps): TwoFactorService {
  const { db, secretBox, hasher, limiter, notifier, sessions, devices } = deps;

  function requireSecretBox(): SecretBox {
    if (!secretBox) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        message:
          'Verifikasi dua langkah belum bisa dipakai karena BALESIN_MASTER_KEY di server belum diisi. Minta pengelola server mengisinya lalu menjalankan ulang aplikasi.',
      });
    }
    return secretBox;
  }

  function openSecret(user: TwoFactorUser, encrypted: string, purpose: string): string {
    try {
      return requireSecretBox().decrypt(
        encrypted,
        secretContext(user.organizationId, user.id, purpose),
      );
    } catch (error) {
      if (error instanceof SecretDecryptionError) {
        // Master key berganti/hilang, atau datanya rusak: pengguna tidak bisa berbuat apa-apa.
        throw new AppError('SERVICE_UNAVAILABLE', {
          message:
            'Data verifikasi dua langkah tidak bisa dibuka di server. Hubungi pengelola server atau Owner/Admin.',
          cause: error,
        });
      }
      throw error;
    }
  }

  async function loadUser(auth: AuthContext): Promise<TwoFactorUser> {
    const user = await findTwoFactorUser(db, auth.organizationId, auth.user.id);
    // Tidak mungkin terjadi untuk sesi yang sah (hook auth sudah memeriksa).
    if (!user || user.disabledAt !== null) throw new AppError('UNAUTHENTICATED');
    return user;
  }

  /**
   * Ember tebakan kode untuk percobaan ini (temuan S1 review 2FA):
   * - Cookie perangkat dikenal hanya diakui bila terbit SETELAH 2FA aktif — cookie baru hanya
   *   terbit setelah langkah kedua/aktivasi, jadi pemegangnya pernah lolos langkah kedua. Cookie
   *   dari masa "hanya password" bukan bukti apa-apa.
   * - Ember perangkat dikenal dikunci PER PENGGUNA (semua perangkat dikenal satu akun berbagi
   *   satu ember), bukan per nilai cookie: berapa pun cookie yang dikumpulkan, batasnya tetap.
   */
  function bucketFor(user: LockSubject, presentedDeviceToken: string | undefined): CodeBucket {
    const device = devices.verify(presentedDeviceToken);
    const trusted =
      device !== undefined &&
      device.userId === user.id &&
      user.totpEnabledAt !== null &&
      device.issuedAt.getTime() >= trustedDeviceThreshold(user.totpEnabledAt) &&
      deviceStillValid(device, user.passwordChangedAt);
    if (trusted) {
      return {
        rule: TWO_FACTOR_DEVICE_RULE,
        flag: TWO_FACTOR_DEVICE_LOCK_FLAG,
        key: user.id,
        trustedDevice: true,
      };
    }
    return {
      rule: TWO_FACTOR_ACCOUNT_RULE,
      flag: TWO_FACTOR_ACCOUNT_LOCK_FLAG,
      key: user.id,
      trustedDevice: false,
    };
  }

  /**
   * Kode benar: jatah percobaan ini dikembalikan. Hitungan ember AKUN tidak dihapus — tebakan
   * penyerang dari tempat lain tidak boleh "diputihkan" oleh login pemilik akun (temuan R1, sama
   * dengan aturan login password). Ember perangkat dikenal milik pemilik sendiri boleh dihapus.
   */
  async function settleSuccess(bucket: CodeBucket): Promise<void> {
    if (bucket.trustedDevice) await limiter.reset(bucket.rule, bucket.key);
    else await limiter.refund(bucket.rule, bucket.key);
  }

  function notify(payload: SecurityNoticeEmailPayload, log: FastifyBaseLogger): void {
    // Diantrekan tanpa ditunggu: antrian lambat/mati tidak boleh menggagalkan aksi pengguna.
    void notifier.securityNotice(payload).catch((err: unknown) => {
      log.warn({ err, userId: payload.userId }, 'Gagal mengantre email pemberitahuan keamanan');
    });
  }

  function notifyAdministrators(
    user: Pick<TwoFactorUser, 'id' | 'organizationId'>,
    occurredAt: string,
    auditLogId: string,
    log: FastifyBaseLogger,
  ): void {
    void findOtherAdministrators(db, user.organizationId, user.id)
      .then((recipients) =>
        Promise.all(
          recipients.map((recipientUserId) =>
            notifier.securityNoticeAdmin({
              organizationId: user.organizationId,
              recipientUserId,
              subjectUserId: user.id,
              event: 'two_factor_enabled',
              occurredAt,
              auditLogId,
            }),
          ),
        ),
      )
      .catch((err: unknown) => {
        log.warn({ err, userId: user.id }, 'Gagal mengantre pemberitahuan 2FA ke Owner/Admin');
      });
  }

  async function recordFailure(
    user: Pick<TwoFactorUser, 'id' | 'organizationId'>,
    context: TwoFactorContext,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorUserId: null,
      action: AUDIT_ACTIONS.twoFactorFailed,
      targetType: 'user',
      targetId: user.id,
      metadata,
      client: context.client,
    });
  }

  /** Sisa kunci untuk ember ini: kunci 15 menit, atau kunci harian (selain perangkat dikenal). */
  async function lockTtl(bucket: CodeBucket): Promise<number> {
    const short = await limiter.flagTtl(bucket.flag, bucket.key);
    if (bucket.trustedDevice) return short;
    return Math.max(short, await limiter.flagTtl(TWO_FACTOR_DAILY_LOCK_FLAG, bucket.key));
  }

  /**
   * Kode salah (selain dari perangkat dikenal) dihitung di ember 24 jam. Mencapai batas → kunci
   * harian + audit. Mengembalikan lama kunci (detik) bila kunci harian baru saja dipasang, atau 0.
   */
  async function recordDailyFailure(
    bucket: CodeBucket,
    user: LockSubject,
    trigger: LockTrigger,
    context: TwoFactorContext,
  ): Promise<number> {
    if (bucket.trustedDevice) return 0;
    const daily = await limiter.consume(TWO_FACTOR_DAILY_RULE, bucket.key);
    if (daily.count < TWO_FACTOR_DAILY_RULE.limit) return 0;
    await limiter.setFlag(TWO_FACTOR_DAILY_LOCK_FLAG, bucket.key, daily.retryAfterSeconds);
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorUserId: null,
      action: AUDIT_ACTIONS.accountLocked,
      targetType: 'user',
      targetId: user.id,
      metadata: {
        scope: 'two_factor',
        daily: true,
        trustedDevice: false,
        failedAttempts: TWO_FACTOR_DAILY_RULE.limit,
        trigger,
        lockedUntil: new Date(Date.now() + daily.retryAfterSeconds * 1000).toISOString(),
      },
      client: context.client,
    });
    return daily.retryAfterSeconds;
  }

  /** Kunci langkah kedua (lingkup `two_factor`): penanda Redis, audit, email (≤ 1×/jam/akun). */
  async function lock(
    bucket: CodeBucket,
    user: LockSubject,
    trigger: LockTrigger,
    context: TwoFactorContext,
  ): Promise<void> {
    await limiter.setFlag(bucket.flag, bucket.key, TWO_FACTOR_LOCK_SECONDS);
    await limiter.reset(bucket.rule, bucket.key);
    const lockedUntil = new Date(Date.now() + TWO_FACTOR_LOCK_SECONDS * 1000).toISOString();
    await recordAudit(db, {
      organizationId: user.organizationId,
      actorUserId: null,
      action: AUDIT_ACTIONS.accountLocked,
      targetType: 'user',
      targetId: user.id,
      metadata: {
        scope: 'two_factor',
        trustedDevice: bucket.trustedDevice,
        failedAttempts: bucket.rule.limit,
        trigger,
        lockedUntil,
      },
      client: context.client,
    });
    const shouldNotify = await limiter.claimFlag(
      LOCK_NOTICE_FLAG,
      loginAccountKey(user.email),
      LOCK_NOTICE_INTERVAL_SECONDS,
    );
    if (!shouldNotify) return;
    void notifier
      .accountLocked({
        organizationId: user.organizationId,
        userId: user.id,
        lockedUntil,
        scope: 'two_factor',
        trigger,
      })
      .catch((err: unknown) => {
        context.log.warn({ err, userId: user.id }, 'Gagal mengantre email kunci akun');
      });
  }

  /**
   * Memeriksa kode autentikator atau kode cadangan milik `user`. Kode TOTP yang benar langsung
   * "dipakai" (langkahnya dicatat, tidak bisa diputar ulang). Kode cadangan yang benar hanya
   * ditemukan; pemanggil menandainya lewat `consumeBackupCode` di transaksi aksinya.
   */
  async function checkCode(user: TwoFactorUser, code: string): Promise<CodeCheck> {
    const kind = twoFactorCodeKind(code);
    if (kind === 'backup_code') {
      const stored = await unusedBackupCodes(db, user.organizationId, user.id);
      for (const candidate of stored) {
        if (await hasher.verify(candidate.codeHash, code)) {
          return { ok: true, method: 'backup_code', backupCodeId: candidate.id };
        }
      }
      return { ok: false, method: 'backup_code', reason: 'wrong_code' };
    }

    if (kind !== 'totp' || !user.totpSecretEncrypted) {
      return { ok: false, method: 'totp', reason: 'wrong_code' };
    }
    const secret = openSecret(user, user.totpSecretEncrypted, ACTIVE_SECRET_PURPOSE);
    const step = matchTotp(secret, code, { lastUsedStep: user.totpLastUsedStep });
    if (step === null) {
      // Cocok bila langkah terakhir diabaikan = kode yang sudah pernah dipakai (untuk audit).
      const replayed = matchTotp(secret, code) !== null;
      return { ok: false, method: 'totp', reason: replayed ? 'replayed' : 'wrong_code' };
    }
    if (!(await claimTotpStep(db, user.organizationId, user.id, step))) {
      return { ok: false, method: 'totp', reason: 'replayed' };
    }
    return { ok: true, method: 'totp' };
  }

  /**
   * Menandai kode cadangan terpakai (bersyarat belum dipakai) + audit, di `executor` pemanggil.
   * Mengembalikan sisa kode setelahnya, atau `undefined` bila permintaan lain sudah memakainya.
   */
  async function consumeBackupCode(
    executor: DbExecutor,
    user: Pick<TwoFactorUser, 'id' | 'organizationId'>,
    codeId: string,
    usage: 'login' | 'reauth' | 'password_reset',
    context: TwoFactorContext,
  ): Promise<number | undefined> {
    if (!(await markBackupCodeUsed(executor, user.organizationId, codeId))) return undefined;
    const { remaining } = await backupCodeSummary(executor, user.organizationId, user.id);
    await recordAudit(executor, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: AUDIT_ACTIONS.twoFactorBackupCodeUsed,
      targetType: 'user',
      targetId: user.id,
      metadata: { usage, remaining },
      client: context.client,
    });
    return remaining;
  }

  function notifyBackupCodeUsed(
    user: Pick<TwoFactorUser, 'id' | 'organizationId'>,
    remaining: number,
    log: FastifyBaseLogger,
  ): void {
    notify(
      {
        organizationId: user.organizationId,
        userId: user.id,
        event: 'backup_code_used',
        occurredAt: new Date().toISOString(),
        backupCodesRemaining: remaining,
      },
      log,
    );
  }

  /**
   * Konfirmasi ulang identitas untuk aksi pengelolaan: password (dan kode, bila diminta).
   * Password salah dibatasi ember `2fa-konfirmasi` dan tidak sampai memeriksa kode. Kode salah
   * masuk ember yang SAMA dengan langkah kedua saat masuk (akun / perangkat dikenal): ikut
   * mengunci langkah kedua dan mengirim email kunci (temuan R4). Kode cadangan yang dipakai di
   * sini langsung ditandai terpakai (+ audit + email).
   */
  async function reauthenticate(
    user: TwoFactorUser,
    input: { password?: string | undefined; code?: string },
    action: string,
    context: TwoFactorContext,
  ): Promise<CodeCheck | undefined> {
    if (input.password === undefined) {
      throw passwordError('Masukkan password-mu untuk melanjutkan.');
    }
    const attempt = await limiter.consume(TWO_FACTOR_REAUTH_RULE, user.id);
    if (!attempt.allowed) {
      throw rateLimited(
        attempt.retryAfterSeconds,
        'Terlalu banyak percobaan konfirmasi yang salah.',
      );
    }
    if (!(await hasher.verify(user.passwordHash, input.password))) {
      await recordFailure(user, context, { usage: action, reason: 'wrong_password' });
      throw passwordError('Password salah. Periksa lagi lalu coba kembali.');
    }
    let check: CodeCheck | undefined;
    if (input.code !== undefined) {
      const bucket = bucketFor(user, context.presentedDeviceToken);
      const lockedFor = await lockTtl(bucket);
      if (lockedFor > 0) {
        await recordFailure(user, context, { usage: action, reason: 'locked' });
        throw lockedError(lockedFor);
      }
      const codeAttempt = await limiter.consume(bucket.rule, bucket.key);
      if (!codeAttempt.allowed) {
        await recordFailure(user, context, { usage: action, reason: 'locked' });
        throw lockedError(codeAttempt.retryAfterSeconds);
      }
      check = await checkCode(user, input.code);
      if (check.ok && check.method === 'backup_code') {
        const remaining = await consumeBackupCode(db, user, check.backupCodeId, 'reauth', context);
        if (remaining === undefined) {
          check = { ok: false, method: 'backup_code', reason: 'replayed' };
        } else {
          notifyBackupCodeUsed(user, remaining, context.log);
        }
      }
      if (!check.ok) {
        await recordFailure(user, context, {
          usage: action,
          method: check.method,
          reason: check.reason,
          attempt: codeAttempt.count,
          trustedDevice: bucket.trustedDevice,
        });
        const dailyLock = await recordDailyFailure(bucket, user, 'reauth', context);
        if (dailyLock > 0) throw lockedError(dailyLock);
        if (codeAttempt.count >= bucket.rule.limit) {
          await lock(bucket, user, 'reauth', context);
          throw lockedError(TWO_FACTOR_LOCK_SECONDS);
        }
        throw codeError(WRONG_CODE_MESSAGE);
      }
      await settleSuccess(bucket);
    }
    await limiter.refund(TWO_FACTOR_REAUTH_RULE, user.id);
    return check;
  }

  async function assertEnrollmentOpen(
    user: { id: string; organizationId: string; role: UserRole; totpEnabledAt: Date | null },
    usage: 'login' | 'enrollment',
    context: TwoFactorContext,
  ): Promise<void> {
    if (!isTwoFactorRequired(user.role) || user.totpEnabledAt !== null) return;
    if (!(await isEnrollmentClosed(db, user.organizationId, user.id))) return;
    // Paling banyak satu entri per pengguna per menit: pemegang password tidak bisa membanjiri
    // audit dengan mencoba masuk berulang (jawabannya tetap 403).
    const firstInWindow = await limiter
      .claimFlag(ENROLLMENT_EXPIRED_AUDIT_FLAG, user.id, 60)
      .catch(() => true);
    if (firstInWindow) {
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: AUDIT_ACTIONS.twoFactorEnrollmentExpired,
        targetType: 'user',
        targetId: user.id,
        metadata: { usage },
        client: context.client,
      });
    }
    throw new AppError('TWO_FACTOR_ENROLLMENT_EXPIRED');
  }

  return {
    available: secretBox !== null,

    assertEnrollmentOpen,

    async confirmIdentity(auth, input, action, context) {
      const user = await loadUser(auth);
      const enabled = user.totpEnabledAt !== null;
      if (enabled && input.code === undefined) {
        throw codeError(
          'Masukkan kode dari aplikasi autentikator atau salah satu kode cadangan untuk melanjutkan.',
        );
      }
      const check = await reauthenticate(
        user,
        {
          password: input.password,
          ...(enabled && input.code !== undefined ? { code: input.code } : {}),
        },
        action,
        context,
      );
      return { method: check?.ok ? check.method : null };
    },

    async assertNotLocked(user, context) {
      const bucket = bucketFor(user, context.presentedDeviceToken);
      const lockedFor = await lockTtl(bucket);
      if (lockedFor > 0) {
        await recordFailure(user, context, {
          usage: 'login',
          reason: 'locked',
          trustedDevice: bucket.trustedDevice,
        });
        throw lockedError(lockedFor);
      }
    },

    async issueChallenge(user, organizationId, context) {
      const token = randomToken(32);
      const challenge = await insertChallenge(db, {
        organizationId,
        userId: user.id,
        tokenHash: sha256Hex(token),
        bindingHash: challengeBinding(context.client),
        client: context.client,
        lifetimeMinutes: TWO_FACTOR_CHALLENGE_MINUTES,
      });
      const summary = await backupCodeSummary(db, organizationId, user.id);
      await recordAudit(db, {
        organizationId,
        actorUserId: null,
        action: AUDIT_ACTIONS.twoFactorChallengeIssued,
        targetType: 'user',
        targetId: user.id,
        metadata: { challengeRef: challenge.id },
        client: context.client,
      });
      return {
        status: 'two_factor_required',
        challengeToken: token,
        expiresAt: challenge.expiresAt.toISOString(),
        attemptsRemaining: CHALLENGE_MAX_ATTEMPTS,
        methods: summary.remaining > 0 ? ['totp', 'backup_code'] : ['totp'],
      };
    },

    async verifyChallenge(input, context) {
      const ipKey = ipRateLimitKey(context.client);
      await enforceRateLimit(
        limiter,
        TWO_FACTOR_IP_RULE,
        ipKey,
        () => 'Terlalu banyak percobaan verifikasi dari jaringanmu.',
      );

      const challenge = await findChallenge(db, sha256Hex(input.challengeToken));
      if (!challenge) throw new AppError('TWO_FACTOR_CHALLENGE_INVALID');
      const { user, organization } = challenge;

      const invalidReason = !challenge.usable
        ? 'expired_or_used'
        : challenge.failedAttempts >= CHALLENGE_MAX_ATTEMPTS
          ? 'attempts_exhausted'
          : !constantTimeEqual(challenge.bindingHash, challengeBinding(context.client))
            ? 'different_client'
            : user.disabledAt !== null
              ? 'disabled'
              : user.totpEnabledAt === null
                ? 'two_factor_disabled'
                : undefined;
      if (invalidReason) {
        await recordFailure(user, context, {
          reason: 'challenge_invalid',
          detail: invalidReason,
          challengeRef: challenge.id,
        });
        throw new AppError('TWO_FACTOR_CHALLENGE_INVALID');
      }

      const bucket = bucketFor(user, context.presentedDeviceToken);
      const lockedFor = await lockTtl(bucket);
      if (lockedFor > 0) {
        await recordFailure(user, context, { reason: 'locked', challengeRef: challenge.id });
        throw lockedError(lockedFor);
      }
      // Jatah diambil SEBELUM kode diperiksa dan secara atomik (serbuan bersamaan tetap terbatas).
      const attempt = await limiter.consume(bucket.rule, bucket.key);
      if (!attempt.allowed) {
        await recordFailure(user, context, { reason: 'locked', challengeRef: challenge.id });
        throw lockedError(attempt.retryAfterSeconds);
      }
      const challengeAttempt = await claimChallengeAttempt(
        db,
        challenge.organizationId,
        challenge.id,
        CHALLENGE_MAX_ATTEMPTS,
      );
      if (challengeAttempt === undefined) {
        await limiter.refund(bucket.rule, bucket.key);
        throw new AppError('TWO_FACTOR_CHALLENGE_INVALID');
      }

      const check = await checkCode(user, input.code);
      if (!check.ok) {
        await recordFailure(user, context, {
          reason: check.reason,
          method: check.method,
          attempt: attempt.count,
          challengeAttempt,
          trustedDevice: bucket.trustedDevice,
          challengeRef: challenge.id,
        });
        const dailyLock = await recordDailyFailure(bucket, user, 'login', context);
        if (dailyLock > 0) {
          await closeChallenge(db, challenge.organizationId, challenge.id);
          throw lockedError(dailyLock);
        }
        if (attempt.count >= bucket.rule.limit) {
          await closeChallenge(db, challenge.organizationId, challenge.id);
          await lock(bucket, user, 'login', context);
          throw lockedError(TWO_FACTOR_LOCK_SECONDS);
        }
        if (challengeAttempt >= CHALLENGE_MAX_ATTEMPTS) {
          await closeChallenge(db, challenge.organizationId, challenge.id);
          throw new AppError('TWO_FACTOR_CHALLENGE_INVALID', {
            message: `Kode salah ${CHALLENGE_MAX_ATTEMPTS} kali. Masuk lagi dengan email dan password-mu.`,
          });
        }
        const left = CHALLENGE_MAX_ATTEMPTS - challengeAttempt;
        throw codeError(`${WRONG_CODE_MESSAGE} Sisa ${left} percobaan.`);
      }

      await limiter.refund(TWO_FACTOR_IP_RULE, ipKey);
      await settleSuccess(bucket);
      return {
        challengeId: challenge.id,
        user,
        organization,
        method: check.method,
        ...(check.method === 'backup_code' ? { backupCodeId: check.backupCodeId } : {}),
      };
    },

    async completeChallenge(executor, verified, context) {
      const { user } = verified;
      // Dua permintaan bersamaan dengan kode benar: hanya satu yang boleh menerbitkan sesi.
      if (!(await closeChallenge(executor, user.organizationId, verified.challengeId))) {
        throw new AppError('TWO_FACTOR_CHALLENGE_INVALID');
      }
      if (verified.backupCodeId === undefined) {
        return (await backupCodeSummary(executor, user.organizationId, user.id)).remaining;
      }
      const remaining = await consumeBackupCode(
        executor,
        user,
        verified.backupCodeId,
        'login',
        context,
      );
      // Kode yang sama dipakai permintaan lain lebih dulu: transaksi dibatalkan (tantangan tetap
      // terbuka, tanpa sesi).
      if (remaining === undefined) throw codeError(WRONG_CODE_MESSAGE);
      return remaining;
    },

    afterLogin(verified, backupCodesRemaining, context) {
      if (verified.method === 'backup_code') {
        notifyBackupCodeUsed(verified.user, backupCodesRemaining, context.log);
      }
    },

    async status(auth) {
      const user = await loadUser(auth);
      const enabled = user.totpEnabledAt !== null;
      const summary = enabled
        ? await backupCodeSummary(db, user.organizationId, user.id)
        : { remaining: 0, generatedAt: null };
      const enrollmentPending =
        !enabled &&
        user.totpPendingSecretEncrypted !== null &&
        (await isPendingSecretFresh(
          db,
          user.organizationId,
          user.id,
          TWO_FACTOR_ENROLLMENT_PENDING_MINUTES,
          TWO_FACTOR_ENROLLMENT_PENDING_MAX_MINUTES,
        ));
      return {
        enabled,
        required: isTwoFactorRequired(user.role),
        enabledAt: user.totpEnabledAt?.toISOString() ?? null,
        backupCodesRemaining: summary.remaining,
        backupCodesGeneratedAt: summary.generatedAt?.toISOString() ?? null,
        enrollmentPending,
      };
    },

    async startEnrollment(auth, input, context) {
      const box = requireSecretBox();
      const user = await loadUser(auth);
      if (user.totpEnabledAt !== null) {
        throw conflict('Verifikasi dua langkah sudah aktif untuk akunmu.');
      }
      await enforceRateLimit(
        limiter,
        TWO_FACTOR_ENROLL_RULE,
        user.id,
        (wait) =>
          `Terlalu sering mencoba mendaftarkan verifikasi dua langkah. Coba lagi dalam ${wait}.`,
      );
      // Batas waktu pendaftaran peran wajib (review undangan R3): juga untuk sesi terbatas yang
      // dibuat sebelum batasnya lewat.
      await assertEnrollmentOpen(user, 'enrollment', context);
      // Hanya sesi berjenis pendaftaran 2FA — dibuat TEPAT setelah password dimasukkan
      // (masuk/setup) dan berumur 30 menit — yang dibebaskan dari password. Jenisnya ditetapkan
      // saat sesi dibuat, bukan dari peran sekarang: sesi biasa yang dicuri lalu perannya
      // dinaikkan tidak boleh bisa memasang autentikator milik orang lain (temuan S2).
      if (auth.sessionKind !== 'two_factor_enrollment') {
        await reauthenticate(user, { password: input.password }, 'enrollment', context);
      }

      // Layar dimuat ulang (tab HP dibuang browser saat pengguna pindah ke aplikasi autentikator):
      // rahasia tertunda yang masih berlaku DARI SESI INI dipakai ulang, supaya entri yang sudah
      // dipindai tidak basi. Rahasia tertunda dari sesi lain tidak bisa dibuka → rahasia baru.
      // Pemakaian ulang juga dibatasi:
      //  - waktu mutlak sejak rahasia itu pertama dibuat (`totp_pending_issued_at`);
      //  - peramban + jaringan yang SAMA dengan saat sesi ini dibuat (review 2FA R7): pemegang
      //    cookie curian dari tempat lain tidak bisa diam-diam membaca ulang rahasia yang sedang
      //    dipindai pemilik — ia hanya bisa memutarnya, sehingga QR pemilik ditolak dan ketahuan.
      const pendingContext = pendingSecretContext(user.organizationId, user.id, auth.sessionRef);
      const existing =
        user.totpPendingSecretEncrypted !== null &&
        (await isPendingSecretFresh(
          db,
          user.organizationId,
          user.id,
          TWO_FACTOR_ENROLLMENT_PENDING_MINUTES,
          TWO_FACTOR_ENROLLMENT_PENDING_MAX_MINUTES,
        ))
          ? user.totpPendingSecretEncrypted
          : null;
      const sessionClient = existing
        ? await findSessionClient(db, user.organizationId, auth.sessionRef)
        : undefined;
      const sameClient =
        sessionClient !== undefined &&
        ipRateLimitKey(sessionClient) === ipRateLimitKey(context.client) &&
        (sessionClient.userAgent ?? '') === (context.client.userAgent ?? '');
      const openedSecret = existing ? tryOpen(box, existing, pendingContext) : undefined;
      const reusedSecret = sameClient ? openedSecret : undefined;
      const secret = reusedSecret ?? generateTotpSecret();
      const pendingEncrypted =
        reusedSecret !== undefined && existing !== null
          ? existing
          : box.encrypt(secret, pendingContext);
      // Waktu dibuat diperbarui: QR yang tampil berlaku 15 menit sejak ditampilkan.
      const createdAt = await savePendingSecret(
        db,
        user.organizationId,
        user.id,
        pendingEncrypted,
        reusedSecret === undefined,
      );
      if (!createdAt) throw conflict('Verifikasi dua langkah sudah aktif untuk akunmu.');

      const issuer = sanitizeTotpLabelPart(
        (await findTotpIssuer(db, user.organizationId)) ?? DEFAULT_PRODUCT_NAME,
        DEFAULT_PRODUCT_NAME,
      );
      await recordAudit(db, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: AUDIT_ACTIONS.twoFactorEnrollmentStarted,
        targetType: 'user',
        targetId: user.id,
        metadata: {
          reusedPending: reusedSecret !== undefined,
          // Rahasia milik sesi ini masih berlaku tetapi diputar karena peramban/jaringannya lain.
          ...(openedSecret !== undefined && reusedSecret === undefined
            ? { rotatedReason: 'different_client' }
            : {}),
        },
        client: context.client,
      });
      return {
        otpauthUri: totpUri({ issuer, accountName: user.email, secretBase32: secret }),
        secret,
        secretGrouped: groupSecret(secret),
        issuer,
        accountName: user.email,
        expiresAt: new Date(
          createdAt.getTime() + TWO_FACTOR_ENROLLMENT_PENDING_MINUTES * 60_000,
        ).toISOString(),
        digits: TOTP_CODE_LENGTH,
        periodSeconds: TOTP_PERIOD_SECONDS,
      };
    },

    async confirmEnrollment(auth, input, context) {
      const box = requireSecretBox();
      const user = await loadUser(auth);
      if (user.totpEnabledAt !== null) {
        throw conflict('Verifikasi dua langkah sudah aktif untuk akunmu.');
      }
      await enforceRateLimit(
        limiter,
        TWO_FACTOR_ENROLL_RULE,
        user.id,
        (wait) => `Terlalu banyak percobaan kode. Coba lagi dalam ${wait}.`,
      );
      const pending = user.totpPendingSecretEncrypted;
      const expired = () =>
        conflict(
          'Kode QR pendaftaran sudah kedaluwarsa atau belum dibuat. Mulai lagi pendaftarannya.',
        );
      if (
        pending === null ||
        !(await isPendingSecretFresh(
          db,
          user.organizationId,
          user.id,
          TWO_FACTOR_ENROLLMENT_PENDING_MINUTES,
          TWO_FACTOR_ENROLLMENT_PENDING_MAX_MINUTES,
        ))
      ) {
        throw expired();
      }
      // Hanya sesi yang memulai pendaftaran yang bisa mengonfirmasinya (lihat `pendingSecretContext`).
      const secret = tryOpen(
        box,
        pending,
        pendingSecretContext(user.organizationId, user.id, auth.sessionRef),
      );
      if (secret === undefined) throw expired();
      const step = matchTotp(secret, input.code);
      if (step === null) {
        await recordFailure(user, context, { usage: 'enrollment', reason: 'wrong_code' });
        throw codeError(
          'Kode tidak cocok. Masukkan kode terbaru dari entri akun ini di aplikasi autentikator. ' +
            'Kalau kamu pernah memindai kode QR lain untuk akun ini, hapus entri lamanya. ' +
            'Pastikan juga jam di ponselmu tepat.',
        );
      }

      // Hashing kode cadangan (mahal) di luar transaksi.
      const backup = await generateBackupCodes(hasher);
      const { issued, generatedAt, revokedSessions, enabledAt, auditLogId } = await db.transaction(
        async (tx) => {
          const activatedAt = await activateTotp(tx, {
            organizationId: user.organizationId,
            userId: user.id,
            expectedPending: pending,
            secretEncrypted: box.encrypt(
              secret,
              secretContext(user.organizationId, user.id, ACTIVE_SECRET_PURPOSE),
            ),
            usedStep: step,
          });
          if (!activatedAt) throw expired();
          const codesCreatedAt = await replaceBackupCodes(
            tx,
            user.organizationId,
            user.id,
            backup.hashes,
          );
          // Semua sesi lama (termasuk sesi terbatas ini) dicabut: sesi yang dibuat hanya dengan
          // password tidak boleh ikut "naik kelas" setelah 2FA aktif.
          const revoked = await sessions.revokeAllForUser(tx, user.organizationId, user.id);
          const session = await sessions.issue(tx, {
            user: auth.user,
            organization: auth.organization,
            client: context.client,
            twoFactorEnabled: true,
            twoFactorVerified: true,
          });
          const enabledAuditId = await recordAudit(tx, {
            organizationId: user.organizationId,
            actorUserId: user.id,
            action: AUDIT_ACTIONS.twoFactorEnabled,
            targetType: 'user',
            targetId: user.id,
            metadata: {
              required: isTwoFactorRequired(user.role),
              generatedCount: backup.hashes.length,
              revokedSessions: revoked,
            },
            client: context.client,
          });
          await recordAudit(tx, {
            organizationId: user.organizationId,
            actorUserId: user.id,
            action: AUDIT_ACTIONS.loginSucceeded,
            targetType: 'session',
            targetId: session.auth.sessionRef,
            metadata: { via: 'two_factor_enrollment' },
            client: context.client,
          });
          return {
            issued: session,
            generatedAt: codesCreatedAt,
            revokedSessions: revoked,
            enabledAt: activatedAt,
            auditLogId: enabledAuditId,
          };
        },
      );
      context.log.info(
        { userId: user.id, revokedSessions },
        'Verifikasi dua langkah diaktifkan; sesi diganti',
      );
      await limiter.reset(TWO_FACTOR_ENROLL_RULE, user.id);
      const occurredAt = enabledAt.toISOString();
      notify(
        {
          organizationId: user.organizationId,
          userId: user.id,
          event: 'two_factor_enabled',
          occurredAt,
          auditLogId,
        },
        context.log,
      );
      // Trust-on-first-use (review 2FA R5): untuk peran wajib, autentikator yang PERTAMA
      // didaftarkan menjadi kunci kedua akun itu. Owner/Admin lain ikut diberi tahu kapan, dari
      // IP mana, dan dengan perangkat apa — satu job per penerima.
      if (isTwoFactorRequired(user.role)) {
        notifyAdministrators(user, occurredAt, auditLogId, context.log);
      }
      return {
        issued,
        // Login kini benar-benar selesai (semua langkah): cookie perangkat dikenal diterbitkan.
        // Waktu terbitnya tidak boleh lebih awal dari waktu aktif 2FA (jam database), karena
        // hanya cookie yang terbit setelah 2FA aktif yang diakui di langkah kedua (S1).
        deviceToken: devices.issue(user.id, deviceIssueTime(enabledAt)),
        backupCodes: { codes: backup.display, generatedAt: generatedAt.toISOString() },
      };
    },

    async regenerateBackupCodes(auth, input, context) {
      const user = await loadUser(auth);
      if (user.totpEnabledAt === null) {
        throw conflict('Verifikasi dua langkah belum aktif, jadi belum ada kode cadangan.');
      }
      const check = await reauthenticate(user, input, 'regenerate_backup_codes', context);
      const backup = await generateBackupCodes(hasher);
      const generatedAt = await db.transaction(async (tx) => {
        const createdAt = await replaceBackupCodes(tx, user.organizationId, user.id, backup.hashes);
        await recordAudit(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: AUDIT_ACTIONS.twoFactorBackupCodesRegenerated,
          targetType: 'user',
          targetId: user.id,
          metadata: { confirmedWith: check?.method ?? null, generatedCount: backup.hashes.length },
          client: context.client,
        });
        return createdAt;
      });
      notify(
        {
          organizationId: user.organizationId,
          userId: user.id,
          event: 'backup_codes_regenerated',
          occurredAt: generatedAt.toISOString(),
        },
        context.log,
      );
      return { codes: backup.display, generatedAt: generatedAt.toISOString() };
    },

    async disable(auth, input, context) {
      if (isTwoFactorRequired(auth.user.role)) {
        throw new AppError('FORBIDDEN', {
          message:
            'Peranmu wajib memakai verifikasi dua langkah, jadi tidak bisa dinonaktifkan. Kalau ponselmu hilang, minta Owner atau Admin mengaturnya ulang.',
        });
      }
      const user = await loadUser(auth);
      if (user.totpEnabledAt === null) {
        throw conflict('Verifikasi dua langkah memang belum aktif.');
      }
      const check = await reauthenticate(user, input, 'disable', context);
      await db.transaction(async (tx) => {
        await deactivateTotp(tx, user.organizationId, user.id);
        await deleteBackupCodes(tx, user.organizationId, user.id);
        await deleteChallenges(tx, user.organizationId, user.id);
        await recordAudit(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: AUDIT_ACTIONS.twoFactorDisabled,
          targetType: 'user',
          targetId: user.id,
          metadata: { confirmedWith: check?.method ?? null },
          client: context.client,
        });
      });
      notify(
        {
          organizationId: user.organizationId,
          userId: user.id,
          event: 'two_factor_disabled',
          occurredAt: new Date().toISOString(),
        },
        context.log,
      );
    },

    async verifySecondFactor(user, code, trigger, context) {
      const bucket = bucketFor(user, context.presentedDeviceToken);
      const lockedFor = await lockTtl(bucket);
      if (lockedFor > 0) {
        await recordFailure(user, context, { usage: trigger, reason: 'locked' });
        throw lockedError(lockedFor);
      }
      const attempt = await limiter.consume(bucket.rule, bucket.key);
      if (!attempt.allowed) {
        await recordFailure(user, context, { usage: trigger, reason: 'locked' });
        throw lockedError(attempt.retryAfterSeconds);
      }
      const check = await checkCode(user, code);
      if (!check.ok) {
        await recordFailure(user, context, {
          usage: trigger,
          method: check.method,
          reason: check.reason,
          attempt: attempt.count,
          trustedDevice: bucket.trustedDevice,
        });
        const dailyLock = await recordDailyFailure(bucket, user, trigger, context);
        if (dailyLock > 0) throw lockedError(dailyLock);
        if (attempt.count >= bucket.rule.limit) {
          await lock(bucket, user, trigger, context);
          throw lockedError(TWO_FACTOR_LOCK_SECONDS);
        }
        return { ok: false };
      }
      await settleSuccess(bucket);
      return check;
    },

    consumeBackupCode: (executor, user, codeId, usage, context) =>
      consumeBackupCode(executor, user, codeId, usage, context),

    notifyBackupCodeUsed,
  };
}
