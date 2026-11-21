import { DEFAULT_MASCOT_NAME, DEFAULT_PRODUCT_NAME, type BrandIcons } from '@balesin/shared';
import { createContext, useContext } from 'react';

/**
 * Konfigurasi merek (white-label). Satu-satunya tempat nama produk dan maskot ditulis
 * di aplikasi web. Nilai bawaan dipakai sampai pengaturan organisasi dimuat dari API
 * (`GET /branding`, lihat `BrandProvider`), lalu disuntikkan lewat `BrandContext`.
 */
export interface Brand {
  /** Nama produk di UI dan judul tab. */
  productName: string;
  /** Nama maskot yang disebut di teks keadaan kosong (ilustrasinya tetap bawaan). */
  mascotName: string;
  /** Nama organisasi pemakai (tampil di halaman masuk). `null` sebelum setup selesai. */
  organizationName: string | null;
  /** URL logo organisasi. `null` = tanda merek bawaan (`BrandMark`). */
  logoUrl: string | null;
  /** Warna utama organisasi `#rrggbb`; `null` = warna bawaan design system. */
  primaryColor: string | null;
  /** Favicon & ikon PWA dari logo; `null` = ikon bawaan produk. */
  icons: BrandIcons | null;
}

export const defaultBrand: Brand = {
  productName: DEFAULT_PRODUCT_NAME,
  mascotName: DEFAULT_MASCOT_NAME,
  organizationName: null,
  logoUrl: null,
  primaryColor: null,
  icons: null,
};

export const BrandContext = createContext<Brand>(defaultBrand);

export function useBrand(): Brand {
  return useContext(BrandContext);
}

/**
 * Huruf monogram: dari nama organisasi tanpa awalan badan usaha ("PT Maju Jaya" → "M"), selain itu
 * huruf pertama nama aplikasi.
 */
export function monogramLetter(organizationName: string | null, productName: string): string {
  const source =
    organizationName?.trim().replace(/^(PT|CV|UD|Koperasi)\.?\s+/i, '') || productName.trim();
  return Array.from(source)[0]?.toLocaleUpperCase('id-ID') ?? '';
}
