import { defineConfig, devices } from '@playwright/test';
import { OWNER_STATE_PATH } from './stack/env';
import { BASE_URL, VIEWPORTS, webServer } from './viewports';

/**
 * Skrip screenshot untuk `kritikus-desain`: setiap layar di capture/screens.ts
 * difoto di 390×844 dan 1440×900, mode terang & gelap → e2e/screenshots/.
 *
 *   pnpm screenshots                        semua layar
 *   SCREENS=masuk,setup-token pnpm screenshots  layar tertentu saja
 *
 * Backend foto dimulai dari instalasi kosong; proyek `sesi` membuat Owner dan menyimpan
 * sesinya untuk layar di dalam aplikasi.
 */
const base = { ...devices['Desktop Chrome'], deviceScaleFactor: 2 };
const hp = { ...base, viewport: VIEWPORTS.hp, isMobile: true, hasTouch: true };
const desktop = { ...base, viewport: VIEWPORTS.desktop };
const session = { storageState: OWNER_STATE_PATH };

export default defineConfig({
  testDir: './capture',
  outputDir: './test-results',
  fullyParallel: true,
  retries: 1,
  reporter: [['list']],
  use: { baseURL: BASE_URL, locale: 'id-ID', timezoneId: 'Asia/Jakarta' },
  projects: [
    { name: 'sesi', testMatch: /sesi\.setup\.ts$/, retries: 0 },
    {
      name: '390-terang',
      dependencies: ['sesi'],
      use: { ...hp, ...session, colorScheme: 'light' },
    },
    { name: '390-gelap', dependencies: ['sesi'], use: { ...hp, ...session, colorScheme: 'dark' } },
    {
      name: '1440-terang',
      dependencies: ['sesi'],
      use: { ...desktop, ...session, colorScheme: 'light' },
    },
    {
      name: '1440-gelap',
      dependencies: ['sesi'],
      use: { ...desktop, ...session, colorScheme: 'dark' },
    },
  ],
  webServer,
});
