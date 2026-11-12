import { describe, expect, it } from 'vitest';

import { serializeRequest, serializeResponse } from './logger';
import { REDACTED, Secret } from './secret';
import { createLogCapture } from './testing';

describe('createLogger', () => {
  it('menulis JSON dengan level berlabel, waktu ISO, dan nama layanan', () => {
    const capture = createLogCapture();
    capture.logger.info({ userId: 'u1' }, 'halo');

    const [entry] = capture.entries();
    expect(entry).toMatchObject({ level: 'info', service: 'test', userId: 'u1', msg: 'halo' });
    expect(typeof entry?.time).toBe('string');
    expect(Number.isNaN(Date.parse(entry?.time as string))).toBe(false);
  });

  it('menghormati level log', () => {
    const capture = createLogCapture('warn');
    capture.logger.info('tidak tampil');
    capture.logger.warn('tampil');
    expect(capture.entries().map((entry) => entry.msg)).toEqual(['tampil']);
  });

  it('menyensor header sensitif di lokasi mana pun', () => {
    const capture = createLogCapture();
    const headers = {
      authorization: 'Bearer token-abc-123456',
      cookie: 'balesin_sid=sesi-rahasia',
      'set-cookie': ['balesin_sid=sesi-baru'],
      'x-api-key': 'blsn_live_kuncirahasia123',
      'x-hub-signature': 'sha1=aaaa1111',
      'x-hub-signature-256': 'sha256=bbbb2222',
      'user-agent': 'vitest',
    };

    capture.logger.info({ headers }, 'header tingkat atas');
    capture.logger.info({ request: { headers } }, 'header bersarang');
    capture.logger.info({ webhook: { delivery: { attempt: { headers } } } }, 'header dalam');

    const text = capture.text();
    for (const secret of [
      'token-abc-123456',
      'sesi-rahasia',
      'sesi-baru',
      'kuncirahasia123',
      'aaaa1111',
      'bbbb2222',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('vitest');
    expect(capture.entries()[0]?.headers).toMatchObject({
      authorization: REDACTED,
      cookie: REDACTED,
      'user-agent': 'vitest',
    });
  });

  it('menyensor kunci rahasia di objek bersarang', () => {
    const capture = createLogCapture();
    capture.logger.info(
      {
        password: 'p-atas',
        channel: {
          access_token: 't-akses',
          meta: { app_secret: 's-app', nested: [{ api_key: 'k-api', token: 't-dalam' }] },
        },
        env: { BALESIN_MASTER_KEY: 'mk-base64', SESSION_SECRET: 'ss-rahasia' },
        config: { masterKey: new Secret(Buffer.from('kunci-master')), smtp: { secret: 'x-rhs' } },
      },
      'konfigurasi',
    );

    const text = capture.text();
    for (const secret of [
      'p-atas',
      't-akses',
      's-app',
      'k-api',
      't-dalam',
      'mk-base64',
      'ss-rahasia',
      'kunci-master',
      'x-rhs',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('menyensor binding child logger', () => {
    const capture = createLogCapture();
    capture.logger.child({ token: 'child-token', module: 'auth' }).info('dari child');

    expect(capture.text()).not.toContain('child-token');
    expect(capture.entries()[0]).toMatchObject({ module: 'auth', token: REDACTED });
  });

  it('menyensor pola rahasia di teks pesan', () => {
    const capture = createLogCapture();
    capture.logger.error('gagal konek ke %s', 'postgres://balesin:sandi-db@db:5432/balesin');
    capture.logger.info('memanggil https://graph.facebook.com/v1/x?access_token=TOKENMETA123');

    const text = capture.text();
    expect(text).not.toContain('sandi-db');
    expect(text).not.toContain('TOKENMETA123');
    expect(capture.entries()).toHaveLength(2);
  });

  it('mencatat error lengkap dengan stack, tanpa rahasianya', () => {
    const capture = createLogCapture();
    const error = Object.assign(new Error('Invalid URL'), {
      code: 'ERR_INVALID_URL',
      input: 'redis://:sandi-redis@cache:6379',
    });

    capture.logger.error({ err: error }, 'gagal start');

    const [entry] = capture.entries();
    const err = entry?.err as Record<string, unknown>;
    expect(err.type).toBe('Error');
    expect(err.message).toBe('Invalid URL');
    expect(err.code).toBe('ERR_INVALID_URL');
    expect(String(err.stack)).toContain('logger.test');
    expect(capture.text()).not.toContain('sandi-redis');
  });

  it('tidak membocorkan parameter query walau error di-log tanpa pesan', () => {
    const makeError = () =>
      Object.assign(
        new Error(
          'Failed query: update "users" set "password_hash" = $1\nparams: hash-super-rahasia',
        ),
        { query: 'update "users" set "password_hash" = $1', params: ['hash-super-rahasia'] },
      );
    const capture = createLogCapture();

    capture.logger.error(makeError());
    capture.logger.error({ err: makeError() });
    capture.logger.error({ err: makeError() }, 'gagal memperbarui pengguna');
    capture.logger.error(makeError(), 'gagal memperbarui pengguna');
    capture.logger.error(`teks bebas: ${makeError().message}`);

    expect(capture.text()).not.toContain('hash-super-rahasia');
    const entries = capture.entries();
    expect(entries).toHaveLength(5);
    expect(entries[0]?.msg).toBe('Failed query: update "users" set "password_hash" = $1');
    expect(entries[2]?.msg).toBe('gagal memperbarui pengguna');
    expect(entries[3]?.msg).toBe('gagal memperbarui pengguna');
    expect((entries[3]?.err as Record<string, unknown>).params).toBe(REDACTED);
  });
});

describe('serializer request/response', () => {
  it('hanya mencatat method, path tanpa query, dan IP', () => {
    const serialized = serializeRequest({
      method: 'GET',
      url: '/webhooks/whatsapp/abc?hub.verify_token=rahasia&hub.challenge=1',
      ip: '10.0.0.7',
      headers: { authorization: 'Bearer abc' },
      body: { password: 'x' },
    });

    expect(serialized).toEqual({ method: 'GET', url: '/webhooks/whatsapp/abc', ip: '10.0.0.7' });
  });

  it('menerima IncomingMessage mentah dan nilai yang bukan objek', () => {
    expect(
      serializeRequest({ method: 'POST', url: '/x#frag', socket: { remoteAddress: '::1' } }),
    ).toEqual({ method: 'POST', url: '/x', ip: '::1' });
    expect(serializeRequest(undefined)).toEqual({});
    expect(serializeResponse({ statusCode: 201, headers: { 'set-cookie': 'a=b' } })).toEqual({
      statusCode: 201,
    });
  });

  it('dipakai otomatis untuk kunci req dan res', () => {
    const capture = createLogCapture();
    capture.logger.info(
      {
        req: { method: 'GET', url: '/a?token=q-rahasia', headers: { cookie: 'sid=c-rahasia' } },
        res: { statusCode: 200, headers: { 'set-cookie': 'sid=s-rahasia' } },
      },
      'request completed',
    );

    const [entry] = capture.entries();
    expect(entry?.req).toEqual({ method: 'GET', url: '/a' });
    expect(entry?.res).toEqual({ statusCode: 200 });
    expect(capture.text()).not.toMatch(/rahasia/);
  });
});
