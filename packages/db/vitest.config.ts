import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tes integrasi memakai Postgres sungguhan (lihat src/testing/index.ts).
    globalSetup: ['./src/testing/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
