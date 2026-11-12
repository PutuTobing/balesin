import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };
import { brandFavicon, designTokens } from './vite/design-tokens-plugin.ts';

export default defineConfig({
  plugins: [react(), designTokens(), brandFavicon()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    proxy: {
      // API dan WebSocket inbox dilayani apps/api.
      '/api': { target: 'http://localhost:3000', changeOrigin: true, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    // CSS komponen tidak diproses di tes (jsdom tidak punya layout). Pengecualian:
    // impor `.css?raw`, supaya tes penjaga bisa membaca isi berkas CSS apa adanya.
    css: { include: [/\.css\?raw/] },
  },
});
