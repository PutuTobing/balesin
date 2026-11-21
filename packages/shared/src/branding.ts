import { z } from 'zod';

// Ekstensi `.ts` eksplisit (audit akhir QA R4): berkas ini juga dimuat konfigurasi Vite web
// (`service-worker-plugin.ts`) lewat pemuat native Node, yang tidak menebak ekstensi.
import { MIN_TEXT_CONTRAST, color, contrastRatio } from './design-tokens.ts';
import { isoDateTimeSchema, singleLineText } from './fields.ts';

/**
 * Branding white-label (PRD §3.8): nama produk, warna utama, logo, dan nama maskot milik organisasi
 * pemakai. Tidak ada nilai khusus satu perusahaan di sini — semuanya diisi lewat wizard setup atau
 * Pengaturan → Merek.
 */

/** Nama produk bawaan bila organisasi tidak mengisinya. */
export const DEFAULT_PRODUCT_NAME = 'Balesin';

/**
 * Nama maskot bawaan produk. Ilustrasinya tetap bawaan; organisasi hanya boleh mengganti NAMA yang
 * dipakai di teks sapaan (lihat docs/DECISIONS.md, white-label Fase 7).
 */
export const DEFAULT_MASCOT_NAME = 'Kak Sky';

/**
 * Huruf Kiril/Yunani yang tampak sama dengan huruf Latin pembentuk "whatsapp" (review merek B3).
 * Bukan daftar konfusabel Unicode lengkap — cukup untuk ejaan pengelabuan yang umum.
 */
const LATIN_LOOKALIKES: Readonly<Record<string, string>> = {
  // Kiril
  а: 'a',
  А: 'a',
  һ: 'h',
  Һ: 'h',
  Н: 'h',
  н: 'h',
  ѕ: 's',
  Ѕ: 's',
  р: 'p',
  Р: 'p',
  т: 't',
  Т: 't',
  ԝ: 'w',
  Ԝ: 'w',
  ѡ: 'w',
  Ѡ: 'w',
  // Yunani
  α: 'a',
  Α: 'a',
  Η: 'h',
  η: 'h',
  ρ: 'p',
  Ρ: 'p',
  τ: 't',
  Τ: 't',
  ω: 'w',
};

/** Huruf "whatsapp" boleh diselingi apa pun yang BUKAN huruf (spasi, tanda baca, simbol, angka). */
const META_TRADEMARK_PATTERN = /w\P{L}*h\P{L}*a\P{L}*t\P{L}*s\P{L}*a\P{L}*p\P{L}*p/iu;
const TRADEMARK_MESSAGE =
  'Nama ini tidak boleh memuat kata "WhatsApp" (merek dagang Meta). Pakai nama lain.';

/**
 * `true` bila teks memuat merek dagang Meta "WhatsApp" (CLAUDE.md "Aturan keras"), termasuk ejaan
 * pengelabuan: huruf lebar penuh/matematis (NFKC), karakter format tak terlihat (ZWJ dsb., `\p{Cf}`),
 * huruf Kiril/Yunani yang mirip, dan pemisah apa pun di antara hurufnya.
 */
export function containsMetaTrademark(value: string): boolean {
  const normalized = [...value.normalize('NFKC').replace(/\p{Cf}/gu, '')]
    .map((char) => LATIN_LOOKALIKES[char] ?? char)
    .join('');
  return META_TRADEMARK_PATTERN.test(normalized);
}

function withoutMetaTrademark<T extends z.ZodType<string>>(schema: T) {
  return schema.refine((value) => !containsMetaTrademark(value), TRADEMARK_MESSAGE);
}

export const organizationNameSchema = singleLineText({
  min: 2,
  max: 100,
  requiredMessage: 'Nama perusahaan wajib diisi.',
  tooShortMessage: 'Nama perusahaan minimal 2 karakter.',
  tooLongMessage: 'Nama perusahaan maksimal 100 karakter.',
});

