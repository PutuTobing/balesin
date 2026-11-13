import { DEFAULT_PRODUCT_NAME } from '@balesin/shared';
import { createContext, useContext } from 'react';

/**
 * Konfigurasi merek (white-label). Satu-satunya tempat nama produk dan maskot ditulis
 * di aplikasi web. Nilai bawaan dipakai sampai pengaturan organisasi dimuat dari API
 * (`GET /branding`, lihat `BrandProvider`), lalu disuntikkan lewat `BrandContext`.
 */
export interface Brand {
  /** Nama produk di UI dan judul tab. */
  productName: string;
  /** Nama maskot yang disebut di teks keadaan kosong. */
  mascotName: string;
  /** Nama organisasi pemakai (tampil di halaman masuk). `null` sebelum setup selesai. */
  organizationName: string | null;
  /** URL logo organisasi. `null` = tanda merek bawaan (`BrandMark`). */
  logoUrl: string | null;
}

export const defaultBrand: Brand = {
  productName: DEFAULT_PRODUCT_NAME,
  mascotName: 'Kak Sky',
  organizationName: null,
  logoUrl: null,
};

export const BrandContext = createContext<Brand>(defaultBrand);

export function useBrand(): Brand {
  return useContext(BrandContext);
}
