/**
 * Perlengkapan tes integrasi API: aplikasi sungguhan di atas Postgres + Redis sungguhan.
 *
 * - Tiap berkas tes membuat database sementara SENDIRI (dimigrasi dari nol): wizard setup dan
 *   login bergantung pada "organisasi milik instalasi", yang hanya boleh ada satu per database.
 * - Kunci Redis memakai awalan acak per berkas dan dihapus di akhir.
 * - Bila Postgres/Redis mati, tes GAGAL dengan pesan jelas (tidak dilewati diam-diam).
 * - Owner/Admin/Supervisor wajib 2FA: `completeSetup` dan `login` otomatis mendaftarkan 2FA
 *   (atau menjawab langkah kedua dengan kode TOTP yang dihitung dari rahasia yang tercatat),
 *   jadi tes yang tidak sedang menguji 2FA tetap mendapat sesi penuh. Tes 2FA memakai
 *   `completeSetupWithoutTwoFactor`, `startLogin`, dan panggilan langsung.
 */
import { randomBytes } from 'node:crypto';

import {
  closeRedis,
  generateTotp,
  Secret,
  type AccountLockedEmailPayload,
  type Redis,
  type SecurityNoticeEmailPayload,
} from '@balesin/core';
import {
  connectTestRedis,
  createLogCapture,
  deleteRedisKeys,
  TEST_MAIL,
} from '@balesin/core/testing';
import { closeDb, createDb, users, type Database } from '@balesin/db';
import { createTemporaryDatabase, type TemporaryDatabase } from '@balesin/db/testing';
import {
  API_ROUTES,
  CSRF_HEADER_NAME,
  authenticatedSessionSchema,
  confirmTwoFactorEnrollmentResponseSchema,
  loginResponseSchema,
  meResponseSchema,
  startTwoFactorEnrollmentResponseSchema,
  verifyTwoFactorResponseSchema,
  type AuthenticatedSession,
  type CompleteSetupRequest,
  type EmailSettingsInput,
  type LoginResponse,
  type MeResponse,
} from '@balesin/shared';
import { eq } from 'drizzle-orm';
import { inject } from 'vitest';

import type { App, AppConfig, AppDeps } from '../app';
import { sessionCookieName } from '../http/cookies';
import type { EmailNotifier } from '../queues/email-queue';
import type { OutboundMessageEnqueuer } from '../queues/message-queue';
import type { NotificationEnqueuer } from '../queues/notification-queue';
import type { WebhookEventEnqueuer } from '../queues/webhook-queue';
import { buildTestApp, defaultTestConfig, TEST_APP_ORIGIN, type TestApp } from './build-test-app';

export const TEST_SETUP_TOKEN = 'token-setup-khusus-tes-0123456789';
export const TEST_MASTER_KEY = randomBytes(32);

export const OWNER = {
  name: 'Sari Wulandari',
  email: 'sari@majujaya.test',
  password: 'kopi-tubruk-gerimis-senja',
} as const;

export interface IntegrationHarness extends TestApp {
  db: Database;
  redis: Redis;
  database: TemporaryDatabase;
  /** Pemberitahuan keamanan (2FA, kode cadangan) yang diantrekan. */
  readonly securityNotices: SecurityNoticeEmailPayload[];
  /** Awalan kunci Redis berkas tes ini (batas laju + channel event inbox `<awalan>:inbox-events`). */
  readonly redisPrefix: string;
  /** Mengosongkan database, kunci batas laju, antrean notifikasi, dan log. */
  reset(): Promise<void>;
  /** Membangun ulang aplikasi di atas database/Redis yang sama dengan konfigurasi lain. */
  rebuild(options?: HarnessOptions): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  config?: Partial<AppConfig>;
  overrides?: AppDeps['overrides'];
  /** Pengganti pengantre notifikasi (bawaan: mencatat ke `lockedNotifications`). */
  notifier?: EmailNotifier;
  /** Pengganti pengantre kejadian webhook (bawaan: mencatat ke `webhookJobs`). */
  webhookQueue?: WebhookEventEnqueuer;
  /** Pengganti pengantre pesan keluar (bawaan: mencatat ke `messageJobs`). */
  messageQueue?: OutboundMessageEnqueuer;
  /** Pengganti pengantre notifikasi (bawaan: mencatat ke `notificationJobs`). */
  notificationQueue?: NotificationEnqueuer;
  /** `false` = Redis yang tidak pernah tersambung (menguji perilaku saat Redis mati). */
  redis?: false;
}

