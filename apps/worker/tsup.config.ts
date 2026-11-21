import { defineConfig } from 'tsup';

/**
 * Build produksi: satu berkas ESM di `dist/`.
 * - Paket internal `@balesin/*` (sumber TypeScript) ikut di-bundle.
 * - Semua paket pihak ketiga TIDAK di-bundle; diambil dari `node_modules` saat jalan.
 *   Karena itu setiap paket pihak ketiga yang dipakai paket `@balesin/*` harus terdaftar di
 *   `dependencies` package.json ini — diperiksa otomatis setelah build
 *   (packages/core/scripts/check-bundle-deps.mjs).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  metafile: true,
  skipNodeModulesBundle: true,
  noExternal: [/^@balesin\//],
});
