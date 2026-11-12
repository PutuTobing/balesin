import { describe, expect, it } from 'vitest';

import {
  describeError,
  isSensitiveKey,
  redactSecrets,
  scrubSecretsInJsonLine,
  scrubSecretsInText,
} from './redact';
import { REDACTED, Secret } from './secret';

describe('isSensitiveKey', () => {
  it.each([
    'password',
    'PASSWORD',
    'passwordHash',
    'password_hash',
    'token',
    'access_token',
    'accessToken',
    'hub.verify_token',
    'tokenHash',
    'app_secret',
    'appSecret',
    'client_secret',
    'SESSION_SECRET',
    'api_key',
    'apiKey',
    'x-api-key',
    'authorization',
    'Authorization',
    'cookie',
    'set-cookie',
    'x-hub-signature',
    'x-hub-signature-256',
    'BALESIN_MASTER_KEY',
    'masterKey',
    'DATABASE_URL',
    'redisUrl',
    'pass',
    'auth',
    'otp',
  ])('menganggap "%s" rahasia', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['email', 'name', 'code', 'key', 'author', 'url', 'statusCode', 'requestId', 'passed'])(
    'tidak menganggap "%s" rahasia',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe('scrubSecretsInText', () => {
  it('menyensor kredensial di URL', () => {
    expect(scrubSecretsInText('gagal ke postgres://balesin:s4nd1@db:5432/balesin')).toBe(
      `gagal ke postgres://${REDACTED}@db:5432/balesin`,
    );
    expect(scrubSecretsInText('redis://:rahasia@localhost:6379')).toBe(
      `redis://${REDACTED}@localhost:6379`,
    );
  });

  it('tidak mengubah URL biasa dan alamat email', () => {
    const text = 'buka https://contoh.com/users/budi@contoh.com lalu kirim ke budi@contoh.com';
    expect(scrubSecretsInText(text)).toBe(text);
  });

  it('menyensor Bearer/Basic', () => {
    expect(scrubSecretsInText('Authorization: Bearer abc.def-123_xyz')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
    expect(scrubSecretsInText('basic dXNlcjpwYXNz')).toBe(`basic ${REDACTED}`);
  });

  it('menyensor parameter rahasia di query string', () => {
    const scrubbed = scrubSecretsInText(
      'GET /webhooks/whatsapp/1?hub.mode=subscribe&hub.verify_token=tokenku&hub.challenge=42',
    );
    expect(scrubbed).not.toContain('tokenku');
    expect(scrubbed).toContain('hub.mode=subscribe');
    expect(scrubbed).toContain('hub.challenge=42');

    expect(scrubSecretsInText('https://graph.facebook.com/v1/me?access_token=XYZ123&x=1')).toBe(
      `https://graph.facebook.com/v1/me?access_token=${REDACTED}&x=1`,
    );
  });

  it('menyensor token Meta dan API key Balesin', () => {
    const metaToken = `EAAG${'a1B2c3D4'.repeat(6)}`;
    expect(scrubSecretsInText(`token: ${metaToken}`)).toBe(`token: ${REDACTED}`);
    expect(scrubSecretsInText('kunci blsn_live01_abcdefghijklmnop')).toBe(
      `kunci blsn_live01_${REDACTED}`,
    );
  });

  it('menyensor nilai parameter di pesan error query Drizzle', () => {
    const message =
      'Failed query: insert into "users" values ($1, $2)\nparams: budi@x.com,hash-rahasia';
    const scrubbed = scrubSecretsInText(message);
    expect(scrubbed).toBe(`Failed query: insert into "users" values ($1, $2)\nparams: ${REDACTED}`);
  });

  it('idempoten', () => {
    const once = scrubSecretsInText('postgres://a:b@h/db?password=x Bearer abcdefghij');
    expect(scrubSecretsInText(once)).toBe(once);
  });
});

describe('scrubSecretsInJsonLine', () => {
  it('menjaga baris tetap JSON yang sah', () => {
    const line = JSON.stringify({
      a: 'redis://localhost',
      b: 'budi@contoh.com',
      msg: 'Failed query: select "a" from "t" where "x" = $1\nparams: nilai "berkutip", lain',
      c: 'postgres://u:p@h/db',
      d: 'tetap',
    });
    const scrubbed = scrubSecretsInJsonLine(line);
    const parsed = JSON.parse(scrubbed) as Record<string, string>;

    expect(parsed.a).toBe('redis://localhost');
    expect(parsed.b).toBe('budi@contoh.com');
    expect(parsed.msg).toBe(
      `Failed query: select "a" from "t" where "x" = $1\nparams: ${REDACTED}`,
    );
    expect(parsed.c).toBe(`postgres://${REDACTED}@h/db`);
    expect(parsed.d).toBe('tetap');
  });
});

describe('redactSecrets', () => {
  it('menyensor kunci rahasia di kedalaman berapa pun, termasuk di dalam array', () => {
    const input = {
      user: { email: 'budi@contoh.com', password: 'hunter2', profile: { apiKey: 'k-123' } },
      channels: [{ name: 'CS', credentials: { access_token: 'EAAxyz', app_secret: 's3cr3t' } }],
      headers: {
        authorization: 'Bearer abc',
        cookie: 'sid=1',
        'set-cookie': ['sid=2'],
        'x-api-key': 'blsn_a_b',
        'x-hub-signature-256': 'sha256=abc',
        'content-type': 'application/json',
      },
    };

    const output = redactSecrets(input);

    expect(output).toEqual({
      user: { email: 'budi@contoh.com', password: REDACTED, profile: { apiKey: REDACTED } },
      channels: [{ name: 'CS', credentials: REDACTED }],
      headers: {
        authorization: REDACTED,
        cookie: REDACTED,
        'set-cookie': REDACTED,
        'x-api-key': REDACTED,
        'x-hub-signature-256': REDACTED,
        'content-type': 'application/json',
      },
    });
    // Nilai asli tidak diubah.
    expect(input.user.password).toBe('hunter2');
  });

  it('membiarkan boolean/null pada kunci rahasia (berguna untuk debugging)', () => {
    expect(redactSecrets({ hasToken: true, password: null, token: undefined })).toEqual({
      hasToken: true,
      password: null,
      token: undefined,
    });
  });

  it('tidak pernah menampilkan Secret maupun data biner', () => {
    const output = redactSecrets({
      config: { key: new Secret(Buffer.alloc(32, 7)), raw: Buffer.from('kunci-rahasia') },
    });
    expect(output).toEqual({ config: { key: REDACTED, raw: '[Biner 13 byte]' } });
    expect(JSON.stringify(output)).not.toContain('kunci-rahasia');
  });

  it('menyaring teks di dalam nilai biasa', () => {
    expect(
      redactSecrets({ target: 'postgres://u:sandi@db/x', list: ['Bearer abcdefghi'] }),
    ).toEqual({ target: `postgres://${REDACTED}@db/x`, list: [`Bearer ${REDACTED}`] });
  });

  it('mengubah Error jadi objek biasa beserta cause-nya', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const error = new Error('gagal ke redis://:sandi@cache:6379', { cause });

    const output = redactSecrets({ failure: error }) as {
      failure: { type: string; message: string; stack: string; cause: { code: string } };
    };

    expect(output.failure.type).toBe('Error');
    expect(output.failure.message).toBe(`gagal ke redis://${REDACTED}@cache:6379`);
    expect(output.failure.stack).toContain('redact.test');
    expect(output.failure.stack).not.toContain('sandi');
    expect(output.failure.cause.code).toBe('ECONNREFUSED');
  });

  it('menyensor nilai parameter dan rincian baris pada error database', () => {
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'users_organization_id_email_unique',
      detail: 'Key (organization_id, email)=(1, budi@contoh.com) already exists.',
      where: 'baris dengan nilai sensitif',
    });
    const drizzleError = Object.assign(
      new Error(
        'Failed query: insert into "users" ("email", "password_hash") values ($1, $2)\nparams: budi@contoh.com,$argon2id$hash-rahasia',
      ),
      {
        query: 'insert into "users" ("email", "password_hash") values ($1, $2)',
        params: ['budi@contoh.com', '$argon2id$hash-rahasia'],
        cause: pgError,
      },
    );

    const output = redactSecrets(drizzleError) as Record<string, unknown>;
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain('hash-rahasia');
    expect(serialized).not.toContain('budi@contoh.com');
    expect(output.message).toBe(
      'Failed query: insert into "users" ("email", "password_hash") values ($1, $2)',
    );
    expect(output.params).toBe(REDACTED);
    expect(output.cause).toMatchObject({
      code: '23505',
      constraint: 'users_organization_id_email_unique',
      detail: REDACTED,
      where: REDACTED,
    });
    expect(describeError(drizzleError)).not.toContain('hash-rahasia');
  });

  it('stack tidak membocorkan parameter walau nilainya mirip baris stack', () => {
    const query = 'insert into "messages" ("body") values ($1)';
    const body = 'halo\n    at rumah saya, PIN ATM 123456';
    const error = Object.assign(new Error(`Failed query: ${query}\nparams: ${body}`), {
      query,
      params: [body],
    });

    const output = redactSecrets(error) as { message: string; stack: string };

    expect(output.message).toBe(`Failed query: ${query}`);
    expect(output.stack.startsWith(`Error: Failed query: ${query}\n    at `)).toBe(true);
    expect(output.stack).toContain('redact.test');
    expect(JSON.stringify(output)).not.toContain('rumah saya');
    expect(JSON.stringify(output)).not.toContain('123456');
  });

  it('menyertakan galat di dalam AggregateError', () => {
    const error = new AggregateError(
      [
        Object.assign(new Error('connect ECONNREFUSED ::1:5432'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
      ],
      '',
    );

    const output = redactSecrets(error) as { type: string; errors: Array<{ message: string }> };

    expect(output.type).toBe('AggregateError');
    expect(output.errors.map((inner) => inner.message)).toEqual([
      'connect ECONNREFUSED ::1:5432',
      'connect ECONNREFUSED 127.0.0.1:5432',
    ]);
  });

  it('tahan terhadap referensi melingkar, objek sangat dalam, dan getter yang melempar', () => {
    const circular: Record<string, unknown> = { name: 'a' };
    circular.self = circular;
    expect(redactSecrets(circular)).toEqual({ name: 'a', self: '[Melingkar]' });

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(redactSecrets(deep))).toContain('[Terlalu dalam]');

    const throwing = Object.defineProperty({}, 'bad', {
      enumerable: true,
      get: () => {
        throw new Error('boom');
      },
    });
    expect(redactSecrets(throwing)).toEqual({ bad: '[Tidak terbaca]' });
  });

  it('memakai toJSON seperti JSON.stringify, serta mendukung Map dan Set', () => {
    expect(
      redactSecrets({
        url: new URL('https://user:sandi@contoh.com/x'),
        map: new Map<string, unknown>([
          ['token', 'abc'],
          ['id', 1],
        ]),
        set: new Set(['a', 'b']),
        when: new Date(0),
      }),
    ).toEqual({
      url: `https://${REDACTED}@contoh.com/x`,
      map: { token: REDACTED, id: 1 },
      set: ['a', 'b'],
      when: new Date(0),
    });
  });
});

describe('Secret', () => {
  it('hanya membuka nilai lewat reveal()', () => {
    const secret = new Secret('sangat-rahasia');
    expect(secret.reveal()).toBe('sangat-rahasia');
    expect(String(secret)).toBe(REDACTED);
    expect(`${secret.toString()}`).toBe(REDACTED);
    expect(JSON.stringify({ secret })).toBe(`{"secret":"${REDACTED}"}`);
    expect(Object.keys(secret)).toEqual([]);
  });
});
