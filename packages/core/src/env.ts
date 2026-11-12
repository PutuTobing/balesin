import { isIP } from 'node:net';

import { z } from 'zod';

import { LOG_LEVELS, type LogLevel } from './logger';
import { Secret } from './secret';

/**
 * Validasi variabel lingkungan (.env) untuk api dan worker.
 *
 * Aturan:
 *  - Gagal cepat saat start, dengan pesan bahasa Indonesia yang menyebut NAMA variabel.
 *  - NILAI variabel tidak pernah ikut tercetak (bisa berisi rahasia).
 *  - `.env` hanya untuk infrastruktur; koneksi (SMTP, WhatsApp, dll.) diisi lewat UI
 *    (docs/PENGATURAN-UI.md).
 */

export type EnvSource = Record<string, string | undefined>;

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export interface EnvProblem {
  variable: string;
  message: string;
}

export class EnvValidationError extends Error {
  readonly problems: readonly EnvProblem[];

  constructor(problems: readonly EnvProblem[], notes: readonly string[] = []) {
    super(formatEnvProblems(problems, notes));
    this.name = 'EnvValidationError';
    this.problems = problems;
  }
}

function formatEnvProblems(problems: readonly EnvProblem[], notes: readonly string[]): string {
  return [
    'Konfigurasi lingkungan tidak valid. Perbaiki variabel berikut (berkas .env):',
    ...problems.map((problem) => `  - ${problem.variable}: ${problem.message}`),
    ...notes.map((note) => `Catatan: ${note}`),
    'Contoh isi ada di .env.example. Nilai variabel sengaja tidak ditampilkan.',
  ].join('\n');
}

/** Buang variabel kosong (`KUNCI=` di .env berarti "tidak diisi") dan spasi di tepi nilai. */
export function cleanEnvSource(source: EnvSource): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const trimmed = value?.trim();
    if (trimmed) cleaned[key] = trimmed;
  }
  return cleaned;
}

/**
 * `true` kecuali NODE_ENV jelas-jelas `development` atau `test`.
 * NODE_ENV yang kosong/salah ketik diperlakukan seketat production (aman secara default).
 */
export function isProductionLike(source: EnvSource): boolean {
  const nodeEnv = source.NODE_ENV?.trim();
  return nodeEnv !== 'development' && nodeEnv !== 'test';
}

/**
 * Validasi `source` dengan `schema`. Melempar `EnvValidationError` yang pesannya
 * hanya memuat nama variabel dan penjelasan — tidak pernah nilainya.
 */
