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

/**
 * Ringkasan kegagalan migrasi yang aman dicetak ke terminal.
 *
 * Error query Drizzle memuat teks SQL lengkap dan baris `params:` berisi nilai, jadi pesannya
 * TIDAK dicetak. Yang dicetak hanya pesan error Postgres penyebabnya (baris pertama) dan kode
 * SQLSTATE; untuk error lain (mis. gagal tersambung) pesan dan kodenya sendiri.
 */
export function describeMigrationFailure(error: unknown): string {
  let isQueryError = false;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as Record<string, unknown>;
    if (typeof candidate.query === 'string' && 'params' in candidate) isQueryError = true;
    if (typeof candidate.severity === 'string' && typeof candidate.code === 'string') {
      return `${firstLine(candidate.message, candidate.code)} (SQLSTATE ${candidate.code})`;
    }
    current = candidate.cause;
  }

  if (isQueryError) return 'query migrasi ditolak database (rincian tidak ditampilkan)';
  if (!(error instanceof Error)) return 'galat tidak dikenal';
  const code = (error as { code?: unknown }).code;
  const message = firstLine(error.message) || error.name;
  return typeof code === 'string' && !message.includes(code) ? `${message} (${code})` : message;
}

/** Baris pertama pesan; untuk error data (kelas 22) nilai yang diulang Postgres ikut dibuang. */
function firstLine(message: unknown, sqlState = ''): string {
  if (typeof message !== 'string') return '';
  const [line = ''] = message.split('\n');
  const valueAt = sqlState.startsWith('22') ? line.indexOf(': "') : -1;
  return valueAt === -1 ? line : line.slice(0, valueAt);
}
