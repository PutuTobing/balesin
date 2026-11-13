import { REDACTED, Secret } from './secret';

/**
 * Redaksi rahasia untuk log, audit log, dan keluaran diagnostik lain.
 *
 * Dua lapis:
 *  1. `redactSecrets(value)` — menelusuri objek sedalam apa pun dan menyensor nilai dari kunci
 *     yang namanya berbau rahasia (password, token, secret, authorization, cookie, …).
 *  2. `scrubSecretsInText(text)` — menyensor pola rahasia di dalam teks bebas: kredensial di
 *     URL, header (`Authorization: …`, `Cookie: …`), `kunci=nilai`, pasangan JSON
 *     `"kunci":"nilai"`, token Meta/Telegram, API key Balesin, parameter query database.
 *
 * Aturannya sengaja "lebih baik kelebihan sensor daripada bocor".
 *
 * Semua pemindaian teks di berkas ini LINEAR terhadap panjang teks (teks dari luar — isi pesan
 * pelanggan, payload webhook — bisa ikut ter-log; sensor yang kuadratik berarti satu baris log
 * bisa menahan event loop). Aturan untuk pola baru: awali dengan teks tetap, jangan memakai
 * pengulangan malas (`*?`) yang mencari penanda jauh, dan tambahkan kasusnya ke tes waktu di
 * `redact.test.ts`.
 */

const MAX_DEPTH = 8;

/**
 * String yang lebih panjang dari ini dipotong sebelum masuk log. Log bukan tempat menyimpan
 * data besar, dan batas ini membatasi biaya sensor per nilai.
 */
export const MAX_LOGGED_STRING_LENGTH = 16_384;

/** Kunci dianggap rahasia bila (setelah dinormalkan) MENGANDUNG salah satu potongan ini. */
const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'passphrase',
  'passcode',
  'secret',
  'token',
  'jwt',
  'apikey',
  'accesskey',
  'licensekey',
  'authorization',
  'cookie',
  'sessionid',
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

/**
 * Kunci pendek yang hanya dianggap rahasia bila namanya PERSIS ini (hindari salah tangkap).
 * `code` dan `key` sengaja tidak masuk: terlalu umum (kode SQLSTATE, nama kunci Redis).
 */
const SENSITIVE_KEYS_EXACT = new Set(['pass', 'pwd', 'auth', 'otp', 'pin', 'dsn', 'sid']);

/**
 * Properti error yang memuat NILAI data, bukan sekadar deskripsi:
 *  - `params`/`parameters`: parameter query (Drizzle menaruh semua nilai bind di sini — bisa
 *    berisi hash password, token, isi pesan pelanggan).
 *  - `detail`/`where`: rincian dari Postgres, mis. "Failing row contains (…seluruh isi baris…)".
 *  - `args`: argumen perintah (lihat juga `command` di `walkError`).
 * Kode error, nama constraint, tabel, dan kolom tetap tampil dan cukup untuk debugging.
 */
const ERROR_DATA_PROPS = new Set(['params', 'parameters', 'detail', 'where', 'args']);

/** `true` bila nama kunci menandakan isinya rahasia. Tidak peka huruf besar/kecil maupun pemisah. */
export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_KEYS_EXACT.has(normalized)) return true;
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

// ── Sensor teks ─────────────────────────────────────────────────────────────
//
// Ada dua ragam:
//  - `text`: teks apa adanya (nilai string, pesan error, stack).
//  - `json`: satu baris log yang SUDAH berbentuk JSON. Di sini tanda kutip dan garis miring
//    terbalik adalah bagian dari struktur, jadi pola tidak pernah menelan `"` tanpa `\` di
//    depannya dan tidak pernah memutus pasangan escape — baris selalu tetap JSON yang sah.

type TextMode = 'text' | 'json';

type Replacement = readonly [pattern: RegExp, replacement: string];

const HEADER_NAMES =
  'set-cookie|cookie|proxy-authorization|authorization|x-api-key|x-csrf-token|x-hub-signature(?:-256)?|x-balesin-signature';

