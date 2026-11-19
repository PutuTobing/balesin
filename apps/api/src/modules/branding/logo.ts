import { AppError, sha256Hex } from '@balesin/core';
import {
  LOGO_MAX_BYTES,
  LOGO_MAX_DIMENSION,
  type LogoContentType,
  type LogoUpload,
} from '@balesin/shared';

import { LogoImageError, inspectLogoImage, renderBrandIcons, type RenderedIcon } from './icons';

/**
 * Pemeriksaan logo yang diunggah (SECURITY.md §7): tipe ditentukan dari ISI berkas, bukan
 * dari `contentType` kiriman klien maupun ekstensi. Hanya gambar raster (PNG/JPEG/WebP);
 * SVG ditolak karena bisa membawa skrip.
 */

export interface ValidatedLogo {
  contentType: LogoContentType;
  data: Buffer;
  sha256: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Tipe gambar menurut byte pembukanya, atau `undefined` bila bukan PNG/JPEG/WebP. */
export function sniffImageType(data: Buffer): LogoContentType | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.length >= 12 &&
    data.toString('latin1', 0, 4) === 'RIFF' &&
    data.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

/**
 * Mengubah kiriman base64 menjadi logo siap simpan. Melempar `VALIDATION_ERROR` pada isian
 * `field` bila isinya bukan gambar yang diizinkan atau ukurannya melewati batas.
 */
function invalidLogo(field: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', { details: [{ location: 'body', field, message }] });
}

export function validateLogoUpload(upload: LogoUpload, field: string): ValidatedLogo {
  const fail = (message: string) => invalidLogo(field, message);

  const data = Buffer.from(upload.dataBase64, 'base64');
  if (data.length === 0) throw fail('Berkas logo kosong. Pilih ulang gambarnya.');
  if (data.length > LOGO_MAX_BYTES) {
    throw fail(
      `Ukuran logo maksimal ${LOGO_MAX_BYTES / 1024} KB. Perkecil gambarnya lalu coba lagi.`,
    );
  }

  const sniffed = sniffImageType(data);
  if (!sniffed) {
    throw fail('Logo harus berupa gambar PNG, JPG, atau WebP. Berkas SVG tidak diterima.');
  }
  if (sniffed !== upload.contentType) {
    throw fail('Isi berkas logo tidak cocok dengan jenisnya. Pilih ulang gambarnya.');
  }
  return { contentType: sniffed, data, sha256: sha256Hex(data) };
}

export interface PreparedLogo extends ValidatedLogo {
  width: number;
  height: number;
  /** Ikon PNG `BRAND_ICONS` yang dibuat dari logo ini. */
  icons: RenderedIcon[];
}

const LOGO_IMAGE_MESSAGES: Readonly<Record<LogoImageError['reason'], string>> = {
  unreadable: 'Gambar logo rusak atau tidak bisa dibaca. Simpan ulang gambarnya lalu coba lagi.',
  too_large: `Ukuran gambar logo maksimal ${LOGO_MAX_DIMENSION}×${LOGO_MAX_DIMENSION} piksel. Perkecil gambarnya lalu coba lagi.`,
  format_mismatch: 'Isi berkas logo tidak cocok dengan jenisnya. Pilih ulang gambarnya.',
};

/**
 * `validateLogoUpload` + pemeriksaan gambar sungguhan (dekoder dibatasi) + pembuatan ikon PWA.
 * Dipanggil SEBELUM transaksi (mengolah gambar memakan CPU).
 */
export async function prepareLogoUpload(upload: LogoUpload, field: string): Promise<PreparedLogo> {
  const logo = validateLogoUpload(upload, field);
  try {
    const { width, height } = await inspectLogoImage(logo.data, logo.contentType);
    const icons = await renderBrandIcons(logo.data);
    return { ...logo, width, height, icons };
  } catch (error) {
    if (error instanceof LogoImageError) {
      throw invalidLogo(field, LOGO_IMAGE_MESSAGES[error.reason]);
    }
    throw error;
  }
}