/** Nama yang tampil di aplikasi dan email (mis. "Balesin Maju Jaya"). */
export const productNameSchema = withoutMetaTrademark(
  singleLineText({
    min: 2,
    max: 40,
    requiredMessage: 'Nama aplikasi wajib diisi.',
    tooShortMessage: 'Nama aplikasi minimal 2 karakter.',
    tooLongMessage: 'Nama aplikasi maksimal 40 karakter.',
  }),
);

/** Nama maskot di teks sapaan (bawaan `DEFAULT_MASCOT_NAME`). */
export const MASCOT_NAME_MAX = 30;
export const mascotNameSchema = withoutMetaTrademark(
  singleLineText({
    min: 2,
    max: MASCOT_NAME_MAX,
    requiredMessage: 'Nama maskot wajib diisi.',
    tooShortMessage: 'Nama maskot minimal 2 karakter.',
    tooLongMessage: `Nama maskot maksimal ${MASCOT_NAME_MAX} karakter.`,
  }),
);

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** Teks terang di atas warna utama yang gelap. */
export const BRAND_LIGHT_TEXT = '#ffffff';
/** Teks gelap di atas warna utama yang terang (tinta tema terang). */
export const BRAND_DARK_TEXT = color.light.ink.toLowerCase();

/**
 * Warna teks yang terbaca di atas warna utama (tombol email & aplikasi): putih bila kontrasnya
 * ≥ 4.5:1, selain itu tinta gelap bila ≥ 4.5:1, selain itu `null` (warna tidak layak jadi latar
 * tombol). Putih diutamakan karena itu tampilan tombol yang paling umum.
 */
export function brandColorTextColor(hex: string): string | null {
  const value = hex.trim().toLowerCase();
  if (!HEX_COLOR_PATTERN.test(value)) return null;
  if (contrastRatio(value, BRAND_LIGHT_TEXT) >= MIN_TEXT_CONTRAST) return BRAND_LIGHT_TEXT;
  if (contrastRatio(value, BRAND_DARK_TEXT) >= MIN_TEXT_CONTRAST) return BRAND_DARK_TEXT;
  return null;
}

export const BRAND_COLOR_LOW_CONTRAST_MESSAGE =
  'Teks di atas warna ini sulit dibaca, baik putih maupun gelap. Pilih warna yang lebih gelap atau lebih terang.';

/**
 * Warna heksadesimal 6 digit, disimpan huruf kecil: `#1b3557`. Ditolak bila tidak ada warna teks
 * (putih maupun gelap) yang terbaca di atasnya, karena warna utama dipakai sebagai latar tombol.
 */
export const brandColorSchema = z
  .string({ error: 'Warna wajib diisi.' })
  .trim()
  .toLowerCase()
  // `abort`: format salah cukup satu pesan, tanpa pesan kontras.
  .regex(HEX_COLOR_PATTERN, {
    error: 'Warna harus berupa kode heksadesimal 6 digit, contoh: #1b3557.',
    abort: true,
  })
  .refine((value) => brandColorTextColor(value) !== null, BRAND_COLOR_LOW_CONTRAST_MESSAGE);

export const LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number];
/** Sisi terpanjang logo (piksel). Lebih dari ini ditolak — mencegah "bom dekompresi". */
export const LOGO_MAX_DIMENSION = 4096;

const LOGO_MAX_BASE64_LENGTH = Math.ceil(LOGO_MAX_BYTES / 3) * 4;
const LOGO_TOO_LARGE_MESSAGE = `Ukuran logo maksimal ${LOGO_MAX_BYTES / 1024} KB. Perkecil gambarnya lalu coba lagi.`;

/**
 * Logo dikirim sebagai base64 di dalam JSON. Server memeriksa ISI berkasnya (bukan hanya
 * `contentType`) dan menolak SVG — lihat SECURITY.md §7.
 */
