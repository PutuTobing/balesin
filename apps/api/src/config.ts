import {
  allowedSmtpPorts,
  baseEnvShape,
  envDefault,
  envOptional,
  envParse,
  envRequired,
  envRequiredInProduction,
  isProductionLike,
  parseEnv,
  resolveSmtpFallback,
  smtpFallbackEnvShape,
  STRONG_SECRET_HINT,
  type EnvSource,
  type LogLevel,
  type NodeEnv,
  type Secret,
  type SmtpFallbackConfig,
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
  /**
   * Kunci token CSRF. Wajib di production; di development/test boleh kosong (aplikasi membuat
   * kunci acak sementara yang berganti setiap start).
   */
  sessionSecret: Secret<string> | null;
  /**
   * `true` = cookie sesi `__Host-` + `Secure`. Mengikuti skema `APP_URL`: https → true.
   * Hanya `false` untuk http://localhost (pengembangan lokal), karena di production `APP_URL`
   * wajib https kecuali localhost.
   */
  cookieSecure: boolean;
  /** Token sekali pakai untuk wizard setup Owner pertama. */
  setupToken: Secret<string> | null;
  /** Cadangan opsional sebelum SMTP diatur lewat UI. `null` bila `SMTP_HOST` kosong. */
  smtpFallback: SmtpFallbackConfig | null;
  /**
   * Port SMTP yang boleh dituju tes koneksi/pengiriman (permukaan SSRF). Di luar production
   * ditambah 1025, port penangkap email lokal (Mailpit) dari `pnpm db:up`.
   */
  smtpAllowedPorts: number[];
  /** Versi Graph API Meta yang dikunci, mis. `v21.0`. */
  metaGraphVersion: string | null;
  mediaDir: string;
  /** IP/CIDR privat yang boleh dituju webhook keluar (SECURITY.md §6). */
  outboundPrivateAllowlist: string[];
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
      envParse.strongSecret(32),
      STRONG_SECRET_HINT,
    ),
    SETUP_TOKEN: envOptional(envParse.strongSecret(32), STRONG_SECRET_HINT),
    ...smtpFallbackEnvShape(),
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

  const smtpFallback = resolveSmtpFallback(env);
  const isProduction = env.NODE_ENV === 'production';

  return {
    env: env.NODE_ENV,
    isProduction,
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
    cookieSecure: new URL(env.APP_URL).protocol === 'https:',
    setupToken: env.SETUP_TOKEN,
    smtpFallback,
    smtpAllowedPorts: allowedSmtpPorts(isProduction),
    metaGraphVersion: env.META_GRAPH_VERSION,
    mediaDir: env.MEDIA_DIR,
    outboundPrivateAllowlist: env.OUTBOUND_PRIVATE_ALLOWLIST,
  };
}
