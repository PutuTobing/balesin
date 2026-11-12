import { createLogCapture, type LogCapture } from '@balesin/core/testing';

import { buildApp, type App, type AppDeps } from '../app';
import type { ReadinessProbes } from '../modules/health/health.service';

export const TEST_APP_ORIGIN = 'http://localhost:5173';

export interface TestAppOptions {
  config?: Partial<AppDeps['config']>;
  readinessProbes?: Partial<ReadinessProbes>;
  readinessTimeoutMs?: number;
}

export interface TestApp {
  app: App;
  /** Semua log yang ditulis aplikasi (sudah melewati redaksi, sama seperti di produksi). */
  logs: LogCapture;
}

const healthy = () => Promise.resolve();

/**
 * Aplikasi untuk tes `app.inject()`: dependensi palsu (tidak butuh Postgres/Redis hidup) dan
 * log ditangkap di memori. Rute khusus tes boleh ditambahkan sebelum request pertama.
 */
export async function buildTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const logs = createLogCapture();
  const app = await buildApp({
    config: {
      appOrigin: TEST_APP_ORIGIN,
      isProduction: false,
      trustProxy: false,
      ...options.config,
    },
    logger: logs.logger,
    readinessProbes: { postgres: healthy, redis: healthy, ...options.readinessProbes },
    readinessTimeoutMs: options.readinessTimeoutMs,
  });
  return { app, logs };
}
