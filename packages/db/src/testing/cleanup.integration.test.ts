import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { describe, expect, inject, it } from 'vitest';

import { describeMigrationFailure, runMigrations } from '../migrator';
import {
  assertTestDatabaseUrl,
  createTemporaryDatabase,
  dropStaleTemporaryDatabases,
  TEMPORARY_DATABASE_COMMENT,
} from './index';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

async function withClient<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function databaseExists(baseUrl: string, name: string): Promise<boolean> {
  return withClient(baseUrl, async (client) => {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [name]);
    return rowCount === 1;
  });
}

/** Nama berpola persis buatan alat ini, dengan waktu pembuatan yang ditentukan. */
function temporaryName(baseUrl: string, createdAt: number): string {
  const baseName = new URL(baseUrl).pathname.slice(1);
  return `${baseName}_tmp_${createdAt.toString(36)}_${randomBytes(4).toString('hex')}`;
}

describe('dropStaleTemporaryDatabases', () => {
  it('menghapus sisa tes lama buatan alat ini (nama berpola + komentar penanda + sudah tua)', async () => {
    const baseUrl = inject('testDatabaseBaseUrl');
    const name = temporaryName(baseUrl, Date.now() - TWO_HOURS_MS);
    await withClient(baseUrl, async (client) => {
      await client.query(`create database "${name}"`);
      await client.query(`comment on database "${name}" is '${TEMPORARY_DATABASE_COMMENT}'`);
    });

    try {
      await dropStaleTemporaryDatabases(baseUrl);

      expect(await databaseExists(baseUrl, name)).toBe(false);
    } finally {
      await withClient(baseUrl, (client) =>
        client.query(`drop database if exists "${name}" with (force)`),
      );
    }
  });

  it('tidak menghapus database tua bernama mirip yang tidak membawa komentar penanda', async () => {
    const baseUrl = inject('testDatabaseBaseUrl');
    const name = temporaryName(baseUrl, Date.now() - TWO_HOURS_MS);
    await withClient(baseUrl, (client) => client.query(`create database "${name}"`));

    try {
      await dropStaleTemporaryDatabases(baseUrl);

      expect(await databaseExists(baseUrl, name)).toBe(true);
    } finally {
      await withClient(baseUrl, (client) =>
        client.query(`drop database if exists "${name}" with (force)`),
      );
    }
  });

  it('database sementara baru membawa komentar penanda', async () => {
    const baseUrl = inject('testDatabaseBaseUrl');
    const database = await createTemporaryDatabase(baseUrl, { migrate: false });

    try {
      const comment = await withClient(baseUrl, async (client) => {
        const { rows } = await client.query<{ comment: string | null }>(
          `select shobj_description(oid, 'pg_database') as comment
           from pg_database where datname = $1`,
          [database.name],
        );
        return rows[0]?.comment;
      });

      expect(comment).toBe(TEMPORARY_DATABASE_COMMENT);
      expect(database.name).toMatch(/_test_tmp_[0-9a-z]{8,9}_[0-9a-f]{8}$/);
    } finally {
      await database.drop();
    }
  });
});

describe('assertTestDatabaseUrl', () => {
  it.each([
    'postgres://u:p@localhost:5432/balesin',
    'postgres://u:p@localhost:5432/produksi',
    'postgres://u:p@localhost:5432/balesin_test_palsu',
    'postgres://u:p@localhost:5432/Balesin_TEST',
    'postgres://u:p@localhost:5432/',
    '',
    'bukan-url',
  ])('menolak "%s"', (url) => {
    expect(() => assertTestDatabaseUrl(url)).toThrow(/_test|bukan URL/);
  });

  it('menerima database yang berakhiran _test dan mengembalikan URL-nya utuh', () => {
    const url = 'postgres://u:p@localhost:5432/balesin_test';
    expect(assertTestDatabaseUrl(url)).toBe(url);
  });
});

describe('describeMigrationFailure', () => {
  it('error query: hanya pesan Postgres dan SQLSTATE — tanpa SQL dan tanpa nilai parameter', () => {
    const pgError = Object.assign(new Error('relation "users" already exists\nbaris kedua'), {
      severity: 'ERROR',
      code: '42P07',
    });
    const queryError = Object.assign(
      new Error('Failed query: CREATE TABLE "users" (…)\nparams: nilai-parameter-rahasia'),
      { query: 'CREATE TABLE "users" (…)', params: ['nilai-parameter-rahasia'], cause: pgError },
    );

    const summary = describeMigrationFailure(queryError);

    expect(summary).toBe('relation "users" already exists (SQLSTATE 42P07)');
  });

  it('error data (kelas 22) tidak mengulang nilai yang ditolak', () => {
    const pgError = Object.assign(
      new Error('invalid input syntax for type uuid: "nilai-rahasia"'),
      {
        severity: 'ERROR',
        code: '22P02',
      },
    );

    expect(describeMigrationFailure(new Error('gagal', { cause: pgError }))).toBe(
      'invalid input syntax for type uuid (SQLSTATE 22P02)',
    );

    const rangeError = Object.assign(
      new Error('value "99999999999-nilai-rahasia" is out of range for type integer'),
      { severity: 'ERROR', code: '22003' },
    );
    expect(describeMigrationFailure(rangeError)).toBe(
      'value … is out of range for type integer (SQLSTATE 22003)',
    );
  });

  it('error query tanpa penyebab Postgres tidak mencetak pesannya sama sekali', () => {
    const queryError = Object.assign(new Error('Failed query: select 1\nparams: nilai-rahasia'), {
      query: 'select 1',
      params: ['nilai-rahasia'],
    });

    expect(describeMigrationFailure(queryError)).not.toContain('nilai-rahasia');
  });

  it('error lain: pesan dan kodenya', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });

    expect(describeMigrationFailure(refused)).toBe('connect ECONNREFUSED 127.0.0.1:5432');
    expect(
      describeMigrationFailure(Object.assign(new Error('batas waktu'), { code: 'ETIMEDOUT' })),
    ).toBe('batas waktu (ETIMEDOUT)');
    expect(describeMigrationFailure('teks')).toBe('galat tidak dikenal');
  });

  it('kegagalan sungguhan dari Postgres: password salah tidak membocorkan password', async () => {
    const url = new URL(inject('testDatabaseBaseUrl'));
    url.password = 'sandi-salah-rahasia';

    const failure = await runMigrations(url.toString()).then(
      () => undefined,
      (error: unknown) => error,
    );

    const summary = describeMigrationFailure(failure);
    expect(summary).toContain('28P01');
    expect(summary).not.toContain('sandi-salah-rahasia');
  });
});
