import { AppError, sha256Hex } from '@balesin/core';
import {
  MAIL_AVATAR_MAX_DIMENSION,
  MAIL_AVATAR_SIZE,
  MAIL_AVATAR_STORED_MAX_BYTES,
  MAIL_AVATAR_UPLOAD_MAX_BYTES,
  MAIL_SIGNATURE_LOGO_MAX_WIDTH,
  MAIL_SIGNATURE_LOGO_STORED_MAX_BYTES,
  MAIL_SIGNATURE_LOGO_UPLOAD_MAX_BYTES,
} from '@balesin/shared';
import sharp from 'sharp';

import { inspectLogoImage, LogoImageError, withDecodeSlot } from '../branding/icons';
import { sniffImageType } from '../branding/logo';

/**
 * Foto akun Email / channel (KONTRAK-API-EMAIL §4, pola logo organisasi — SECURITY.md §7):
 *  - jenis dari ISI (PNG/JPEG/WebP), SVG & lainnya ditolak 415; > 1 MB → 413;
 *  - header diperiksa dulu (format cocok, sisi ≤ 4.096) sebelum didekode; dekoder dibatasi
 *    (`limitInputPixels`, frame pertama, `failOn: error`) dan antre satu per proses (`withDecodeSlot`);
 *  - hasil = potong persegi tengah 256×256 PNG tanpa metadata (EXIF/ICC dibuang), ≤ 128 KB.
 */

export interface ProcessedAvatar {
  data: Buffer;
  sha256: string;
}

export async function processMailAvatar(base64: string): Promise<ProcessedAvatar> {
  const input = Buffer.from(base64, 'base64');
  if (input.length === 0) {
    throw new AppError('VALIDATION_ERROR', {
      message: 'Berkas foto kosong. Pilih ulang gambarnya.',
      details: [{ location: 'body', field: 'image', message: 'Berkas foto kosong.' }],
    });
  }
  if (input.length > MAIL_AVATAR_UPLOAD_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', { message: 'Ukuran foto maksimal 1 MB.' });
  }
  const type = sniffImageType(input);
  if (!type) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
      message: 'Foto harus berupa gambar PNG, JPG, atau WebP. Berkas SVG tidak diterima.',
    });
  }
  try {
    const { width, height } = await inspectLogoImage(input, type);
    if (width > MAIL_AVATAR_MAX_DIMENSION || height > MAIL_AVATAR_MAX_DIMENSION) {
      throw new LogoImageError('too_large');
    }
    const data = await withDecodeSlot(async () => {
      const base = () =>
        sharp(input, {
          limitInputPixels: MAIL_AVATAR_MAX_DIMENSION * MAIL_AVATAR_MAX_DIMENSION,
          failOn: 'error',
          animated: false,
          autoOrient: true,
        }).resize(MAIL_AVATAR_SIZE, MAIL_AVATAR_SIZE, { fit: 'cover', position: 'centre' });
      let out = await base().png({ compressionLevel: 9 }).toBuffer();
      if (out.length > MAIL_AVATAR_STORED_MAX_BYTES) {
        out = await base().png({ compressionLevel: 9, palette: true, quality: 90 }).toBuffer();
      }
      return out;
    });
    if (data.length > MAIL_AVATAR_STORED_MAX_BYTES) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Foto ini terlalu rumit untuk diperkecil. Pakai gambar yang lebih sederhana.',
        details: [{ location: 'body', field: 'image', message: 'Foto terlalu rumit.' }],
      });
    }
    return { data, sha256: sha256Hex(data) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const reason = error instanceof LogoImageError ? error.reason : 'unreadable';
    const message =
      reason === 'too_large'
        ? 'Ukuran gambar maksimal 4.096×4.096 piksel. Perkecil gambarnya lalu coba lagi.'
        : reason === 'format_mismatch'
          ? 'Isi berkas tidak cocok dengan jenis gambarnya. Pilih ulang gambarnya.'
          : 'Gambar rusak atau tidak bisa dibaca. Simpan ulang gambarnya lalu coba lagi.';
    throw new AppError('VALIDATION_ERROR', {
      message,
      details: [{ location: 'body', field: 'image', message }],
    });
  }
}

/**
 * 9B: logo tanda tangan (KONTRAK-API-EMAIL-TULIS §4) — jenis dari ISI (PNG/JPEG/WebP, SVG ditolak),
 * ≤ 1 MB, header diperiksa sebelum didekode, hasil PNG lebar ≤ 320 px (rasio dijaga, tidak
 * diperbesar), tanpa metadata, ≤ 128 KB.
 */
export async function processSignatureLogo(
  base64: string,
): Promise<ProcessedAvatar & { width: number }> {
  const input = Buffer.from(base64, 'base64');
  if (input.length === 0) {
    throw new AppError('VALIDATION_ERROR', {
      message: 'Berkas logo kosong. Pilih ulang gambarnya.',
      details: [{ location: 'body', field: 'image', message: 'Berkas logo kosong.' }],
    });
  }
  if (input.length > MAIL_SIGNATURE_LOGO_UPLOAD_MAX_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', { message: 'Ukuran logo maksimal 1 MB.' });
  }
  const type = sniffImageType(input);
  if (!type) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', {
      message: 'Logo harus berupa gambar PNG, JPG, atau WebP. Berkas SVG tidak diterima.',
    });
  }
  try {
    const { width, height } = await inspectLogoImage(input, type);
    if (width > MAIL_AVATAR_MAX_DIMENSION || height > MAIL_AVATAR_MAX_DIMENSION) {
      throw new LogoImageError('too_large');
    }
    const result = await withDecodeSlot(async () => {
      const base = () =>
        sharp(input, {
          limitInputPixels: MAIL_AVATAR_MAX_DIMENSION * MAIL_AVATAR_MAX_DIMENSION,
          failOn: 'error',
          animated: false,
          autoOrient: true,
        }).resize({ width: MAIL_SIGNATURE_LOGO_MAX_WIDTH, withoutEnlargement: true });
      let out = await base().png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
      if (out.data.length > MAIL_SIGNATURE_LOGO_STORED_MAX_BYTES) {
        out = await base()
          .png({ compressionLevel: 9, palette: true, quality: 90 })
          .toBuffer({ resolveWithObject: true });
      }
      return out;
    });
    if (result.data.length > MAIL_SIGNATURE_LOGO_STORED_MAX_BYTES) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'Logo ini terlalu rumit untuk diperkecil. Pakai gambar yang lebih sederhana.',
        details: [{ location: 'body', field: 'image', message: 'Logo terlalu rumit.' }],
      });
    }
    return { data: result.data, sha256: sha256Hex(result.data), width: result.info.width };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const reason = error instanceof LogoImageError ? error.reason : 'unreadable';
    const message =
      reason === 'too_large'
        ? 'Ukuran gambar maksimal 4.096×4.096 piksel. Perkecil gambarnya lalu coba lagi.'
        : 'Gambar rusak atau tidak bisa dibaca. Simpan ulang gambarnya lalu coba lagi.';
    throw new AppError('VALIDATION_ERROR', {
      message,
      details: [{ location: 'body', field: 'image', message }],
    });
  }
}
