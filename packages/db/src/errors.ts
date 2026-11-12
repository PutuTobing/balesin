/** Kode SQLSTATE Postgres yang sering perlu ditangani aplikasi. */
export const PG_ERROR_CODES = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  invalidTextRepresentation: '22P02',
} as const;

export type PgErrorCode = (typeof PG_ERROR_CODES)[keyof typeof PG_ERROR_CODES];

/** Bagian error Postgres yang aman dipakai untuk logika (tanpa nilai data). */
export interface PgErrorInfo {
  code: string;
  constraint?: string;
  table?: string;
  column?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Mengambil info error Postgres dari sebuah error. Drizzle membungkus error driver
 * (`DrizzleQueryError` dengan `cause`), jadi rantai `cause` ikut ditelusuri.
 */
export function getPgError(error: unknown): PgErrorInfo | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as Record<string, unknown>;
    const code = asString(candidate.code);
    if (code && /^[0-9A-Z]{5}$/.test(code) && typeof candidate.severity === 'string') {
      return {
        code,
        constraint: asString(candidate.constraint),
        table: asString(candidate.table),
        column: asString(candidate.column),
      };
    }
    current = candidate.cause;
  }
  return undefined;
}

/**
 * `true` bila `error` adalah error Postgres dengan kode tersebut (dan, bila diberikan,
 * berasal dari constraint tersebut). Contoh: mengubah bentrok email jadi HTTP 409.
 */
export function isPgError(error: unknown, code: PgErrorCode, constraint?: string): boolean {
  const info = getPgError(error);
  if (!info || info.code !== code) return false;
  return constraint === undefined || info.constraint === constraint;
}
