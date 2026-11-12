import { REDACTED, Secret } from './secret';

/**
 * Redaksi rahasia untuk log, audit log, dan keluaran diagnostik lain.
 *
 * Dua lapis:
 *  1. `redactSecrets(value)` — menelusuri objek sedalam apa pun dan menyensor nilai dari kunci
 *     yang namanya berbau rahasia (password, token, secret, authorization, cookie, …).
 *  2. `scrubSecretsInText(text)` — menyensor pola rahasia di dalam teks bebas
 *     (kredensial di URL, `Bearer …`, `access_token=…`, token Meta `EAA…`, API key `blsn_…`).
 *
 * Aturannya sengaja "lebih baik kelebihan sensor daripada bocor".
 */

const MAX_DEPTH = 8;

/** Kunci dianggap rahasia bila (setelah dinormalkan) MENGANDUNG salah satu potongan ini. */
const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'signature',
  'masterkey',
  'privatekey',
  'encryptionkey',
  'signingkey',
  'credential',
  'connectionstring',
  'databaseurl',
  'redisurl',
  'totp',
  'otpcode',
  'backupcode',
  'recoverycode',
] as const;

/** Kunci pendek yang hanya dianggap rahasia bila namanya PERSIS ini (hindari salah tangkap). */
const SENSITIVE_KEYS_EXACT = new Set(['pass', 'pwd', 'auth', 'otp', 'pin', 'dsn']);

/**
 * Properti error yang memuat NILAI data, bukan sekadar deskripsi:
 *  - `params`/`parameters`: parameter query (Drizzle menaruh semua nilai bind di sini — bisa
 *    berisi hash password, token, isi pesan pelanggan).
 *  - `detail`/`where`: rincian dari Postgres, mis. "Failing row contains (…seluruh isi baris…)".
 * Kode error, nama constraint, tabel, dan kolom tetap tampil dan cukup untuk debugging.
 */
const ERROR_DATA_PROPS = new Set(['params', 'parameters', 'detail', 'where']);

const TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Kredensial di URL: skema://user:password@host
  [/\b([a-z][a-z0-9+.-]{1,30}:\/\/)[^\s/?#@"'\\<>]*@/gi, `$1${REDACTED}@`],
  // Isi header Authorization
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Parameter rahasia di query string / form-urlencoded
  [
    /(?<![A-Za-z0-9_])((?:access_token|refresh_token|id_token|input_token|fb_exchange_token|hub\.verify_token|verify_token|appsecret_proof|client_secret|app_secret|api_key|apikey|password|passwd|token|secret|signature)=)[^&\s"'#\\]+/gi,
    `$1${REDACTED}`,
  ],
  // Token akses Meta (selalu berawalan "EAA")
  [/\bEAA[A-Za-z0-9]{20,}/g, REDACTED],
  // API key Balesin: blsn_<prefix>_<secret> — prefix dibiarkan agar key bisa dikenali
  [/\b(blsn_[A-Za-z0-9]+_)[A-Za-z0-9_-]{8,}/g, `$1${REDACTED}`],
];

/**
 * Error query Drizzle menulis semua nilai parameter di pesannya, di baris kedua:
 * "Failed query: <sql>" lalu baris "params: <nilai1>,<nilai2>". Semua setelah "params: " disensor.
 * Ada dua bentuk: teks biasa (baris baru sungguhan), dan teks yang sudah jadi string JSON
 * (baris baru tertulis sebagai garis miring terbalik + n; sensor berhenti di tanda kutip
 * penutup agar baris JSON tidak rusak).
 */
const DRIZZLE_PARAMS_IN_TEXT = /(Failed query: [^]*?\nparams: )[^]*/g;
const DRIZZLE_PARAMS_IN_JSON = /(Failed query: (?:[^"\\]|\\.)*?\\nparams: )(?:[^"\\]|\\.)*/g;

/** `true` bila nama kunci menandakan isinya rahasia. Tidak peka huruf besar/kecil maupun pemisah. */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_KEYS_EXACT.has(normalized)) return true;
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function applyTextPatterns(text: string): string {
  let result = text;
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Menyensor pola rahasia di dalam teks bebas. Aman dipanggil berulang (idempoten). */
export function scrubSecretsInText(text: string): string {
  return applyTextPatterns(text.replace(DRIZZLE_PARAMS_IN_TEXT, `$1${REDACTED}`));
}

/**
 * Sama seperti `scrubSecretsInText`, untuk satu baris log yang SUDAH berbentuk JSON:
 * tidak pernah menyentuh tanda kutip, jadi baris tetap JSON yang sah.
 */
export function scrubSecretsInJsonLine(line: string): string {
  return applyTextPatterns(line.replace(DRIZZLE_PARAMS_IN_JSON, `$1${REDACTED}`));
}

/**
 * Salinan `value` yang aman untuk di-log: nilai kunci rahasia diganti `[DISEMBUNYIKAN]`,
 * teks disaring pola rahasianya, data biner dan `Secret` tidak pernah ditampilkan,
 * dan `Error` diubah jadi objek biasa. Nilai asli tidak diubah.
 */
export function redactSecrets(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}

function redactValueOfSensitiveKey(value: unknown): unknown {
  // Boolean/null/undefined bukan rahasia dan berguna untuk debugging (mis. `hasToken: true`).
  if (value === null || value === undefined || typeof value === 'boolean') return value;
  return REDACTED;
}

function walk(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubSecretsInText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;

  if (value instanceof Secret) return REDACTED;
  if (value instanceof Date) return value;
  if (ArrayBuffer.isView(value)) return `[Biner ${value.byteLength} byte]`;
  if (value instanceof ArrayBuffer) return `[Biner ${value.byteLength} byte]`;
  if (ancestors.has(value)) return '[Melingkar]';
  if (depth >= MAX_DEPTH) return '[Terlalu dalam]';

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, ancestors));
    if (value instanceof Error) return walkError(value, depth, ancestors);
    if (value instanceof Map) {
      const entries = Array.from(value.entries(), ([key, item]) => [String(key), item] as const);
      return walkEntries(entries, depth, ancestors);
    }
    if (value instanceof Set) {
      return Array.from(value, (item) => walk(item, depth + 1, ancestors));
    }

    const jsonValue = callToJson(value);
    if (jsonValue !== value) return walk(jsonValue, depth + 1, ancestors);

    return walkEntries(ownEntries(value), depth, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function walkEntries(
  entries: Iterable<readonly [string, unknown]>,
  depth: number,
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    result[key] = isSensitiveKey(key)
      ? redactValueOfSensitiveKey(item)
      : walk(item, depth + 1, ancestors);
  }
  return result;
}

function walkError(
  error: Error,
  depth: number,
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  const message = describeError(error);
  const result: Record<string, unknown> = {
    type: error.constructor.name || error.name,
    message,
  };
  const stack = safeErrorStack(error, message);
  if (stack !== undefined) result.stack = stack;
  if (error.cause !== undefined) result.cause = walk(error.cause, depth + 1, ancestors);
  // `errors` pada AggregateError tidak enumerable (mis. gagal konek ke ::1 DAN 127.0.0.1).
  if (error instanceof AggregateError) result.errors = walk(error.errors, depth + 1, ancestors);

  for (const [key, item] of ownEntries(error)) {
    if (key === 'message' || key === 'stack' || key === 'cause') continue;
    result[key] =
      isSensitiveKey(key) || ERROR_DATA_PROPS.has(key)
        ? redactValueOfSensitiveKey(item)
        : walk(item, depth + 1, ancestors);
  }
  return result;
}

/**
 * Pesan error yang aman. Error query Drizzle menulis seluruh nilai parameter di pesannya
 * ("Failed query: …\nparams: nilai1,nilai2"), jadi untuk error berbentuk begitu pesannya
 * disusun ulang hanya dari teks SQL (yang memakai placeholder `$1`, bukan nilai).
 */
export function describeError(error: Error): string {
  const candidate = error as Error & { query?: unknown; params?: unknown };
  if (typeof candidate.query === 'string' && 'params' in candidate) {
    return scrubSecretsInText(`Failed query: ${candidate.query}`);
  }
  return scrubSecretsInText(error.message);
}

/**
 * Stack dengan kepala diganti pesan aman (kepala bawaan mengulang pesan asli).
 * Awal daftar frame dicari dari letak pesan aslinya, bukan dari pola "at …" — isi pesan
 * (mis. nilai parameter query) bisa saja memuat teks yang mirip frame.
 */
function safeErrorStack(error: Error, message: string): string | undefined {
  const { stack } = error;
  if (typeof stack !== 'string') return undefined;
  const messageAt = error.message ? stack.indexOf(error.message) : -1;
  const framesAt = messageAt === -1 ? stack.search(/\n\s+at /) : messageAt + error.message.length;
  const frames = framesAt === -1 ? '' : scrubSecretsInText(stack.slice(framesAt));
  return `${error.name}: ${message}${frames}`;
}

/** Tiru `JSON.stringify`: objek dengan `toJSON()` diwakili hasil `toJSON()`-nya. */
function callToJson(value: object): unknown {
  const candidate = value as { toJSON?: unknown };
  if (typeof candidate.toJSON !== 'function') return value;
  try {
    return (candidate.toJSON as () => unknown).call(value);
  } catch {
    return '[Tidak terbaca]';
  }
}

/** Properti enumerable milik sendiri; getter yang melempar error tidak menggagalkan log. */
function ownEntries(value: object): Array<readonly [string, unknown]> {
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of Object.keys(value)) {
    try {
      entries.push([key, (value as Record<string, unknown>)[key]]);
    } catch {
      entries.push([key, '[Tidak terbaca]']);
    }
  }
  return entries;
}
