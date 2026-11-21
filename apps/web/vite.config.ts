import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };
import { brandFavicon, designTokens, fontPreload } from './vite/design-tokens-plugin.ts';
import { serviceWorker } from './vite/service-worker-plugin.ts';

export default defineConfig({
  plugins: [
    react(),
    designTokens(),
    brandFavicon(),
    // Font UI utama (subset Latin). Nama berkasnya sama dengan di src/styles/fonts.css.
    fontPreload('plus-jakarta-sans-latin-wght-normal'),
    // Manifest PWA + service worker (precache aset statis, Web Push).
    serviceWorker(),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    // Stack E2E/foto layar: tanpa HMR. Berkas yang disunting selagi tes berjalan (mis. paket
    // `shared` oleh sesi lain) tidak boleh memuat ulang halaman di tengah tes — itu membuang isian
    // formulir dan dialog yang sedang dibuka, dan gagalnya tampak acak.
    ...(process.env.BALESIN_DEV_NO_HMR === '1' ? { hmr: false } : {}),
    proxy: {
      // API dan WebSocket inbox dilayani apps/api. E2E memakai API tersendiri (e2e/stack).
      '/api': {
        target: process.env.BALESIN_API_PROXY ?? 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    // `pnpm test` menjalankan semua paket bersamaan (tes integrasi API/worker ikut memakan CPU):
    // tes layar utuh yang biasanya < 1 detik bisa melewati batas bawaan 5 detik. Batas waktu
    // bukan asersi — menunggu lebih lama tidak melemahkan apa pun yang diperiksa.
    testTimeout: 15_000,
    // CSS komponen tidak diproses di tes (jsdom tidak punya layout). Pengecualian:
    // impor `.css?raw`, supaya tes penjaga bisa membaca isi berkas CSS apa adanya.
    css: { include: [/\.css\?raw/] },
  },
});
