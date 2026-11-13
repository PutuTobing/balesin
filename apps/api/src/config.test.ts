import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { EnvValidationError, REDACTED, type EnvSource } from '@balesin/core';
import { describe, expect, it } from 'vitest';

import { loadConfig } from './config';

const MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
const SESSION_SECRET = 'rahasia-sesi-yang-panjangnya-lebih-dari-32-karakter';

/** Sama dengan nilai di `.env.example`. */
const developmentEnv: EnvSource = {
  NODE_ENV: 'development',
  APP_URL: 'http://localhost:5173',
  API_URL: 'http://localhost:3000',
  API_HOST: '127.0.0.1',
  API_PORT: '3000',
  LOG_LEVEL: 'info',
  TRUST_PROXY: 'false',
  DATABASE_URL: 'postgres://balesin:sandi-db@localhost:5432/balesin',
  REDIS_URL: 'redis://:sandi-redis@localhost:6379',
  BALESIN_MASTER_KEY: '',
  SESSION_SECRET: '',
  SETUP_TOKEN: '',
  SMTP_HOST: '',
  SMTP_PORT: '465',
  SMTP_SECURE: 'true',
  SMTP_USER: '',
  SMTP_PASSWORD: '',
  SMTP_FROM: '',
  META_GRAPH_VERSION: '',
  MEDIA_DIR: './media',
  OUTBOUND_PRIVATE_ALLOWLIST: '',
};

const productionEnv: EnvSource = {
  ...developmentEnv,
  NODE_ENV: 'production',
  APP_URL: 'https://balesin.contoh.co.id',
  API_URL: 'https://balesin.contoh.co.id/api',
  BALESIN_MASTER_KEY: MASTER_KEY,
  SESSION_SECRET,
};

