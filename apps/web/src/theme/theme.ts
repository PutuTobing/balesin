import { deviceKey, readDeviceValue, writeDeviceValue } from '../lib/device-storage';

/**
 * Logika tema. Bawaan = "Ikuti sistem": tidak ada atribut di <html>, CSS memakai
 * `prefers-color-scheme`. Pilihan Terang/Gelap disimpan di perangkat dan dipasang
 * sebagai `<html data-theme>`; `public/theme-init.js` memasangnya sebelum cat pertama.
 */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

/** Harus sama dengan kunci di `public/theme-init.js` (dijaga oleh tes). */
export const THEME_STORAGE_KEY = deviceKey('tema');
export const THEME_ATTRIBUTE = 'data-theme';
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

export function parsePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readPreference(): ThemePreference {
  return parsePreference(readDeviceValue(THEME_STORAGE_KEY));
}

/** "Ikuti sistem" tidak disimpan: kuncinya dihapus supaya CSS yang menentukan. */
export function storePreference(preference: ThemePreference): void {
  writeDeviceValue(THEME_STORAGE_KEY, preference === 'system' ? null : preference);
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference !== 'system') return preference;
  return systemPrefersDark ? 'dark' : 'light';
}

export function applyPreference(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
): void {
  if (preference === 'system') root.removeAttribute(THEME_ATTRIBUTE);
  else root.setAttribute(THEME_ATTRIBUTE, preference);
}

/** Samakan warna bilah browser HP (`<meta name="theme-color">`) dengan latar tema aktif. */
export function syncThemeColorMeta(doc: Document = document): void {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const background = getComputedStyle(doc.documentElement).getPropertyValue('--bg').trim();
  if (background) meta.content = background;
}
