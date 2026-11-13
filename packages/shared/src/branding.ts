import { z } from 'zod';

import { singleLineText } from './fields';

/**
 * Branding white-label (PRD §3.8): nama produk, warna utama, dan logo milik organisasi pemakai.
 * Tidak ada nilai khusus satu perusahaan di sini — semuanya diisi lewat wizard setup.
 */

/** Nama produk bawaan bila organisasi tidak mengisinya. */
export const DEFAULT_PRODUCT_NAME = 'Balesin';

export const organizationNameSchema = singleLineText({
  min: 2,
  max: 100,
  requiredMessage: 'Nama perusahaan wajib diisi.',
  tooShortMessage: 'Nama perusahaan minimal 2 karakter.',
  tooLongMessage: 'Nama perusahaan maksimal 100 karakter.',
});

/** Nama yang tampil di aplikasi dan email (mis. "Balesin Maju Jaya"). */
export const productNameSchema = singleLineText({
  min: 2,
  max: 40,
  requiredMessage: 'Nama aplikasi wajib diisi.',
  tooShortMessage: 'Nama aplikasi minimal 2 karakter.',
  tooLongMessage: 'Nama aplikasi maksimal 40 karakter.',
});

/** Warna heksadesimal 6 digit, disimpan huruf kecil: `#1b3557`. */
export const brandColorSchema = z
  .string({ error: 'Warna wajib diisi.' })
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, 'Warna harus berupa kode heksadesimal 6 digit, contoh: #1b3557.');

export const LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number];

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
 * `GET /branding` — publik (dipakai halaman masuk sebelum ada sesi), jadi hanya memuat hal
 * yang memang tampil di halaman masuk.
 */
export const brandingResponseSchema = z.object({
  productName: z.string(),
  /** `null` selama wizard setup belum selesai. */
  organizationName: z.string().nullable(),
  primaryColor: z.string().nullable(),
  /** Path relatif terhadap alamat API (mis. `/api/v1/branding/logo?v=ab12cd34`), atau `null`. */
  logoUrl: z.string().nullable(),
});
export type BrandingResponse = z.infer<typeof brandingResponseSchema>;
