import { breakpoints, color, font } from '@balesin/shared/design-tokens';
import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import { renderFaviconSvg, renderTokensCss } from '../../vite/design-tokens-plugin';

/**
 * Penjaga "tidak ada warna/ukuran liar" (DESIGN.md §3, rubrik §5 kriteria 2):
 * semua CSS aplikasi hanya boleh memakai variabel yang dihasilkan dari design token.
 */
const cssFiles = import.meta.glob<string>('../**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const sources = Object.entries(cssFiles).map(([path, raw]) => ({
  // Kunci glob relatif ke folder ini: './x.css' atau '../folder/x.css'.
  path: path.startsWith('./') ? `src/styles/${path.slice(2)}` : path.replace('../', 'src/'),
  // Buang komentar supaya contoh di komentar tidak ikut dinilai.
  css: raw.replace(/\/\*[\s\S]*?\*\//g, ''),
}));

const FONTS_FILE = 'src/styles/fonts.css';

interface Declaration {
  path: string;
  property: string;
  value: string;
}

const declarations: Declaration[] = sources.flatMap(({ path, css }) =>
  [...css.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;{}]+)/gm)].map((match) => ({
    path,
    property: match[1] ?? '',
    value: (match[2] ?? '').trim(),
  })),
);

function offenders(filter: (declaration: Declaration) => boolean): string[] {
  return declarations.filter(filter).map((d) => `${d.path} → ${d.property}: ${d.value}`);
}

const tokensCss = renderTokensCss();
const definedVariables = new Set([...tokensCss.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));

describe('CSS variables dari token', () => {
  it('menghasilkan warna untuk tema terang, gelap, dan ikuti sistem', () => {
    expect(tokensCss).toContain(`--bg: ${color.light.bg};`);
    expect(tokensCss).toContain(`--bg: ${color.dark.bg};`);
    expect(tokensCss).toContain(`--bubble-out: ${color.light.bubbleOut};`);
    expect(tokensCss).toContain(`--surface-2: ${color.dark.surface2};`);
    expect(tokensCss).toMatch(/\[data-theme='dark'\] \{\n {2}color-scheme: dark;/);
    expect(tokensCss).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\[data-theme='light'\]\) \{/,
    );
  });

  it('menghasilkan skala huruf, spasi, radius, ukuran, dan gerak', () => {
    for (const expected of [
      '--text-12: 0.75rem;',
      '--text-14: 0.875rem;',
      '--text-32: 2rem;',
      '--leading-text: 1.45;',
      '--leading-title: 1.2;',
      '--space-4: 4px;',
      '--space-48: 48px;',
      '--radius-input: 6px;',
      '--radius-card: 10px;',
      '--radius-bubble: 16px;',
      '--radius-pill: 999px;',
      '--size-rail: 64px;',
      '--size-list: 360px;',
      '--size-detail: 340px;',
      '--size-touch: 44px;',
      '--duration-fast: 120ms;',
      '--duration-slow: 200ms;',
    ]) {
      expect(tokensCss).toContain(expected);
    }
  });

  it('setiap var(--…) yang dipakai CSS aplikasi berasal dari token', () => {
    const unknown = sources.flatMap(({ path, css }) =>
      [...css.matchAll(/var\((--[a-z0-9-]+)/g)]
        .map((match) => match[1])
        .filter((name) => !definedVariables.has(name))
        .map((name) => `${path} → ${name}`),
    );
    expect(unknown).toEqual([]);
  });

  it('favicon digambar dengan warna token', () => {
    const svg = renderFaviconSvg();
    expect(svg).toContain(color.light.primary);
    expect(svg).toContain(color.light.accent);
  });
});

describe('tidak ada nilai liar di CSS aplikasi', () => {
  it('ada berkas CSS yang diperiksa', () => {
    expect(sources.length).toBeGreaterThan(10);
    expect(declarations.length).toBeGreaterThan(200);
  });

  it('tidak ada warna yang ditulis langsung', () => {
    const colorLiteral = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/i;
    const namedColor = /\b(?:white|black|red|blue|green|gray|grey|orange|purple|yellow)\b/i;
    expect(
      offenders(
        (d) =>
          !d.property.startsWith('--') && (colorLiteral.test(d.value) || namedColor.test(d.value)),
      ),
    ).toEqual([]);
  });

  it('ukuran huruf hanya dari skala token', () => {
    expect(
      offenders(
        (d) => d.property === 'font-size' && !/^(var\(--text-\d+\)|inherit)$/.test(d.value),
      ),
    ).toEqual([]);
  });

  it('keluarga dan berat huruf hanya dari token', () => {
    expect(
      offenders(
        (d) =>
          d.path !== FONTS_FILE &&
          ((d.property === 'font-family' && !/^var\(--font-(sans|mono)\)$/.test(d.value)) ||
            (d.property === 'font-weight' && !/^var\(--weight-[a-z]+\)$/.test(d.value)) ||
            (d.property === 'font' && d.value !== 'inherit')),
      ),
    ).toEqual([]);
  });

  it('spasi (padding, margin, gap) hanya dari token kelipatan 4', () => {
    const spacing = /^(padding|margin|gap|row-gap|column-gap)(-|$)/;
    // Yang boleh selain token: 0, auto, dan ±1px untuk kompensasi garis rambut.
    const literalLength = /(?<![\w.-])-?(?!0(?![.\d]))(?!1px\b)\d*\.?\d+(px|rem|em|%)/;
    expect(
      offenders(
        (d) => spacing.test(d.property) && literalLength.test(d.value.replace(/var\([^)]*\)/g, '')),
      ),
    ).toEqual([]);
  });

  it('radius hanya dari token', () => {
    expect(
      offenders(
        (d) =>
          d.property.startsWith('border') &&
          d.property.endsWith('radius') &&
          /\d/.test(d.value.replace(/var\([^)]*\)/g, '').replace(/\b0\b/g, '')) &&
          !/^calc\(var\(--radius-[a-z]+\) \/ \d+\)$/.test(d.value),
      ),
    ).toEqual([]);
  });

  it('durasi gerak hanya dari token', () => {
    expect(
      offenders(
        (d) =>
          /^(transition|animation)(-duration)?$/.test(d.property) &&
          !d.value.includes('!important') &&
          /\d+m?s\b/.test(d.value.replace(/var\([^)]*\)/g, '')),
      ),
    ).toEqual([]);
  });

  it('media query lebar hanya memakai breakpoint token', () => {
    const allowed = new Set([
      breakpoints.hpMax,
      breakpoints.hpMax + 1,
      breakpoints.desktopMin - 1,
      breakpoints.desktopMin,
    ]);
    const stray = sources.flatMap(({ path, css }) =>
      [...css.matchAll(/\((?:min|max)-width:\s*(\d+)px\)/g)]
        .filter((match) => !allowed.has(Number(match[1])))
        .map((match) => `${path} → ${match[0]}`),
    );
    expect(stray).toEqual([]);
  });
});

