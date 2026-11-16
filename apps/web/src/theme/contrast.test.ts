import {
  MIN_GRAPHIC_CONTRAST,
  MIN_TEXT_CONTRAST,
  color,
  contrastPairs,
  contrastRatio,
  relativeLuminance,
  type ThemeName,
} from '@balesin/shared/design-tokens';
import { describe, expect, it } from 'vitest';

const themes: ThemeName[] = ['light', 'dark'];

describe('rumus kontras WCAG', () => {
  it('hitam di atas putih = 21, warna sama = 1', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#1167D8', '#1167d8')).toBe(1);
  });

  it('menolak format warna selain #RRGGBB', () => {
    expect(() => relativeLuminance('#FFF')).toThrow();
    expect(() => relativeLuminance('rgb(0 0 0)')).toThrow();
  });
});

describe('kontras token (DESIGN.md §1: teks minimal 4.5:1)', () => {
  const cases = themes.flatMap((theme) =>
    contrastPairs.map((pair) => ({
      ...pair,
      theme,
      ratio: contrastRatio(color[theme][pair.fg], color[theme][pair.bg]),
    })),
  );

  it.each(cases)('$theme: $fg di atas $bg ≥ $min', ({ ratio, min }) => {
    expect(ratio).toBeGreaterThanOrEqual(min);
  });

  it('semua teks utama dan sekunder terdaftar untuk setiap latar', () => {
    const backgrounds = ['bg', 'surface', 'surface2', 'bubbleOut', 'bubbleIn'] as const;
    for (const fg of ['ink', 'ink2'] as const) {
      for (const bg of backgrounds) {
        expect(contrastPairs).toContainEqual({ fg, bg, min: MIN_TEXT_CONTRAST });
      }
    }
  });

  it('ambang yang dipakai hanya 4.5 (teks) dan 3 (grafis)', () => {
    for (const pair of contrastPairs) {
      expect([MIN_TEXT_CONTRAST, MIN_GRAPHIC_CONTRAST]).toContain(pair.min);
    }
  });

  /**
   * Catatan terdokumentasi: token status dari DESIGN.md tidak cukup kontras untuk teks
   * di tema terang, sehingga teks memakai varian `*Ink`. Jika token dasar diubah
   * sampai lolos, tes ini gagal dan varian `*Ink` bisa dihapus.
   */
  it('token status dasar memang tidak aman untuk teks di tema terang', () => {
    const { surface, success, warning, danger } = color.light;
    expect(contrastRatio(success, surface)).toBeLessThan(MIN_TEXT_CONTRAST);
    expect(contrastRatio(warning, surface)).toBeLessThan(MIN_TEXT_CONTRAST);
    expect(contrastRatio(danger, surface)).toBeLessThan(MIN_TEXT_CONTRAST);
  });
});

/**
 * Inbox (Fase 2 butir 5): baris chat terpilih berlatar `primarySoft`, dan di atasnya tampil teks
 * sekunder, centang dibaca (`primary`), serta lencana hitungan tab aktif (`ink`). Hitung mundur
 * sesi punya latar `surface` sendiri (pasangan `warningInk`/`dangerInk` × `surface` sudah di
 * `contrastPairs`). Ikon gagal kirim (`dangerInk`) cukup ambang grafis 3:1. Dicek di sini karena
 * `contrastPairs` milik paket shared.
 */
describe('kontras baris chat terpilih (latar primarySoft)', () => {
  const cases = themes.flatMap((theme) =>
    (['ink', 'ink2', 'primary'] as const).map((fg) => ({
      theme,
      fg,
      ratio: contrastRatio(color[theme][fg], color[theme].primarySoft),
    })),
  );

  it.each(cases)('$theme: $fg di atas primarySoft ≥ 4.5', ({ ratio }) => {
    expect(ratio).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });
});

describe('ikon gagal kirim di baris chat terpilih', () => {
  it.each(themes)('%s: dangerInk di atas primarySoft ≥ 3 (grafis)', (theme) => {
    expect(contrastRatio(color[theme].dangerInk, color[theme].primarySoft)).toBeGreaterThanOrEqual(
      MIN_GRAPHIC_CONTRAST,
    );
  });
});
