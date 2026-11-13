import {
  baseEnvShape,
  envDefault,
  envOptional,
  envParse,
  envRequired,
  envRequiredInProduction,
  EnvValidationError,
  isProductionLike,
  parseEnv,
  type EnvSource,
  type LogLevel,
  type NodeEnv,
  type Secret,
} from '@balesin/core';
import { z } from 'zod';

/**
 * Konfigurasi API, dibaca sekali saat start dari variabel lingkungan (.env).
 * Hanya hal infrastruktur — koneksi (SMTP, WhatsApp, dll.) diatur lewat UI dan disimpan
 * terenkripsi di database (docs/PENGATURAN-UI.md).
 */
export interface ApiConfig {
  env: NodeEnv;
  isProduction: boolean;
  logLevel: LogLevel;
  /** Alamat publik web. */
  appUrl: string;
  /** Origin web (skema + host + port): satu-satunya origin yang diizinkan CORS. */
  appOrigin: string;
  /** Alamat publik API. */
  apiUrl: string;
  host: string;
  port: number;
  /** `true` = percaya semua proxy; daftar = hanya IP/CIDR proxy tersebut. */
  trustProxy: boolean | string[];
  databaseUrl: Secret<string>;
  redisUrl: Secret<string>;
  /** Kunci AES-256-GCM (32 byte) untuk mengenkripsi kredensial di database. Wajib di production. */
  masterKey: Secret<Buffer> | null;
  /** Wajib di production. */
  sessionSecret: Secret<string> | null;
  /** Token sekali pakai untuk wizard setup Owner pertama. */
  setupToken: Secret<string> | null;
  /** Cadangan opsional sebelum SMTP diatur lewat UI. `null` bila `SMTP_HOST` kosong. */
  smtpFallback: SmtpFallbackConfig | null;
  /** Versi Graph API Meta yang dikunci, mis. `v21.0`. */
  metaGraphVersion: string | null;
  mediaDir: string;
  /** IP/CIDR privat yang boleh dituju webhook keluar (SECURITY.md §6). */
  outboundPrivateAllowlist: string[];
}

export interface SmtpFallbackConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: Secret<string> | null;
  from: string;
}

const URL_MESSAGE =
  'harus berupa URL http(s) tanpa query, contoh: https://balesin.perusahaan.co.id';
const IP_LIST_MESSAGE =
  'harus berupa daftar IP atau CIDR dipisah koma, contoh: 10.0.0.5,192.168.1.0/24';

/**
 * TRUST_PROXY menentukan dari mana alamat IP klien dibaca (batas login per IP, audit log):
 *  - `false`: header X-Forwarded-* diabaikan (API tidak di belakang proxy).
 *  - daftar IP/CIDR: hanya proxy dengan alamat itu yang dipercaya. Ini yang benar di production.
 *  - `true`: percaya SEMUA hop — klien bisa memalsukan IP-nya lewat X-Forwarded-For. Hanya
 *    diterima di development/test. CIDR `/0` sama artinya, jadi ikut ditolak di production.
 * Angka (`1`, `0`) tidak diterima: di Fastify angka berarti jumlah hop, bukan ya/tidak.
 */
function parseTrustProxy(production: boolean) {
  return (raw: string): boolean | string[] | undefined => {
    if (raw === 'false') return false;
    if (raw === 'true') return production ? undefined : true;
    const proxies = envParse.list(envParse.ipOrCidr)(raw);
    if (production && proxies?.some((proxy) => proxy.endsWith('/0'))) return undefined;
    return proxies;
  };
}

function apiEnvSchema(production: boolean) {
  const publicUrl = envRequired(
    envParse.httpUrl({ httpsOnly: production }),
    production ? `${URL_MESSAGE} (wajib https di production)` : URL_MESSAGE,
  );

  return z.object({
    ...baseEnvShape(production),
    APP_URL: publicUrl,
    API_URL: publicUrl,
    API_HOST: envDefault(
      (raw) => (/^[A-Za-z0-9.:-]+$/.test(raw) ? raw : undefined),
      '127.0.0.1',
      'harus berupa alamat IP atau nama host, contoh: 127.0.0.1 atau 0.0.0.0',
    ),
    API_PORT: envDefault(envParse.integer(1, 65_535), 3000, 'harus berupa angka 1–65535'),
    TRUST_PROXY: envDefault(
      parseTrustProxy(production),
      false,
      production
        ? 'di production harus false atau daftar IP/CIDR proxy tepercaya dipisah koma (contoh: 10.0.0.2); ' +
            'nilai true tidak diterima karena membuat alamat IP klien bisa dipalsukan'
        : 'harus true, false, atau daftar IP/CIDR proxy dipisah koma (contoh: 10.0.0.2,10.0.1.0/24)',
    ),
    SESSION_SECRET: envRequiredInProduction(
      production,
      envParse.secretText(32),
      'minimal 32 karakter acak',
    ),
    SETUP_TOKEN: envOptional(envParse.secretText(16), 'minimal 16 karakter acak'),
    SMTP_HOST: envOptional(envParse.text, 'harus berupa nama host'),
    SMTP_PORT: envDefault(envParse.integer(1, 65_535), 465, 'harus berupa angka 1–65535'),
    SMTP_SECURE: envDefault(envParse.boolean, true, 'harus true atau false'),
    SMTP_USER: envOptional(envParse.text, 'harus berupa teks'),
    SMTP_PASSWORD: envOptional(envParse.secretText(1), 'harus berupa teks'),
    SMTP_FROM: envOptional(envParse.text, 'harus berupa teks'),
    META_GRAPH_VERSION: envOptional(
      (raw) => (/^v\d{1,3}\.\d{1,2}$/.test(raw) ? raw : undefined),
      'harus berformat vNN.0, contoh: v21.0',
    ),
    MEDIA_DIR: envDefault(envParse.text, './media', 'harus berupa path folder'),
    OUTBOUND_PRIVATE_ALLOWLIST: envDefault(envParse.list(envParse.ipOrCidr), [], IP_LIST_MESSAGE),
  });
}

/**
 * Membaca dan memvalidasi konfigurasi. Melempar `EnvValidationError` (pesan bahasa Indonesia,
 * menyebut nama variabel, tanpa nilainya) bila ada yang salah.
 */
export function loadConfig(source: EnvSource): ApiConfig {
  const env = parseEnv(apiEnvSchema(isProductionLike(source)), source);

  if (env.SMTP_HOST !== null && env.SMTP_FROM === null) {
    throw new EnvValidationError([
      { variable: 'SMTP_FROM', message: 'wajib diisi bila SMTP_HOST diisi' },
    ]);
  }

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    logLevel: env.LOG_LEVEL,
    appUrl: env.APP_URL,
    appOrigin: new URL(env.APP_URL).origin,
    apiUrl: env.API_URL,
    host: env.API_HOST,
    port: env.API_PORT,
    trustProxy: env.TRUST_PROXY,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    masterKey: env.BALESIN_MASTER_KEY,
    sessionSecret: env.SESSION_SECRET,
    setupToken: env.SETUP_TOKEN,
    smtpFallback:
      env.SMTP_HOST !== null && env.SMTP_FROM !== null
        ? {
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_SECURE,
            user: env.SMTP_USER,
            password: env.SMTP_PASSWORD,
            from: env.SMTP_FROM,
          }
        : null,
    metaGraphVersion: env.META_GRAPH_VERSION,
    mediaDir: env.MEDIA_DIR,
    outboundPrivateAllowlist: env.OUTBOUND_PRIVATE_ALLOWLIST,
  };
}
