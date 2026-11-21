/**
 * `pnpm db:migrate` — menerapkan migrasi ke database di `DATABASE_URL`.
 * Skrip CLI: keluaran lewat console; connection string tidak pernah dicetak.
 */
import { describeDatabaseUrl, describeMigrationFailure, runMigrations } from './migrator';

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error('DATABASE_URL belum diisi. Salin .env.example menjadi .env lalu isi nilainya.');
  process.exit(1);
}

const target = describeDatabaseUrl(databaseUrl);

try {
  console.log(`Menjalankan migrasi database di ${target} ...`);
  await runMigrations(databaseUrl);
  console.log('Migrasi selesai.');
} catch (error) {
  // Hanya ringkasan: objek error lengkap bisa memuat detail koneksi dan nilai parameter query.
  console.error(`Migrasi gagal di ${target}: ${describeMigrationFailure(error)}`);
  console.error('Pastikan Postgres menyala (`pnpm db:up`) dan DATABASE_URL benar.');
  process.exit(1);
}
