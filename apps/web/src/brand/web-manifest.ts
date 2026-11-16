import { DEFAULT_PRODUCT_NAME } from '@balesin/shared';
import { useEffect } from 'react';
import type { Brand } from './brand';

/**
 * Manifest PWA bermerek (white-label). `/manifest.webmanifest` statis memakai nama bawaan; begitu
 * merek organisasi dimuat, `<link rel="manifest">` diganti Blob URL berisi manifest yang sama
 * dengan nama produk dan logo organisasi. Manifest Blob wajib memakai URL ABSOLUT (relatif
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
  brand: Pick<Brand, 'productName' | 'logoUrl'>,
  origin: string,
): WebManifest {
  const name = brand.productName.trim() || DEFAULT_PRODUCT_NAME;
  const icons = (base.icons ?? []).flatMap((icon) => {
    const src = absolute(icon.src, origin);
    return src ? [{ ...icon, src }] : [];
  });
  // Logo organisasi (path relatif API yang sama origin) di depan; ikon bawaan tetap ada untuk
  // ukuran wajib 192/512 dan maskable.
  const logo = brand.logoUrl ? absolute(brand.logoUrl, origin) : undefined;
  return {
    ...base,
    id: absolute(base.id ?? '/', origin),
    start_url: absolute(base.start_url ?? '/', origin),
    scope: absolute(base.scope ?? '/', origin),
    name,
    short_name: name.length > SHORT_NAME_MAX ? name.slice(0, SHORT_NAME_MAX).trimEnd() : name,
    icons: logo ? [{ src: logo, sizes: 'any', purpose: 'any' }, ...icons] : icons,
  };
}

export function useBrandManifest(brand: Brand): void {
  const { productName, logoUrl } = brand;
  useEffect(() => {
    if (productName === DEFAULT_PRODUCT_NAME && !logoUrl) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const title = document.querySelector<HTMLMetaElement>(
      'meta[name="apple-mobile-web-app-title"]',
    );
    if (title) title.content = productName;
    if (!link) return;
    const original = link.getAttribute('href') ?? '/manifest.webmanifest';
    const controller = new AbortController();
    let objectUrl: string | null = null;
    fetch(new URL(original, window.location.origin), { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<WebManifest>) : null))
      .then((base) => {
        if (!base) return;
        const manifest = brandedManifest(base, { productName, logoUrl }, window.location.origin);
        objectUrl = URL.createObjectURL(
          new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }),
        );
        link.href = objectUrl;
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      link.setAttribute('href', original);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [productName, logoUrl]);
}