export const logoUploadSchema = z.object({
  contentType: z.enum(LOGO_CONTENT_TYPES, {
    error: 'Logo harus berupa gambar PNG, JPG, atau WebP.',
  }),
  /** Isi berkas dalam base64 standar (tanpa awalan `data:`). */
  dataBase64: z
    .string({ error: 'Berkas logo wajib diisi.' })
    .min(1, 'Berkas logo wajib diisi.')
    .max(LOGO_MAX_BASE64_LENGTH, LOGO_TOO_LARGE_MESSAGE)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Berkas logo tidak terbaca. Pilih ulang gambarnya.'),
});
export type LogoUpload = z.infer<typeof logoUploadSchema>;

export const brandingInputSchema = z.object({
  /** Kosong/`null` = pakai nama bawaan. */
  productName: productNameSchema.nullish(),
  /** Kosong/`null` = pakai warna bawaan design system. */
  primaryColor: brandColorSchema.nullish(),
  /** Kosong/`null` = tanpa logo. */
  logo: logoUploadSchema.nullish(),
});
export type BrandingInput = z.infer<typeof brandingInputSchema>;

/**
 * Ikon aplikasi yang dibuat server dari logo organisasi (PNG persegi). `file` = segmen terakhir
 * alamatnya (`GET /branding/icons/:file`).
 *  - `maskable`: logo di dalam zona aman di atas latar penuh (Android memotong ikon jadi
 *    lingkaran/kotak membulat).
 *  - `opaque`: latar penuh tanpa transparansi (iOS mengisi bagian transparan dengan hitam).
 */
export const BRAND_ICONS = [
  { file: 'favicon-32.png', size: 32, purpose: 'any', opaque: false },
  { file: 'apple-touch-icon.png', size: 180, purpose: 'any', opaque: true },
  { file: 'icon-192.png', size: 192, purpose: 'any', opaque: false },
  { file: 'icon-512.png', size: 512, purpose: 'any', opaque: false },
  { file: 'maskable-192.png', size: 192, purpose: 'maskable', opaque: true },
  { file: 'maskable-512.png', size: 512, purpose: 'maskable', opaque: true },
] as const;
export type BrandIcon = (typeof BRAND_ICONS)[number];
export type BrandIconFile = BrandIcon['file'];
export const BRAND_ICON_FILES = BRAND_ICONS.map((icon) => icon.file) as [
  BrandIconFile,
  ...BrandIconFile[],
];
export const brandIconFileSchema = z.enum(BRAND_ICON_FILES);
/** Batas atas satu ikon PNG hasil olahan (CHECK `organization_logo_icons.byte_size`). */
export const BRAND_ICON_MAX_BYTES = 1024 * 1024;
/** Ikon yang masuk ke `icons` manifest PWA (favicon & apple-touch-icon lewat `<link>`). */
export const BRAND_MANIFEST_ICON_FILES: readonly BrandIconFile[] = [
  'icon-192.png',
  'icon-512.png',
  'maskable-192.png',
  'maskable-512.png',
];

/** Satu entri `icons` manifest PWA (siap disalin ke manifest; `src` dijadikan absolut oleh web). */
export const brandManifestIconSchema = z.object({
  /** Path relatif terhadap alamat API (mis. `/api/v1/branding/icons/icon-192.png?v=ab12cd34`). */
  src: z.string(),
  sizes: z.string(),
  type: z.literal('image/png'),
  purpose: z.enum(['any', 'maskable']),
});
export type BrandManifestIcon = z.infer<typeof brandManifestIconSchema>;

export const brandIconsSchema = z.object({
  /** Untuk `<link rel="icon" type="image/png" sizes="32x32">`. */
  favicon: z.string(),
  /** Untuk `<link rel="apple-touch-icon">` (180×180, latar penuh). */
  appleTouchIcon: z.string(),
  /**
   * Pengganti SELURUH `icons` manifest PWA (192/512 biasa + maskable). Ikon bawaan produk tidak
   * ikut dipakai bila organisasi punya logo.
   */
  manifest: z.array(brandManifestIconSchema),
});
export type BrandIcons = z.infer<typeof brandIconsSchema>;

