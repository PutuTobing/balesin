import {
  BRAND_DARK_TEXT,
  BRAND_ICON_MAX_BYTES,
  BRAND_ICONS,
  LOGO_MAX_BYTES,
  LOGO_MAX_DIMENSION,
  type BrandIcon,
  type BrandIconFile,
  type LogoContentType,
} from '@balesin/shared';
import sharp, { type Metadata, type Sharp, type SharpOptions } from 'sharp';

/**
 * Ikon aplikasi dari logo organisasi (favicon, apple-touch-icon, ikon PWA 192/512 + maskable).
 *
 * Logo adalah masukan tak tepercaya, jadi decoder dibatasi (SECURITY.md §7):
 *  - hanya dipanggil SETELAH `validateLogoUpload` (≤ 256 KB, magic bytes PNG/JPEG/WebP);
 *  - format hasil baca libvips harus sama dengan hasil sniffing (SVG/TIFF/dll. tidak pernah lolos);
 *  - jumlah piksel dibatasi (`limitInputPixels`) dan dimensi ≤ `LOGO_MAX_DIMENSION` → "bom
 *    dekompresi" (PNG kecil berdimensi raksasa) ditolak sebelum didekode;
 *  - hanya frame pertama yang dibaca; galat dekode = tolak (`failOn: 'error'`);
 *  - dekode berjalan satu per satu per proses (`withDecodeSlot`, review merek B4), dan logo didekode
 *    SEKALI ke ukuran kerja ≤ 1024 px sebelum keenam ikon dibuat.
 * Ikon dibuat SEKALI saat logo disimpan, bukan per permintaan. Logo yang disimpan pun hasil olah
 * ulang tanpa metadata (EXIF/ICC/XMP, data sisipan setelah akhir gambar) — review merek B5.
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

/** Sisi terpanjang gambar kerja: cukup untuk ikon terbesar (512) tanpa mendekode logo berulang. */
const WORKING_SIZE = 1024;

/** Dekode logo bersamaan per proses (review merek B4): CPU & memori server kecil tetap terkendali. */
const MAX_CONCURRENT_DECODES = 1;
let activeDecodes = 0;
const waitingDecodes: (() => void)[] = [];

/**
 * Menjalankan `task` (dekode/olah gambar) saat slot tersedia. Jangan dipanggil bersarang — slot
 * tidak reentran.
 */
export async function withDecodeSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeDecodes < MAX_CONCURRENT_DECODES) {
    activeDecodes += 1;
  } else {
    // Slot diserahkan langsung oleh yang selesai (lihat `finally`), jadi hitungannya tetap.
    await new Promise<void>((resolve) => waitingDecodes.push(resolve));
  }
  try {
    return await task();
  } finally {
    const next = waitingDecodes.shift();
    if (next) next();
    else activeDecodes -= 1;
  }
}

export type LogoImageErrorReason =
  | 'unreadable'
  | 'too_large'
  | 'format_mismatch'
  /** Hasil olah ulang logo melebihi `LOGO_MAX_BYTES`. */
  | 'output_too_large'
  /** Ikon hasil olahan melebihi `BRAND_ICON_MAX_BYTES` (mis. logo penuh derau). */
  | 'icon_too_large';

export class LogoImageError extends Error {
  constructor(
    readonly reason: LogoImageErrorReason,
    options?: { cause?: unknown },
  ) {
    super(`Logo tidak bisa diolah: ${reason}`, options);
  }
}

function asLogoImageError(error: unknown): LogoImageError {
  return error instanceof LogoImageError
    ? error
    : new LogoImageError('unreadable', { cause: error });
}

export interface LogoDimensions {
  width: number;
  height: number;
  /** PNG berpalet (diolah ulang tetap berpalet supaya ukurannya tidak membengkak). */
  palette: boolean;
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
  return { width, height, palette: metadata.isPalette };
}

/** Logo yang sudah didekode SEKALI ke ukuran kerja (RGBA mentah). */
interface WorkingImage {
  pixels: Buffer;
  width: number;
  height: number;
}

