/**
 * Geometri logo Balesin bawaan: simbol gelembung chat berbentuk "b" yang ekornya
 * melengkung jadi panah balas, titik aksen, dan wordmark "balesin".
 *
 * Sumber: vektor dari Tobing di `assets/brand/logo-sheet.svg` (dirapikan: koordinat
 * wordmark diseragamkan, tanpa `<use>`/`xlink`, tanpa teks bawaan). Satu-satunya tempat
 * bentuk logo ditulis. Komponen `BrandMark`/`BrandLogo`, favicon (plugin Vite), berkas
 * `src/assets/logo-*.svg`, dan ikon PNG di `public/` semuanya diturunkan dari sini.
 *
 * Tanpa impor: berkas ini juga dimuat oleh konfigurasi Vite dan skrip pembuat ikon.
 */

/** Simbol, satuan asli. Kotak pembatasnya ±(-0.25, 0)–(222, 274.6). */
export const symbol = {
  path:
    'M47 0C65 0 78 14 78 31V60C92 54 108 52 124 52C180 52 222 94 222 149' +
    'C222 205 180 250 124 250H68V264C68 273 58 278 51 272L5 237C-2 232-2 223 5 218' +
    'L51 183C58 178 68 182 68 191V210H124C158 210 182 183 182 149C182 117 158 92 124 92' +
    'C89 92 60 118 53 151C50 165 49 177 38 177C25 177 16 164 16 149V31C16 14 29 0 47 0Z',
  dot: { cx: 193, cy: 39, r: 23 },
  /** Titik tengah kotak pembatas (dipakai untuk memusatkan simbol di ubin ikon). */
  center: { x: 110.875, y: 137.3 },
  height: 274.6,
  /** viewBox persegi yang memuat simbol tepat di tengah (rail: ditengahkan dalam kotak). */
  squareViewBox: '-27 -1 276 276',
  /** viewBox pas kotak pembatas (rata kiri dengan teks/kartu di sebelahnya). */
  tightViewBox: '-1 -1 224 277',
} as const;

/**
 * Wordmark "balesin" dari garis bulat (stroke). Tinggi-x seragam di y=53, garis dasar
 * y=139. Dipakai hanya bila nama produk masih bawaan.
 */
export const wordmark = {
  strokeWidth: 29,
  path:
    'M15 15V139M227 53V139M277 15V139' +
    'M325 95H411C411 71 395 53 370 53C343 53 325 72 325 96C325 122 344 139 370 139' +
    'C385 139 397 135 405 128' +
    'M512 65C502 57 490 53 476 53C458 53 446 62 446 74C446 87 457 92 479 97' +
    'C500 102 513 108 513 120C513 132 500 140 479 140C465 140 451 136 442 128' +
    'M554 53V139M603 53V139M603 89C603 67 618 53 640 53C662 53 675 68 675 90V139',
  bowls: [
    { cx: 59, cy: 96, rx: 44, ry: 43 },
    { cx: 183, cy: 96, rx: 44, ry: 43 },
  ],
  /** Titik huruf "i". */
  dot: { cx: 554, cy: 15, r: 15 },
} as const;

/** Logo lengkap (simbol + wordmark) dalam koordinat wordmark, sesuai susunan lembar logo. */
export const fullLogo = {
  viewBox: '-240 -46 932 251',
  width: 932,
  height: 251,
  symbolTransform: 'translate(-238 -44) scale(0.9)',
} as const;

export interface LogoColors {
  /** Simbol. Token `primary`. */
  primary: string;
  /** Titik aksen. Token `accent`. */
  accent: string;
  /** Wordmark. Token `ink`. */
  ink: string;
}

export interface IconColors {
  /** Ubin. Token `primary`. */
  primary: string;
  /** Simbol di atas ubin. Token `onPrimary`. */
  onPrimary: string;
  /** Titik aksen. Token `accent`. */
  accent: string;
}

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

function symbolMarkup(fill: string, accent: string, dotRadius: number = symbol.dot.r): string {
  const { path, dot } = symbol;
  return `<path d="${path}" fill="${fill}"/><circle cx="${dot.cx}" cy="${dot.cy}" r="${dotRadius}" fill="${accent}"/>`;
}

