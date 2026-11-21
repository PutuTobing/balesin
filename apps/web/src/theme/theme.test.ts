import { afterEach, describe, expect, it, vi } from 'vitest';
import themeInitScript from '../../public/theme-init.js?raw';
import {
  THEME_ATTRIBUTE,
  THEME_STORAGE_KEY,
  applyPreference,
  parsePreference,
  readPreference,
  resolveTheme,
  storePreference,
  syncThemeColorMeta,
} from './theme';

const root = document.documentElement;

describe('pilihan tema', () => {
  it('menganggap nilai tak dikenal sebagai "Ikuti sistem"', () => {
    expect(parsePreference('light')).toBe('light');
    expect(parsePreference('dark')).toBe('dark');
    expect(parsePreference('system')).toBe('system');
    expect(parsePreference('ungu')).toBe('system');
    expect(parsePreference(null)).toBe('system');
    expect(parsePreference(undefined)).toBe('system');
  });

  it('bawaannya "Ikuti sistem" saat belum ada yang tersimpan', () => {
    expect(readPreference()).toBe('system');
  });

  it('menyimpan Terang/Gelap di perangkat dan membacanya kembali', () => {
    storePreference('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(readPreference()).toBe('dark');

    storePreference('light');
    expect(readPreference()).toBe('light');
  });

  it('"Ikuti sistem" menghapus simpanan supaya CSS yang menentukan', () => {
    storePreference('dark');
    storePreference('system');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(readPreference()).toBe('system');
  });

  it('tetap jalan saat penyimpanan diblokir browser', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(readPreference()).toBe('system');
    expect(() => storePreference('dark')).not.toThrow();
  });

  it('menerjemahkan "Ikuti sistem" sesuai pengaturan perangkat', () => {
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('memasang data-theme hanya untuk pilihan eksplisit', () => {
    applyPreference('dark');
    expect(root).toHaveAttribute(THEME_ATTRIBUTE, 'dark');

    applyPreference('light');
    expect(root).toHaveAttribute(THEME_ATTRIBUTE, 'light');

    applyPreference('system');
    expect(root).not.toHaveAttribute(THEME_ATTRIBUTE);
  });
});

describe('warna bilah browser', () => {
  afterEach(() => {
    document.head.querySelector('meta[name="theme-color"]')?.remove();
    root.style.removeProperty('--bg');
  });

  it('mengikuti latar tema aktif', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#F6F4EF';
    document.head.append(meta);
    root.style.setProperty('--bg', '#0F1620');

    syncThemeColorMeta();

    expect(meta.content).toBe('#0F1620');
  });

  it('tidak melakukan apa-apa bila meta tidak ada', () => {
    expect(() => syncThemeColorMeta()).not.toThrow();
  });
});

/**
 * `public/theme-init.js` adalah skrip eksternal yang memblokir render (bukan inline,
 * demi CSP). Ia berjalan sebelum aplikasi, jadi harus sepakat dengan theme.ts.
 */
describe('theme-init.js (anti-kedipan)', () => {
  // Skrip klasik: dijalankan apa adanya seperti oleh <script src>.
  const runInitScript = () => window.eval(themeInitScript) as unknown;

  it('memakai kunci penyimpanan yang sama dengan aplikasi', () => {
    expect(themeInitScript).toContain(`'${THEME_STORAGE_KEY}'`);
    expect(themeInitScript).toContain(`'${THEME_ATTRIBUTE}'`);
  });

  it('memasang tema tersimpan sebelum aplikasi dimuat', () => {
    storePreference('dark');
    runInitScript();
    expect(root).toHaveAttribute(THEME_ATTRIBUTE, 'dark');
  });

  it('membiarkan CSS mengikuti sistem bila tidak ada simpanan', () => {
    runInitScript();
    expect(root).not.toHaveAttribute(THEME_ATTRIBUTE);
  });

  it('mengabaikan nilai tersimpan yang rusak', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, '"><script>');
    runInitScript();
    expect(root).not.toHaveAttribute(THEME_ATTRIBUTE);
  });

  it('tidak melempar galat saat penyimpanan diblokir', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(runInitScript).not.toThrow();
    expect(root).not.toHaveAttribute(THEME_ATTRIBUTE);
  });
});
