import type { Plugin, ResolvedConfig } from 'vite';
// Impor relatif (bukan `@balesin/shared/...`) supaya ikut ter-bundle saat Vite memuat
// konfigurasi: impor bare akan dieksternalkan dan Node harus memuat berkas .ts mentah.
import {
  color,
  staticVariables,
  themeVariables,
  type CssVariables,
  type ThemeName,
} from '../../../packages/shared/src/design-tokens.ts';
import { renderBrandMarkSvg } from '../src/brand/brand-mark-shape.ts';

const VIRTUAL_ID = 'virtual:design-tokens.css';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const FAVICON_PATH = '/favicon.svg';

function block(selector: string, vars: CssVariables, scheme?: ThemeName, indent = ''): string {
  const lines = Object.entries(vars).map(([name, value]) => `${indent}  ${name}: ${value};`);
  if (scheme) lines.unshift(`${indent}  color-scheme: ${scheme};`);
  return `${indent}${selector} {\n${lines.join('\n')}\n${indent}}`;
}

/**
 * Stylesheet token. Tema default mengikuti `prefers-color-scheme` murni lewat CSS;
 * atribut `data-theme` (di <html> atau elemen mana pun) memaksa terang/gelap.
 */
export function renderTokensCss(): string {
  return [
    '/* Dihasilkan otomatis dari packages/shared/src/design-tokens.ts. Jangan disunting. */',
    block(':root', staticVariables()),
    block(":root,\n[data-theme='light']", themeVariables('light'), 'light'),
    block("[data-theme='dark']", themeVariables('dark'), 'dark'),
    [
      '@media (prefers-color-scheme: dark) {',
      block(":root:not([data-theme='light'])", themeVariables('dark'), 'dark', '  '),
      '}',
    ].join('\n'),
    '',
  ].join('\n\n');
}

export function renderFaviconSvg(): string {
  const { primary, onPrimary, accent } = color.light;
  return renderBrandMarkSvg({ primary, onPrimary, accent });
}

/**
 * `import 'virtual:design-tokens.css'` → CSS variables dari token. Juga mengisi
 * `<meta name="theme-color">` awal; nilainya diperbarui saat tema berganti.
 */
export function designTokens(): Plugin {
  return {
    name: 'balesin:design-tokens',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      return id === RESOLVED_ID ? renderTokensCss() : undefined;
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { name: 'theme-color', content: color.light.bg },
          injectTo: 'head',
        },
      ];
    },
  };
}

/**
 * `<link rel="preload">` untuk font utama, hanya di build produksi.
 * URL-nya diambil dari aset yang benar-benar dihasilkan build (nama ber-hash yang sama
 * dengan yang dipakai CSS), jadi font diunduh satu kali. Di dev server URL font di CSS
 * berbeda (`/@fs/...`), sehingga preload di sana hanya menghasilkan unduhan ganda dan
 * peringatan "preloaded but not used".
 */
export function fontPreload(fileNamePart: string): Plugin {
  let config: ResolvedConfig | undefined;
  return {
    name: 'balesin:font-preload',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        const fileName = Object.keys(context.bundle ?? {}).find(
          (name) => name.includes(fileNamePart) && name.endsWith('.woff2'),
        );
        if (!fileName) {
          throw new Error(
            `Font "${fileNamePart}" tidak ada di hasil build. Periksa src/styles/fonts.css.`,
          );
        }
        return [
          {
            tag: 'link',
            attrs: {
              rel: 'preload',
              as: 'font',
              type: 'font/woff2',
              crossorigin: true,
              href: `${config?.base ?? '/'}${fileName}`,
            },
            injectTo: 'head',
          },
        ];
      },
    },
  };
}

/** Favicon digambar dari tanda merek yang sama dengan komponen `BrandMark`. */
export function brandFavicon(): Plugin {
  return {
    name: 'balesin:brand-favicon',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== FAVICON_PATH) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(renderFaviconSvg());
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: FAVICON_PATH.slice(1),
        source: renderFaviconSvg(),
      });
    },
    transformIndexHtml() {
      return [
        {
          tag: 'link',
          attrs: { rel: 'icon', type: 'image/svg+xml', href: FAVICON_PATH },
          injectTo: 'head',
        },
      ];
    },
  };
}
