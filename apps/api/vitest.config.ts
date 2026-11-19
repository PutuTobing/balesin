import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tes integrasi memakai Postgres sungguhan: `inject('testDatabaseBaseUrl')` dipakai untuk
    // membuat database sementara per berkas tes (lihat src/testing/integration.ts).
    globalSetup: ['../../packages/db/src/testing/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Teardown global menghapus semua database sementara yang dilepas berkas tes (±90, masing-masing
    // satu checkpoint Postgres; cepat tanpa beban, tetapi bawaan 10 dtk terlalu sempit untuk semuanya).
    teardownTimeout: 300_000,
  },
});
