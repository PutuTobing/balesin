/**
 * Geometri tanda merek SEMENTARA: gelembung chat netral di atas ubin membulat.
 * Logo final belum ada (docs/BUTUH-TOBING.md #5). Untuk menggantinya cukup ubah berkas
 * ini: komponen `BrandMark` dan favicon sama-sama digambar dari sini.
 */
export const BRAND_MARK_SIZE = 32;

export const brandMarkShape = {
  tile: { size: BRAND_MARK_SIZE, radius: 8 },
  /** Gelembung chat dengan ekor di kiri bawah. */
  bubble:
    'M11.5 8.5h9a4.5 4.5 0 0 1 4.5 4.5v4a4.5 4.5 0 0 1-4.5 4.5h-5.2l-4.3 3.4v-3.5a4.5 4.5 0 0 1-4-4.4v-4a4.5 4.5 0 0 1 4.5-4.5z',
  /** Titik aksen "pesan baru" di kanan atas gelembung. */
  dot: { cx: 24, cy: 9.5, r: 3.2, ring: 1.6 },
} as const;

export interface BrandMarkColors {
  primary: string;
  onPrimary: string;
  accent: string;
}

/** SVG mandiri (warna ditanam) untuk favicon. Dipanggil saat build oleh plugin Vite. */
export function renderBrandMarkSvg(colors: BrandMarkColors): string {
  const { tile, bubble, dot } = brandMarkShape;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${tile.size} ${tile.size}">`,
    `<rect width="${tile.size}" height="${tile.size}" rx="${tile.radius}" fill="${colors.primary}"/>`,
    `<path d="${bubble}" fill="${colors.onPrimary}"/>`,
    `<circle cx="${dot.cx}" cy="${dot.cy}" r="${dot.r}" fill="${colors.accent}" stroke="${colors.primary}" stroke-width="${dot.ring}"/>`,
    '</svg>',
  ].join('');
}
