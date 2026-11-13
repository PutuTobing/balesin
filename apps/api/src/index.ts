import {
  closeRedis,
  createLogger,
  createRedis,
  createShutdown,
  EnvValidationError,
  pingRedis,
  registerCrashHandlers,
  registerShutdownSignals,
  scrubSecretsInText,
} from '@balesin/core';
import { closeDb, createDb, pingDb } from '@balesin/db';

import { buildApp } from './app';
import { loadConfig, type ApiConfig } from './config';
import { createEmailQueue } from './queues/email-queue';

/** Titik masuk proses API: baca konfigurasi → sambungkan dependensi → dengarkan port. */
async function main(config: ApiConfig): Promise<void> {
  const logger = createLogger({
    service: 'api',
    level: config.logLevel,
    pretty: config.env === 'development',
  });

  if (!config.sessionSecret) {
    logger.warn(
      'SESSION_SECRET kosong: memakai kunci acak sementara, token CSRF tidak berlaku lagi setelah API dijalankan ulang (cukup muat ulang halaman). Isi SESSION_SECRET di .env supaya tetap.',
    );
  }
  if (!config.masterKey) {
    logger.warn(
      'BALESIN_MASTER_KEY kosong: kredensial (mis. password SMTP) tidak bisa disimpan sampai variabel itu diisi di .env.',
    );
  }
  if (!config.setupToken) {
    logger.warn(
      'SETUP_TOKEN kosong: wizard setup tidak bisa dijalankan. Abaikan bila Owner sudah dibuat.',
    );
  }

  const db = createDb(config.databaseUrl.reveal(), {
    applicationName: 'balesin-api',
    onPoolError: (err) => logger.error({ err }, 'Koneksi Postgres yang menganggur terputus'),
  });
  const redis = createRedis(config.redisUrl.reveal(), {
    role: 'client',
    name: 'balesin-api',
    logger,
  });
  // Koneksi terpisah untuk mengantre job: juga ber-peran `client` (gagal cepat bila Redis
  // mati) supaya permintaan HTTP tidak pernah menggantung menunggu antrian.
  const queueRedis = createRedis(config.redisUrl.reveal(), {
    role: 'client',
    name: 'balesin-api-antrian',
    logger,
  });
  const emailQueue = createEmailQueue({ connection: queueRedis });

  const app = await buildApp({
    config,
    logger,
    readinessProbes: {
      postgres: () => pingDb(db),
      redis: () => pingRedis(redis),
    },
    db,
    redis,
    notifier: emailQueue.notifier,
  });

  const shutdown = createShutdown({
    logger,
    steps: [
      { name: 'http', run: () => app.close() },
      { name: 'antrian', run: () => emailQueue.close() },
      { name: 'postgres', run: () => closeDb(db) },
      { name: 'redis', run: () => closeRedis(redis) },
      { name: 'redis-antrian', run: () => closeRedis(queueRedis) },
    ],
  });
  registerShutdownSignals(shutdown);
  registerCrashHandlers(logger, shutdown);

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    logger.fatal({ err }, 'API gagal mulai mendengarkan');
    await shutdown('listen-failed', 1);
  }
}

function loadConfigOrExit(): ApiConfig {
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
  await main(loadConfigOrExit());
} catch (error) {
  const message = error instanceof Error ? error.message : 'galat tidak dikenal';
  process.stderr.write(`API gagal start: ${scrubSecretsInText(message)}\n`);
  process.exit(1);
}
