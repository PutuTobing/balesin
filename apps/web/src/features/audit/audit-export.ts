import { AUDIT_LOG_EXPORT_MAX_ROWS, type AuditLogFilter } from '@balesin/shared';
import { t } from '../../i18n/id';
import { endpoints } from '../../lib/api/endpoints';

/** Nama produk → bagian nama berkas yang aman: huruf kecil, angka, tanda hubung. */
export function fileSlug(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLocaleLowerCase('id-ID')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'aplikasi';
}

/** `audit-log-<produk>-YYYYMMDD.csv` (tanggal perangkat). */
export function auditFileName(productName: string, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return t.audit.fileName(fileSlug(productName), date);
}

export interface ExportResult {
  rows: number;
  truncated: boolean;
  maxRows: number;
}

/**
 * Ekspor CSV lewat `fetch` (cookie sesi, sama-origin) → `Blob` → tautan unduhan sementara. Tidak
 * membuka URL di tab baru dan tidak menaruh token di URL. URL objek dicabut setelah diklik.
 */
export async function downloadAuditCsv(
  filter: AuditLogFilter,
  productName: string,
): Promise<ExportResult> {
  const { blob, headers } = await endpoints.audit.exportCsv(filter);
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = auditFileName(productName);
    link.rel = 'noopener';
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // Beri browser waktu memulai unduhan sebelum URL-nya dicabut.
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  const rows = Number(headers.get('x-export-rows') ?? '');
  return {
    rows: Number.isFinite(rows) ? rows : 0,
    truncated: headers.get('x-export-truncated') === '1',
    maxRows: AUDIT_LOG_EXPORT_MAX_ROWS,
  };
}
