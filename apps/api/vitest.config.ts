import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tes integrasi memakai Postgres sungguhan: `inject('testDatabaseBaseUrl')` dipakai untuk
    // membuat database sementara per berkas tes (lihat src/testing/integration.ts).
    globalSetup: ['../../packages/db/src/testing/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
