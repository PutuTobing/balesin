import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  baseEnvShape,
  cleanEnvSource,
  envDefault,
  envOptional,
  envParse,
  envRequired,
  EnvValidationError,
  isProductionLike,
  parseEnv,
  type EnvSource,
} from './env';
import { REDACTED, Secret } from './secret';

const MASTER_KEY = Buffer.alloc(32, 1).toString('base64');

const validEnv: EnvSource = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://balesin:sandi-db@localhost:5432/balesin',
  REDIS_URL: 'redis://:sandi-redis@localhost:6379',
};

function parseBase(source: EnvSource) {
  return parseEnv(z.object(baseEnvShape(isProductionLike(source))), source);
}

function captureError(run: () => unknown): EnvValidationError {
  try {
    run();
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('seharusnya melempar EnvValidationError');
}

describe('cleanEnvSource', () => {
  it('menganggap variabel kosong sebagai tidak diisi dan memangkas spasi', () => {
    expect(cleanEnvSource({ A: '', B: '   ', C: ' nilai ', D: undefined })).toEqual({ C: 'nilai' });
  });
});

describe('isProductionLike', () => {
  it('hanya development dan test yang longgar', () => {
    expect(isProductionLike({ NODE_ENV: 'development' })).toBe(false);
    expect(isProductionLike({ NODE_ENV: 'test' })).toBe(false);
    expect(isProductionLike({ NODE_ENV: 'production' })).toBe(true);
    expect(isProductionLike({})).toBe(true);
    expect(isProductionLike({ NODE_ENV: 'prod' })).toBe(true);
  });
});

describe('baseEnvShape', () => {
  it('menerima env development tanpa rahasia dan mengisi nilai bawaan', () => {
    const env = parseBase(validEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.BALESIN_MASTER_KEY).toBeNull();
    expect(env.DATABASE_URL).toBeInstanceOf(Secret);
    expect(env.DATABASE_URL.reveal()).toBe(validEnv.DATABASE_URL);
    expect(env.REDIS_URL.reveal()).toBe(validEnv.REDIS_URL);
  });

  it('membungkus rahasia sehingga konfigurasi aman di-serialize', () => {
    const env = parseBase({ ...validEnv, BALESIN_MASTER_KEY: MASTER_KEY });

    expect(env.BALESIN_MASTER_KEY?.reveal()).toEqual(Buffer.alloc(32, 1));
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain('sandi-db');
    expect(serialized).not.toContain('sandi-redis');
    expect(serialized).not.toContain(MASTER_KEY);
    expect(serialized).toContain(REDACTED);
  });

  it('menyebut semua variabel yang salah sekaligus, tanpa mencetak nilainya', () => {
    const error = captureError(() =>
      parseBase({
        NODE_ENV: 'development',
        LOG_LEVEL: 'cerewet-sekali',
        DATABASE_URL: 'mysql://root:sandi-salah@localhost/db',
        BALESIN_MASTER_KEY: 'kunci-terlalu-pendek',
      }),
    );

    expect(error.problems.map((problem) => problem.variable).sort()).toEqual([
      'BALESIN_MASTER_KEY',
      'DATABASE_URL',
      'LOG_LEVEL',
      'REDIS_URL',
    ]);
    expect(error.message).toContain('REDIS_URL: wajib diisi');
    expect(error.message).toContain('DATABASE_URL: harus berupa URL Postgres');
    for (const value of ['cerewet-sekali', 'sandi-salah', 'mysql://', 'kunci-terlalu-pendek']) {
      expect(error.message).not.toContain(value);
      expect(JSON.stringify(error.problems)).not.toContain(value);
    }
  });

  it('mewajibkan master key di production', () => {
    const error = captureError(() => parseBase({ ...validEnv, NODE_ENV: 'production' }));
    expect(error.problems).toEqual([
      { variable: 'BALESIN_MASTER_KEY', message: 'wajib diisi di production' },
    ]);

    const env = parseBase({ ...validEnv, NODE_ENV: 'production', BALESIN_MASTER_KEY: MASTER_KEY });
    expect(env.NODE_ENV).toBe('production');
  });

  it('memperlakukan NODE_ENV kosong sebagai production dan menjelaskannya', () => {
    const error = captureError(() => parseBase({ ...validEnv, NODE_ENV: undefined }));
    expect(error.problems.map((problem) => problem.variable)).toEqual(['BALESIN_MASTER_KEY']);
    expect(error.message).toContain('NODE_ENV tidak diisi');
  });

  it.each([
    ['bukan base64', '!!!bukan-base64!!!'],
    ['16 byte', Buffer.alloc(16).toString('base64')],
    ['64 byte', Buffer.alloc(64).toString('base64')],
  ])('menolak master key %s', (_label, key) => {
    const error = captureError(() => parseBase({ ...validEnv, BALESIN_MASTER_KEY: key }));
    expect(error.problems[0]?.variable).toBe('BALESIN_MASTER_KEY');
    expect(error.message).not.toContain(key);
  });

  it('menolak NODE_ENV yang tidak dikenal', () => {
    const error = captureError(() =>
      parseBase({ ...validEnv, NODE_ENV: 'staging', BALESIN_MASTER_KEY: MASTER_KEY }),
    );
    expect(error.problems).toEqual([
      { variable: 'NODE_ENV', message: 'harus salah satu dari: development, test, production' },
    ]);
  });
});

describe('pengurai nilai', () => {
  it('integer menghormati rentang', () => {
    const port = envParse.integer(1, 65_535);
    expect(port('3000')).toBe(3000);
    expect(port('0')).toBeUndefined();
    expect(port('70000')).toBeUndefined();
    expect(port('30a')).toBeUndefined();
    expect(port('-1')).toBeUndefined();
  });

  it('boolean hanya menerima true/false/1/0', () => {
    expect(envParse.boolean('true')).toBe(true);
    expect(envParse.boolean('0')).toBe(false);
    expect(envParse.boolean('ya')).toBeUndefined();
  });

  it('httpUrl menormalkan dan bisa mewajibkan https', () => {
    expect(envParse.httpUrl()('http://localhost:5173/')).toBe('http://localhost:5173');
    expect(envParse.httpUrl()('https://balesin.contoh.id/app/')).toBe(
      'https://balesin.contoh.id/app',
    );
    expect(envParse.httpUrl()('ftp://contoh.id')).toBeUndefined();
    expect(envParse.httpUrl()('bukan url')).toBeUndefined();
    expect(envParse.httpUrl()('https://user:sandi@contoh.id')).toBeUndefined();

    const httpsOnly = envParse.httpUrl({ httpsOnly: true });
    expect(httpsOnly('https://balesin.contoh.id')).toBe('https://balesin.contoh.id');
    expect(httpsOnly('http://balesin.contoh.id')).toBeUndefined();
    expect(httpsOnly('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('list gagal bila salah satu butir tidak valid', () => {
    const numbers = envParse.list(envParse.integer(0, 9));
    expect(numbers('1, 2,3')).toEqual([1, 2, 3]);
    expect(numbers('1,x')).toBeUndefined();
  });

  it('envRequired / envOptional / envDefault', () => {
    const schema = z.object({
      WAJIB: envRequired(envParse.text, 'tidak valid'),
      OPSIONAL: envOptional(envParse.integer(1, 5), 'harus 1–5'),
      BAWAAN: envDefault(envParse.boolean, false, 'harus true atau false'),
    });

    expect(parseEnv(schema, { WAJIB: 'x' })).toEqual({ WAJIB: 'x', OPSIONAL: null, BAWAAN: false });
    expect(parseEnv(schema, { WAJIB: 'x', OPSIONAL: '3', BAWAAN: 'true' })).toEqual({
      WAJIB: 'x',
      OPSIONAL: 3,
      BAWAAN: true,
    });

    const error = captureError(() => parseEnv(schema, { OPSIONAL: '9', BAWAAN: 'mungkin' }));
    expect(error.problems).toEqual([
      { variable: 'WAJIB', message: 'wajib diisi' },
      { variable: 'OPSIONAL', message: 'harus 1–5' },
      { variable: 'BAWAAN', message: 'harus true atau false' },
    ]);
  });
});
