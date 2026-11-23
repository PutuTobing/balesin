import {
  DEFAULT_META_GRAPH_VERSION,
  Secret,
  type AccountLockedEmailPayload,
  type AccountTokenEmailPayload,
  type ChannelChangedEmailPayload,
  type EmailSettingsChangedEmailPayload,
  type InvitationEmailPayload,
  type SecurityNoticeAdminEmailPayload,
  type SecurityNoticeEmailPayload,
  type NotificationJobPayload,
  type SendMessageJobPayload,
  type WebhookEventJobPayload,
} from '@balesin/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogCapture, type LogCapture } from '@balesin/core/testing';
import { createDb, type Database } from '@balesin/db';
import { SMTP_ALLOWED_PORTS } from '@balesin/shared';
import { Redis } from 'ioredis';

import { buildApp, type App, type AppConfig, type AppDeps } from '../app';
import type { ReadinessProbes } from '../modules/health/health.service';
import type { EmailNotifier } from '../queues/email-queue';
import type { OutboundMessageEnqueuer } from '../queues/message-queue';
import type { NotificationEnqueuer } from '../queues/notification-queue';
import type { WebhookEventEnqueuer } from '../queues/webhook-queue';

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
  /** Pengganti pengantre kejadian webhook (bawaan: mencatat ke `webhookJobs`). */
  webhookQueue?: WebhookEventEnqueuer;
  /** Pengganti pengantre pesan keluar (bawaan: mencatat ke `messageJobs`). */
  messageQueue?: OutboundMessageEnqueuer;
  /** Pengganti pengantre notifikasi (bawaan: mencatat ke `notificationJobs`). */
  notificationQueue?: NotificationEnqueuer;
  /** Fase 9: antrean modul Email (bawaan: tidak ada — worker memakai jadwalnya). */
  mailQueue?: AppDeps['mailQueue'];
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
  /** Pemberitahuan 2FA peran wajib ke Owner/Admin lain. */
  adminNotices: SecurityNoticeAdminEmailPayload[];
  /** Job email undangan. */
  invitationJobs: InvitationEmailPayload[];
  /** Job email atur ulang password / verifikasi email. */
  accountTokenJobs: AccountTokenEmailPayload[];
  /** Pemberitahuan ke Owner: email pengirim diubah pengguna lain. */
  emailSettingsNotices: EmailSettingsChangedEmailPayload[];
  /** Pemberitahuan ke Owner: channel diubah pengguna selain Owner. */
  channelChangeNotices: ChannelChangedEmailPayload[];
  /** Job kejadian webhook masuk yang diantrekan (bila `webhookQueue` tidak diganti). */
  webhookJobs: WebhookEventJobPayload[];
  /** Job pesan keluar yang diantrekan (bila `messageQueue` tidak diganti). */
  messageJobs: Array<SendMessageJobPayload & { attempt: number }>;
  /** Job notifikasi yang diantrekan (bila `notificationQueue` tidak diganti). */
  notificationJobs: NotificationJobPayload[];
}

const healthy = () => Promise.resolve();

/**
 * Tes TIDAK PERNAH memanggil Meta sungguhan (kredensial belum ada; BUTUH-TOBING #3): hanya server
 * tiruan di 127.0.0.1 yang boleh dituju. Selain itu permintaan gagal seperti jaringan putus.
 */
const offlineMetaFetch: typeof fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    return Promise.reject(new TypeError('Tes tidak boleh memanggil Graph API Meta sungguhan'));
  }
  return fetch(input, init);
};

export function defaultTestConfig(): AppConfig {
  return {
    appUrl: TEST_APP_ORIGIN,
    appOrigin: TEST_APP_ORIGIN,
    isProduction: false,
    trustProxy: false,
    cookieSecure: false,
    sessionSecret: new Secret(TEST_SESSION_SECRET),
    setupToken: null,
    masterKey: null,
    smtpFallback: null,
    smtpAllowedPorts: [...SMTP_ALLOWED_PORTS, 1025],
    apiUrl: 'http://localhost:3000',
    metaGraphVersion: DEFAULT_META_GRAPH_VERSION,
    // Tes memakai server Meta tiruan (`testing/fake-meta.ts`) bila perlu; panggilan lain diblokir
    // `offlineMetaFetch` di bawah.
    metaGraphBaseUrl: null,
    // Folder media per proses tes (dibuat saat dipakai; tidak pernah folder proyek).
    mediaDir: join(tmpdir(), `balesin-tes-media-${String(process.pid)}`),
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
  const adminNotices: SecurityNoticeAdminEmailPayload[] = [];
  const invitationJobs: InvitationEmailPayload[] = [];
  const accountTokenJobs: AccountTokenEmailPayload[] = [];
  const emailSettingsNotices: EmailSettingsChangedEmailPayload[] = [];
  const channelChangeNotices: ChannelChangedEmailPayload[] = [];
  const webhookJobs: WebhookEventJobPayload[] = [];
  const messageJobs: Array<SendMessageJobPayload & { attempt: number }> = [];
  const notificationJobs: NotificationJobPayload[] = [];
  const record =
    <T>(list: T[]) =>
    (payload: T) => {
      list.push(payload);
      return Promise.resolve();
    };
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
      accountLocked: record(lockedNotifications),
      securityNotice: record(securityNotices),
      securityNoticeAdmin: record(adminNotices),
      invitation: record(invitationJobs),
      accountToken: record(accountTokenJobs),
      emailSettingsChanged: record(emailSettingsNotices),
      channelChanged: record(channelChangeNotices),
    },
    webhookQueue: options.webhookQueue ?? {
      enqueue: (events) => {
        webhookJobs.push(...events);
        return Promise.resolve();
      },
    },
    messageQueue: options.messageQueue ?? {
      enqueue: (job, attempt) => {
        messageJobs.push({ ...job, attempt });
        return Promise.resolve();
      },
    },
    notificationQueue: options.notificationQueue ?? { enqueue: record(notificationJobs) },
    ...(options.mailQueue ? { mailQueue: options.mailQueue } : {}),
    overrides: {
      ...options.overrides,
      meta: { fetch: offlineMetaFetch, ...options.overrides?.meta },
    },
  });
  return {
    app,
    logs,
    lockedNotifications,
    securityNotices,
    adminNotices,
    invitationJobs,
    accountTokenJobs,
    emailSettingsNotices,
    channelChangeNotices,
    webhookJobs,
    messageJobs,
    notificationJobs,
  };
}

/**
 * Opsi untuk rute contoh di dalam tes: publik dan tanpa kewajiban skema respons. Rute aplikasi
 * sungguhan tidak boleh memakai ini — nyatakan akses dan skema responsnya sendiri.
 */
export const TEST_ROUTE = { config: { access: { kind: 'public' }, rawResponse: true } } as const;
