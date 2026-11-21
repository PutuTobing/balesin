import { describe, expect, it } from 'vitest';
import { SCROLL_KEYS, isScrolledToBottom, pickActiveSection } from './section-nav';

const at = (...tops: number[]) =>
  ['ringkasan', 'webhook', 'profil-bisnis', 'nama', 'kredensial', 'akses'].map((id, index) => ({
    id,
    top: tops[index] ?? 9999,
  }));

describe('pemilih bagian aktif (navigasi bagian halaman nomor)', () => {
  it('bagian terakhir yang tepi atasnya sudah sampai tepi atas wadah + 24px', () => {
    // Wadah mulai di y 72 (di bawah header). Di puncak: kartu pertama di 72 + 24.
    expect(pickActiveSection(at(96, 900, 1500, 2100, 2300, 2900), 72, false)).toBe('ringkasan');
    // Profil bisnis sudah di atas, Nama channel belum.
    expect(pickActiveSection(at(-1600, -900, 80, 700, 900, 1500), 72, false)).toBe('profil-bisnis');
    // Tepat di batas 96 masih dihitung.
    expect(pickActiveSection(at(-1600, -900, -300, 96, 263, 900), 72, false)).toBe('nama');
    // Kartu pendek: Kredensial yang masih di bawah batas tidak "menang".
    expect(pickActiveSection(at(-1600, -900, -300, 88, 263, 900), 72, false)).toBe('nama');
  });

  it('wadah di dasar → bagian terakhir, walau kartunya tidak bisa naik ke atas', () => {
    expect(pickActiveSection(at(-2000, -1300, -700, -200, 0, 569), 72, true)).toBe('akses');
  });

  it('tanpa bagian → null; wadah di dasar dihitung dengan toleransi pembulatan', () => {
    expect(pickActiveSection([], 0, false)).toBeNull();
    expect(isScrolledToBottom({ scrollTop: 1998.5, clientHeight: 800, scrollHeight: 2800 })).toBe(
      true,
    );
    expect(isScrolledToBottom({ scrollTop: 1900, clientHeight: 800, scrollHeight: 2800 })).toBe(
      false,
    );
    expect(SCROLL_KEYS.has('PageDown')).toBe(true);
    expect(SCROLL_KEYS.has('Tab')).toBe(false);
  });
});