export function integrationConfig(): AppConfig {
  return {
    ...defaultTestConfig(),
    setupToken: new Secret(TEST_SETUP_TOKEN),
    masterKey: new Secret(TEST_MASTER_KEY),
  };
}

export async function createIntegrationHarness(
  options: HarnessOptions = {},
): Promise<IntegrationHarness> {
  // Disalin dari template yang sudah dimigrasi (global setup) — tanpa menjalankan ulang migrasi.
  const database = await createTemporaryDatabase(inject('testDatabaseBaseUrl'), {
    template: inject('testDatabaseTemplate'),
  });
  const db = createDb(database.url, { applicationName: 'balesin-test-api' });
  const rateLimitPrefix = `balesin-tes-${randomBytes(6).toString('hex')}`;

  let built: TestApp | undefined;
  let redis: Redis | undefined;

  activeDb = db;
  const harness = {
    db,
    database,
    async rebuild(next: HarnessOptions = {}) {
      await built?.app.close();
      if (!redis) {
        // Log koneksi Redis tidak perlu ikut diperiksa tes; yang diperiksa log aplikasi.
        redis = await connectTestRedis(
          'client',
          createLogCapture('silent').logger,
          'balesin-tes-api',
        );
      }
      built = await buildTestApp({
        config: { ...integrationConfig(), ...next.config },
        db,
        redis: next.redis === false ? undefined : redis,
        notifier: next.notifier,
        webhookQueue: next.webhookQueue,
        messageQueue: next.messageQueue,
        notificationQueue: next.notificationQueue,
        overrides: { rateLimitPrefix, ...next.overrides },
      });
    },
    async reset() {
      await database.reset();
      if (redis) await deleteRedisKeys(redis, rateLimitPrefix);
      totpSecrets.clear();
      knownPasswords.clear();
      if (built) {
        await built.app.backgroundTasks.drain();
        built.lockedNotifications.length = 0;
        built.securityNotices.length = 0;
        built.adminNotices.length = 0;
        built.invitationJobs.length = 0;
        built.accountTokenJobs.length = 0;
        built.emailSettingsNotices.length = 0;
        built.channelChangeNotices.length = 0;
        built.webhookJobs.length = 0;
        built.messageJobs.length = 0;
        built.notificationJobs.length = 0;
        built.logs.lines.length = 0;
      }
    },
    async close() {
      await built?.app.close();
      if (redis) {
        await deleteRedisKeys(redis, rateLimitPrefix);
        await closeRedis(redis);
      }
      await closeDb(db);
      // Dilepas, bukan di-DROP: `DROP DATABASE` memaksa checkpoint Postgres yang bisa antre > 30 dtk
      // saat banyak berkas tes berjalan paralel. Dihapus teardown global (lihat `release`).
      await database.release();
    },
    get app(): App {
      if (!built) throw new Error('Aplikasi tes belum dibangun');
      return built.app;
    },
    get logs() {
      if (!built) throw new Error('Aplikasi tes belum dibangun');
      return built.logs;
    },
    get lockedNotifications(): AccountLockedEmailPayload[] {
      if (!built) throw new Error('Aplikasi tes belum dibangun');
      return built.lockedNotifications;
    },
    get securityNotices(): SecurityNoticeEmailPayload[] {
      if (!built) throw new Error('Aplikasi tes belum dibangun');
      return built.securityNotices;
    },
    get adminNotices() {
      if (!built) throw new Error('Aplikasi tes belum dibangun');
      return built.adminNotices;
    },
    get invitationJobs() {
      if (!built) throw new Error('Aplikasi tes belum dibangun');
      return built.invitationJobs;
    },
    get accountTokenJobs() {
      if (!built) throw new Error('Aplikasi tes belum dibangun');
      return built.accountTokenJobs;
    },
    get emailSettingsNotices() {
      if (!built) throw new Error('Aplikasi tes belum dibangun');
      return built.emailSettingsNotices;
    },
    get channelChangeNotices() {
      if (!built) throw new Error('Aplikasi tes belum dibangun');
      return built.channelChangeNotices;
    },
    get webhookJobs() {
      if (!built) throw new Error('Aplikasi tes belum dibangun');
      return built.webhookJobs;
    },
    get messageJobs() {
      if (!built) throw new Error('Aplikasi tes belum dibangun');
      return built.messageJobs;
    },
    get notificationJobs() {
      if (!built) throw new Error('Aplikasi tes belum dibangun');
      return built.notificationJobs;
    },
    get redis(): Redis {
      if (!redis) throw new Error('Redis tes belum tersambung');
      return redis;
    },
    redisPrefix: rateLimitPrefix,
  };

  try {
    await harness.rebuild(options);
  } catch (error) {
    await closeDb(db);
    await database.drop();
    throw error;
  }
  return harness;
}

