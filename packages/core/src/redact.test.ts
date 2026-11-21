import { describe, expect, it } from 'vitest';

import { describeError, isSensitiveKey, redactSecrets } from './redact';
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
    'accessKey',
    'aws_secret_access_key',
    'licenseKey',
    'sessionId',
    'session_id',
    'sid',
    'passcode',
    'jwt',
    'idJwt',
  ])('menganggap "%s" rahasia', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'email',
    'name',
    'code',
    'key',
    'author',
    'url',
    'statusCode',
    'requestId',
    'passed',
    'side',
    'sessionRef',
    'jobId',
  ])('tidak menganggap "%s" rahasia', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
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

  it('error Redis: hanya nama perintah yang ditampilkan, argumennya tidak pernah', () => {
    const replyError = Object.assign(new Error('WRONGPASS invalid username-password pair'), {
      name: 'ReplyError',
      command: { name: 'hello', args: ['3', 'AUTH', 'default', 'sandi-redis-asli'] },
    });
    const pipelineError = Object.assign(new Error('Pipeline gagal'), {
      previousErrors: [
        Object.assign(new Error('OOM command not allowed'), {
          command: { name: 'set', args: ['sesi:kunci-rahasia', 'isi-rahasia'] },
        }),
      ],
      // Jaring kedua: `args` di error mana pun dianggap data.
      args: ['argumen-lepas-rahasia'],
    });

    const reply = redactSecrets(replyError) as { command: unknown };
    const pipeline = redactSecrets({ gagal: pipelineError });

    expect(reply.command).toEqual({ name: 'hello' });
    for (const output of [reply, pipeline]) {
      const serialized = JSON.stringify(output);
      for (const secret of ['sandi-redis-asli', 'kunci-rahasia', 'isi-rahasia', 'argumen-lepas']) {
        expect(serialized).not.toContain(secret);
      }
    }
    expect(JSON.stringify(pipeline)).toContain('"name":"set"');
  });

  it('error dengan `command` berupa teks (mis. nodemailer) tetap menampilkan nama perintahnya', () => {
    const smtpError = Object.assign(new Error('Invalid login: 535 Authentication failed'), {
      code: 'EAUTH',
      command: 'AUTH PLAIN',
      responseCode: 535,
    });

    expect(redactSecrets(smtpError)).toMatchObject({
      code: 'EAUTH',
      command: 'AUTH PLAIN',
      responseCode: 535,
    });
  });

  it('error Postgres kelas 22 tidak mengulang nilai yang ditolak; kelas lain tidak dipotong', () => {
    const castError = Object.assign(
      new Error('invalid input syntax for type uuid: "token-sesi-nyasar"'),
      { severity: 'ERROR', code: '22P02', routine: 'string_to_uuid' },
    );
    const uniqueError = Object.assign(
      new Error('duplicate key value violates unique constraint "users_email_unique"'),
      { severity: 'ERROR', code: '23505', constraint: 'users_email_unique' },
    );

    const cast = redactSecrets(castError) as { message: string; stack: string; code: string };

    expect(cast.message).toBe(`invalid input syntax for type uuid: ${REDACTED}`);
    expect(cast.code).toBe('22P02');
    expect(cast.stack).toContain('redact.test');
    expect(JSON.stringify(cast)).not.toContain('token-sesi-nyasar');
    expect(describeError(uniqueError)).toBe(
      'duplicate key value violates unique constraint "users_email_unique"',
    );
  });

  it('error Postgres kelas 22: nilai di awal/tengah pesan dan nilai yang memuat kutip ikut hilang', () => {
    const dataError = (message: string, code: string) =>
      Object.assign(new Error(message), { severity: 'ERROR', code });

    expect(
      describeError(dataError('value "99999999999" is out of range for type integer', '22003')),
    ).toBe(`value ${REDACTED} is out of range for type integer`);
    expect(
      describeError(dataError('invalid input syntax for type integer: "12"rahasia"34"', '22P02')),
    ).toBe(`invalid input syntax for type integer: ${REDACTED}`);
    expect(
      describeError(dataError('date/time field value out of range: "2026-13-45', '22008')),
    ).toBe(`date/time field value out of range: ${REDACTED}`);
    // Tanpa tanda kutip tidak ada nilai yang diulang: pesan dibiarkan.
    expect(describeError(dataError('division by zero', '22012'))).toBe('division by zero');
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
