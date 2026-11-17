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
  // `import-thread` = titik masuk `worker_threads` parsing berkas impor (review broadcast T1); dimuat
  // `import-runner.ts` dari `dist/import-thread.js` di samping `dist/index.js`.
  entry: {
    index: 'src/index.ts',
    'import-thread': 'src/modules/broadcasts/import-thread.ts',
  },
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
