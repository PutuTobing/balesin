import { DEFAULT_PRODUCT_NAME } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';
import { brandingQuery } from '../lib/api/queries';
import { BrandContext, defaultBrand, type Brand } from './brand';

/**
 * Merek dari `GET /branding` (white-label): nama produk, nama organisasi, dan logo milik
 * organisasi menggantikan bawaan di seluruh aplikasi. Selama belum dimuat atau gagal dimuat,
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
          }
        : defaultBrand,
    [data],
  );
  return <BrandContext value={brand}>{children}</BrandContext>;
}
