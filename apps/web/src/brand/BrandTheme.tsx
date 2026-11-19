import { useLayoutEffect } from 'react';
import { useTheme } from '../theme/theme-context';
import { useBrand } from './brand';
import { BRAND_THEME_PROPERTIES, brandThemeVariables } from './brand-theme';

/**
 * Warna utama organisasi → token aksen (`--primary` dkk.) untuk tema yang sedang tampil, lewat
 * CSSOM pada `<html>` (properti satu per satu, tidak menyisipkan elemen `<style>` berisi teks dari
 * server — CSP aplikasi `style-src-elem 'self' 'unsafe-inline'`). Warna yang tidak lolos
 * kontras di tema itu tidak dipakai (lihat `brandThemeVariables`).
 */
export function BrandTheme() {
  const { primaryColor } = useBrand();
  const { resolved } = useTheme();
  useLayoutEffect(() => {
    const variables = brandThemeVariables(primaryColor, resolved);
    if (!variables) return;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
    return () => {
      for (const name of BRAND_THEME_PROPERTIES) root.style.removeProperty(name);
    };
  }, [primaryColor, resolved]);
  return null;
}
