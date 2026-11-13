import {
  allowedSmtpPorts,
  baseEnvShape,
  isProductionLike,
  parseEnv,
  resolveSmtpFallback,
  smtpFallbackEnvShape,
  type EnvSource,
  type LogLevel,
  type NodeEnv,
  type Secret,
  type SmtpFallbackConfig,
} from '@balesin/core';
import { z } from 'zod';

/** Konfigurasi worker, dibaca sekali saat start dari variabel lingkungan (.env). */
export interface WorkerConfig {
  env: NodeEnv;
  isProduction: boolean;
  logLevel: LogLevel;
  databaseUrl: Secret<string>;
  redisUrl: Secret<string>;
  /** Kunci AES-256-GCM untuk membuka kredensial tersimpan (password SMTP, nanti token channel). Wajib di production. */
  masterKey: Secret<Buffer> | null;
  /** Cadangan `SMTP_*` bila organisasi belum mengisi Pengaturan → Email pengirim. */
  smtpFallback: SmtpFallbackConfig | null;
  /** Port SMTP yang boleh dituju saat mengirim email. */
  smtpAllowedPorts: number[];
}

/**
 * Membaca dan memvalidasi konfigurasi. Melempar `EnvValidationError` (pesan bahasa Indonesia,
 * menyebut nama variabel, tanpa nilainya) bila ada yang salah.
 */
export function loadConfig(source: EnvSource): WorkerConfig {
  const env = parseEnv(
    z.object({ ...baseEnvShape(isProductionLike(source)), ...smtpFallbackEnvShape() }),
    source,
  );
  const isProduction = env.NODE_ENV === 'production';
  return {
    env: env.NODE_ENV,
    isProduction,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    masterKey: env.BALESIN_MASTER_KEY,
    smtpFallback: resolveSmtpFallback(env),
    smtpAllowedPorts: allowedSmtpPorts(isProduction),
  };
}
