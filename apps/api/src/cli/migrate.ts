/**
 * Migrasi database untuk image produksi: `node dist/migrate.js` (layanan `migrate` di
 * deploy/docker-compose.yml; dipanggil installer dan `balesin update`).
 *
 * 1. Menerapkan migrasi Drizzle sebagai PEMILIK tabel (`DATABASE_URL` = pengguna migrasi).
 * 2. Bila `APP_DB_USER` + `APP_DB_PASSWORD` diisi: memastikan peran runtime (hak DML saja) yang
 *    dipakai api dan worker — lihat `db-roles.ts`.
 *
 * Keluaran lewat stdout/stderr; connection string dan password tidak pernah dicetak.
 * Kode keluar: 0 berhasil, 1 gagal (pesan bahasa Indonesia).
 */
import { scrubSecretsInText } from '@balesin/core';
import { closeDb, createDb } from '@balesin/db';
import {
  DEFAULT_MIGRATIONS_FOLDER,
  describeDatabaseUrl,
  describeMigrationFailure,
  runMigrations,
} from '@balesin/db/migrator';

import { ensureRuntimeRole, RuntimeRoleError } from './db-roles';

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL (pengguna migrasi/pemilik tabel) belum diisi.\n');
    return 1;
  }
  const target = describeDatabaseUrl(databaseUrl);
  // Image produksi: folder migrasi disalin ke /app/migrations (kode @balesin/db ikut di-bundle).
  const migrationsFolder = process.env.MIGRATIONS_DIR?.trim() || DEFAULT_MIGRATIONS_FOLDER;

  try {
    process.stdout.write(`Menjalankan migrasi database di ${target} ...\n`);
    await runMigrations(databaseUrl, { migrationsFolder });
    process.stdout.write('Migrasi selesai.\n');
  } catch (error) {
    process.stderr.write(`Migrasi gagal di ${target}: ${describeMigrationFailure(error)}\n`);
    return 1;
  }

  const role = process.env.APP_DB_USER?.trim();
  const password = process.env.APP_DB_PASSWORD?.trim();
  if (!role && !password) {
    process.stdout.write(
      'APP_DB_USER kosong: peran runtime tidak diatur (api/worker memakai pengguna migrasi).\n',
    );
    return 0;
  }
  if (!role || !password) {
    process.stderr.write('APP_DB_USER dan APP_DB_PASSWORD harus diisi berdua.\n');
    return 1;
  }

  const db = createDb(databaseUrl, { applicationName: 'balesin-migrate', maxConnections: 1 });
  try {
    await ensureRuntimeRole(db, { role, password });
    process.stdout.write(`Peran runtime "${role}" siap (hak baca/tulis data saja).\n`);
    return 0;
  } catch (error) {
    const message =
      error instanceof RuntimeRoleError ? error.message : describeMigrationFailure(error);
    process.stderr.write(`Gagal menyiapkan peran runtime: ${scrubSecretsInText(message)}\n`);
    return 1;
  } finally {
    await closeDb(db);
  }
}

process.exitCode = await main();
