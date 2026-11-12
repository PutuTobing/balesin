import { EnvValidationError, type EnvSource } from '@balesin/core';
import { describe, expect, it } from 'vitest';

import { loadConfig } from './config';

const developmentEnv: EnvSource = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'debug',
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

  it('mengabaikan variabel yang hanya dipakai api', () => {
    const config = loadConfig({ ...developmentEnv, APP_URL: 'bukan url', API_PORT: 'abc' });
    expect(config.env).toBe('development');
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
