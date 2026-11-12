import {
  baseEnvShape,
  isProductionLike,
  parseEnv,
  type EnvSource,
  type LogLevel,
  type NodeEnv,
  type Secret,
} from '@balesin/core';
import { z } from 'zod';

/** Konfigurasi worker, dibaca sekali saat start dari variabel lingkungan (.env). */
export interface WorkerConfig {
  env: NodeEnv;
  isProduction: boolean;
  logLevel: LogLevel;
  databaseUrl: Secret<string>;
  redisUrl: Secret<string>;
  /** Kunci AES-256-GCM untuk membuka kredensial channel saat mengirim pesan. Wajib di production. */
  masterKey: Secret<Buffer> | null;
}

/**
 * Membaca dan memvalidasi konfigurasi. Melempar `EnvValidationError` (pesan bahasa Indonesia,
 * menyebut nama variabel, tanpa nilainya) bila ada yang salah.
 */
export function loadConfig(source: EnvSource): WorkerConfig {
  const env = parseEnv(z.object(baseEnvShape(isProductionLike(source))), source);
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    masterKey: env.BALESIN_MASTER_KEY,
  };
}