export function parseEnv<Schema extends z.ZodType>(
  schema: Schema,
  source: EnvSource,
): z.output<Schema> {
  const result = schema.safeParse(cleanEnvSource(source));
  if (result.success) return result.data;

  const seen = new Set<string>();
  const problems: EnvProblem[] = [];
  for (const issue of result.error.issues) {
    const variable = issue.path.length > 0 ? String(issue.path[0]) : '(umum)';
    const key = `${variable}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push({ variable, message: issue.message });
  }

  const notes = source.NODE_ENV?.trim()
    ? []
    : ['NODE_ENV tidak diisi, sehingga dianggap production (aturan paling ketat).'];
  throw new EnvValidationError(problems, notes);
}

// ── Pengurai nilai ──────────────────────────────────────────────────────────
// Mengembalikan `undefined` bila teks tidak valid.

export type EnvParser<T> = (raw: string) => T | undefined;

const MISSING_MESSAGE = 'wajib diisi';

function withProtocol(raw: string, protocols: readonly string[]): URL | undefined {
  try {
    const url = new URL(raw);
    return protocols.includes(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

function decodeBase64Key(raw: string, byteLength: number): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return undefined;
  const key = Buffer.from(raw, 'base64');
  return key.length === byteLength ? key : undefined;
}

export const envParse = {
  text: (raw: string): string => raw,

  oneOf:
    <const Values extends readonly string[]>(values: Values): EnvParser<Values[number]> =>
    (raw) =>
      values.find((value) => value === raw),

  integer:
    (min: number, max: number): EnvParser<number> =>
    (raw) => {
      if (!/^\d{1,10}$/.test(raw)) return undefined;
      const value = Number(raw);
      return value >= min && value <= max ? value : undefined;
    },

  boolean: (raw: string): boolean | undefined => {
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return undefined;
  },

  /** URL http(s) tanpa garis miring di akhir. `httpsOnly` tetap mengizinkan http://localhost. */
  httpUrl:
    (options: { httpsOnly?: boolean } = {}): EnvParser<string> =>
    (raw) => {
      const url = withProtocol(raw, ['http:', 'https:']);
      if (!url || url.username || url.password || url.search || url.hash) return undefined;
      const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (options.httpsOnly && url.protocol !== 'https:' && !isLocal) return undefined;
      return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    },

  /** Connection string; dibungkus `Secret` karena memuat password. */
  connectionUrl:
    (protocols: readonly string[]): EnvParser<Secret<string>> =>
    (raw) =>
      withProtocol(raw, protocols) ? new Secret(raw) : undefined,

  /** Kunci acak dalam base64 dengan panjang byte tertentu (mis. master key AES-256 = 32 byte). */
  base64Key:
    (byteLength: number): EnvParser<Secret<Buffer>> =>
    (raw) => {
      const key = decodeBase64Key(raw, byteLength);
      return key ? new Secret(key) : undefined;
    },

  secretText:
    (minLength: number): EnvParser<Secret<string>> =>
    (raw) =>
      raw.length >= minLength ? new Secret(raw) : undefined,

  /** Alamat IP (v4/v6) atau rentang CIDR, mis. `10.0.0.5` atau `192.168.1.0/24`. */
  ipOrCidr: (raw: string): string | undefined => {
    const [address = '', prefix, ...extra] = raw.split('/');
    const version = isIP(address);
    if (version === 0 || extra.length > 0) return undefined;
    if (prefix === undefined) return raw;
    if (!/^\d{1,3}$/.test(prefix)) return undefined;
    return Number(prefix) <= (version === 4 ? 32 : 128) ? raw : undefined;
  },

  /** Daftar dipisah koma; gagal bila salah satu butir tidak valid. */
  list:
    <T>(item: EnvParser<T>): EnvParser<T[]> =>
    (raw) => {
      const items: T[] = [];
      for (const part of raw.split(',')) {
        const parsed = item(part.trim());
        if (parsed === undefined) return undefined;
        items.push(parsed);
      }
      return items;
    },
};

// ── Pembungkus jadi skema Zod ───────────────────────────────────────────────

/** Variabel wajib. */
export function envRequired<T>(
  parse: EnvParser<T>,
  invalidMessage: string,
  missingMessage: string = MISSING_MESSAGE,
) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): T => {
      const parsed = raw === undefined ? undefined : parse(raw);
      if (parsed !== undefined) return parsed;
      ctx.addIssue(raw === undefined ? missingMessage : invalidMessage);
      return z.NEVER;
    });
}

/** Variabel opsional: `null` bila tidak diisi; tetap ditolak bila diisi tapi tidak valid. */
export function envOptional<T>(parse: EnvParser<T>, invalidMessage: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): T | null => {
      if (raw === undefined) return null;
      const parsed = parse(raw);
      if (parsed !== undefined) return parsed;
      ctx.addIssue(invalidMessage);
      return z.NEVER;
    });
}

/** Variabel opsional dengan nilai bawaan. */
export function envDefault<T>(parse: EnvParser<T>, defaultValue: T, invalidMessage: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): T => {
      if (raw === undefined) return defaultValue;
      const parsed = parse(raw);
      if (parsed !== undefined) return parsed;
      ctx.addIssue(invalidMessage);
      return z.NEVER;
    });
}

/** Wajib di production, opsional (`null`) di development/test. */
export function envRequiredInProduction<T>(
  production: boolean,
  parse: EnvParser<T>,
  invalidMessage: string,
) {
  return production
    ? envRequired<T | null>(parse, invalidMessage, 'wajib diisi di production')
    : envOptional(parse, invalidMessage);
}

const MASTER_KEY_MESSAGE =
  'harus 32 byte acak dalam base64 — buat dengan: ' +
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`;

/**
 * Variabel yang dipakai api DAN worker. `production` menentukan apakah rahasia wajib ada
 * (lihat `isProductionLike`).
 */
export function baseEnvShape(production: boolean) {
  return {
    NODE_ENV: envDefault<NodeEnv>(
      envParse.oneOf(NODE_ENVS),
      'production',
      `harus salah satu dari: ${NODE_ENVS.join(', ')}`,
    ),
    LOG_LEVEL: envDefault<LogLevel>(
      envParse.oneOf(LOG_LEVELS),
      'info',
      `harus salah satu dari: ${LOG_LEVELS.join(', ')}`,
    ),
    DATABASE_URL: envRequired(
      envParse.connectionUrl(['postgres:', 'postgresql:']),
      'harus berupa URL Postgres, contoh: postgres://pengguna:sandi@host:5432/nama_database',
    ),
    REDIS_URL: envRequired(
      envParse.connectionUrl(['redis:', 'rediss:']),
      'harus berupa URL Redis, contoh: redis://:sandi@host:6379',
    ),
    BALESIN_MASTER_KEY: envRequiredInProduction(
      production,
      envParse.base64Key(32),
      MASTER_KEY_MESSAGE,
    ),
  };
}
