import { describe, expect, it } from 'vitest';

import { PG_ERROR_CODES, getPgError, isPgError } from './errors';
import { newId } from './ids';

/** Bentuk error driver Postgres: ada `code` SQLSTATE dan `severity`. */
function pgError(code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error('pg'), { code, severity: 'ERROR', ...extra });
}

describe('getPgError / isPgError', () => {
  it('membaca error Postgres langsung', () => {
    const error = pgError('23505', { constraint: 'users_email_key', table: 'users' });
    expect(getPgError(error)).toMatchObject({
      code: '23505',
      constraint: 'users_email_key',
      table: 'users',
    });
    expect(isPgError(error, PG_ERROR_CODES.uniqueViolation)).toBe(true);
  });

  it('menelusuri rantai cause (Drizzle membungkus error driver)', () => {
    const wrapped = new Error('Failed query', { cause: pgError('23503') });
    expect(isPgError(wrapped, PG_ERROR_CODES.foreignKeyViolation)).toBe(true);
    const deeper = new Error('luar', { cause: new Error('tengah', { cause: pgError('23514') }) });
    expect(isPgError(deeper, PG_ERROR_CODES.checkViolation)).toBe(true);
  });

  it('mencocokkan nama constraint bila diberikan', () => {
    const error = pgError('23505', { constraint: 'users_email_key' });
    expect(isPgError(error, PG_ERROR_CODES.uniqueViolation, 'users_email_key')).toBe(true);
    expect(isPgError(error, PG_ERROR_CODES.uniqueViolation, 'lain')).toBe(false);
  });

  it('kode berbeda tidak cocok', () => {
    expect(isPgError(pgError('23505'), PG_ERROR_CODES.notNullViolation)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['string', 'error'],
    ['angka', 42],
    ['Error biasa', new Error('biasa')],
    ['code bukan SQLSTATE', Object.assign(new Error('x'), { code: 'ECONNRESET', severity: 'x' })],
    ['code tanpa severity', Object.assign(new Error('x'), { code: '23505' })],
  ])('bukan error Postgres: %s', (_nama, value) => {
    expect(getPgError(value)).toBeUndefined();
    expect(isPgError(value, PG_ERROR_CODES.uniqueViolation)).toBe(false);
  });

  it('rantai cause melingkar tidak membuat loop tak berujung', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b', { cause: a });
    a.cause = b;
    expect(getPgError(a)).toBeUndefined();
  });
});

describe('newId', () => {
  it('UUIDv7 yang valid dan unik', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});
