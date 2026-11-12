import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { runMigrations } from './migrator';
import { createTemporaryDatabase, resolveTestDatabaseUrl, type TemporaryDatabase } from './testing';

describe('migrasi dari nol', () => {
  let database: TemporaryDatabase;
  let client: Client;

  beforeAll(async () => {
    // Database kosong sungguhan — belum dimigrasi.
    database = await createTemporaryDatabase(inject('testDatabaseBaseUrl'), { migrate: false });
    client = new Client({ connectionString: database.url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await database.drop();
  });

  async function publicTables(): Promise<string[]> {
    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    return rows.map((row) => row.table_name);
  }

  it('database baru benar-benar kosong', async () => {
    expect(await publicTables()).toEqual([]);
  });

  it('membuat keempat tabel fondasi dan enum peran', async () => {
    await runMigrations(database.url);

    expect(await publicTables()).toEqual(['audit_logs', 'organizations', 'user_sessions', 'users']);

    const { rows: roles } = await client.query<{ enumlabel: string }>(
      `select e.enumlabel from pg_enum e
       join pg_type t on t.oid = e.enumtypid
       where t.typname = 'user_role' order by e.enumsortorder`,
    );
    expect(roles.map((row) => row.enumlabel)).toEqual([
      'owner',
      'admin',
      'supervisor',
      'cs',
      'teknisi',
    ]);
  });

  it('setiap tabel punya organization_id dan created_at; updated_at kecuali audit_logs', async () => {
    const { rows } = await client.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public'`,
    );
    const columnsOf = (table: string) =>
      rows.filter((row) => row.table_name === table).map((row) => row.column_name);

    // `organizations` adalah akar tenant: `id`-nya adalah organization_id tabel lain.
    for (const table of ['users', 'user_sessions', 'audit_logs']) {
      expect(columnsOf(table)).toContain('organization_id');
    }
    for (const table of ['organizations', 'users', 'user_sessions', 'audit_logs']) {
      expect(columnsOf(table)).toContain('created_at');
    }
    for (const table of ['organizations', 'users', 'user_sessions']) {
      expect(columnsOf(table)).toContain('updated_at');
    }
    // Audit log hanya-tambah: tidak pernah diubah, jadi tidak punya updated_at.
    expect(columnsOf('audit_logs')).not.toContain('updated_at');
  });

  it('semua kolom waktu bertipe timestamptz dan semua id bertipe uuid', async () => {
    const { rows } = await client.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
       where table_schema = 'public'`,
    );
    for (const row of rows) {
      if (row.column_name.endsWith('_at')) {
        expect(row.data_type, row.column_name).toBe('timestamp with time zone');
      }
      if (row.column_name === 'id' || row.column_name.endsWith('_id')) {
        // target_id sengaja teks: target audit tidak selalu baris ber-UUID.
        if (row.column_name === 'target_id') continue;
        expect(row.data_type, row.column_name).toBe('uuid');
      }
    }
  });

  it('aman dijalankan ulang (idempoten)', async () => {
    const countApplied = async () => {
      const { rows } = await client.query<{ count: string }>(
        'select count(*) as count from drizzle.__drizzle_migrations',
      );
      return Number(rows[0]?.count);
    };
    const before = await countApplied();

    await runMigrations(database.url);
    await runMigrations(database.url);

    expect(before).toBeGreaterThan(0);
    expect(await countApplied()).toBe(before);
  });
});

describe('pengaman database tes', () => {
  it('menolak database yang namanya tidak berakhiran _test', () => {
    expect(() =>
      resolveTestDatabaseUrl({ DATABASE_URL_TEST: 'postgres://u:p@localhost:5432/balesin' }),
    ).toThrow(/berakhiran "_test"/);
    expect(() => resolveTestDatabaseUrl({ DATABASE_URL_TEST: 'bukan-url' })).toThrow(
      /bukan URL Postgres/,
    );
  });

  it('memakai Postgres dari `pnpm db:up` bila DATABASE_URL_TEST kosong', () => {
    expect(resolveTestDatabaseUrl({})).toBe(
      'postgres://balesin:balesin@localhost:5432/balesin_test',
    );
    expect(resolveTestDatabaseUrl({ DATABASE_URL_TEST: '  ' })).toBe(
      'postgres://balesin:balesin@localhost:5432/balesin_test',
    );
  });

  it('gagal dengan pesan jelas (tanpa password) bila Postgres tidak bisa dihubungi', async () => {
    const unreachable = 'postgres://balesin:sandi-rahasia@127.0.0.1:1/balesin_test';

    const error = await createTemporaryDatabase(unreachable).then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );

    expect(error?.message).toContain('pnpm db:up');
    expect(error?.message).toContain('127.0.0.1:1/balesin_test');
    expect(error?.message).not.toContain('sandi-rahasia');
  });
});
