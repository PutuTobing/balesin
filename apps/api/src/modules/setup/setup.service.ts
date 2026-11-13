import { AppError, constantTimeEqual, type Secret } from '@balesin/core';
import {
  PG_ERROR_CODES,
  emailSettings as emailSettingsTable,
  installation,
  isPgError,
  organizationLogos,
  organizations,
  users,
  type Database,
} from '@balesin/db';
import {
  DEFAULT_PRODUCT_NAME,
  type CheckSetupPasswordRequest,
  type CompleteSetupRequest,
  type EmailSettingsInput,
  type EmailTestResult,
  type PasswordCheckResponse,
  type SetupStatusResponse,
} from '@balesin/shared';
import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';

import { ipRateLimitKey, type ClientInfo } from '../../http/client-info';
import {
  enforceRateLimit,
  formatWait,
  rateLimited,
  type RateLimitRule,
  type RateLimiter,
} from '../../http/rate-limit';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import type { PasswordHasher } from '../auth/password-hasher';
import { checkPassword } from '../auth/password-policy';
import type { IssuedSession, SessionService } from '../auth/session.service';
import { validateLogoUpload } from '../branding/logo';
import type { EmailSettingsService } from '../email-settings/email-settings.service';
import { isSetupCompleted } from '../installation/installation.repo';
import type { SetupEmailTestMemo } from './setup-email-test-memo';

/**
 * Wizard setup pertama kali (SECURITY.md §1).
 *
 * - Hanya jalan selama belum ada Owner, dan hanya dengan `SETUP_TOKEN` yang benar
 *   (perbandingan waktu-konstan, dibatasi lajunya per IP dan secara keseluruhan).
 * - Terkunci permanen setelah Owner dibuat. Dua permintaan bersamaan tidak bisa sama-sama
 *   lolos: transaksi mengambil kunci advisory, memeriksa ulang, lalu menulis baris
 *   `installation` yang primary key-nya hanya mengizinkan satu baris.
 */

export interface SetupRequestContext {
  client: ClientInfo;
  log: FastifyBaseLogger;
}

export interface SetupService {
  status(): Promise<SetupStatusResponse>;
  /** Melempar bila setup sudah selesai, token belum diatur, token salah, atau batas laju terlewati. */
  assertSetupToken(presented: string, context: SetupRequestContext): Promise<void>;
  checkPassword(input: CheckSetupPasswordRequest): PasswordCheckResponse;
  /**
   * Mengingat hasil tes email di wizard (tes koneksi / kirim email tes) supaya `complete`
   * bisa mencatatnya sebagai status pengaturan bila isiannya tidak berubah.
   */
  rememberEmailTest(
    settings: EmailSettingsInput,
    result: EmailTestResult,
    context: SetupRequestContext,
  ): Promise<void>;
  complete(input: CompleteSetupRequest, context: SetupRequestContext): Promise<IssuedSession>;
}

export interface SetupServiceDeps {
  db: Database;
  setupToken: Secret<string> | null;
  limiter: RateLimiter;
  hasher: PasswordHasher;
  sessions: SessionService;
  emailSettings: EmailSettingsService;
  emailTestMemo: SetupEmailTestMemo;
}

/** Semua percobaan token per IP (token benar mengembalikan jatahnya). */
export const SETUP_TOKEN_IP_RULE: RateLimitRule = {
  name: 'setup-token-ip',
  limit: 10,
  windowSeconds: 15 * 60,
};
/** Token SALAH dari seluruh penjuru — menahan tebakan yang disebar ke banyak IP. */
export const SETUP_TOKEN_GLOBAL_RULE: RateLimitRule = {
  name: 'setup-token-semua',
  limit: 100,
  windowSeconds: 15 * 60,
};
const GLOBAL_KEY = 'semua';

/** Kunci advisory Postgres untuk transaksi penyelesaian setup (angka tetap, khusus keperluan ini). */
const SETUP_LOCK_ID = 7_262_537_462;

const ALREADY_COMPLETED_MESSAGE =
  'Setup sudah selesai dan tidak bisa dijalankan lagi. Masuk dengan akun Owner yang sudah dibuat.';

function alreadyCompleted(cause?: unknown): AppError {
  return new AppError('CONFLICT', { message: ALREADY_COMPLETED_MESSAGE, cause });
}

