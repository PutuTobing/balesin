import {
  channelTestOverridesFromEnv,
  closeRedis,
  createInboxEventPublisher,
  createLogger,
  createMediaStore,
  createMetaGraphClient,
  createTelegramBotClient,
  createRedis,
  createSecretBox,
  createShutdown,
  plaintextLoginPolicy,
  EnvValidationError,
  registerCrashHandlers,
  registerShutdownSignals,
  scrubSecretsInText,
} from '@balesin/core';
import { closeDb, createDb } from '@balesin/db';
import { IMAP_ALLOWED_PORTS } from '@balesin/shared';

import { loadConfig, type WorkerConfig } from './config';
import { createNotificationProducer, redisThrottle } from './queues/notifications';
import { createOwnerNotifier } from './queues/webhooks-out';
import { startWorkers } from './runtime';

/** Titik masuk proses worker: baca konfigurasi → sambungkan Redis dan Postgres → proses antrian. */
function main(config: WorkerConfig): void {
  const logger = createLogger({
    service: 'worker',
    level: config.logLevel,
    pretty: config.env === 'development',
  });

  if (!config.masterKey) {
    logger.warn(
      'BALESIN_MASTER_KEY kosong: kredensial tersimpan (mis. password SMTP) tidak bisa dibuka, email yang membutuhkannya akan gagal.',
    );
  }

  const redis = createRedis(config.redisUrl.reveal(), {
    role: 'queue',
    name: 'balesin-worker',
    logger,
  });
  const db = createDb(config.databaseUrl.reveal(), {
    applicationName: 'balesin-worker',
    onPoolError: (err) => logger.error({ err }, 'Koneksi Postgres yang menganggur terputus'),
  });
  const secretBox = config.masterKey ? createSecretBox(config.masterKey) : null;
  const publisher = createInboxEventPublisher(redis, { logger });
  // Klien Graph API terpusat (host tetap, versi terkunci, server tiruan hanya dev/test).
  const meta = createMetaGraphClient({
    version: config.metaGraphVersion,
    baseUrl: config.metaGraphBaseUrl,
    logger,
  });
  const notificationProducer = createNotificationProducer({ connection: redis }, logger);
  // Fase 6: klien Bot API Telegram (host tetap) + media store bersama api (lampiran email).
  // Non-produksi saja (stack E2E): Telegram/IMAP tiruan. Produksi dengan variabel ini = gagal start.
  const testOverrides = channelTestOverridesFromEnv(process.env);
  const telegram = createTelegramBotClient(
    testOverrides.telegramBaseUrl ? { baseUrl: testOverrides.telegramBaseUrl } : {},
  );
  const mediaStore = createMediaStore(config.mediaDir);
  const ownerNotifier = createOwnerNotifier({ connection: redis });
  const runtime = startWorkers({ connection: redis }, logger, {
    email: {
      appUrl: config.appUrl,
      db,
      secretBox,
      fallback: config.smtpFallback,
      allowedPorts: config.smtpAllowedPorts,
      plaintextLogin: plaintextLoginPolicy(config.isProduction),
    },
    webhooks: { db, publisher, notifications: notificationProducer },
    maintenance: { db, publisher, notifications: notificationProducer, meta, secretBox },
    messages: {
      db,
      meta,
      secretBox,
      publisher,
      channels: {
        telegram,
        store: mediaStore,
        smtp: {
          allowedPorts: config.smtpAllowedPorts,
          plaintextLogin: plaintextLoginPolicy(config.isProduction),
          fallback: config.smtpFallback,
        },
      },
    },
    // Fase 6: kotak masuk channel Email (IMAP, TLS wajib).
    channels: {
      db,
      secretBox,
      store: mediaStore,
      imapPolicy: {
        allowedPorts: [...IMAP_ALLOWED_PORTS, ...(testOverrides.imap?.allowedPorts ?? [])],
        ...(testOverrides.imap?.testCa ? { testCa: testOverrides.imap.testCa } : {}),
      },
    },
    notifications: { db, secretBox, appUrl: config.appUrl, throttle: redisThrottle(redis) },
    webhooksOut: { db, secretBox, appUrl: config.appUrl, notifyOwner: ownerNotifier.notify },
    broadcast: { db, meta, secretBox, publisher, notifyOwner: ownerNotifier.notify },
  });

  const shutdown = createShutdown({
    logger,
    // Job yang sedang berjalan diberi waktu selesai sebelum koneksi ditutup.
    timeoutMs: 30_000,
    steps: [
      { name: 'workers', run: () => runtime.close() },
      { name: 'antrian-notifikasi', run: () => notificationProducer.close() },
      { name: 'antrian-email-owner', run: () => ownerNotifier.close() },
      { name: 'postgres', run: () => closeDb(db) },
      { name: 'redis', run: () => closeRedis(redis) },
    ],
  });
  registerShutdownSignals(shutdown);
  registerCrashHandlers(logger, shutdown);

  logger.info({ queues: runtime.workers.map((worker) => worker.name) }, 'Worker berjalan');
}

function loadConfigOrExit(): WorkerConfig {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    // Logger belum ada (LOG_LEVEL pun bisa salah). Pesannya hanya memuat nama variabel.
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

try {
  main(loadConfigOrExit());
} catch (error) {
  const message = error instanceof Error ? error.message : 'galat tidak dikenal';
  process.stderr.write(`Worker gagal start: ${scrubSecretsInText(message)}\n`);
  process.exit(1);
}
