import { color } from '@balesin/shared/design-tokens';
import { describe, expect, it } from 'vitest';
import logoSymbolFile from '../assets/logo-symbol.svg?raw';
import logoFile from '../assets/logo.svg?raw';
import faviconIco from '../../public/favicon.ico?inline';
import { renderFaviconSvg, renderLogoSvg, renderSymbolSvg } from './brand-mark-shape';

/**
 * Penjaga aset merek: berkas logo dan ikon di repo harus sama dengan geometri di
 * `brand-mark-shape.ts` (sumber tunggal) dan berukuran wajar.
 *
 * Bila geometri atau token warna berubah, buat ulang berkasnya:
 * - `src/assets/logo*.svg` = keluaran `renderSymbolSvg`/`renderLogoSvg` dengan warna terang;
 * - ikon PNG di `public/` = render `renderIconSvg` (tata letak `iconLayouts`) dan
 *   `renderFaviconSvg` pada ukuran di bawah ini, lalu dioptimalkan (PNG lossless).
 */
const light = color.light;

describe('logo SVG bersih', () => {
  it('berkas logo sama dengan geometri dan warna token', () => {
    expect(logoSymbolFile).toBe(renderSymbolSvg(light));
    expect(logoFile).toBe(renderLogoSvg(light));
  });

  it.each([
    ['logo-symbol.svg', logoSymbolFile],
    ['logo.svg', logoFile],
    ['favicon', renderFaviconSvg(light)],
  ])('%s tanpa skrip, tautan, atau gambar bitmap', (_name, svg) => {
    expect(svg).not.toMatch(/<script|<image|<foreignObject|href=|\son[a-z]+=|url\(/i);
    expect(svg.match(/#[0-9A-F]{6}/gi)?.every((hex) => Object.values(light).includes(hex))).toBe(
      true,
    );
  });
});

const pngFiles = import.meta.glob<string>('../../public/**/*.png', {
  query: '?inline',
  import: 'default',
  eager: true,
});

function pngInfo(dataUrl: string) {
  const bytes = Uint8Array.from(atob(dataUrl.split(',')[1] ?? ''), (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20), bytes: bytes.length };
}

describe('ikon aplikasi di public/', () => {
  const expected: Record<string, number> = {
    'apple-touch-icon.png': 180,
    'icons/icon-192.png': 192,
    'icons/icon-512.png': 512,
    'icons/icon-maskable-192.png': 192,
    'icons/icon-maskable-512.png': 512,
  };

  it.each(Object.entries(expected))('%s berukuran %ipx dan ringan', (file, size) => {
    const dataUrl = pngFiles[`../../public/${file}`];
    expect(dataUrl, file).toBeDefined();
    const info = pngInfo(dataUrl ?? '');
    expect([info.width, info.height]).toEqual([size, size]);
    expect(info.bytes).toBeLessThan(32 * 1024);
  });
});

describe('favicon.ico', () => {
  it('berisi 16, 32, dan 48 px', () => {
    const bytes = Uint8Array.from(atob(faviconIco.split(',')[1] ?? ''), (c) => c.charCodeAt(0));
    const count = bytes[4] ?? 0;
    const sizes = Array.from({ length: count }, (_, i) => bytes[6 + i * 16] ?? 0).sort(
      (a, b) => a - b,
    );
    expect(sizes).toEqual([16, 32, 48]);
    expect(bytes.length).toBeLessThan(8 * 1024);
  });
});
