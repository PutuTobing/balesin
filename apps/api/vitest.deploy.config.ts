import { defineConfig } from 'vitest/config';

/**
 * Tes penjaga berkas deploy (review keamanan Fase 7): hanya membaca berkas di `deploy/`, `.github/`,
 * dan `docs/`, jadi dijalankan TANPA globalSetup Postgres milik vitest.config.ts.
 *   pnpm --filter @balesin/api test:deploy
 */
export default defineConfig({
  test: {
    include: ['src/cli/security-review-fase7-deploy.test.ts'],
  },
});
