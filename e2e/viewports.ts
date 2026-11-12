/** Dua ukuran wajib rubrik desain (docs/DESIGN.md §5). */
export const VIEWPORTS = {
  hp: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
} as const;

export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5173);
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`;

/** Jalankan dev server web otomatis, kecuali E2E_BASE_URL menunjuk server yang sudah jalan. */
export const webServer = process.env.E2E_BASE_URL
  ? undefined
  : {
      command: `pnpm --filter @balesin/web dev --port ${WEB_PORT} --strictPort`,
      cwd: '..',
      url: BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    };
