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

/** Titik masuk proses API: baca konfigurasi → sambungkan dependensi → dengarkan port. */
async function main(config: ApiConfig): Promise<void> {
  const logger = createLogger({
    service: 'api',
    level: config.logLevel,
    pretty: config.env === 'development',
  });

  const db = createDb(config.databaseUrl.reveal(), {
    applicationName: 'balesin-api',
    onPoolError: (err) => logger.error({ err }, 'Koneksi Postgres yang menganggur terputus'),
  });
  const redis = createRedis(config.redisUrl.reveal(), {
    role: 'client',
    name: 'balesin-api',
    logger,
  });

  const app = await buildApp({
    config,
    logger,
    readinessProbes: {
      postgres: () => pingDb(db),
      redis: () => pingRedis(redis),
    },
  });

  const shutdown = createShutdown({
    logger,
    steps: [
      { name: 'http', run: () => app.close() },
      { name: 'postgres', run: () => closeDb(db) },
      { name: 'redis', run: () => closeRedis(redis) },
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
