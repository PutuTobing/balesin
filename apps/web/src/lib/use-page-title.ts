import { useEffect } from 'react';
import { useBrand } from '../brand/brand';
import { t } from '../i18n/id';

/** Judul tab: "<halaman> · <nama produk>". */
export function usePageTitle(page: string): void {
  const { productName } = useBrand();
  useEffect(() => {
    document.title = t.common.documentTitle(page, productName);
  }, [page, productName]);
}