// ── Permintaan seperti dari browser ─────────────────────────────────────────

export interface CallOptions {
  /** Nilai header `Cookie` (hasil `sessionCookieOf`). */
  cookie?: string;
  /** Token CSRF sesi; dikirim di header `X-CSRF-Token`. */
  csrf?: string;
  /** Header `Origin`. Bawaan origin aplikasi (seperti browser); `null` = tidak dikirim. */
  origin?: string | null;
  /** Alamat IP klien. */
  ip?: string;
  headers?: Record<string, string>;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export function call(
  app: App,
  method: Method,
  url: string,
  body?: unknown,
  options: CallOptions = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  const origin = options.origin === undefined ? TEST_APP_ORIGIN : options.origin;
  if (origin !== null) headers.origin = origin;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.csrf) headers[CSRF_HEADER_NAME] = options.csrf;
  return app.inject({
    method,
    url,
    headers,
    ...(body === undefined ? {} : { payload: body as object }),
    ...(options.ip ? { remoteAddress: options.ip } : {}),
  });
}

type InjectResponse = Awaited<ReturnType<typeof call>>;

/** Semua nilai header `Set-Cookie` dari sebuah respons. */
export function setCookies(response: InjectResponse): string[] {
  const header = response.headers['set-cookie'];
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [String(header)];
}

/** `nama=nilai` cookie sesi dari respons (untuk dikirim balik lewat `CallOptions.cookie`). */
export function sessionCookieOf(response: InjectResponse, secure = false): string {
  const name = sessionCookieName(secure);
  const cookie = setCookies(response).find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error('Respons tidak memasang cookie sesi');
  const pair = cookie.split(';')[0] ?? '';
  if (pair === `${name}=`) throw new Error('Cookie sesi dikosongkan, bukan dipasang');
  return pair;
}

export interface SignedIn {
  cookie: string;
  csrf: string;
  session: AuthenticatedSession;
}

/** Sesi TERBATAS "wajib mendaftar 2FA" (setup, atau login peran wajib 2FA yang belum mendaftar). */
export interface EnrollmentSignedIn {
  cookie: string;
  csrf: string;
  session: MeResponse;
}

/** Sesi penuh setelah 2FA baru diaktifkan: + rahasia TOTP dan kode cadangan. */
export interface SignedInWithTwoFactor extends SignedIn {
  totpSecret: string;
  backupCodes: string[];
}

// ── 2FA di tes ──────────────────────────────────────────────────────────────
//
// Rahasia TOTP pengguna yang didaftarkan lewat helper dicatat di sini (per berkas tes; dihapus
// `reset`) supaya `login` bisa menjawab langkah kedua. Kode yang sama tidak boleh dipakai dua kali
// dalam 30 detik (cegah replay), sedangkan tes sering masuk berkali-kali dalam hitungan detik:
// sebelum menjawab, helper mengosongkan `totp_last_used_step` pengguna itu. Perilaku replay yang
// sesungguhnya diuji langsung di `two-factor.integration.test.ts` tanpa helper ini.

const totpSecrets = new Map<string, string>();
/** Password pengguna yang pernah masuk/setup lewat helper (untuk `confirmationOf`). */
const knownPasswords = new Map<string, string>();
let activeDb: Database | undefined;

/** Rahasia TOTP yang tercatat untuk email ini (didaftarkan lewat helper). */
export function totpSecretOf(email: string): string {
  const secret = totpSecrets.get(email);
  if (!secret) throw new Error(`Belum ada rahasia TOTP tercatat untuk ${email}`);
  return secret;
}

