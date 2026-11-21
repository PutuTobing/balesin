import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tes integrasi antrian email memakai Postgres sungguhan (`inject('testDatabaseUrl')`).
    globalSetup: ['../../packages/db/src/testing/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