function wordmarkMarkup(ink: string): string {
  const { strokeWidth, path, bowls, dot } = wordmark;
  const ellipses = bowls
    .map(({ cx, cy, rx, ry }) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/>`)
    .join('');
  return [
    `<g fill="none" stroke="${ink}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">`,
    `<path d="${path}"/>${ellipses}</g>`,
    `<circle cx="${dot.cx}" cy="${dot.cy}" r="${dot.r}" fill="${ink}"/>`,
  ].join('');
}

/** Simbol saja, latar transparan. */
export function renderSymbolSvg(colors: Pick<LogoColors, 'primary' | 'accent'>): string {
  return `<svg ${SVG_NS} viewBox="${symbol.squareViewBox}" width="276" height="276">${symbolMarkup(colors.primary, colors.accent)}</svg>\n`;
}

/** Simbol + wordmark, latar transparan. */
export function renderLogoSvg(colors: LogoColors): string {
  const { viewBox, width, height, symbolTransform } = fullLogo;
  return [
    `<svg ${SVG_NS} viewBox="${viewBox}" width="${width}" height="${height}">`,
    `<g transform="${symbolTransform}">${symbolMarkup(colors.primary, colors.accent)}</g>`,
    wordmarkMarkup(colors.ink),
    '</svg>\n',
  ].join('');
}

export interface IconLayout {
  /** Tinggi simbol terhadap sisi ubin (0–1). */
  symbolRatio: number;
  /** Jari-jari sudut ubin terhadap sisi (0 = persegi penuh untuk di-mask OS). */
  cornerRatio: number;
}

/** Tata letak ikon. Semua turunan dari ikon aplikasi Tobing (`assets/brand/app-icon.png`). */
export const iconLayouts = {
  /** Ikon PWA `purpose: any` (sudut membulat, transparan di luar ubin). */
  any: { symbolRatio: 0.66, cornerRatio: 0.22 },
  /** Ikon persegi penuh: apple-touch-icon (iOS membulatkan sendiri). */
  square: { symbolRatio: 0.66, cornerRatio: 0 },
  /** Ikon PWA `purpose: maskable`: simbol di dalam lingkaran aman 80%. */
  maskable: { symbolRatio: 0.6, cornerRatio: 0 },
} as const satisfies Record<string, IconLayout>;

const ICON_SIZE = 1024;

/** Ubin ikon aplikasi: simbol putih di atas biru, titik aksen. */
export function renderIconSvg(colors: IconColors, layout: IconLayout): string {
  const scale = (layout.symbolRatio * ICON_SIZE) / symbol.height;
  const tx = ICON_SIZE / 2 - scale * symbol.center.x;
  const ty = ICON_SIZE / 2 - scale * symbol.center.y;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const rx = round(layout.cornerRatio * ICON_SIZE);
  return [
    `<svg ${SVG_NS} viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}">`,
    `<rect width="${ICON_SIZE}" height="${ICON_SIZE}"${rx ? ` rx="${rx}"` : ''} fill="${colors.primary}"/>`,
    `<g transform="translate(${round(tx)} ${round(ty)}) scale(${round(scale)})">`,
    symbolMarkup(colors.onPrimary, colors.accent),
    '</g></svg>',
  ].join('');
}

/**
 * Favicon disetel untuk kisi 16 px (berlaku juga di 32 px = 2×): batang "b" tepat 3 px dan
 * cincinnya 2 px jatuh di garis piksel, jadi tidak buram. Titik aksen sedikit dibesarkan
 * supaya tidak hilang di 16 px. Angka dicari dengan melihat hasil render 16/32 px.
 */
export const favicon = {
  size: 16,
  scale: 0.0484,
  translate: { x: 2.226, y: 1.48 },
  cornerRadius: 3.5,
  dotRadius: 30,
} as const;

export function renderFaviconSvg(colors: IconColors): string {
  const { size, scale, translate, cornerRadius, dotRadius } = favicon;
  return [
    `<svg ${SVG_NS} viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" rx="${cornerRadius}" fill="${colors.primary}"/>`,
    `<g transform="translate(${translate.x} ${translate.y}) scale(${scale})">`,
    symbolMarkup(colors.onPrimary, colors.accent, dotRadius),
    '</g></svg>',
  ].join('');
}
