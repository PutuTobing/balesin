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
 *  2. web (Vite dev) di port E2E dengan proxy `/api` ke API E2E.
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
        command: `pnpm --filter @balesin/web dev --port ${E2E_WEB_PORT} --strictPort`,
        cwd: '..',
        url: E2E_BASE_URL,
        env: { BALESIN_API_PROXY: E2E_API_URL },
        reuseExistingServer: false,
        timeout: 120_000,
      },
    ];