export function createSetupService(deps: SetupServiceDeps): SetupService {
  const { db, setupToken, limiter, hasher, sessions, emailSettings, emailTestMemo } = deps;

  async function assertSetupToken(presented: string, context: SetupRequestContext): Promise<void> {
    if (await isSetupCompleted(db)) throw alreadyCompleted();
    if (!setupToken) {
      throw new AppError('SERVICE_UNAVAILABLE', {
        message:
          'Token setup belum diatur di server. Isi SETUP_TOKEN di berkas .env server, jalankan ulang aplikasi, lalu buka lagi halaman ini.',
      });
    }

    const ipKey = ipRateLimitKey(context.client);
    const tooMany = (wait: string) =>
      `Terlalu banyak percobaan token setup. Coba lagi dalam ${wait}.`;
    await enforceRateLimit(limiter, SETUP_TOKEN_IP_RULE, ipKey, tooMany);

    if (constantTimeEqual(presented, setupToken.reveal())) {
      await limiter.refund(SETUP_TOKEN_IP_RULE, ipKey);
      return;
    }

    const global = await limiter.consume(SETUP_TOKEN_GLOBAL_RULE, GLOBAL_KEY);
    context.log.warn({ ip: context.client.ip }, 'Token setup salah');
    if (!global.allowed) {
      throw rateLimited(global.retryAfterSeconds, tooMany(formatWait(global.retryAfterSeconds)));
    }
    throw new AppError('FORBIDDEN', {
      message:
        'Token setup salah. Salin lagi nilai SETUP_TOKEN dari berkas .env server (atau dari keluaran installer), lalu coba lagi.',
    });
  }

  function assertOwnerPassword(input: CompleteSetupRequest): void {
    const verdict = checkPassword(input.owner.password, {
      email: input.owner.email,
      name: input.owner.name,
      organizationName: input.organization.name,
      productName: input.branding?.productName ?? DEFAULT_PRODUCT_NAME,
    });
    if (!verdict.acceptable) {
      throw new AppError('VALIDATION_ERROR', {
        details: [{ location: 'body', field: 'owner.password', message: verdict.message }],
      });
    }
  }

  return {
    async status() {
      const completed = await isSetupCompleted(db);
      return {
        needsSetup: !completed,
        setupTokenConfigured: setupToken !== null,
        canStoreSecrets: emailSettings.canStoreSecrets,
      };
    },

    assertSetupToken,

    rememberEmailTest: (settings, result, context) =>
      emailTestMemo.remember(settings, result, context.log),

    checkPassword(input) {
      const verdict = checkPassword(input.password, {
        email: input.email,
        name: input.name,
        organizationName: input.organizationName,
        productName: DEFAULT_PRODUCT_NAME,
      });
      return verdict.acceptable
        ? { acceptable: true, message: null }
        : { acceptable: false, message: verdict.message };
    },

    async complete(input, context) {
      await assertSetupToken(input.setupToken, context);

      // Semua pemeriksaan isi dilakukan SEBELUM transaksi (hashing password itu mahal).
      assertOwnerPassword(input);
      const logo = input.branding?.logo
        ? validateLogoUpload(input.branding.logo, 'branding.logo')
        : undefined;
      const preparedEmail = input.email
        ? emailSettings.prepare(input.email, undefined, 'email.')
        : undefined;
      // Hasil tes terakhir di langkah Email (bila isiannya sama persis) ikut tersimpan sebagai
      // status, jadi Pengaturan → Email pengirim langsung menampilkan "Terhubung" + waktunya.
      const lastEmailTest = input.email
        ? await emailTestMemo.recall(input.email, context.log)
        : undefined;
      const passwordHash = await hasher.hash(input.owner.password);

      try {
        return await db.transaction(async (tx) => {
          // Permintaan setup lain menunggu di sini sampai transaksi ini selesai, lalu melihat
          // Owner yang sudah ada dan berhenti.
          await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_ID})`);
          if (await isSetupCompleted(tx)) throw alreadyCompleted();

          const [organization] = await tx
            .insert(organizations)
            .values({
              name: input.organization.name,
              timezone: input.organization.timezone,
              productName: input.branding?.productName ?? null,
              brandColor: input.branding?.primaryColor ?? null,
            })
            .returning();
          if (!organization) throw new Error('Organisasi tidak tersimpan');

          const [owner] = await tx
            .insert(users)
            .values({
              organizationId: organization.id,
              email: input.owner.email,
              name: input.owner.name,
              passwordHash,
              role: 'owner',
              lastLoginAt: sql`now()`,
            })
            .returning();
          if (!owner) throw new Error('Owner tidak tersimpan');

          // Pengunci tingkat database: baris kedua mustahil ada (primary key satu nilai).
          await tx.insert(installation).values({ organizationId: organization.id });

          if (logo) {
            await tx.insert(organizationLogos).values({
              organizationId: organization.id,
              contentType: logo.contentType,
              data: logo.data,
              byteSize: logo.data.length,
              sha256: logo.sha256,
            });
          }
          if (preparedEmail) {
            await tx.insert(emailSettingsTable).values({
              organizationId: organization.id,
              ...emailSettings.toValues(organization.id, preparedEmail, undefined),
              ...(lastEmailTest
                ? {
                    lastTestOk: lastEmailTest.ok,
                    lastTestCode: lastEmailTest.code,
                    lastTestedAt: lastEmailTest.testedAt,
                  }
                : {}),
              updatedByUserId: owner.id,
            });
          }

          await recordAudit(tx, {
            organizationId: organization.id,
            actorUserId: owner.id,
            action: AUDIT_ACTIONS.setupCompleted,
            targetType: 'organization',
            targetId: organization.id,
            metadata: {
              timezone: organization.timezone,
              productNameSet: organization.productName !== null,
              brandColorSet: organization.brandColor !== null,
              logoUploaded: logo !== undefined,
              emailConfigured: preparedEmail !== undefined,
              emailTested: lastEmailTest !== undefined,
            },
            client: context.client,
          });

          const issued = await sessions.issue(tx, {
            user: { id: owner.id, name: owner.name, email: owner.email, role: owner.role },
            organization: {
              id: organization.id,
              name: organization.name,
              timezone: organization.timezone,
            },
            client: context.client,
          });
          await recordAudit(tx, {
            organizationId: organization.id,
            actorUserId: owner.id,
            action: AUDIT_ACTIONS.loginSucceeded,
            targetType: 'session',
            targetId: issued.auth.sessionRef,
            metadata: { via: 'setup' },
            client: context.client,
          });
          return issued;
        });
      } catch (error) {
        if (isPgError(error, PG_ERROR_CODES.uniqueViolation, 'installation_pkey')) {
          throw alreadyCompleted(error);
        }
        throw error;
      }
    },
  };
}
