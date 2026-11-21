import type { Database } from '@balesin/db';
import { sql } from 'drizzle-orm';

/**
 * Peran database RUNTIME terpisah dari pemilik tabel (Fase 7, catatan review Fase 1 I2/F.16).
 *
 * - Migrasi berjalan sebagai PEMILIK tabel (peran bootstrap Postgres di compose produksi).
 * - api dan worker tersambung sebagai peran runtime yang hanya punya hak DML
 *   (SELECT/INSERT/UPDATE/DELETE) — tidak bisa `ALTER TABLE`, `DISABLE TRIGGER`, `DROP`, atau
 *   membuat objek. Jadi trigger "audit_logs hanya-tambah" (migrasi 0002) tidak bisa dimatikan dari
 *   proses aplikasi, dan `UPDATE`/`DELETE` pada `audit_logs` dicabut juga di tingkat hak akses.
 *
 * Dipanggil setiap migrasi (idempoten): tabel baru dari migrasi berikutnya ikut mendapat hak lewat
 * `GRANT … ON ALL TABLES` ulang dan `ALTER DEFAULT PRIVILEGES`.
 */

/** Nama peran Postgres yang diterima: huruf kecil/angka/garis bawah, maks. 63 karakter. */
const ROLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Password peran runtime: hanya karakter yang aman di URL koneksi dan di literal SQL (installer
 * membuat 48 karakter heksadesimal). Dengan begitu tidak ada escaping yang bisa salah.
 */
const ROLE_PASSWORD_PATTERN = /^[A-Za-z0-9_-]{24,128}$/;

/** Tabel hanya-tambah: peran runtime hanya boleh membaca dan menambah baris. */
const APPEND_ONLY_TABLES = ['audit_logs'] as const;

export class RuntimeRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeRoleError';
  }
}

export interface RuntimeRoleOptions {
  /** Nama peran runtime, mis. `balesin_app`. */
  role: string;
  /** Password peran runtime (acak dari installer). Tidak pernah dicetak. */
  password: string;
}

export function assertRoleName(role: string, variable = 'APP_DB_USER'): string {
  if (!ROLE_NAME_PATTERN.test(role)) {
    throw new RuntimeRoleError(
      `${variable} harus berupa nama peran Postgres: huruf kecil, angka, atau garis bawah (maks. 63 karakter), diawali huruf/garis bawah.`,
    );
  }
  return role;
}

export function assertRolePassword(password: string): string {
  if (!ROLE_PASSWORD_PATTERN.test(password)) {
    throw new RuntimeRoleError(
      'APP_DB_PASSWORD harus 24–128 karakter dari huruf, angka, - atau _ (installer membuatnya acak).',
    );
  }
  return password;
}

/** Perintah SQL penyelarasan peran — terpisah supaya bisa diperiksa tes tanpa database. */
export function runtimeRoleStatements(input: {
  role: string;
  password: string;
  owner: string;
  database: string;
  appendOnlyTables: readonly string[];
}): string[] {
  const role = `"${assertRoleName(input.role)}"`;
  const owner = `"${assertRoleName(input.owner, 'pengguna migrasi')}"`;
  const database = `"${assertRoleName(input.database, 'nama database')}"`;
  const password = `'${assertRolePassword(input.password)}'`;
  return [
    `alter role ${role} with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls inherit password ${password}`,
    `grant connect, temporary on database ${database} to ${role}`,
    // PG 15+ sudah mencabut CREATE di skema public dari PUBLIC; ditegaskan untuk hasil restore lama.
    'revoke create on schema public from public',
    `grant usage on schema public to ${role}`,
    `grant select, insert, update, delete on all tables in schema public to ${role}`,
    `grant usage, select, update on all sequences in schema public to ${role}`,
    `alter default privileges for role ${owner} in schema public grant select, insert, update, delete on tables to ${role}`,
    `alter default privileges for role ${owner} in schema public grant usage, select, update on sequences to ${role}`,
    ...input.appendOnlyTables.map(
      (table) =>
        `revoke update, delete, truncate on table "${assertRoleName(table, 'tabel')}" from ${role}`,
    ),
  ];
}

/**
 * Membuat (bila belum ada) dan menyelaraskan peran runtime. `db` tersambung sebagai pemilik
 * tabel. Semua perintah dalam satu transaksi.
 */
export async function ensureRuntimeRole(db: Database, options: RuntimeRoleOptions): Promise<void> {
  const role = assertRoleName(options.role);
  assertRolePassword(options.password);

  await db.transaction(async (tx) => {
    const self = await tx.execute<{ owner: string; database: string }>(
      sql`select current_user as owner, current_database() as database`,
    );
    const current = self.rows[0];
    if (!current) throw new RuntimeRoleError('Tidak bisa membaca peran pemilik database.');
    if (current.owner === role) {
      throw new RuntimeRoleError(
        'APP_DB_USER tidak boleh sama dengan pengguna migrasi (pemilik tabel). Pakai peran terpisah, mis. balesin_app.',
      );
    }

    const existing = await tx.execute(sql`select 1 from pg_roles where rolname = ${role}`);
    if (existing.rows.length === 0) {
      await tx.execute(sql.raw(`create role "${role}" login`));
    }
    const present = await tx.execute<{ tablename: string }>(
      sql`select tablename from pg_tables where schemaname = 'public'`,
    );
    const tables = new Set(present.rows.map((row) => row.tablename));
    const statements = runtimeRoleStatements({
      role,
      password: options.password,
      owner: current.owner,
      database: current.database,
      appendOnlyTables: APPEND_ONLY_TABLES.filter((table) => tables.has(table)),
    });
    for (const statement of statements) {
      await tx.execute(sql.raw(statement));
    }
  });
}