async function decodeToWorking(data: Buffer): Promise<WorkingImage> {
  const { data: pixels, info } = await sharp(data, INPUT_OPTIONS)
    .resize(WORKING_SIZE, WORKING_SIZE, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { pixels, width: info.width, height: info.height };
}

function fromWorking(image: WorkingImage): Sharp {
  return sharp(image.pixels, { raw: { width: image.width, height: image.height, channels: 4 } });
}

/** Luminans relatif rata-rata bagian logo yang tidak transparan (0 gelap … 1 terang). */
async function opaqueLuminance(image: WorkingImage): Promise<number> {
  const { data: pixels } = await fromWorking(image)
    .resize(32, 32, { fit: 'inside' })
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

async function backgroundOf(image: WorkingImage): Promise<string> {
  return (await opaqueLuminance(image)) > 0.8 ? BRAND_DARK_TEXT : WHITE;
}

/**
 * Latar ikon yang tidak boleh transparan: putih, kecuali logonya sendiri terang (mis. logo putih
 * untuk header gelap) — maka tinta gelap supaya logonya tetap terlihat.
 */
export async function opaqueBackgroundFor(data: Buffer): Promise<string> {
  return backgroundOf(await decodeToWorking(data));
}

async function renderIcon(
  image: WorkingImage,
  icon: BrandIcon,
  background: string,
): Promise<Buffer> {
  const scale =
    icon.purpose === 'maskable'
      ? CONTENT_SCALE.maskable
      : icon.opaque
        ? CONTENT_SCALE.opaque
        : CONTENT_SCALE.any;
  const inner = Math.max(1, Math.round(icon.size * scale));
  const fitted = await fromWorking(image)
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
  const encode = (palette: boolean) =>
    (icon.opaque ? sharp(composed).removeAlpha() : sharp(composed))
      .png({ compressionLevel: 9, palette })
      .toBuffer();
  let output = await encode(false);
  // Logo penuh derau bisa menghasilkan PNG besar: coba berpalet, lalu tolak (400, bukan 500 dari
  // CHECK `organization_logo_icons.byte_size`).
  if (output.length > BRAND_ICON_MAX_BYTES) output = await encode(true);
  if (output.length > BRAND_ICON_MAX_BYTES) throw new LogoImageError('icon_too_large');
  return output;
}

export interface RenderedIcon {
  file: BrandIconFile;
  data: Buffer;
}

/**
 * Membuat semua ikon `BRAND_ICONS` dari logo yang SUDAH lolos `validateLogoUpload` +
 * `inspectLogoImage`. Logo didekode sekali (dibatasi `limitInputPixels`) ke ukuran kerja.
 * Melempar `LogoImageError` (`unreadable` bila dekode gagal). Tidak mengambil slot dekode sendiri:
 * pemanggil produksi lewat `processLogoImage` / `renderStoredLogoIcons`.
 */
export async function renderBrandIcons(data: Buffer): Promise<RenderedIcon[]> {
  try {
    const image = await decodeToWorking(data);
    const background = await backgroundOf(image);
    const icons: RenderedIcon[] = [];
    // Berurutan, bukan paralel: tidak membebani CPU server kecil (enam gambar kecil).
    for (const icon of BRAND_ICONS) {
      icons.push({ file: icon.file, data: await renderIcon(image, icon, background) });
    }
    return icons;
  } catch (error) {
    throw asLogoImageError(error);
  }
}

/**
 * Logo yang DISIMPAN & disajikan: diolah ulang dengan format yang sama, orientasi EXIF diterapkan,
 * tanpa metadata (EXIF/GPS, profil ICC → sRGB, XMP) dan tanpa data sisipan setelah akhir gambar.
 * Bila hasilnya melewati `LOGO_MAX_BYTES`, dicoba sekali lagi dengan kompresi lebih kuat.
 */
async function reencodeLogo(
  data: Buffer,
  contentType: LogoContentType,
  palette: boolean,
): Promise<Buffer> {
  const encode = (strong: boolean): Promise<Buffer> => {
    const image = sharp(data, INPUT_OPTIONS);
    switch (contentType) {
      case 'image/png':
        return image.png({ compressionLevel: 9, palette: palette || strong }).toBuffer();
      case 'image/jpeg':
        return image.jpeg({ quality: strong ? 80 : 92, mozjpeg: true }).toBuffer();
      case 'image/webp':
        return image.webp({ quality: strong ? 80 : 92, alphaQuality: 100 }).toBuffer();
    }
  };
  let output = await encode(false);
  if (output.length > LOGO_MAX_BYTES) output = await encode(true);
  if (output.length > LOGO_MAX_BYTES) throw new LogoImageError('output_too_large');
  return output;
}

export interface ProcessedLogo extends LogoDimensions {
  /** Logo hasil olah ulang tanpa metadata — inilah yang disimpan. */
  data: Buffer;
  icons: RenderedIcon[];
}

/**
 * Seluruh pengolahan logo unggahan dalam SATU slot dekode: periksa header → olah ulang tanpa
 * metadata → buat ikon. Masukan = logo yang sudah lolos `validateLogoUpload`.
 */
export function processLogoImage(
  data: Buffer,
  contentType: LogoContentType,
): Promise<ProcessedLogo> {
  return withDecodeSlot(async () => {
    try {
      const dimensions = await inspectLogoImage(data, contentType);
      const sanitized = await reencodeLogo(data, contentType, dimensions.palette);
      const icons = await renderBrandIcons(data);
      return { ...dimensions, data: sanitized, icons };
    } catch (error) {
      throw asLogoImageError(error);
    }
  });
}

/**
 * Ikon untuk logo yang SUDAH tersimpan (isi ulang): rantai pemeriksaan header yang sama dengan
 * unggahan (review merek B1), di dalam slot dekode.
 */
export function renderStoredLogoIcons(
  data: Buffer,
  contentType: LogoContentType,
): Promise<RenderedIcon[]> {
  return withDecodeSlot(async () => {
    try {
      await inspectLogoImage(data, contentType);
      return await renderBrandIcons(data);
    } catch (error) {
      throw asLogoImageError(error);
    }
  });
}
