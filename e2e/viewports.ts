import { availableParallelism } from 'node:os';

import { E2E_API_URL, E2E_BASE_URL, E2E_WEB_PORT, backendEnv } from './stack/env';

/** Dua ukuran wajib rubrik desain (docs/DESIGN.md §5). */
export const VIEWPORTS = {
  hp: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
} as const;

export const BASE_URL = E2E_BASE_URL;

/**
 * Server untuk tes dan screenshot, dinyalakan otomatis oleh Playwright:
 *  1. backend E2E (database & Redis direset, lalu API + worker) — lihat `stack/start-backend.mjs`;
 *  2. web (Vite dev) di port E2E dengan proxy `/api` ke API E2E, DIPANASKAN dulu (`stack/start-web.mjs`:
 *     optimasi dependensi + transformasi semua modul) — dianggap siap saat mencetak
 *     `BALESIN_E2E_WEB_SIAP`, bukan saat port terbuka (audit QA akhir D1: cache Vite dingin).
 *
 * Selalu dinyalakan baru (tidak memakai server yang sudah jalan) supaya setiap run mulai dari
 * instalasi kosong. `E2E_BASE_URL` = pakai server yang sudah ada, tanpa menyalakan apa pun.
 */
export const webServer = process.env.E2E_BASE_URL
  ? undefined
  : [
      {
        command: 'node e2e/stack/start-backend.mjs',
        cwd: '..',
        url: `${E2E_API_URL}/ready`,
        env: backendEnv(),
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'pipe' as const,
        stderr: 'pipe' as const,
      },
      {
        command: 'node e2e/stack/start-web.mjs',
        cwd: '..',
        // Tanpa `url`: Playwright menganggap siap saat salah satu syarat terpenuhi, dan port Vite
        // terbuka jauh sebelum pemanasan selesai.
        wait: { stdout: /^BALESIN_E2E_WEB_SIAP$/m },
        env: {
          BALESIN_API_PROXY: E2E_API_URL,
          BALESIN_DEV_NO_HMR: '1',
          E2E_WEB_PORT: String(E2E_WEB_PORT),
        },
        reuseExistingServer: false,
        // Cache dingin di mesin sibuk: optimasi dependensi + ratusan modul bisa beberapa menit.
        timeout: 600_000,
        stdout: 'pipe' as const,
        stderr: 'pipe' as const,
      },
    ];

/**
 * Jumlah worker Playwright. `E2E_WORKERS` (angka atau persen, mis. `8`/`50%`) menimpa. Bawaan
 * lokal: setengah inti, paling banyak 5 — stack sungguhan (API, worker, Postgres, Redis, Vite) ikut
 * berjalan di mesin yang sama, dan 10 worker pernah membuat pembuatan context browser > 30 dtk
 * (audit QA akhir D1). CI: bawaan Playwright (setengah inti runner).
 */
const workersEnv = process.env.E2E_WORKERS?.trim();
export const workers: number | string | undefined = workersEnv
  ? // Playwright menolak angka berupa teks ("3"); hanya persen yang boleh berupa teks.
    /^\d+$/.test(workersEnv)
    ? Number(workersEnv)
    : workersEnv
  : process.env.CI
    ? undefined
    : Math.max(1, Math.min(5, Math.floor(availableParallelism() / 2)));
