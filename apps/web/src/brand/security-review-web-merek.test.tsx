/**
 * Tes penjaga review keamanan web — Pengaturan → Merek & penerapan merek di aplikasi
 * (docs/security-reviews/2026-11-24-web-merek.md). Semua `it` = regresi (LULUS); tidak ada
 * temuan Sedang ke atas, jadi tidak ada `it.fails`.
 */
import {
  API_ROUTES,
  BRAND_DARK_TEXT,
  brandingResponseSchema,
  type BrandIcons,
} from '@balesin/shared';
import {
  MIN_GRAPHIC_CONTRAST,
  MIN_TEXT_CONTRAST,
  color,
  contrastRatio,
  type ThemeName,
} from '@balesin/shared/design-tokens';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../i18n/id';
import { apiError, fakeSession, json } from '../test/fake-api';
import { renderApp } from '../test/render-app';
import { ThemeProvider } from '../theme/ThemeProvider';
import { BrandContext, defaultBrand } from './brand';
import { BRAND_THEME_PROPERTIES, brandThemeVariables } from './brand-theme';
import { BrandTheme } from './BrandTheme';
import { brandedManifest, useBrandIcons } from './web-manifest';

const HEX = /^#[0-9a-f]{6}$/;
const ORIGIN = 'https://balesin.contoh.id';
const THEMES: ThemeName[] = ['light', 'dark'];

afterEach(() => {
  for (const name of BRAND_THEME_PROPERTIES) document.documentElement.style.removeProperty(name);
  document.head.querySelectorAll('link[data-brand]').forEach((link) => link.remove());
});