/** Kode TOTP saat ini untuk pengguna yang didaftarkan lewat helper, siap dipakai ulang di tes. */
export async function freshTotpCode(email: string): Promise<string> {
  const secret = totpSecretOf(email);
  if (activeDb) {
    await activeDb.update(users).set({ totpLastUsedStep: null }).where(eq(users.email, email));
  }
  return generateTotp(secret);
}

/**
 * Konfirmasi ulang identitas (`{ password, code }`) untuk pengguna yang 2FA-nya didaftarkan lewat
 * helper — dipakai body aksi yang wajib konfirmasi (undangan, email pengirim, channel, …).
 */
export async function confirmationFor(
  credentials: { email: string; password: string } = OWNER,
): Promise<{ password: string; code?: string }> {
  return totpSecrets.has(credentials.email)
    ? { password: credentials.password, code: await freshTotpCode(credentials.email) }
    : { password: credentials.password };
}

/** Konfirmasi identitas milik pemegang sesi `signed` (password dicatat saat masuk lewat helper). */
export async function confirmationOf(signed: {
  session: { user: { email: string } };
}): Promise<{ password: string; code?: string }> {
  const email = signed.session.user.email;
  const password = knownPasswords.get(email);
  if (password === undefined) throw new Error(`Password ${email} tidak tercatat di helper tes`);
  return confirmationFor({ email, password });
}

/** `body` + `confirmation` pemegang sesi `signed`. */
export async function withConfirmation<T extends object>(
  signed: { session: { user: { email: string } } },
  body: T,
): Promise<T & { confirmation: { password: string; code?: string } }> {
  return { ...body, confirmation: await confirmationOf(signed) };
}

function enrollmentSignedIn(response: InjectResponse): EnrollmentSignedIn {
  const session = meResponseSchema.parse(response.json());
  return { cookie: sessionCookieOf(response), csrf: session.csrfToken, session };
}

/** Mendaftarkan 2FA dari sebuah sesi (terbatas atau penuh) dan mengembalikan sesi penuh baru. */
export async function enrollTwoFactor(
  app: App,
  signed: { cookie: string; csrf: string; session: { user: { email: string } } },
  options: CallOptions & { password?: string } = {},
): Promise<SignedInWithTwoFactor> {
  const { password, ...callOptions } = options;
  const start = await call(
    app,
    'POST',
    API_ROUTES.twoFactor.enroll,
    password === undefined ? {} : { password },
    { ...callOptions, cookie: signed.cookie, csrf: signed.csrf },
  );
  if (start.statusCode !== 200) {
    throw new Error(`Mulai daftar 2FA gagal (${start.statusCode}): ${start.body}`);
  }
  const { secret } = startTwoFactorEnrollmentResponseSchema.parse(start.json());
  const confirm = await call(
    app,
    'POST',
    API_ROUTES.twoFactor.confirmEnrollment,
    { code: generateTotp(secret) },
    { ...callOptions, cookie: signed.cookie, csrf: signed.csrf },
  );
  if (confirm.statusCode !== 200) {
    throw new Error(`Konfirmasi 2FA gagal (${confirm.statusCode}): ${confirm.body}`);
  }
  const body = confirmTwoFactorEnrollmentResponseSchema.parse(confirm.json());
  totpSecrets.set(signed.session.user.email, secret);
  return {
    cookie: sessionCookieOf(confirm),
    csrf: body.csrfToken,
    session: authenticatedSessionSchema.parse(body),
    totpSecret: secret,
    backupCodes: body.backupCodes.codes,
  };
}

export function setupBody(overrides: Partial<CompleteSetupRequest> = {}): CompleteSetupRequest {
  return {
    setupToken: TEST_SETUP_TOKEN,
    owner: { ...OWNER },
    organization: { name: 'PT Maju Jaya Abadi', timezone: 'Asia/Jakarta' },
    ...overrides,
  };
}

