import {
  closeRedis,
  createLogger,
  createRedis,
  createShutdown,
  EnvValidationError,
  registerCrashHandlers,
  registerShutdownSignals,
  scrubSecretsInText,
} from '@balesin/core';

import { loadConfig, type WorkerConfig } from './config';
import { startWorkers } from './runtime';

/** Titik masuk proses worker: baca konfigurasi → sambungkan Redis → proses antrian. */
function main(config: WorkerConfig): void {
  const logger = createLogger({
    service: 'worker',
    level: config.logLevel,
    pretty: config.env === 'development',
  });

  const redis = createRedis(config.redisUrl.reveal(), {
    role: 'queue',
    name: 'balesin-worker',
    logger,
  });
  const runtime = startWorkers({ connection: redis }, logger);

  const shutdown = createShutdown({
    logger,
    // Job yang sedang berjalan diberi waktu selesai sebelum koneksi Redis ditutup.
    timeoutMs: 30_000,
    steps: [
      { name: 'workers', run: () => runtime.close() },
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