/** Pola yang bentuknya sama untuk kedua ragam (tidak menyentuh `"` maupun `\`). */
const COMMON_PATTERNS: readonly Replacement[] = [
  // Kredensial di URL — skema://user:password@host — sampai `@` TERAKHIR sebelum akhir host,
  // karena password boleh memuat `@`.
  [/\b([a-z][a-z0-9+.-]{1,30}:\/\/)[^\s/?#"'<>\\]*@/gi, `$1${REDACTED}@`],
  // Skema otentikasi HTTP
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Kode otorisasi OAuth di query string (`code` terlalu umum untuk disensor di tempat lain)
  [/([?&]code=)[^&\s"'#\\]+/g, `$1${REDACTED}`],
  // Tanda tangan HMAC, mis. isi X-Hub-Signature-256
  [/\b(sha(?:1|256|384|512)=)[A-Fa-f0-9]{16,}/g, `$1${REDACTED}`],
  // Token akses Meta (selalu berawalan "EAA")
  [/\bEAA[A-Za-z0-9]{20,}/g, REDACTED],
  // API key Balesin: blsn_<prefix>_<secret> — prefix dibiarkan agar key bisa dikenali
  [/\b(blsn_[A-Za-z0-9]+_)[A-Za-z0-9_-]{8,}/g, `$1${REDACTED}`],
  // Token bot Telegram: <id bot>:<rahasia>, juga di path URL (/bot<id>:<rahasia>/…)
  [/(?<![A-Za-z0-9])((?:bot)?\d{6,12}:)[A-Za-z0-9_-]{30,}/g, `$1${REDACTED}`],
];

const MODE_PATTERNS: Record<TextMode, readonly Replacement[]> = {
  text: [
    // user:password@ dengan password yang memuat tanda kutip atau garis miring terbalik.
    // Untuk http(s) password tidak boleh memuat `,` `}` `]`: tanpa batas itu JSON berisi URL
    // ber-port yang diikuti alamat email ("https://x:8080","email":"a@b") ikut tertangkap.
    [/\b((?!https?:)[a-z][a-z0-9+.-]{1,30}:\/\/[^\s/?#"'@:]*:)[^\s/?#]*@/gi, `$1${REDACTED}@`],
    [/\b(https?:\/\/[^\s/?#"'@:]*:)[^\s/?#,}\]]*@/gi, `$1${REDACTED}@`],
    // Baris header mentah atau hasil util.inspect: `Cookie: a=b`, `'set-cookie': [ 'a=b' ]`.
    // (Bentuk JSON `"cookie":"…"` ditangani `redactJsonPairs`.)
    [new RegExp(`\\b((?:${HEADER_NAMES})'?\\s*:\\s*)[^\\r\\n]+`, 'gi'), `$1${REDACTED}`],
    // Redis mengulang argumen perintah yang tidak dikenalnya (bisa berisi password AUTH)
    [/(with args beginning with:)[^\n]*/g, `$1 ${REDACTED}`],
    // Postgres mengulang nilai yang gagal diubah tipenya
    [/(invalid input (?:syntax|value) for [A-Za-z0-9_ ]{1,60}: )[^\n]*/g, `$1${REDACTED}`],
  ],
  json: [
    [
      /\b((?!https?:)[a-z][a-z0-9+.-]{1,30}:\/\/[^\s/?#"'@:\\]*:)(?:[^\s/?#"\\]|\\["\\])*@/gi,
      `$1${REDACTED}@`,
    ],
    [/\b(https?:\/\/[^\s/?#"'@:\\]*:)(?:[^\s/?#"\\,}\]]|\\["\\])*@/gi, `$1${REDACTED}@`],
    [
      new RegExp(`\\b((?:${HEADER_NAMES})'?\\s*:\\s*)(?:[^"\\\\]|\\\\["\\\\])+`, 'gi'),
      `$1${REDACTED}`,
    ],
    // Dua pola berikut berhenti di akhir baris (baris baru ter-escape), sama seperti ragam teks,
    // supaya frame stack sesudahnya tidak ikut terhapus.
    [/(with args beginning with:)(?:[^"\\]|\\[^n])*/g, `$1 ${REDACTED}`],
    [
      /(invalid input (?:syntax|value) for [A-Za-z0-9_ ]{1,60}: )(?:[^"\\]|\\[^n])*/g,
      `$1${REDACTED}`,
    ],
  ],
};

/**
 * Error query Drizzle menulis semua nilai parameter di pesannya, di baris kedua:
 * "Failed query: <sql>" lalu "params: <nilai1>,<nilai2>". Semua setelah "params: " disensor —
 * sampai akhir teks (ragam `text`) atau sampai tanda kutip penutup string JSON-nya (ragam
 * `json`, tempat baris baru tertulis sebagai `\` + `n`).
 *
 * Sengaja memakai `indexOf`, bukan regex: versi regex berjalan kuadratik untuk teks yang
 * mengulang "Failed query: " (temuan S2 pada review keamanan Fase 0).
 */
const QUERY_HEAD = 'Failed query: ';
const QUERY_PARAMS_MARKER: Record<TextMode, string> = {
  text: '\nparams: ',
  json: '\\nparams: ',
};

/** Indeks tanda kutip penutup string JSON yang memuat posisi `from` (atau panjang teks). */
function endOfJsonString(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (char === 0x5c)
      index += 1; // `\` — lewati karakter yang di-escape
    else if (char === 0x22) return index; // `"`
  }
  return text.length;
}

function redactQueryParams(text: string, mode: TextMode): string {
  let head = text.indexOf(QUERY_HEAD);
  if (head === -1) return text;

  const marker = QUERY_PARAMS_MARKER[mode];
  let result = '';
  let copied = 0;
  while (head !== -1) {
    const limit = mode === 'json' ? endOfJsonString(text, head) : text.length;
    // Penanda dicari hanya di dalam string yang memuat "Failed query: " ini.
    const markerAt = text.slice(head, limit).indexOf(marker);
    if (markerAt !== -1) {
      const valueStart = head + markerAt + marker.length;
      result += text.slice(copied, valueStart) + REDACTED;
      copied = limit;
    }
    head = text.indexOf(QUERY_HEAD, limit);
  }
  return copied === 0 ? text : result + text.slice(copied);
}

/**
 * Pasangan JSON `"kunci":"nilai"` atau `"kunci":123` dengan kunci berbau rahasia, di tingkat
 * escape berapa pun: `"password":"x"`, `\"password\":\"x\"` (JSON di dalam string JSON), dst.
 * Dipakai kedua ragam: pemindaian nilai berhenti SEBELUM tanda kutip yang bukan jelas-jelas
 * tanda kutip ter-escape milik isi nilai itu sendiri, jadi struktur JSON di sekelilingnya utuh.
 */
const JSON_PAIR_HEAD = /"([A-Za-z0-9_.-]{1,64})(\\*)"\s*:\s*/g;
const JSON_NUMBER = /-?\d[\d.eE+-]{0,40}/y;

function countBackslashes(text: string, from: number): number {
  let index = from;
  while (text.charCodeAt(index) === 0x5c) index += 1;
  return index - from;
}

/**
 * Akhir nilai string yang tanda kutip pembukanya didahului `escapeDepth` garis miring terbalik.
 * Tanda kutip di dalam nilai itu sendiri didahului tepat `2 × escapeDepth + 1` garis miring
 * (modulo satu tingkat escape); tanda kutip lain — penutup nilai ini maupun penutup string yang
 * membungkusnya — menghentikan pemindaian.
 */
function endOfEscapedString(text: string, from: number, escapeDepth: number): number {
  const modulus = 2 * (escapeDepth + 1);
  let index = from;
  while (index < text.length) {
    const char = text.charCodeAt(index);
    if (char === 0x22) return index;
    if (char !== 0x5c) {
      index += 1;
      continue;
    }
    const run = countBackslashes(text, index);
    if (text.charCodeAt(index + run) === 0x22) {
      if (run % modulus !== modulus - 1) return index;
      index += run + 1;
    } else {
      index += run;
    }
  }
  return text.length;
}

function redactJsonPairs(text: string): string {
  let result = '';
  let copied = 0;
  JSON_PAIR_HEAD.lastIndex = 0;
  for (let head = JSON_PAIR_HEAD.exec(text); head !== null; head = JSON_PAIR_HEAD.exec(text)) {
    if (!isSensitiveKey(head[1] ?? '')) continue;

    const keyEscape = head[2] ?? '';
    const valueAt = JSON_PAIR_HEAD.lastIndex;
    const valueEscape = countBackslashes(text, valueAt);
    let redacted: string | undefined;
    let valueStart = valueAt;
    let valueEnd = valueAt;

    if (text.charCodeAt(valueAt + valueEscape) === 0x22) {
      // Tanda kutip pembuka nilai harus setingkat dengan tanda kutip kuncinya. Kalau tidak,
      // itu tanda kutip milik struktur di luarnya (mis. penutup string JSON pembungkus).
      if (valueEscape !== keyEscape.length) continue;
      valueStart = valueAt + valueEscape + 1;
      valueEnd = endOfEscapedString(text, valueStart, valueEscape);
      redacted = REDACTED;
    } else if (valueEscape === 0) {
      JSON_NUMBER.lastIndex = valueAt;
      const number = JSON_NUMBER.exec(text);
      if (number) {
        valueEnd = valueAt + number[0].length;
        // Angka diganti STRING (dengan tingkat escape yang sama dengan kuncinya) supaya JSON tetap sah.
        redacted = `${keyEscape}"${REDACTED}${keyEscape}"`;
      }
    }
    if (redacted === undefined) continue; // objek, array, true/false/null: tidak ada yang disensor

    result += text.slice(copied, valueStart) + redacted;
    copied = valueEnd;
    JSON_PAIR_HEAD.lastIndex = valueEnd;
  }
  return copied === 0 ? text : result + text.slice(copied);
}

/**
 * `kunci=nilai` (query string, form-urlencoded, conninfo libpq, atribut) dengan kunci berbau
 * rahasia — termasuk yang berawalan, mis. `reset_token=`, `new_password=`. Nilai boleh
 * diapit tanda kutip. Kunci yang bukan rahasia dilewati TANPA menelan nilainya, supaya
 * `url="…?token=abc"` tetap terperiksa.
 */
const ASSIGNMENT_KEY = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{1,64})=/g;
const ASSIGNMENT_VALUE: Record<TextMode, RegExp> = {
  text: /"[^"\n]*"?|'[^'\n]*'?|[^&\s"'#]+/y,
  json: /\\"(?:[^"\\]|\\\\)*(?:\\")?|'[^'"\\]*'?|(?:[^&\s"'#\\]|\\\\)+/y,
};

/** Ganti isi nilai, pertahankan tanda kutip pengapitnya (bila ada). */
function redactAssignmentValue(value: string): string {
  const quote = /^(?:\\"|"|')/.exec(value)?.[0];
  if (!quote) return REDACTED;
  const closed = value.length > quote.length && value.endsWith(quote);
  return `${quote}${REDACTED}${closed ? quote : ''}`;
}

function redactAssignments(text: string, mode: TextMode): string {
  const valuePattern = ASSIGNMENT_VALUE[mode];
  let result = '';
  let copied = 0;
  ASSIGNMENT_KEY.lastIndex = 0;
  for (let key = ASSIGNMENT_KEY.exec(text); key !== null; key = ASSIGNMENT_KEY.exec(text)) {
    if (!isSensitiveKey(key[1] ?? '')) continue;

    const valueStart = ASSIGNMENT_KEY.lastIndex;
    valuePattern.lastIndex = valueStart;
    const value = valuePattern.exec(text);
    if (!value) continue;

    result += text.slice(copied, valueStart) + redactAssignmentValue(value[0]);
    copied = valueStart + value[0].length;
    ASSIGNMENT_KEY.lastIndex = copied;
  }
  return copied === 0 ? text : result + text.slice(copied);
}

function scrub(text: string, mode: TextMode): string {
  let result = redactQueryParams(text, mode);
  result = redactJsonPairs(result);
  for (const [pattern, replacement] of MODE_PATTERNS[mode]) {
    result = result.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of COMMON_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return redactAssignments(result, mode);
}

/** Menyensor pola rahasia di dalam teks bebas. Aman dipanggil berulang (idempoten). */
export function scrubSecretsInText(text: string): string {
  return scrub(text, 'text');
}

/**
 * Sama seperti `scrubSecretsInText`, untuk satu baris log yang SUDAH berbentuk JSON:
 * hasilnya selalu tetap JSON yang sah.
 */
export function scrubSecretsInJsonLine(line: string): string {
  return scrub(line, 'json');
}

/** Potong teks yang terlalu panjang untuk log (lihat `MAX_LOGGED_STRING_LENGTH`). */
export function clipForLog(text: string): string {
  if (text.length <= MAX_LOGGED_STRING_LENGTH) return text;
  return `${text.slice(0, MAX_LOGGED_STRING_LENGTH)}… [dipotong dari ${text.length} karakter]`;
}

/** Teks yang aman untuk log: dipotong bila terlalu panjang, lalu disensor. */
export function sanitizeText(text: string): string {
  return scrubSecretsInText(clipForLog(text));
}

// ── Sensor objek ────────────────────────────────────────────────────────────

/**
 * Salinan `value` yang aman untuk di-log: nilai kunci rahasia diganti `[DISEMBUNYIKAN]`,
 * teks disaring pola rahasianya (dan dipotong bila terlalu panjang), data biner dan `Secret`
 * tidak pernah ditampilkan, dan `Error` diubah jadi objek biasa. Nilai asli tidak diubah.
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
  if (typeof value === 'string') return sanitizeText(value);
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
    if (key === 'command' && typeof item === 'object' && item !== null) {
      // ioredis menempelkan `command = { name, args }` pada setiap error balasan Redis. `args`
      // memuat SEMUA argumen perintah yang gagal: password AUTH, nama kunci, isi job. Hanya
      // nama perintahnya yang boleh masuk log.
      const { name } = item as { name?: unknown };
      result[key] = { name: typeof name === 'string' ? sanitizeText(name) : undefined };
      continue;
    }
    result[key] =
      isSensitiveKey(key) || ERROR_DATA_PROPS.has(key)
        ? redactValueOfSensitiveKey(item)
        : walk(item, depth + 1, ancestors);
  }
  return result;
}

/** Error dari Postgres (driver `pg`): punya `severity` dan `code` SQLSTATE lima karakter. */
function sqlStateOf(error: Error): string | undefined {
  const candidate = error as Error & { code?: unknown; severity?: unknown };
  if (typeof candidate.severity !== 'string' || typeof candidate.code !== 'string') {
    return undefined;
  }
  return /^[0-9A-Z]{5}$/.test(candidate.code) ? candidate.code : undefined;
}

/**
 * Pesan error yang aman untuk log.
 *  - Error query Drizzle menulis seluruh nilai parameter di pesannya ("Failed query: …" lalu
 *    "params: nilai1,nilai2"), jadi pesannya disusun ulang hanya dari teks SQL (yang memakai
 *    placeholder `$1`, bukan nilai).
 *  - Error Postgres kelas 22 (data exception, mis. 22P02) mengulang nilai yang ditolak:
 *    `invalid input syntax for type uuid: "<nilai>"`. Bagian setelah `: "` dibuang.
 */
export function describeError(error: Error): string {
  const candidate = error as Error & { query?: unknown; params?: unknown };
  if (typeof candidate.query === 'string' && 'params' in candidate) {
    return sanitizeText(`${QUERY_HEAD}${candidate.query}`);
  }
  if (sqlStateOf(error)?.startsWith('22')) {
    const valueAt = error.message.indexOf(': "');
    if (valueAt !== -1) return sanitizeText(`${error.message.slice(0, valueAt)}: ${REDACTED}`);
  }
  return sanitizeText(error.message);
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
  const frames = framesAt === -1 ? '' : sanitizeText(stack.slice(framesAt));
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
