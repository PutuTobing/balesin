import {
  Secret,
  type AccountLockedEmailPayload,
  type SecurityNoticeEmailPayload,
} from '@balesin/core';
import { createLogCapture, type LogCapture } from '@balesin/core/testing';
import { createDb, type Database } from '@balesin/db';
import { SMTP_ALLOWED_PORTS } from '@balesin/shared';
import { Redis } from 'ioredis';

import { buildApp, type App, type AppConfig, type AppDeps } from '../app';
import type { ReadinessProbes } from '../modules/health/health.service';
import type { EmailNotifier } from '../queues/email-queue';

export const TEST_APP_ORIGIN = 'http://localhost:5173';
export const TEST_SESSION_SECRET = 'rahasia-sesi-khusus-tes-minimal-32-karakter';

export interface TestAppOptions {
  config?: Partial<AppConfig>;
  readinessProbes?: Partial<ReadinessProbes>;
  readinessTimeoutMs?: number;
  /** Database sungguhan (tes integrasi). Bawaan: klien yang tidak pernah tersambung. */
  db?: Database;
  /** Redis sungguhan (tes integrasi). Bawaan: klien yang tidak pernah tersambung. */
  redis?: Redis;
  notifier?: EmailNotifier;
  overrides?: AppDeps['overrides'];
}

export interface TestApp {
  app: App;
  /** Semua log yang ditulis aplikasi (sudah melewati redaksi, sama seperti di produksi). */
  logs: LogCapture;
  /** Pemberitahuan "akun dikunci" yang diantrekan (bila `notifier` tidak diganti). */
  lockedNotifications: AccountLockedEmailPayload[];
  /** Pemberitahuan keamanan (2FA, kode cadangan) yang diantrekan (bila `notifier` tidak diganti). */
  securityNotices: SecurityNoticeEmailPayload[];
}

const healthy = () => Promise.resolve();

export function defaultTestConfig(): AppConfig {
  return {
    appOrigin: TEST_APP_ORIGIN,
    isProduction: false,
    trustProxy: false,
    cookieSecure: false,
    sessionSecret: new Secret(TEST_SESSION_SECRET),
    setupToken: null,
    masterKey: null,
    smtpFallback: null,
    smtpAllowedPorts: [...SMTP_ALLOWED_PORTS, 1025],
  };
}

/**
 * Klien database dan Redis yang TIDAK PERNAH tersambung (alamatnya port 1): cukup untuk tes
 * yang hanya menguji lapisan HTTP. Tes yang ternyata menyentuh database/Redis langsung gagal,
 * tidak diam-diam memakai layanan sungguhan.
 */
function unreachableDb(): Database {
  return createDb('postgres://tidak-dipakai:tidak-dipakai@127.0.0.1:1/tidak_dipakai');
}

function unreachableRedis(): Redis {
  return new Redis({
    host: '127.0.0.1',
    port: 1,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
}

/**
 * Aplikasi untuk tes `app.inject()`: log ditangkap di memori; database dan Redis palsu kecuali
 * diberikan lewat `options` (lihat `testing/integration.ts` untuk tes integrasi). Rute khusus
 * tes boleh ditambahkan sebelum request pertama — wajib menyatakan aksesnya (`TEST_ROUTE`).
 */
export async function buildTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const logs = createLogCapture();
  const lockedNotifications: AccountLockedEmailPayload[] = [];
  const securityNotices: SecurityNoticeEmailPayload[] = [];
  const redis = options.redis ?? unreachableRedis();
  // ioredis memancarkan `error` saat gagal tersambung; tanpa listener itu menjadi galat tak tertangani.
  if (!options.redis) redis.on('error', () => undefined);

  const app = await buildApp({
    config: { ...defaultTestConfig(), ...options.config },
    logger: logs.logger,
    readinessProbes: { postgres: healthy, redis: healthy, ...options.readinessProbes },
    readinessTimeoutMs: options.readinessTimeoutMs,
    db: options.db ?? unreachableDb(),
    redis,
    notifier: options.notifier ?? {
      accountLocked: (payload) => {
        lockedNotifications.push(payload);
        return Promise.resolve();
      },
      securityNotice: (payload) => {
        securityNotices.push(payload);
        return Promise.resolve();
      },
    },
    overrides: options.overrides,
  });
  return { app, logs, lockedNotifications, securityNotices };
}

/**
 * Opsi untuk rute contoh di dalam tes: publik dan tanpa kewajiban skema respons. Rute aplikasi
 * sungguhan tidak boleh memakai ini — nyatakan akses dan skema responsnya sendiri.
 */
export const TEST_ROUTE = { config: { access: { kind: 'public' }, rawResponse: true } } as const;