/** Menyelesaikan wizard setup TANPA mendaftar 2FA: sesi terbatas Owner. */
export async function completeSetupWithoutTwoFactor(
  app: App,
  overrides: Partial<CompleteSetupRequest> = {},
): Promise<EnrollmentSignedIn> {
  const owner = setupBody(overrides).owner;
  knownPasswords.set(owner.email, owner.password);
  const response = await call(app, 'POST', API_ROUTES.setup.complete, setupBody(overrides));
  if (response.statusCode !== 201) {
    throw new Error(`Setup gagal (${response.statusCode}): ${response.body}`);
  }
  return enrollmentSignedIn(response);
}

/** Menyelesaikan wizard setup lalu mendaftarkan 2FA Owner: sesi penuh Owner. */
export async function completeSetup(
  app: App,
  overrides: Partial<CompleteSetupRequest> = {},
): Promise<SignedInWithTwoFactor> {
  return enrollTwoFactor(app, await completeSetupWithoutTwoFactor(app, overrides));
}

/** Hanya langkah password (`POST /auth/login`) — untuk tes yang memeriksa langkah berikutnya. */
export async function startLogin(
  app: App,
  credentials: { email: string; password: string } = OWNER,
  options: CallOptions = {},
): Promise<{ response: InjectResponse; body: LoginResponse }> {
  const response = await call(
    app,
    'POST',
    API_ROUTES.auth.login,
    { email: credentials.email, password: credentials.password },
    options,
  );
  if (response.statusCode !== 200) {
    throw new Error(`Login gagal (${response.statusCode}): ${response.body}`);
  }
  return { response, body: loginResponseSchema.parse(response.json()) };
}

/**
 * Masuk sebagai pengguna yang 2FA-nya aktif (rahasia tercatat): password lalu langkah kedua.
 * Mengembalikan respons TERAKHIR (`POST /auth/2fa/verify`), yang memasang cookie sesi dan cookie
 * perangkat dikenal. Untuk pengguna tanpa 2FA, respons login itu sendiri.
 */
export async function loginResponse(
  app: App,
  credentials: { email: string; password: string } = OWNER,
  options: CallOptions = {},
): Promise<InjectResponse> {
  knownPasswords.set(credentials.email, credentials.password);
  const { response, body } = await startLogin(app, credentials, options);
  if (body.status !== 'two_factor_required') return response;
  const verify = await call(
    app,
    'POST',
    API_ROUTES.twoFactor.verify,
    { challengeToken: body.challengeToken, code: await freshTotpCode(credentials.email) },
    options,
  );
  if (verify.statusCode !== 200) {
    throw new Error(`Langkah kedua gagal (${verify.statusCode}): ${verify.body}`);
  }
  return verify;
}

/**
 * Masuk sampai mendapat sesi PENUH: menjawab langkah kedua dengan kode TOTP pengguna (rahasia
 * yang tercatat), atau mendaftarkan 2FA bila perannya wajib dan belum punya.
 */
export async function login(
  app: App,
  credentials: { email: string; password: string } = OWNER,
  options: CallOptions = {},
): Promise<SignedIn> {
  const response = await loginResponse(app, credentials, options);
  const body = loginResponseSchema.or(verifyTwoFactorResponseSchema).parse(response.json());
  if (body.status === 'two_factor_enrollment_required') {
    return enrollTwoFactor(app, enrollmentSignedIn(response), options);
  }
  if (body.status !== 'authenticated') throw new Error('Login tidak selesai');
  return {
    cookie: sessionCookieOf(response),
    csrf: body.csrfToken,
    session: authenticatedSessionSchema.parse(body),
  };
}

/** `nama=nilai` cookie perangkat dikenal dari respons yang menyelesaikan login. */
export function deviceCookieOf(response: InjectResponse, secure = false): string {
  const name = secure ? '__Host-balesin_device' : 'balesin_device';
  const cookie = setCookies(response).find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error('Respons tidak memasang cookie perangkat');
  return cookie.split(';')[0] ?? '';
}

/** Pengaturan email yang menunjuk penangkap email lokal (Mailpit). */
export function mailpitSettings(overrides: Partial<EmailSettingsInput> = {}): EmailSettingsInput {
  return {
    fromName: 'Balesin Maju Jaya',
    fromAddress: 'cs@majujaya.test',
    replyTo: null,
    host: TEST_MAIL.host,
    port: TEST_MAIL.smtpPort,
    security: 'none',
    username: TEST_MAIL.username,
    password: TEST_MAIL.password,
    ...overrides,
  };
}
