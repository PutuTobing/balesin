import { defineConfig, devices } from '@playwright/test';
import { OWNER_STATE_PATH } from './stack/env';
import { BASE_URL, VIEWPORTS, webServer } from './viewports';

/**
 * E2E melawan API sungguhan (lihat `stack/`). Urutan:
 *  1. `alur-awal` — wizard setup dari instalasi kosong, masuk/keluar, terkunci; menyimpan sesi
 *     Owner ke `OWNER_STATE_PATH`.
 *  2. `tanpa-email` — Pengaturan → Tim selagi email pengirim belum diatur (tautan undangan
 *     disalin manual).
 *  3. `desktop-1440` dan `hp-390` — semua tes lain, memakai sesi Owner itu (tes tamu
 *     mengosongkan sesinya sendiri lewat `test.use({ storageState })`). Di sini
 *     `email-pengirim.spec.ts` mengatur email pengirim organisasi.
 *  4. `berurutan` lalu `berurutan-hp` — spec yang mengubah pengaturan seluruh organisasi, satu per
 *     satu (desktop, lalu jam kerja di HP).
 *  5. `dengan-email` — undangan, lupa/atur ulang password, verifikasi email lewat Mailpit; banner
 *     keamanan Owner setelah Admin mengubah email pengirim (`keamanan-dengan-email.spec.ts`).
 *
 * Proyek 2 dan 5 bergantung pada pengaturan email organisasi yang dibagi bersama, jadi masing-
 * masing berjalan sendiri di sela proyek paralel, tidak bersamaan dengannya.
 */
const sharedEmailSpecs = /(tim-tanpa|tim-dengan|keamanan-dengan)-email\.spec\.ts$/;
/**
 * Spec yang mengubah keadaan seluruh organisasi (ambang broadcast, pesan otomatis & pembagian chat,
 * merek di halaman masuk) dan peka rem darurat — dijalankan setelah proyek paralel, satu per satu.
 */
const serialSpecs = /(broadcast|jam-kerja|merek)\.spec\.ts$/;
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
  // Stack sungguhan (argon2 saat masuk, worker, WebSocket) di 10 worker paralel: di mesin pengembang
  // yang sibuk satu langkah bisa > 5 dtk. Batas tunggu asersi bukan asersi — menunggu lebih lama
  // tidak melemahkan apa yang diperiksa.
  expect: { timeout: 10_000 },
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
      name: 'tanpa-email',
      dependencies: ['alur-awal'],
      testMatch: /tim-tanpa-email\.spec\.ts$/,
      use: { ...desktop, storageState: OWNER_STATE_PATH },
    },
    {
      name: 'desktop-1440',
      dependencies: ['tanpa-email'],
      testIgnore: [sharedEmailSpecs, serialSpecs],
      use: { ...desktop, storageState: OWNER_STATE_PATH },
    },
    {
      name: 'hp-390',
      dependencies: ['tanpa-email'],
      testIgnore: [sharedEmailSpecs, serialSpecs],
      use: { ...hp, storageState: OWNER_STATE_PATH },
    },
    {
      // Setelah proyek paralel, satu per satu: broadcast sungguhan (rem darurat `inbox-balas` menjeda
      // semua kampanye organisasi; ambang persetujuan berlaku organisasi).
      name: 'berurutan',
      dependencies: ['desktop-1440', 'hp-390'],
      testMatch: serialSpecs,
      workers: 1,
      use: { ...desktop, storageState: OWNER_STATE_PATH },
    },
    {
      // Jam kerja & pembagian chat di HP. Setelah `berurutan` (bukan bersamaan): kedua proyek
      // mengubah pengaturan organisasi yang sama (pesan otomatis, round-robin).
      name: 'berurutan-hp',
      dependencies: ['berurutan'],
      testMatch: /jam-kerja\.spec\.ts$/,
      workers: 1,
      use: { ...hp, storageState: OWNER_STATE_PATH },
    },
    {
      name: 'dengan-email',
      dependencies: ['berurutan', 'berurutan-hp'],
      testMatch: /(tim|keamanan)-dengan-email\.spec\.ts$/,
      // Satu per satu: kedua berkas membuat kejadian keamanan baru dan membaca banner Owner yang
      // sama ("N kejadian keamanan baru"); bila paralel, kejadian dari berkas lain memunculkan
      // banner lagi tepat setelah tes lain menandainya sudah dilihat.
      workers: 1,
      use: { ...desktop, storageState: OWNER_STATE_PATH },
    },
  ],
  webServer,
});
