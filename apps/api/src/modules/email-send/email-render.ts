import {
  cleanFileName,
  renderOutboundEmail,
  renderQrPng,
  validateQrisPayload,
  type RenderOutboundEmailResult,
} from '@balesin/core';
import { organizationLogos, organizations, type DbExecutor } from '@balesin/db';
import { EMAIL_CID_PATTERN, type EmailQrisInput } from '@balesin/shared';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';

import { detail, emailError, invalid } from './email-content';

/**
 * Render email lewat API (tahap 9.1, §3.3–3.4): bingkai merek (logo Branding organisasi sebagai PNG
 * inline `cid:logo` lebar ≤ 320 px — WebP tidak dipakai karena banyak aplikasi email tidak
 * mendukung; tanpa logo = nama organisasi), QRIS (TLV + CRC-16 lolos → PNG), lalu
 * `renderOutboundEmail` (variabel di-escape, sanitasi profil keluar). Dipakai kirim API, kirim tes,
 * dan pratinjau (logo/QRIS sebagai `data:` URI).
 */

export const LOGO_CID = 'logo';
const LOGO_MAX_WIDTH = 320;
const DEFAULT_PRIMARY = '#2563eb';
/** Payload QRIS contoh (data fiktif, CRC sah) untuk pratinjau. */
export const SAMPLE_QRIS_PAYLOAD =
  '00020101021226680016ID.CO.CONTOH.WWW01189360000000000000010215ID10200000000010303UMI52044899530336054061850005802ID5911TOKO CONTOH6007JAKARTA61051234563045195';

export interface EmailBrand {
  organizationName: string;
  primaryColor: string;
  /** Logo Branding sebagai PNG (≤ 320 px), `null` bila tidak ada / tidak bisa diolah. */
  logoPng: Buffer | null;
}

const logoCache = new Map<string, Buffer>();

async function logoPngOf(data: Buffer, sha256: string): Promise<Buffer | null> {
  const cached = logoCache.get(sha256);
  if (cached) return cached;
  try {
    const png = await sharp(data, {
      failOn: 'error',
      animated: false,
      limitInputPixels: 4096 * 4096,
    })
      .resize({ width: LOGO_MAX_WIDTH, withoutEnlargement: true })
      .png()
      .toBuffer();
    if (logoCache.size >= 32) logoCache.clear();
    logoCache.set(sha256, png);
    return png;
  } catch {
    return null;
  }
}

export async function loadEmailBrand(db: DbExecutor, organizationId: string): Promise<EmailBrand> {
  const [row] = await db
    .select({
      name: organizations.name,
      brandColor: organizations.brandColor,
      logoData: organizationLogos.data,
      logoSha: organizationLogos.sha256,
    })
    .from(organizations)
    .leftJoin(organizationLogos, eq(organizationLogos.organizationId, organizations.id))
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return {
    organizationName: row?.name ?? '',
    primaryColor: row?.brandColor ?? DEFAULT_PRIMARY,
    logoPng: row?.logoData && row.logoSha ? await logoPngOf(row.logoData, row.logoSha) : null,
  };
}

export interface PreparedQris {
  cid: string;
  png: Buffer;
  /** `attach: true` → juga dilampirkan sebagai berkas ini (tidak dihitung dalam 10 lampiran). */
  attachFilename: string | null;
}

/** QRIS diperiksa SEBELUM apa pun dibuat. Teks payload tidak pernah masuk log. */
export function prepareQris(input: EmailQrisInput | undefined): PreparedQris | null {
  if (!input) return null;
  const payload = input.payload;
  const verdict = validateQrisPayload(payload);
  if (!verdict.ok) {
    throw invalid(
      'qris.payload',
      verdict.reason,
      verdict.reason === 'qris_crc_mismatch'
        ? 'Kode cek (CRC) QRIS tidak cocok — teksnya rusak atau terpotong. Ambil ulang dari sistem pembayaran.'
        : 'Teks QRIS tidak sesuai format standar.',
    );
  }
  const cid = input.cid ?? 'qris';
  if (!EMAIL_CID_PATTERN.test(cid) || cid.toLowerCase() === LOGO_CID) {
    throw invalid(
      'qris.cid',
      'qris_invalid_format',
      'cid QRIS hanya huruf/angka/._- (maks. 64) dan tidak boleh "logo".',
    );
  }
  const attachFilename = input.attach
    ? (cleanFileName(input.filename ?? 'QRIS.png') ?? 'QRIS.png')
    : null;
  return { cid, png: renderQrPng(payload, input.sizePx ?? 480), attachFilename };
}

export interface RenderContent {
  subject: string;
  html: string | null;
  text: string | null;
  layout: 'brand' | 'none';
  footerText: string | null;
  values: Readonly<Record<string, string>>;
  /** Template = variabel diisi; isi luar = `{{…}}` dibiarkan. */
  fromTemplate: boolean;
}

export function renderEmail(
  brand: EmailBrand,
  content: RenderContent,
  options: { qris: PreparedQris | null; inline: 'cid' | 'data' },
): RenderOutboundEmailResult {
  const logoSrc =
    content.layout === 'brand' && brand.logoPng
      ? options.inline === 'cid'
        ? `cid:${LOGO_CID}`
        : `data:image/png;base64,${brand.logoPng.toString('base64')}`
      : null;
  const qrisImageSrc = options.qris
    ? options.inline === 'cid'
      ? `cid:${options.qris.cid}`
      : `data:image/png;base64,${options.qris.png.toString('base64')}`
    : null;
  return renderOutboundEmail({
    subject: content.subject,
    html: content.html,
    text: content.text,
    values: content.values,
    organizationName: brand.organizationName,
    qrisImageSrc,
    layout: content.layout,
    brand: { primaryColor: brand.primaryColor, logoSrc, footerText: content.footerText },
    substituteVariables: content.fromTemplate,
  });
}

/** Galat render → 400 (`template_variable_invalid` per variabel, `subject_invalid`). */
export function renderFailure(
  errors: Extract<RenderOutboundEmailResult, { ok: false }>['errors'],
): never {
  throw emailError(
    'VALIDATION_ERROR',
    errors.map((error) =>
      detail(error.name ? `variables.${error.name}` : error.field, error.reason, error.message),
    ),
  );
}
