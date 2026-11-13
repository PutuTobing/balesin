/**
 * Perlengkapan tes integrasi API: aplikasi sungguhan di atas Postgres + Redis sungguhan.
 *
 * - Tiap berkas tes membuat database sementara SENDIRI (dimigrasi dari nol): wizard setup dan
 *   login bergantung pada "organisasi milik instalasi", yang hanya boleh ada satu per database.
 * - Kunci Redis memakai awalan acak per berkas dan dihapus di akhir.
 * - Bila Postgres/Redis mati, tes GAGAL dengan pesan jelas (tidak dilewati diam-diam).
 */
import { randomBytes } from 'node:crypto';

import { closeRedis, Secret, type AccountLockedEmailPayload, type Redis } from '@balesin/core';
import {
  connectTestRedis,
  createLogCapture,
  deleteRedisKeys,
  TEST_MAIL,
} from '@balesin/core/testing';
import { closeDb, createDb, type Database } from '@balesin/db';
import { createTemporaryDatabase, type TemporaryDatabase } from '@balesin/db/testing';
import {
  API_ROUTES,
  CSRF_HEADER_NAME,
  authenticatedSessionSchema,
  type AuthenticatedSession,
  type CompleteSetupRequest,
  type EmailSettingsInput,
} from '@balesin/shared';
import { inject } from 'vitest';

import type { App, AppConfig, AppDeps } from '../app';
import { sessionCookieName } from '../http/cookies';
import type { EmailNotifier } from '../queues/email-queue';
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
  const database = await createTemporaryDatabase(inject('testDatabaseBaseUrl'));
  const db = createDb(database.url, { applicationName: 'balesin-test-api' });
  const rateLimitPrefix = `balesin-tes-${randomBytes(6).toString('hex')}`;

  let built: TestApp | undefined;
  let redis: Redis | undefined;

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
        overrides: { rateLimitPrefix, ...next.overrides },
      });
    },
    async reset() {
      await database.reset();
      if (redis) await deleteRedisKeys(redis, rateLimitPrefix);
      if (built) {
        built.lockedNotifications.length = 0;
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
      await database.drop();
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
    get redis(): Redis {
      if (!redis) throw new Error('Redis tes belum tersambung');
      return redis;
    },
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

function signedIn(response: InjectResponse): SignedIn {
  const session = authenticatedSessionSchema.parse(response.json());
  return { cookie: sessionCookieOf(response), csrf: session.csrfToken, session };
}

export function setupBody(overrides: Partial<CompleteSetupRequest> = {}): CompleteSetupRequest {
  return {
    setupToken: TEST_SETUP_TOKEN,
    owner: { ...OWNER },
    organization: { name: 'PT Maju Jaya Abadi', timezone: 'Asia/Jakarta' },
    ...overrides,
  };
}

/** Menyelesaikan wizard setup dan mengembalikan sesi Owner. */
export async function completeSetup(
  app: App,
  overrides: Partial<CompleteSetupRequest> = {},
): Promise<SignedIn> {
  const response = await call(app, 'POST', API_ROUTES.setup.complete, setupBody(overrides));
  if (response.statusCode !== 201) {
    throw new Error(`Setup gagal (${response.statusCode}): ${response.body}`);
  }
  return signedIn(response);
}

export async function login(
  app: App,
  credentials: { email: string; password: string } = OWNER,
  options: CallOptions = {},
): Promise<SignedIn> {
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
  return signedIn(response);
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
