import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, VIEWPORTS, webServer } from './viewports';

/**
 * Skrip screenshot untuk `kritikus-desain`: setiap layar di capture/screens.ts
 * difoto di 390×844 dan 1440×900, mode terang & gelap → e2e/screenshots/.
 *
 *   pnpm screenshots                        semua layar
 *   SCREENS=beranda,login pnpm screenshots  layar tertentu saja
 */
const base = { ...devices['Desktop Chrome'], deviceScaleFactor: 2 };
const hp = { ...base, viewport: VIEWPORTS.hp, isMobile: true, hasTouch: true };
const desktop = { ...base, viewport: VIEWPORTS.desktop };

export default defineConfig({
  testDir: './capture',
  outputDir: './test-results',
  fullyParallel: true,
  // Start pertama dev server kadang lambat; ulangi sekali supaya gambar lama tidak tertinggal diam-diam.
  retries: 1,
  reporter: [['list']],
  use: { baseURL: BASE_URL, locale: 'id-ID', timezoneId: 'Asia/Jakarta' },
  projects: [
    { name: '390-terang', use: { ...hp, colorScheme: 'light' } },
    { name: '390-gelap', use: { ...hp, colorScheme: 'dark' } },
    { name: '1440-terang', use: { ...desktop, colorScheme: 'light' } },
    { name: '1440-gelap', use: { ...desktop, colorScheme: 'dark' } },
  ],
  webServer,
});