describe('font self-host', () => {
  const fontsCss = sources.find((source) => source.path === FONTS_FILE)?.css ?? '';

  it('setiap keluarga font kustom di token punya @font-face', () => {
    const custom = [font.sans, font.mono].flatMap((stack) =>
      [...stack.matchAll(/'([^']+ (?:Variable|Fallback))'/g)].map((match) => match[1]),
    );
    expect(custom).toHaveLength(4);
    for (const family of custom) {
      expect(fontsCss).toContain(`font-family: '${family}';`);
    }
  });

  it('hanya memuat subset Latin dari paket lokal, tanpa CDN', () => {
    const urls = [...fontsCss.matchAll(/url\('([^']+)'\)/g)].map((match) => match[1]);
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url).toMatch(
        /^@fontsource-variable\/[a-z-]+\/files\/[a-z-]+-latin-wght-normal\.woff2$/,
      );
    }
  });

  it('tidak ada URL eksternal di CSS maupun index.html', () => {
    const external = /(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i;
    for (const { path, css } of sources) {
      expect(external.test(css), path).toBe(false);
    }
    expect(external.test(indexHtml.replace(/<!--[\s\S]*?-->/g, ''))).toBe(false);
  });
});

describe('index.html aman untuk CSP tanpa inline script', () => {
  const html = indexHtml.replace(/<!--[\s\S]*?-->/g, '');

  it('semua <script> memakai src (tidak ada skrip inline)', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc=/);
      expect(body?.trim()).toBe('');
    }
  });

  it('tidak ada atribut event inline', () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('skrip tema dimuat sebelum aplikasi dan memblokir render', () => {
    const themeScript = html.indexOf('src="/theme-init.js"');
    const appScript = html.indexOf('src="/src/main.tsx"');
    expect(themeScript).toBeGreaterThan(-1);
    expect(themeScript).toBeLessThan(appScript);
    expect(html).toMatch(/<script src="\/theme-init\.js"><\/script>/);
  });
});
