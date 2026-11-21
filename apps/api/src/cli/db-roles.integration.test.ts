/**
 * Peran database runtime (Fase 7): hak DML saja, audit log hanya-tambah juga di tingkat hak akses,
 * tidak bisa mengubah skema atau mematikan trigger. Peran dibuat dengan nama acak di cluster tes
 * dan dihapus di akhir.
 */
import { randomBytes } from 'node:crypto';

import { auditLogs, closeDb, createDb, organizations, type Database } from '@balesin/db';
import { createTemporaryDatabase, type TemporaryDatabase } from '@balesin/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';

import { ensureRuntimeRole, runtimeRoleStatements, RuntimeRoleError } from './db-roles';

const ROLE = `balesin_app_tes_${randomBytes(4).toString('hex')}`;
const PASSWORD = randomBytes(24).toString('hex');

let database: TemporaryDatabase;
let owner: Database;
let runtime: Database;

function asRuntimeUrl(url: string, password = PASSWORD): string {
  const parsed = new URL(url);
  parsed.username = ROLE;
  parsed.password = password;
  return parsed.toString();
}

/** Kode SQLSTATE dari error Drizzle/pg (bisa terbungkus `cause`). */
async function sqlState(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
      current = (current as { cause?: unknown }).cause;
    }
    throw error;
  }
}

beforeAll(async () => {
  database = await createTemporaryDatabase(inject('testDatabaseBaseUrl'));
  owner = createDb(database.url, { applicationName: 'balesin-tes-peran' });
  await ensureRuntimeRole(owner, { role: ROLE, password: PASSWORD });
  runtime = createDb(asRuntimeUrl(database.url), { applicationName: 'balesin-tes-runtime' });
});

afterAll(async () => {
  await closeDb(runtime);
  // Hak peran di database ini (tabel, skema, CONNECT) dicabut dulu supaya `drop role` tidak butuh
  // `DROP DATABASE` — yang memaksa checkpoint Postgres dan bisa antre > 30 dtk saat tes paralel.
  // Database-nya dilepas dan dihapus teardown global (`TemporaryDatabase.release`).
  await owner.execute(sql.raw(`drop owned by "${ROLE}"`));
  await closeDb(owner);
  await database.release();
  const admin = createDb(inject('testDatabaseBaseUrl'), { applicationName: 'balesin-tes-peran' });
  try {
    await admin.execute(sql.raw(`drop role if exists "${ROLE}"`));
  } finally {
    await closeDb(admin);
  }
});

describe('ensureRuntimeRole', () => {
  it('peran runtime bisa membaca dan menulis data biasa', async () => {
    const [org] = await runtime
      .insert(organizations)
      .values({ name: 'PT Peran Tes' })
      .returning({ id: organizations.id });
    if (!org) throw new Error('Organisasi tidak tersimpan');
    await runtime.execute(sql`update organizations set name = 'PT Peran Tes 2'`);
    await runtime.insert(auditLogs).values({ organizationId: org.id, action: 'tes.peran' });
    const audit = await runtime.execute(sql`select 1 from audit_logs`);
    expect(audit.rows).toHaveLength(1);
  });

  it('audit log hanya-tambah juga di tingkat hak akses', async () => {
    expect(await sqlState(runtime.execute(sql`update audit_logs set action = 'ubah'`))).toBe(
      '42501',
    );
    expect(await sqlState(runtime.execute(sql`delete from audit_logs`))).toBe('42501');
    expect(await sqlState(runtime.execute(sql`truncate audit_logs`))).toBe('42501');
  });

  it('tidak bisa mengubah skema atau mematikan trigger', async () => {
    expect(await sqlState(runtime.execute(sql`create table tes_peran (id int)`))).toBe('42501');
    expect(
      await sqlState(
        runtime.execute(sql`alter table audit_logs disable trigger audit_logs_no_update_delete`),
      ),
    ).toBe('42501');
    expect(await sqlState(runtime.execute(sql`drop table organizations cascade`))).toBe('42501');
    expect(
      await sqlState(runtime.execute(sql`select count(*) from drizzle.__drizzle_migrations`)),
    ).toBe('42501');
  });

  it('idempoten dan mengganti password peran', async () => {
    const next = randomBytes(24).toString('hex');
    await ensureRuntimeRole(owner, { role: ROLE, password: next });
    const relogin = createDb(asRuntimeUrl(database.url, next), { applicationName: 'balesin-tes' });
    try {
      const rows = await relogin.execute(sql`select current_user as who`);
      expect(rows.rows[0]).toEqual({ who: ROLE });
    } finally {
      await closeDb(relogin);
    }
    await ensureRuntimeRole(owner, { role: ROLE, password: PASSWORD });
  });

  it('menolak nama peran/password yang tidak aman tanpa menyentuh database', async () => {
    await expect(
      ensureRuntimeRole(owner, { role: 'app"; drop table users; --', password: PASSWORD }),
    ).rejects.toBeInstanceOf(RuntimeRoleError);
    await expect(
      ensureRuntimeRole(owner, {
        role: ROLE,
        password: "abc'; alter role x superuser; --abcdefgh",
      }),
    ).rejects.toBeInstanceOf(RuntimeRoleError);
    expect(() =>
      runtimeRoleStatements({
        role: ROLE,
        password: PASSWORD,
        owner: 'Pemilik-Aneh',
        database: 'balesin',
        appendOnlyTables: [],
      }),
    ).toThrow(RuntimeRoleError);
  });
});
