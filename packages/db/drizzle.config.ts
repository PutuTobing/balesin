import { defineConfig } from 'drizzle-kit';

/**
 * Hanya dipakai `pnpm db:generate` (membuat SQL migrasi dari skema — tidak butuh koneksi DB).
 * Migrasi DIJALANKAN oleh `pnpm db:migrate` (src/migrate.ts), bukan oleh drizzle-kit.
 * Jangan pakai `drizzle-kit push`: semua perubahan skema harus lewat berkas migrasi.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
