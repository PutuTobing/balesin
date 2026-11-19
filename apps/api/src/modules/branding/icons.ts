import {
  BRAND_DARK_TEXT,
  BRAND_ICONS,
  LOGO_MAX_DIMENSION,
  type BrandIcon,
  type BrandIconFile,
  type LogoContentType,
} from '@balesin/shared';
import sharp, { type Metadata, type SharpOptions } from 'sharp';

/**
 * Ikon aplikasi dari logo organisasi (favicon, apple-touch-icon, ikon PWA 192/512 + maskable).
 *
 * Logo adalah masukan tak tepercaya, jadi decoder dibatasi (SECURITY.md §7):
 *  - hanya dipanggil SETELAH `validateLogoUpload` (≤ 256 KB, magic bytes PNG/JPEG/WebP);
 *  - format hasil baca libvips harus sama dengan hasil sniffing (SVG/TIFF/dll. tidak pernah lolos);
 *  - jumlah piksel dibatasi (`limitInputPixels`) dan dimensi ≤ `LOGO_MAX_DIMENSION` → "bom
 *    dekompresi" (PNG kecil berdimensi raksasa) ditolak sebelum didekode;
 *  - hanya frame pertama yang dibaca; galat dekode = tolak (`failOn: 'error'`).
 * Ikon dibuat SEKALI saat logo disimpan, bukan per permintaan.
 */

// Hasil olahan tidak perlu di-cache libvips; proses ini jarang dan berkasnya kecil.
sharp.cache(false);

const INPUT_OPTIONS = {
  limitInputPixels: LOGO_MAX_DIMENSION * LOGO_MAX_DIMENSION,
  failOn: 'error',
  animated: false,
  autoOrient: true,
} as const satisfies SharpOptions;

const SHARP_FORMATS: Readonly<Record<LogoContentType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 } as const;
const WHITE = '#ffffff';

/**
 * Porsi sisi ikon yang diisi logo. Maskable: zona aman = lingkaran berjari-jari 40% sisi, jadi
 * persegi di dalamnya ≈ 56%. Apple: diberi tepi supaya tidak menempel ke sudut membulat.
 */
const CONTENT_SCALE = { any: 1, opaque: 0.8, maskable: 0.56 } as const;

export class LogoImageError extends Error {
  constructor(
    readonly reason: 'unreadable' | 'too_large' | 'format_mismatch',
    options?: { cause?: unknown },
  ) {
    super(`Logo tidak bisa diolah: ${reason}`, options);
  }
}

export interface LogoDimensions {
  width: number;
  height: number;
}

/** Memeriksa header gambar: format cocok dengan hasil sniffing dan dimensinya wajar. */
export async function inspectLogoImage(
  data: Buffer,
  expected: LogoContentType,
): Promise<LogoDimensions> {
  let metadata: Metadata;
  try {
    // Hanya membaca header (tanpa dekode piksel), jadi batas piksel dilepas di sini supaya gambar
    // raksasa dilaporkan "terlalu besar" — bukan "rusak". Dekode sungguhan tetap memakai batasnya.
    metadata = await sharp(data, { ...INPUT_OPTIONS, limitInputPixels: false }).metadata();
  } catch (error) {
    throw new LogoImageError('unreadable', { cause: error });
  }
  if (metadata.format !== SHARP_FORMATS[expected]) throw new LogoImageError('format_mismatch');
  const { width, height } = metadata;
  if (!width || !height) throw new LogoImageError('unreadable');
  if (width > LOGO_MAX_DIMENSION || height > LOGO_MAX_DIMENSION) {
    throw new LogoImageError('too_large');
  }
  return { width, height };
}

/** Luminans relatif rata-rata bagian logo yang tidak transparan (0 gelap … 1 terang). */
async function opaqueLuminance(data: Buffer): Promise<number> {
  const { data: pixels } = await sharp(data, INPUT_OPTIONS)
    .resize(32, 32, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let weighted = 0;
  let totalAlpha = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const alpha = (pixels[index + 3] ?? 0) / 255;
    if (alpha === 0) continue;
    const luminance =
      (0.2126 * (pixels[index] ?? 0) +
        0.7152 * (pixels[index + 1] ?? 0) +
        0.0722 * (pixels[index + 2] ?? 0)) /
      255;
    weighted += luminance * alpha;
    totalAlpha += alpha;
  }
  return totalAlpha === 0 ? 0 : weighted / totalAlpha;
}

/**
 * Latar ikon yang tidak boleh transparan: putih, kecuali logonya sendiri terang (mis. logo putih
 * untuk header gelap) — maka tinta gelap supaya logonya tetap terlihat.
 */
export async function opaqueBackgroundFor(data: Buffer): Promise<string> {
  return (await opaqueLuminance(data)) > 0.8 ? BRAND_DARK_TEXT : WHITE;
}

async function renderIcon(data: Buffer, icon: BrandIcon, background: string): Promise<Buffer> {
  const scale =
    icon.purpose === 'maskable'
      ? CONTENT_SCALE.maskable
      : icon.opaque
        ? CONTENT_SCALE.opaque
        : CONTENT_SCALE.any;
  const inner = Math.max(1, Math.round(icon.size * scale));
  const fitted = await sharp(data, INPUT_OPTIONS)
    .resize(inner, inner, { fit: 'contain', background: TRANSPARENT })
    .png()
    .toBuffer();
  const composed = await sharp({
    create: {
      width: icon.size,
      height: icon.size,
      channels: 4,
      background: icon.opaque ? background : TRANSPARENT,
    },
  })
    .composite([{ input: fitted, gravity: 'centre' }])
    .png()
    .toBuffer();
  // Metadata (EXIF, profil warna, dsb.) tidak ikut: sharp tidak menyalinnya kecuali diminta.
  const output = icon.opaque ? sharp(composed).removeAlpha() : sharp(composed);
  return output.png({ compressionLevel: 9 }).toBuffer();
}

export interface RenderedIcon {
  file: BrandIconFile;
  data: Buffer;
}

/**
 * Membuat semua ikon `BRAND_ICONS` dari logo yang SUDAH lolos `validateLogoUpload` +
 * `inspectLogoImage`. Melempar `LogoImageError('unreadable')` bila dekode gagal.
 */
export async function renderBrandIcons(data: Buffer): Promise<RenderedIcon[]> {
  try {
    const background = await opaqueBackgroundFor(data);
    const icons: RenderedIcon[] = [];
    // Berurutan, bukan paralel: tidak membebani CPU server kecil (enam gambar kecil).
    for (const icon of BRAND_ICONS) {
      icons.push({ file: icon.file, data: await renderIcon(data, icon, background) });
    }
    return icons;
  } catch (error) {
    if (error instanceof LogoImageError) throw error;
    throw new LogoImageError('unreadable', { cause: error });
  }
}
