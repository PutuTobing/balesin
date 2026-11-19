import { DEFAULT_PRODUCT_NAME, type BrandIcons } from '@balesin/shared';
import { useEffect } from 'react';
import type { Brand } from './brand';

/**
 * Manifest PWA bermerek (white-label). `/manifest.webmanifest` statis memakai nama bawaan; begitu
 * merek organisasi dimuat, `<link rel="manifest">` diganti Blob URL berisi manifest yang sama
 * dengan nama produk dan ikon dari logo organisasi (`icons.manifest` menggantikan SELURUH ikon
 * bawaan, docs/KONTRAK-API-AUTH.md "Branding"). Manifest Blob wajib memakai URL ABSOLUT (relatif
 * terhadap `blob:` tidak sah), jadi semua alamat dilengkapi origin halaman.
 */
interface ManifestIcon {
  src: string;
  sizes?: string;
  type?: string;
  purpose?: string;
}
interface WebManifest {
  id?: string;
  name?: string;
  short_name?: string;
  start_url?: string;
  scope?: string;
  icons?: ManifestIcon[];
  [key: string]: unknown;
}

const SHORT_NAME_MAX = 12;

function absolute(path: string | undefined, origin: string): string | undefined {
  if (path === undefined) return undefined;
  try {
    const url = new URL(path, origin);
    return url.origin === origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function brandedManifest(
  base: WebManifest,
  brand: Pick<Brand, 'productName' | 'icons'>,
  origin: string,
): WebManifest {
  const name = brand.productName.trim() || DEFAULT_PRODUCT_NAME;
  // Ikon dari logo organisasi (192/512 biasa + maskable) menggantikan semua ikon bawaan; tanpa
  // logo, ikon bawaan produk tetap dipakai. Alamat lain origin dibuang.
  const source = brand.icons ? brand.icons.manifest : (base.icons ?? []);
  const icons = source.flatMap((icon) => {
    const src = absolute(icon.src, origin);
    return src ? [{ ...icon, src }] : [];
  });
  return {
    ...base,
    id: absolute(base.id ?? '/', origin),
    start_url: absolute(base.start_url ?? '/', origin),
    scope: absolute(base.scope ?? '/', origin),
    name,
    short_name: name.length > SHORT_NAME_MAX ? name.slice(0, SHORT_NAME_MAX).trimEnd() : name,
    icons,
  };
}

export function useBrandManifest(brand: Brand): void {
  const { productName, icons } = brand;
  // Kunci stabil: query yang dimuat ulang dengan isi sama tidak membuat manifest baru.
  const iconsKey = icons ? JSON.stringify(icons.manifest) : '';
  useEffect(() => {
    const brandIcons: BrandIcons['manifest'] | null = iconsKey
      ? (JSON.parse(iconsKey) as BrandIcons['manifest'])
      : null;
    if (productName === DEFAULT_PRODUCT_NAME && !brandIcons) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const title = document.querySelector<HTMLMetaElement>(
      'meta[name="apple-mobile-web-app-title"]',
    );
    const originalTitle = title?.content;
    if (title) title.content = productName;
    if (!link) return;
    const original = link.getAttribute('href') ?? '/manifest.webmanifest';
    const controller = new AbortController();
    let objectUrl: string | null = null;
    fetch(new URL(original, window.location.origin), { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<WebManifest>) : null))
      .then((base) => {
        if (!base) return;
        const manifest = brandedManifest(
          base,
          {
            productName,
            icons: brandIcons ? { favicon: '', appleTouchIcon: '', manifest: brandIcons } : null,
          },
          window.location.origin,
        );
        objectUrl = URL.createObjectURL(
          new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }),
        );
        link.href = objectUrl;
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      link.setAttribute('href', original);
      if (title && originalTitle !== undefined) title.content = originalTitle;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [productName, iconsKey]);
}

/**
 * Favicon & ikon layar utama iOS dari logo organisasi. Tautan bawaan (`.ico`, SVG, apple-touch-icon
 * produk) dilepas sementara — browser memilih SVG bila masih ada — lalu dipasang kembali saat logo
 * dihapus.
 */
export function useBrandIcons(icons: BrandIcons | null): void {
  const faviconPath = icons?.favicon ?? null;
  const appleTouchPath = icons?.appleTouchIcon ?? null;
  useEffect(() => {
    // Hanya alamat sama origin (seperti ikon manifest); selain itu ikon bawaan tetap dipakai.
    const origin = window.location.origin;
    const favicon = faviconPath ? absolute(faviconPath, origin) : undefined;
    const appleTouchIcon = appleTouchPath ? absolute(appleTouchPath, origin) : undefined;
    if (!favicon || !appleTouchIcon) return;
    const head = document.head;
    const originals = Array.from(
      head.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]'),
    );
    for (const link of originals) link.remove();
    const icon = document.createElement('link');
    icon.rel = 'icon';
    icon.type = 'image/png';
    icon.setAttribute('sizes', '32x32');
    icon.href = favicon;
    icon.dataset.brand = '';
    const apple = document.createElement('link');
    apple.rel = 'apple-touch-icon';
    apple.href = appleTouchIcon;
    apple.dataset.brand = '';
    head.append(icon, apple);
    return () => {
      icon.remove();
      apple.remove();
      head.append(...originals);
    };
  }, [faviconPath, appleTouchPath]);
}