function captureError(source: EnvSource): EnvValidationError {
  try {
    loadConfig(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error;
    throw error;
  }
  throw new Error('seharusnya melempar EnvValidationError');
}

describe('loadConfig', () => {
  it('menerima nilai .env.example untuk development', () => {
    const config = loadConfig(developmentEnv);

    expect(config).toMatchObject({
      env: 'development',
      isProduction: false,
      logLevel: 'info',
      appUrl: 'http://localhost:5173',
      appOrigin: 'http://localhost:5173',
      apiUrl: 'http://localhost:3000',
      host: '127.0.0.1',
      port: 3000,
      trustProxy: false,
      masterKey: null,
      sessionSecret: null,
      setupToken: null,
      smtpFallback: null,
      metaGraphVersion: null,
      mediaDir: './media',
      outboundPrivateAllowlist: [],
    });
    expect(config.databaseUrl.reveal()).toBe(developmentEnv.DATABASE_URL);
    expect(config.redisUrl.reveal()).toBe(developmentEnv.REDIS_URL);
  });

  it('cookie sesi: Secure/__Host- mengikuti skema APP_URL (http hanya untuk localhost)', () => {
    expect(loadConfig(developmentEnv).cookieSecure).toBe(false);
    expect(loadConfig(productionEnv).cookieSecure).toBe(true);
    expect(
      loadConfig({ ...developmentEnv, APP_URL: 'https://balesin.contoh.co.id' }).cookieSecure,
    ).toBe(true);
    // Di production http hanya lolos validasi untuk localhost, jadi cookie tanpa Secure tidak
    // mungkin dipakai di alamat publik.
    expect(loadConfig({ ...productionEnv, APP_URL: 'http://localhost:5173' }).cookieSecure).toBe(
      false,
    );
    expect(
      captureError({ ...productionEnv, APP_URL: 'http://balesin.contoh.co.id' }).problems,
    ).toEqual([expect.objectContaining({ variable: 'APP_URL' })]);
  });

  it('port SMTP yang boleh dituju: production hanya port baku; development menambah 1025 (Mailpit)', () => {
    expect(loadConfig(productionEnv).smtpAllowedPorts).toEqual([25, 465, 587, 2525]);
    expect(loadConfig(developmentEnv).smtpAllowedPorts).toEqual([25, 465, 587, 2525, 1025]);
  });

  it('mengisi nilai bawaan bila variabel opsional tidak ada', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      APP_URL: 'http://localhost:5173',
      API_URL: 'http://localhost:3000',
      DATABASE_URL: developmentEnv.DATABASE_URL,
      REDIS_URL: developmentEnv.REDIS_URL,
    });

    expect(config).toMatchObject({
      env: 'test',
      logLevel: 'info',
      host: '127.0.0.1',
      port: 3000,
      trustProxy: false,
      mediaDir: './media',
    });
  });

  it('SETUP_TOKEN dan SESSION_SECRET wajib acak buatan mesin (temuan R3 review Fase 1)', () => {
    const generated = randomBytes(32).toString('base64url');
    expect(loadConfig({ ...productionEnv, SETUP_TOKEN: generated }).setupToken?.reveal()).toBe(
      generated,
    );
    // Nilai base64 standar (dengan + / =) juga diterima, mis. dari installer lama.
    expect(() =>
      loadConfig({ ...productionEnv, SESSION_SECRET: randomBytes(32).toString('base64') }),
    ).not.toThrow();

    for (const weak of [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'token-setup-acak-123456',
      'abcdefghijklmnopqrstuvwxyzABCDEF',
      'rahasia rahasia rahasia rahasia rahasia',
      'abababababababababababababababababab',
    ]) {
      for (const variable of ['SETUP_TOKEN', 'SESSION_SECRET'] as const) {
        const error = captureError({ ...productionEnv, [variable]: weak });
        expect(error.problems, `${variable}=${weak}`).toEqual([
          expect.objectContaining({ variable }),
        ]);
        expect(error.message).toContain('randomBytes(32)');
        expect(error.message).not.toContain(weak);
      }
    }
  });

  it('menerima konfigurasi production yang lengkap', () => {
    const config = loadConfig({
      ...productionEnv,
      TRUST_PROXY: '10.0.0.2, 10.0.1.0/24',
      SETUP_TOKEN: 'Q9vJ2kLmX4pR7sT1uW8yZ3bC6dF0gH5n',
      META_GRAPH_VERSION: 'v21.0',
      OUTBOUND_PRIVATE_ALLOWLIST: '192.168.10.5,10.10.0.0/16',
    });

    expect(config).toMatchObject({
      env: 'production',
      isProduction: true,
      appOrigin: 'https://balesin.contoh.co.id',
      apiUrl: 'https://balesin.contoh.co.id/api',
      trustProxy: ['10.0.0.2', '10.0.1.0/24'],
      metaGraphVersion: 'v21.0',
      outboundPrivateAllowlist: ['192.168.10.5', '10.10.0.0/16'],
    });
    expect(config.masterKey?.reveal()).toEqual(Buffer.alloc(32, 9));
    expect(config.sessionSecret?.reveal()).toBe(SESSION_SECRET);
    expect(config.setupToken?.reveal()).toBe('Q9vJ2kLmX4pR7sT1uW8yZ3bC6dF0gH5n');
  });

  it('rahasia tidak ikut saat konfigurasi di-serialize', () => {
    const config = loadConfig({
      ...productionEnv,
      SMTP_HOST: 'mail.contoh.co.id',
      SMTP_FROM: 'CS <cs@contoh.co.id>',
      SMTP_PASSWORD: 'sandi-smtp',
    });

    const serialized = JSON.stringify(config);

    for (const secret of ['sandi-db', 'sandi-redis', MASTER_KEY, SESSION_SECRET, 'sandi-smtp']) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain(REDACTED);
    expect(config.smtpFallback).toMatchObject({
      host: 'mail.contoh.co.id',
      port: 465,
      security: 'ssl',
      username: null,
      fromName: 'CS',
      fromAddress: 'cs@contoh.co.id',
    });
    expect(config.smtpFallback?.password?.reveal()).toBe('sandi-smtp');
  });

  it('di production mewajibkan master key dan session secret', () => {
    const error = captureError({ ...productionEnv, BALESIN_MASTER_KEY: '', SESSION_SECRET: '' });

    expect(error.problems).toEqual([
      { variable: 'BALESIN_MASTER_KEY', message: 'wajib diisi di production' },
      { variable: 'SESSION_SECRET', message: 'wajib diisi di production' },
    ]);
  });

  it('di production mewajibkan https, kecuali localhost', () => {
    const error = captureError({ ...productionEnv, APP_URL: 'http://balesin.contoh.co.id' });
    expect(error.problems.map((problem) => problem.variable)).toEqual(['APP_URL']);
    expect(error.message).toContain('wajib https di production');

    const local = loadConfig({
      ...productionEnv,
      APP_URL: 'http://localhost:8080',
      API_URL: 'http://localhost:3000',
    });
    expect(local.appOrigin).toBe('http://localhost:8080');
  });

  it('menyebut semua variabel yang salah, dalam bahasa Indonesia, tanpa nilainya', () => {
    const error = captureError({
      ...developmentEnv,
      APP_URL: 'bukan-url-rahasia',
      API_PORT: '99999',
      LOG_LEVEL: 'berisik',
      TRUST_PROXY: 'mungkin-saja',
      DATABASE_URL: '',
      REDIS_URL: 'http://:sandi-nyasar@localhost:6379',
      BALESIN_MASTER_KEY: 'kunci-pendek',
      SESSION_SECRET: 'pendek',
      SMTP_PORT: 'abc',
      META_GRAPH_VERSION: '21',
      OUTBOUND_PRIVATE_ALLOWLIST: '10.0.0.1,bukan-ip',
    });

    expect(error.problems.map((problem) => problem.variable).sort()).toEqual([
      'API_PORT',
      'APP_URL',
      'BALESIN_MASTER_KEY',
      'DATABASE_URL',
      'LOG_LEVEL',
      'META_GRAPH_VERSION',
      'OUTBOUND_PRIVATE_ALLOWLIST',
      'REDIS_URL',
      'SESSION_SECRET',
      'SMTP_PORT',
      'TRUST_PROXY',
    ]);
    expect(error.message).toContain('Konfigurasi lingkungan tidak valid');
    expect(error.message).toContain('DATABASE_URL: wajib diisi');
    expect(error.message).toContain('API_PORT: harus berupa angka 1–65535');
    for (const value of [
      'bukan-url-rahasia',
      '99999',
      'berisik',
      'mungkin-saja',
      'sandi-nyasar',
      'kunci-pendek',
      'pendek"',
      'bukan-ip',
    ]) {
      expect(error.message).not.toContain(value);
    }
  });

  describe('TRUST_PROXY', () => {
    it.each(['true', '0.0.0.0/0', '::/0', '10.0.0.2,0.0.0.0/0'])(
      'production menolak "%s" (mempercayai semua hop = IP klien bisa dipalsukan)',
      (value) => {
        const error = captureError({ ...productionEnv, TRUST_PROXY: value });

        expect(error.problems.map((problem) => problem.variable)).toEqual(['TRUST_PROXY']);
        expect(error.message).toContain('daftar IP/CIDR proxy tepercaya');
      },
    );

    it('production menerima false dan daftar IP/CIDR proxy', () => {
      expect(loadConfig({ ...productionEnv, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
      expect(loadConfig({ ...productionEnv, TRUST_PROXY: '' }).trustProxy).toBe(false);
      expect(loadConfig({ ...productionEnv, TRUST_PROXY: '10.0.0.2' }).trustProxy).toEqual([
        '10.0.0.2',
      ]);
      expect(
        loadConfig({ ...productionEnv, TRUST_PROXY: '10.0.0.2, 172.18.0.0/16, fd00::/8' })
          .trustProxy,
      ).toEqual(['10.0.0.2', '172.18.0.0/16', 'fd00::/8']);
    });

    it('development boleh true', () => {
      expect(loadConfig({ ...developmentEnv, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    });

    it.each(['1', '0', 'yes', '2'])(
      'angka dan kata lain ("%s") ditolak di lingkungan mana pun: bukan ya/tidak di Fastify',
      (value) => {
        for (const env of [developmentEnv, productionEnv]) {
          const error = captureError({ ...env, TRUST_PROXY: value });
          expect(error.problems.map((problem) => problem.variable)).toEqual(['TRUST_PROXY']);
        }
      },
    );
  });

  it('SMTP cadangan: SMTP_FROM wajib bila SMTP_HOST diisi', () => {
    const error = captureError({ ...developmentEnv, SMTP_HOST: 'mail.contoh.co.id' });

    expect(error.problems).toEqual([
      { variable: 'SMTP_FROM', message: 'wajib diisi bila SMTP_HOST diisi' },
    ]);
  });

  it('tanpa NODE_ENV dianggap production', () => {
    const error = captureError({ ...developmentEnv, NODE_ENV: undefined });

    expect(error.problems.map((problem) => problem.variable)).toEqual([
      'BALESIN_MASTER_KEY',
      'SESSION_SECRET',
    ]);
    expect(error.message).toContain('NODE_ENV tidak diisi');
  });
});

describe('.env.example', () => {
  // Menjaga contoh di root repo tetap cocok dengan validasi: orang yang menyalin
  // `.env.example` menjadi `.env` harus langsung bisa menjalankan API.
  const example = parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'));

  it('langsung valid untuk pengembangan lokal', () => {
    const config = loadConfig(example);

    expect(config.env).toBe('development');
    expect(config.appOrigin).toBe('http://localhost:5173');
    expect(config.port).toBe(3000);
  });

  it('tidak berisi rahasia sungguhan', () => {
    for (const name of ['BALESIN_MASTER_KEY', 'SESSION_SECRET', 'SETUP_TOKEN', 'SMTP_PASSWORD']) {
      expect(example[name], name).toBe('');
    }
  });
});
