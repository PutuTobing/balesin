import { defineConfig, devices } from '@playwright/test';
import { OWNER_STATE_PATH } from './stack/env';
import { BASE_URL, VIEWPORTS, webServer } from './viewports';

/**
 * E2E melawan API sungguhan (lihat `stack/`). Urutan:
 *  1. `alur-awal` — wizard setup dari instalasi kosong, masuk/keluar, terkunci; menyimpan sesi
 *     Owner ke `OWNER_STATE_PATH`.
 *  2. `desktop-1440` dan `hp-390` — semua tes lain, memakai sesi Owner itu (tes tamu
 *     mengosongkan sesinya sendiri lewat `test.use({ storageState })`).
 */
const desktop = { ...devices['Desktop Chrome'], viewport: VIEWPORTS.desktop };
const hp = {
  ...devices['Desktop Chrome'],
  viewport: VIEWPORTS.hp,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
};

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Tidak diulang otomatis: alur awal tidak bisa diulang tanpa mereset database, dan tes
  // lain memakai hasilnya. Tes yang gagal harus diperbaiki, bukan dicoba ulang.
  retries: 0,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'id-ID',
    timezoneId: 'Asia/Jakarta',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'alur-awal', testMatch: /alur-awal\.setup\.ts$/, use: desktop },
    {
      name: 'desktop-1440',
      dependencies: ['alur-awal'],
      use: { ...desktop, storageState: OWNER_STATE_PATH },
    },
    {
      name: 'hp-390',
      dependencies: ['alur-awal'],
      use: { ...hp, storageState: OWNER_STATE_PATH },
    },
  ],
  webServer,
});
