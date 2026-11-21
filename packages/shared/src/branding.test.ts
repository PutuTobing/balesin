import { describe, expect, it } from 'vitest';

import {
  BRAND_DARK_TEXT,
  BRAND_ICONS,
  BRAND_MANIFEST_ICON_FILES,
  DEFAULT_MASCOT_NAME,
  brandColorSchema,
  brandColorTextColor,
  brandingResponseSchema,
  containsMetaTrademark,
  mascotNameSchema,
  productNameSchema,
  updateBrandingRequestSchema,
} from './branding';
import { contrastRatio } from './design-tokens';

describe('warna utama', () => {
  it('format: #rrggbb, dirapikan ke huruf kecil', () => {
    expect(brandColorSchema.parse(' #0B5394 ')).toBe('#0b5394');
    for (const value of ['0b5394', '#0b539', '#0b53944', '#gggggg', 'red', '']) {
      expect(brandColorSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('teks di atasnya: putih untuk warna gelap, tinta gelap untuk warna terang', () => {
    expect(brandColorTextColor('#1b3557')).toBe('#ffffff');
    expect(brandColorTextColor('#ffd400')).toBe(BRAND_DARK_TEXT);
    expect(brandColorTextColor('#ffffff')).toBe(BRAND_DARK_TEXT);
    expect(brandColorTextColor('bukan-warna')).toBeNull();
  });

  it('warna tengah yang tidak terbaca dengan teks putih maupun gelap ditolak', () => {
    // Abu-abu tengah: < 4.5:1 terhadap putih DAN terhadap tinta gelap.
    const mid = '#7d7d7d';
    expect(contrastRatio(mid, '#ffffff')).toBeLessThan(4.5);
    expect(contrastRatio(mid, BRAND_DARK_TEXT)).toBeLessThan(4.5);
    expect(brandColorTextColor(mid)).toBeNull();
    const result = brandColorSchema.safeParse(mid);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('sulit dibaca');
  });
});

describe('nama aplikasi & maskot', () => {
  it('merek dagang Meta ditolak dalam berbagai ejaan', () => {
    for (const value of ['WhatsApp CS', 'whatsapp', 'Whats App Kita', 'Layanan whats-app']) {
      const result = productNameSchema.safeParse(value);
      expect(result.success, value).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('merek dagang Meta');
    }
    expect(mascotNameSchema.safeParse('Kak WhatsApp').success).toBe(false);
    expect(productNameSchema.parse('  Balesin Maju Jaya ')).toBe('Balesin Maju Jaya');
  });

  it('ejaan pengelabuan "WhatsApp" ikut ditolak (review merek B3)', () => {
    const disguised: [string, string][] = [
      ['ZWJ di tengah (tampil persis "WhatsApp")', 'Whats‍App'],
      ['zero-width space', 'Whats​App'],
      ['huruf lebar penuh', 'ＷｈａｔｓＡｐｐ'],
      ['a Kiril', 'WhаtsApp'],
      ['s & p Kiril', 'WhatѕAрp'],
      ['W & h Kiril', 'ԜһatsApp'],
      ['alfa & rho Yunani', 'WhαtsAρp'],
      ['en-dash', 'Whats–App'],
      ['garis miring', 'Whats/App'],
      ['plus', 'Whats+App'],
      ['apostrof', "What's App"],
      ['titik antarhuruf', 'W.h.a.t.s.A.p.p'],
      ['huruf matematis tebal', '\u{1d416}hatsApp'],
    ];
    for (const [name, value] of disguised) {
      expect(containsMetaTrademark(value), name).toBe(true);
      expect(productNameSchema.safeParse(`CS ${value}`).success, name).toBe(false);
      expect(mascotNameSchema.safeParse(value).success, name).toBe(false);
    }
    // Nama biasa tidak ikut tertolak.
    for (const value of [
      'Balesin Maju Jaya',
      'Kak Sky',
      'Chat Center',
      'Whatever Apps',
      'Appwhats',
    ]) {
      expect(containsMetaTrademark(value), value).toBe(false);
    }
  });

  it('maskot: 2–30 karakter satu baris', () => {
    expect(mascotNameSchema.parse(' Kak Rina ')).toBe('Kak Rina');
    expect(mascotNameSchema.safeParse('K').success).toBe(false);
    expect(mascotNameSchema.safeParse('x'.repeat(31)).success).toBe(false);
    expect(mascotNameSchema.safeParse('Kak\nRina').success).toBe(false);
  });
});

describe('PATCH /settings/branding', () => {
  it('minimal satu field; null = kembali ke bawaan; field tak dikirim = tidak berubah', () => {
    expect(updateBrandingRequestSchema.safeParse({}).success).toBe(false);
    expect(updateBrandingRequestSchema.parse({ productName: null, logo: null })).toEqual({
      productName: null,
      logo: null,
    });
    expect(updateBrandingRequestSchema.parse({ mascotName: 'Kak Rina' })).toEqual({
      mascotName: 'Kak Rina',
    });
    expect(updateBrandingRequestSchema.safeParse({ primaryColor: '#7d7d7d' }).success).toBe(false);
    expect(
      updateBrandingRequestSchema.safeParse({
        logo: { contentType: 'image/svg+xml', dataBase64: 'PHN2Zy8+' },
      }).success,
    ).toBe(false);
  });
});

describe('GET /branding', () => {
  it('respons lama tanpa mascotName/icons tetap sah (nilai bawaan)', () => {
    const parsed = brandingResponseSchema.parse({
      productName: 'Balesin',
      organizationName: null,
      primaryColor: null,
      logoUrl: null,
    });
    expect(parsed.mascotName).toBe(DEFAULT_MASCOT_NAME);
    expect(parsed.icons).toBeNull();
  });

  it('ikon manifest = 192/512 biasa + maskable; favicon & apple-touch-icon lewat <link>', () => {
    const manifest = BRAND_ICONS.filter((icon) => BRAND_MANIFEST_ICON_FILES.includes(icon.file));
    expect(manifest.map((icon) => `${icon.size}:${icon.purpose}`)).toEqual([
      '192:any',
      '512:any',
      '192:maskable',
      '512:maskable',
    ]);
  });
});
