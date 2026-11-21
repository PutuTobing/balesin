import { DEFAULT_MASCOT_NAME, DEFAULT_PRODUCT_NAME } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';
import { brandingQuery } from '../lib/api/queries';
import { BrandContext, defaultBrand, type Brand } from './brand';
import { useBrandIcons, useBrandManifest } from './web-manifest';

/**
 * Merek dari `GET /branding` (white-label): nama produk, nama organisasi, logo, nama maskot, dan
 * ikon milik organisasi menggantikan bawaan di seluruh aplikasi (warna utama: `BrandTheme`). Selama belum dimuat atau gagal dimuat,
 * merek bawaan dipakai. Penjaga rute menunggu branding sebelum layar pertama dirender,
 * jadi nama/logo tidak berganti di depan mata pengguna.
 */
export function BrandProvider({ children }: { children: ReactNode }) {
  const { data } = useQuery(brandingQuery);
  const brand = useMemo<Brand>(
    () =>
      data
        ? {
            ...defaultBrand,
            productName: data.productName.trim() || DEFAULT_PRODUCT_NAME,
            organizationName: data.organizationName,
            logoUrl: data.logoUrl,
            mascotName: data.mascotName.trim() || DEFAULT_MASCOT_NAME,
            primaryColor: data.primaryColor,
            icons: data.icons,
          }
        : defaultBrand,
    [data],
  );
  // Aplikasi terpasang (PWA), favicon, dan ikon layar utama memakai nama & logo organisasi.
  useBrandManifest(brand);
  useBrandIcons(brand.icons);
  return <BrandContext value={brand}>{children}</BrandContext>;
}