/**
 * `GET /branding` — publik (dipakai halaman masuk sebelum ada sesi), jadi hanya memuat hal
 * yang memang tampil di halaman masuk.
 *
 * `mascotName` dan `icons` punya nilai bawaan saat diurai supaya respons/mock lama yang belum
 * memuatnya tetap sah. `BrandingResponse` = bentuk masukan (field baru opsional);
 * `ParsedBrandingResponse` = hasil urai (selalu lengkap).
 */
export const brandingResponseSchema = z.object({
  productName: z.string(),
  /** `null` selama wizard setup belum selesai. */
  organizationName: z.string().nullable(),
  primaryColor: z.string().nullable(),
  /** Path relatif terhadap alamat API (mis. `/api/v1/branding/logo?v=ab12cd34`), atau `null`. */
  logoUrl: z.string().nullable(),
  /** Nama maskot di teks sapaan (bawaan `DEFAULT_MASCOT_NAME`). */
  mascotName: z.string().default(DEFAULT_MASCOT_NAME),
  /** Ikon dari logo organisasi; `null` = tanpa logo → pakai ikon & favicon bawaan produk. */
  icons: brandIconsSchema.nullable().default(null),
});
export type BrandingResponse = z.input<typeof brandingResponseSchema>;
export type ParsedBrandingResponse = z.output<typeof brandingResponseSchema>;

// ── Pengaturan → Merek (izin `organization.manage` = Owner) ───────────────────

/**
 * `PATCH /settings/branding`. Field yang TIDAK dikirim = tidak berubah; `null` = kembali ke bawaan
 * (nama produk/maskot bawaan, warna bawaan design system, tanpa logo). Minimal satu field.
 */
export const updateBrandingRequestSchema = z
  .object({
    productName: productNameSchema.nullable().optional(),
    primaryColor: brandColorSchema.nullable().optional(),
    mascotName: mascotNameSchema.nullable().optional(),
    /** Logo baru (base64, sama dengan wizard setup), atau `null` = hapus logo. */
    logo: logoUploadSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.productName !== undefined ||
      value.primaryColor !== undefined ||
      value.mascotName !== undefined ||
      value.logo !== undefined,
    'Tidak ada perubahan untuk disimpan.',
  );
export type UpdateBrandingRequest = z.infer<typeof updateBrandingRequestSchema>;

export const brandingLogoInfoSchema = z.object({
  /** Path relatif terhadap alamat API, sama dengan `logoUrl` di `GET /branding`. */
  url: z.string(),
  contentType: z.enum(LOGO_CONTENT_TYPES),
  byteSize: z.number().int().positive(),
  updatedAt: isoDateTimeSchema,
});
export type BrandingLogoInfo = z.infer<typeof brandingLogoInfoSchema>;

export const brandingSettingsSchema = z.object({
  /** Isian tersimpan; `null` = memakai `defaults.productName`. */
  productName: z.string().nullable(),
  /** Isian tersimpan; `null` = warna bawaan design system. */
  primaryColor: z.string().nullable(),
  /** Warna teks yang terbaca di atas `primaryColor` (pratinjau tombol); `null` bila tanpa warna. */
  primaryTextColor: z.string().nullable(),
  /** Isian tersimpan; `null` = memakai `defaults.mascotName`. */
  mascotName: z.string().nullable(),
  logo: brandingLogoInfoSchema.nullable(),
  defaults: z.object({ productName: z.string(), mascotName: z.string() }),
});
export type BrandingSettings = z.infer<typeof brandingSettingsSchema>;

/** `GET` dan `PATCH /settings/branding`. */
export const brandingSettingsResponseSchema = z.object({ branding: brandingSettingsSchema });
export type BrandingSettingsResponse = z.infer<typeof brandingSettingsResponseSchema>;
