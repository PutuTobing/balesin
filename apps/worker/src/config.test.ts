import { EnvValidationError, type EnvSource } from '@balesin/core';
import { describe, expect, it } from 'vitest';

import { loadConfig } from './config';

const developmentEnv: EnvSource = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'debug',
  APP_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://balesin:sandi-db@localhost:5432/balesin',
  REDIS_URL: 'redis://:sandi-redis@localhost:6379',
  BALESIN_MASTER_KEY: '',
};

describe('loadConfig (worker)', () => {
  it('menerima env development tanpa master key', () => {
    const config = loadConfig(developmentEnv);

    expect(config).toMatchObject({
      env: 'development',
      isProduction: false,
      logLevel: 'debug',
      masterKey: null,
    });
    expect(config.redisUrl.reveal()).toBe(developmentEnv.REDIS_URL);
    expect(JSON.stringify(config)).not.toContain('sandi-');
  });

  it('membaca cadangan SMTP yang sama dengan api, tanpa membocorkan passwordnya', () => {
    const none = loadConfig(developmentEnv);
    const config = loadConfig({
      ...developmentEnv,
      SMTP_HOST: 'mail.contoh.co.id',
      SMTP_FROM: 'Balesin Contoh <cs@contoh.co.id>',
      SMTP_USER: 'cs@contoh.co.id',
      SMTP_PASSWORD: 'sandi-smtp-env',
    });

    expect(none.smtpFallback).toBeNull();
    expect(config.smtpFallback).toMatchObject({
      host: 'mail.contoh.co.id',
      port: 465,
      security: 'ssl',
      username: 'cs@contoh.co.id',
      fromName: 'Balesin Contoh',
      fromAddress: 'cs@contoh.co.id',
    });
    expect(config.smtpFallback?.password?.reveal()).toBe('sandi-smtp-env');
    expect(JSON.stringify(config)).not.toContain('sandi-smtp-env');
  });

  it('port penangkap email lokal (1025) hanya diizinkan di luar production', () => {
    const production = loadConfig({
      ...developmentEnv,
      NODE_ENV: 'production',
      BALESIN_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
    });

    expect(loadConfig(developmentEnv).smtpAllowedPorts).toEqual([25, 465, 587, 2525, 1025]);
    expect(production.smtpAllowedPorts).toEqual([25, 465, 587, 2525]);
  });

  it('mengabaikan variabel yang hanya dipakai api', () => {
    const config = loadConfig({ ...developmentEnv, API_URL: 'bukan url', API_PORT: 'abc' });
    expect(config.env).toBe('development');
  });

  it('APP_URL wajib (sumber tautan email) dan wajib https di production', () => {
    expect(loadConfig(developmentEnv).appUrl).toBe('http://localhost:5173');
    const problemsOf = (source: EnvSource) => {
      try {
        loadConfig(source);
      } catch (caught) {
        return (caught as EnvValidationError).problems.map((problem) => problem.variable);
      }
      return [];
    };
    expect(problemsOf({ ...developmentEnv, APP_URL: '' })).toEqual(['APP_URL']);
    expect(problemsOf({ ...developmentEnv, APP_URL: 'bukan url' })).toEqual(['APP_URL']);
    expect(
      problemsOf({
        ...developmentEnv,
        NODE_ENV: 'production',
        BALESIN_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
        APP_URL: 'http://balesin.contoh.co.id',
      }),
    ).toEqual(['APP_URL']);
  });

  it('mewajibkan master key di production dan menolak env yang salah tanpa mencetak nilainya', () => {
    const error = (() => {
      try {
        loadConfig({ ...developmentEnv, NODE_ENV: 'production', REDIS_URL: 'http://sandi-nyasar' });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(EnvValidationError);
    const { problems, message } = error as EnvValidationError;
    expect(problems.map((problem) => problem.variable).sort()).toEqual([
      'BALESIN_MASTER_KEY',
      'REDIS_URL',
    ]);
    expect(message).not.toContain('sandi-nyasar');
  });
});