describe('review keamanan — warna merek ke CSSOM', () => {
  // `GET /branding` publik: `primaryColor` di skema respons = `z.string()` bebas, jadi klien wajib
  // menyaring ulang sebelum menulis ke `style` milik `<html>`.
  const HOSTILE = [
    'red',
    '#fff',
    '#1167d8;background:url(https://evil.example/x)',
    '#1167d8 !important',
    'url(https://evil.example/x)',
    'expression(alert(1))',
    'var(--danger)',
    '#1167d8\u0000',
    '#11 67d8',
    '#1167d8ff',
    'rgb(17 103 216)',
    '</style><script>alert(1)</script>',
    '#gggggg',
  ];

  it('nilai selain #rrggbb murni ditolak → token bawaan', () => {
    for (const value of HOSTILE) {
      for (const theme of THEMES) expect(brandThemeVariables(value, theme), value).toBeNull();
    }
    // Spasi/baris baru di tepi hanya dirapikan: hasilnya tetap hex murni, bukan teks mentah.
    expect(brandThemeVariables(' #1167D8\n', 'light')?.['--primary']).toBe('#1167d8');
  });

  it('BrandTheme tidak menulis apa pun ke <html> untuk nilai berbahaya; nilai sah hanya 3 token hex', () => {
    for (const primaryColor of HOSTILE) {
      const view = render(
        <ThemeProvider>
          <BrandContext value={{ ...defaultBrand, primaryColor }}>
            <BrandTheme />
          </BrandContext>
        </ThemeProvider>,
      );
      for (const name of BRAND_THEME_PROPERTIES) {
        expect(document.documentElement.style.getPropertyValue(name), primaryColor).toBe('');
      }
      view.unmount();
    }
    const before = document.documentElement.style.length;
    const view = render(
      <ThemeProvider>
        <BrandContext value={{ ...defaultBrand, primaryColor: '#1B3557' }}>
          <BrandTheme />
        </BrandContext>
      </ThemeProvider>,
    );
    const style = document.documentElement.style;
    expect(style.length - before).toBe(BRAND_THEME_PROPERTIES.length);
    for (const name of BRAND_THEME_PROPERTIES) expect(style.getPropertyValue(name)).toMatch(HEX);
    view.unmount();
    for (const name of BRAND_THEME_PROPERTIES) expect(style.getPropertyValue(name)).toBe('');
  });

  it('warna yang diterima tidak pernah menurunkan kontras (sapuan 4096 warna × 2 tema)', () => {
    const step = [0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255];
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    let accepted = 0;
    for (const theme of THEMES) {
      const p = color[theme];
      for (const r of step)
        for (const g of step)
          for (const b of step) {
            const value = `#${hex(r)}${hex(g)}${hex(b)}`;
            const vars = brandThemeVariables(value, theme);
            if (!vars) continue;
            accepted += 1;
            const primary = vars['--primary']!;
            const on = vars['--on-primary']!;
            const soft = vars['--primary-soft']!;
            for (const v of [primary, on, soft]) expect(v).toMatch(HEX);
            expect(contrastRatio(on, primary)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
            // Gelembung keluar ikut merek (= isian lembut): tautan, tinta, dan tinta sekunder di
            // atasnya tetap ≥ 4,5:1 (review desain Merek W3).
            expect(vars['--bubble-out']).toBe(soft);
            for (const bg of [p.bg, p.surface, p.bubbleIn, soft]) {
              expect(contrastRatio(primary, bg), `${theme} ${value}`).toBeGreaterThanOrEqual(
                MIN_TEXT_CONTRAST,
              );
            }
            expect(contrastRatio(primary, p.surface2)).toBeGreaterThanOrEqual(MIN_GRAPHIC_CONTRAST);
            expect(contrastRatio(p.ink, soft)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
            expect(contrastRatio(p.ink2, soft)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
            // `--on-primary` juga dipakai DI LUAR latar primary (tombol `.danger` di atas
            // `--danger-ink`, Button.module.css). Di tema terang selalu putih (= bawaan); di tema
            // gelap selalu tinta gelap — keduanya tetap terbaca di atas danger-ink.
            expect(on).toBe(theme === 'light' ? p.onPrimary.toLowerCase() : BRAND_DARK_TEXT);
            expect(contrastRatio(on, p.dangerInk)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
          }
    }
    expect(accepted).toBeGreaterThan(0);
  });
});

describe('review keamanan — ikon & manifest merek', () => {
  const iconsWith = (srcs: string[]): BrandIcons => ({
    favicon: '/api/v1/branding/icons/favicon-32.png?v=1',
    appleTouchIcon: '/api/v1/branding/icons/apple-touch-icon.png?v=1',
    manifest: srcs.map((src) => ({ src, sizes: '192x192', type: 'image/png', purpose: 'any' })),
  });

  it('manifest: campuran ikon sama origin + origin lain → hanya yang sama origin tersisa', () => {
    const manifest = brandedManifest(
      { icons: [] },
      {
        productName: 'Toko',
        icons: iconsWith([
          'https://evil.example/a.png',
          '/api/v1/branding/icons/icon-192.png?v=1',
          '//evil.example/b.png',
          'javascript:alert(1)',
        ]),
      },
      ORIGIN,
    );
    expect(manifest.icons?.map((icon) => icon.src)).toEqual([
      `${ORIGIN}/api/v1/branding/icons/icon-192.png?v=1`,
    ]);
  });

  it('skema respons membuang kunci tak dikenal di ikon manifest (spread `...icon` aman)', () => {
    const parsed = brandingResponseSchema.parse({
      productName: 'X',
      organizationName: null,
      primaryColor: null,
      logoUrl: null,
      icons: {
        favicon: '/f.png',
        appleTouchIcon: '/a.png',
        manifest: [
          {
            src: '/i.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
            start_url: 'https://evil.example/',
          },
        ],
      },
    });
    expect(Object.keys(parsed.icons!.manifest[0]!).sort()).toEqual([
      'purpose',
      'sizes',
      'src',
      'type',
    ]);
  });

  it('favicon/apple-touch: alamat dipasang sebagai atribut saja (tanpa parsing HTML) dan dipulihkan', () => {
    const original = document.createElement('link');
    original.rel = 'icon';
    original.href = '/favicon.svg';
    document.head.append(original);
    const hostile = '/x"><script id="disuntik">alert(1)</script>';
    const icons = { ...iconsWith([]), favicon: hostile, appleTouchIcon: hostile };
    const hook = renderHook(() => useBrandIcons(icons));
    const icon = document.head.querySelector<HTMLLinkElement>('link[rel="icon"][data-brand]');
    // Dijadikan alamat absolut sama origin (W1), tetap sebagai atribut saja.
    expect(icon?.getAttribute('href')).toBe(new URL(hostile, window.location.origin).href);
    expect(document.getElementById('disuntik')).toBeNull();
    expect(document.head.contains(original)).toBe(false);
    hook.unmount();
    expect(document.head.querySelector('link[data-brand]')).toBeNull();
    expect(document.head.contains(original)).toBe(true);
    original.remove();
  });

  it('favicon/apple-touch dari origin lain → tidak dipasang; ikon bawaan tetap (W1)', () => {
    const original = document.createElement('link');
    original.rel = 'icon';
    original.href = '/favicon.svg';
    document.head.append(original);
    for (const evil of [
      'https://evil.example/f.png',
      '//evil.example/f.png',
      'javascript:alert(1)',
    ]) {
      const icons = { ...iconsWith([]), favicon: evil, appleTouchIcon: evil };
      const hook = renderHook(() => useBrandIcons(icons));
      expect(document.head.querySelector('link[data-brand]'), evil).toBeNull();
      expect(document.head.contains(original), evil).toBe(true);
      hook.unmount();
    }
    original.remove();
  });
});

describe('review keamanan — halaman Pengaturan → Merek', () => {
  it('Admin membuka /pengaturan/merek langsung → dialihkan; GET /settings/branding tidak dipanggil', async () => {
    const view = await renderApp('/pengaturan/merek', { session: fakeSession('admin') });
    await waitFor(() => expect(view.router.state.location.pathname).toBe('/pengaturan'));
    expect(view.api.requests.some((r) => r.path === API_ROUTES.settings.branding)).toBe(false);
  });

  it('429 dari PATCH → tombol simpan terkunci (tidak bisa dipicu berulang)', async () => {
    let patched = 0;
    await renderApp('/pengaturan/merek', {
      routes: {
        [`GET ${API_ROUTES.settings.branding}`]: () =>
          json({
            branding: {
              productName: null,
              primaryColor: null,
              primaryTextColor: null,
              mascotName: null,
              logo: null,
              defaults: { productName: 'Balesin', mascotName: 'Kak Sky' },
            },
          }),
        [`PATCH ${API_ROUTES.settings.branding}`]: () => {
          patched += 1;
          return apiError(429, 'RATE_LIMITED', 'Terlalu sering mengubah merek.', {
            retryAfter: 120,
          });
        },
      },
    });
    fireEvent.change(await screen.findByLabelText(t.brandingSettings.productName), {
      target: { value: 'Halo Maju' },
    });
    const save = screen.getByRole('button', { name: t.brandingSettings.save });
    fireEvent.click(save);
    expect(await screen.findByText(t.brandingSettings.lockedTitle)).toBeVisible();
    expect(screen.getByRole('button', { name: t.brandingSettings.save })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: t.brandingSettings.save }));
    expect(patched).toBe(1);
  });
});
