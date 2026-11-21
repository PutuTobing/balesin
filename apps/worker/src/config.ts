import {
  allowedSmtpPorts,
  baseEnvShape,
  envDefault,
  envParse,
  envRequired,
  isProductionLike,
  metaGraphEnvShape,
  parseEnv,
  resolveSmtpFallback,
  smtpFallbackEnvShape,
  type EnvSource,
  type LogLevel,
  type NodeEnv,
  type Secret,
  type SmtpFallbackConfig,
} from '@balesin/core';
import { isAbsolute, resolve } from 'node:path';

import { z } from 'zod';

/** Konfigurasi worker, dibaca sekali saat start dari variabel lingkungan (.env). */
export interface WorkerConfig {
  env: NodeEnv;
  isProduction: boolean;
  logLevel: LogLevel;
  /**
   * Alamat publik web (`APP_URL`, sama dengan API). SATU-SATUNYA sumber alamat di tautan email
   * (undangan, atur ulang password, verifikasi) — tidak pernah dari data permintaan.
   */
  appUrl: string;
  databaseUrl: Secret<string>;
  redisUrl: Secret<string>;
  /** Kunci AES-256-GCM untuk membuka kredensial tersimpan (password SMTP, nanti token channel). Wajib di production. */
  masterKey: Secret<Buffer> | null;
  /** Cadangan `SMTP_*` bila organisasi belum mengisi Pengaturan → Email pengirim. */
  smtpFallback: SmtpFallbackConfig | null;
  /** Port SMTP yang boleh dituju saat mengirim email. */
  smtpAllowedPorts: number[];
  /** Versi Graph API Meta yang dikunci (sama dengan api). */
  metaGraphVersion: string;
  /** HANYA development/test: server Meta tiruan di loopback. `null` = graph.facebook.com. */
  metaGraphBaseUrl: string | null;
  /**
   * Fase 6: folder media BERSAMA api (`MEDIA_DIR`) — lampiran email masuk disimpan worker dan dibaca
   * api. Path relatif di luar production diselesaikan terhadap folder `apps/api` (default dev api =
   * `./media` di sana), supaya dua proses `pnpm dev` memakai folder yang sama. Production: wajib path
   * absolut (volume yang sama dengan api).
   */
  mediaDir: string;
}

/**
 * Membaca dan memvalidasi konfigurasi. Melempar `EnvValidationError` (pesan bahasa Indonesia,
 * menyebut nama variabel, tanpa nilainya) bila ada yang salah.
 */
export function loadConfig(source: EnvSource): WorkerConfig {
  const production = isProductionLike(source);
  const env = parseEnv(
    z.object({
      ...baseEnvShape(production),
      APP_URL: envRequired(
        envParse.httpUrl({ httpsOnly: production }),
        production
          ? 'harus berupa URL http(s) tanpa query, contoh: https://balesin.perusahaan.co.id (wajib https di production)'
          : 'harus berupa URL http(s) tanpa query, contoh: https://balesin.perusahaan.co.id',
      ),
      ...smtpFallbackEnvShape(),
      ...metaGraphEnvShape(production),
      MEDIA_DIR: production
        ? envRequired(
            (raw) => (isAbsolute(raw) ? raw : undefined),
            'harus berupa path folder absolut yang sama dengan MEDIA_DIR api (volume media bersama)',
          )
        : envDefault(envParse.text, './media', 'harus berupa path folder'),
    }),
    source,
  );
  const isProduction = env.NODE_ENV === 'production';
  return {
    env: env.NODE_ENV,
    isProduction,
    logLevel: env.LOG_LEVEL,
    appUrl: env.APP_URL,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    masterKey: env.BALESIN_MASTER_KEY,
    smtpFallback: resolveSmtpFallback(env),
    smtpAllowedPorts: allowedSmtpPorts(isProduction),
    metaGraphVersion: env.META_GRAPH_VERSION,
    metaGraphBaseUrl: env.META_GRAPH_BASE_URL ?? null,
    mediaDir: isAbsolute(env.MEDIA_DIR)
      ? env.MEDIA_DIR
      : resolve(import.meta.dirname, '..', '..', 'api', env.MEDIA_DIR),
  };
}
