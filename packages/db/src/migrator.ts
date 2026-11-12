import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

/** Folder migrasi bawaan: `packages/db/drizzle` (hasil `pnpm db:generate`). */
export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Kunci advisory Postgres agar dua proses migrasi tidak pernah berjalan bersamaan. */
const MIGRATION_LOCK_ID = 7_262_537_461;

export interface RunMigrationsOptions {
  /** Folder berisi berkas migrasi. Wajib diisi bila kode ini di-bundle (mis. image produksi). */
  migrationsFolder?: string;
}

/**
 * Menerapkan semua migrasi yang belum dijalankan. Aman diulang: migrasi yang sudah
 * tercatat di `drizzle.__drizzle_migrations` dilewati. Semua migrasi tertunda berjalan
 * dalam satu transaksi — gagal satu, batal semua.
 */
export async function runMigrations(
  databaseUrl: string,
  options: RunMigrationsOptions = {},
): Promise<void> {
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'balesin-migrate',
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await migrate(drizzle(client), {
      migrationsFolder: options.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER,
    });
  } finally {
    // Kunci advisory tingkat sesi ikut lepas saat koneksi ditutup.
    await client.end();
  }
}

/** `host:port/database` untuk pesan — tanpa pengguna dan password. */
export function describeDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return '(URL tidak valid)';
  }
}
