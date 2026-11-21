import { brandColorTextColor } from '@balesin/shared';
import {
  MIN_GRAPHIC_CONTRAST,
  MIN_TEXT_CONTRAST,
  color,
  contrastRatio,
  type ThemeName,
} from '@balesin/shared/design-tokens';

const HEX = /^#[0-9a-f]{6}$/;

/** Campur dua warna `#rrggbb` (porsi `amount` dari `a`). */
export function mixHex(a: string, b: string, amount: number): string {
  const channel = (hex: string, index: number) =>
    parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  const parts = [0, 1, 2].map((index) =>
    Math.round(channel(a, index) * amount + channel(b, index) * (1 - amount))
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${parts.join('')}`;
}

/** Porsi warna utama di isian lembut (item navigasi aktif, pilihan terpilih). */
// Terang 10%: tautan `--primary` di atas gelembung keluar (= isian lembut) tetap ≥ 4,5:1 untuk
// warna sekelas biru bawaan.
const SOFT_AMOUNT: Record<ThemeName, number> = { light: 0.1, dark: 0.22 };

/**
 * Token aksen dari warna utama organisasi untuk satu tema: `--primary`, `--on-primary` (teks yang
 * terbaca di atasnya, `brandColorTextColor`), `--primary-soft`, dan `--bubble-out` (gelembung pesan
 * dari tim = isian lembut yang sama, seperti di design system bawaan). Hanya dipakai bila SEMUA
 * pasangan kontras yang dijamin design system tetap lolos di tema itu:
 *  - primary sebagai teks/link di atas bg, surface, gelembung masuk, dan isian lembut (≥ 4,5:1);
 *  - primary sebagai grafis di atas surface2 (≥ 3:1);
 *  - tinta & tinta sekunder di atas isian lembut / gelembung keluar (≥ 4,5:1).
 * Selain itu `null` = token bawaan tema. Jadi warna gelap (mis. biru dongker) dipakai di tema terang
 * tetapi mode gelap tetap memakai biru bawaannya yang terbaca.
 */
export function brandThemeVariables(
  primaryColor: string | null,
  theme: ThemeName,
): Record<string, string> | null {
  const primary = primaryColor?.trim().toLowerCase() ?? '';
  if (!HEX.test(primary)) return null;
  const onPrimary = brandColorTextColor(primary);
  if (!onPrimary) return null;
  const palette = color[theme];
  const soft = mixHex(primary, palette.surface.toLowerCase(), SOFT_AMOUNT[theme]);
  const text = [palette.bg, palette.surface, palette.bubbleIn, soft];
  const ok =
    text.every((background) => contrastRatio(primary, background) >= MIN_TEXT_CONTRAST) &&
    contrastRatio(primary, palette.surface2) >= MIN_GRAPHIC_CONTRAST &&
    contrastRatio(palette.ink, soft) >= MIN_TEXT_CONTRAST &&
    contrastRatio(palette.ink2, soft) >= MIN_TEXT_CONTRAST;
  if (!ok) return null;
  return {
    '--primary': primary,
    '--on-primary': onPrimary,
    '--primary-soft': soft,
    '--bubble-out': soft,
  };
}

/**
 * Versi lebih gelap dari `hex` yang lolos di tema terang (usulan saat warna tidak terpakai), atau
 * `null` bila tidak ada. Digelapkan 2% per langkah ke arah hitam.
 */
export function darkerUsableColor(hex: string): string | null {
  const value = hex.trim().toLowerCase();
  if (!HEX.test(value)) return null;
  for (let amount = 0.98; amount > 0.2; amount -= 0.02) {
    const candidate = mixHex(value, '#000000', amount);
    if (brandThemeVariables(candidate, 'light')) return candidate;
  }
  return null;
}

export const BRAND_THEME_PROPERTIES = [
  '--primary',
  '--on-primary',
  '--primary-soft',
  '--bubble-out',
] as const;
