import { describe, expect, it } from 'vitest';
import { brandThemeVariables, darkerUsableColor } from './brand-theme';

describe('warna merek → token tema', () => {
  it('gelembung keluar ikut warna merek (= isian lembut) untuk navy dan magenta', () => {
    for (const hex of ['#1b3557', '#c2185b']) {
      const vars = brandThemeVariables(hex, 'light');
      expect(vars, hex).not.toBeNull();
      expect(vars?.['--bubble-out']).toBe(vars?.['--primary-soft']);
    }
  });

  it('usulan warna lebih gelap untuk warna yang tidak terpakai di tema terang', () => {
    expect(brandThemeVariables('#1f9d6b', 'light')).toBeNull();
    const darker = darkerUsableColor('#1f9d6b');
    expect(darker).toMatch(/^#[0-9a-f]{6}$/);
    expect(brandThemeVariables(darker, 'light')).not.toBeNull();
    // Warna yang sudah terpakai tidak perlu usulan, tetapi fungsinya tetap mengembalikan versi sah.
    expect(darkerUsableColor('bukan warna')).toBeNull();
  });
});
