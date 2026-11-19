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
const SOFT_AMOUNT: Record<ThemeName, number> = { light: 0.12, dark: 0.22 };

/**
 * Token aksen dari warna utama organisasi untuk satu tema: `--primary`, `--on-primary` (teks yang
 * terbaca di atasnya, `brandColorTextColor`), dan `--primary-soft`. Hanya dipakai bila SEMUA
 * pasangan kontras yang dijamin design system (`contrastPairs`: primary sebagai teks/link di atas
 * bg/surface/gelembung, sebagai grafis di atas surface2/primary-soft, tinta di atas primary-soft)
 * tetap lolos di tema itu; selain itu `null` = token bawaan tema. Jadi warna gelap (mis. biru dongker)
 * dipakai di tema terang tetapi mode gelap tetap memakai biru bawaannya yang terbaca.
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
  const text = [palette.bg, palette.surface, palette.bubbleOut, palette.bubbleIn];
  const graphic = [palette.surface2, soft];
  const ok =
    text.every((background) => contrastRatio(primary, background) >= MIN_TEXT_CONTRAST) &&
    graphic.every((background) => contrastRatio(primary, background) >= MIN_GRAPHIC_CONTRAST) &&
    contrastRatio(palette.ink, soft) >= MIN_TEXT_CONTRAST;
  if (!ok) return null;
  return { '--primary': primary, '--on-primary': onPrimary, '--primary-soft': soft };
}

export const BRAND_THEME_PROPERTIES = ['--primary', '--on-primary', '--primary-soft'] as const;
