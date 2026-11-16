import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build, type Plugin, type ResolvedConfig } from 'vite';
// Impor relatif (lihat design-tokens-plugin.ts): ikut ter-bundle saat Vite memuat konfigurasi.
import { DEFAULT_PRODUCT_NAME } from '../../../packages/shared/src/branding.ts';
import { color } from '../../../packages/shared/src/design-tokens.ts';

/**
 * PWA tanpa dependensi tambahan (docs/DECISIONS: service worker buatan sendiri, bukan
 * vite-plugin-pwa/Workbox — cukup precache aset statis + push):
 *  - `/manifest.webmanifest`: nama bawaan white-label (diganti nama merek organisasi saat aplikasi
 *    jalan, lihat `brand/web-manifest.ts`), warna dari token, ikon dari `public/icons`;
 *  - `/sw.js`: `src/sw/sw.ts` dibangun sebagai skrip klasik (IIFE). Build produksi mengisi daftar
 *    precache = berkas hasil build + isi `public/` (tanpa `sw.js` sendiri); dev server = daftar
 *    kosong (tidak ada cache, hanya push).
 */
const SW_ENTRY = 'src/sw/sw.ts';
const SW_FILE = 'sw.js';
const MANIFEST_FILE = 'manifest.webmanifest';

export function renderWebManifest(): string {
  const manifest = {
    id: '/',
    name: DEFAULT_PRODUCT_NAME,
    short_name: DEFAULT_PRODUCT_NAME,
    lang: 'id',
    dir: 'ltr',
    start_url: '/inbox',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: color.light.bg,
    theme_color: color.light.bg,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function bundleServiceWorker(
  config: ResolvedConfig,
  precache: readonly string[],
  version: string,
): Promise<string> {
  const result = await build({
    configFile: false,
    root: config.root,
    logLevel: 'warn',
    publicDir: false,
    define: {
      __PRECACHE__: JSON.stringify(precache),
      __SW_VERSION__: JSON.stringify(version),
    },
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: config.command === 'build',
      sourcemap: false,
      lib: {
        entry: path.resolve(config.root, SW_ENTRY),
        formats: ['iife'],
        name: 'serviceWorker',
        fileName: () => SW_FILE,
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if ('output' in output) {
      const chunk = output.output.find((item) => item.type === 'chunk');
      if (chunk && chunk.type === 'chunk') return chunk.code;
    }
  }
  throw new Error('Service worker tidak menghasilkan kode.');
}

function publicFiles(dir: string, prefix = ''): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) =>
    entry.isDirectory()
      ? publicFiles(path.join(dir, entry.name), `${prefix}/${entry.name}`)
      : [`${prefix}/${entry.name}`],
  );
}

export function serviceWorker(): Plugin {
  let config: ResolvedConfig;
  const built = new Set<string>();
  return {
    name: 'balesin:service-worker',
    configResolved(resolved) {
      config = resolved;
    },
    transformIndexHtml() {
      return [
        { tag: 'link', attrs: { rel: 'manifest', href: `/${MANIFEST_FILE}` }, injectTo: 'head' },
        {
          tag: 'meta',
          attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' },
          injectTo: 'head',
        },
        {
          tag: 'meta',
          attrs: { name: 'mobile-web-app-capable', content: 'yes' },
          injectTo: 'head',
        },
        {
          tag: 'meta',
          attrs: { name: 'apple-mobile-web-app-title', content: DEFAULT_PRODUCT_NAME },
          injectTo: 'head',
        },
      ];
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = (request.url ?? '').split('?')[0];
        if (pathname === `/${MANIFEST_FILE}`) {
          response.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
          response.end(renderWebManifest());
          return;
        }
        if (pathname !== `/${SW_FILE}`) {
          next();
          return;
        }
        bundleServiceWorker(config, [], 'dev')
          .then((code) => {
            response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            response.setHeader('Cache-Control', 'no-cache');
            response.end(code);
          })
          .catch(next);
      });
    },
    generateBundle(_options, bundle) {
      if (config.command !== 'build') return;
      this.emitFile({ type: 'asset', fileName: MANIFEST_FILE, source: renderWebManifest() });
      for (const fileName of Object.keys(bundle)) built.add(`/${fileName}`);
    },
    async closeBundle() {
      if (config.command !== 'build' || built.size === 0) return;
      const precache = [
        // `/index.html` = kerangka aplikasi untuk navigasi offline (ditulis Vite setelah generateBundle).
        ...new Set([
          ...built,
          '/index.html',
          `/${MANIFEST_FILE}`,
          ...publicFiles(config.publicDir),
        ]),
      ]
        .filter((file) => file !== `/${SW_FILE}` && !file.endsWith('.map'))
        .sort();
      const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);
      const code = await bundleServiceWorker(config, precache, version);
      await writeFile(path.join(config.build.outDir, SW_FILE), code);
    },
  };
}
