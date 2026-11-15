import { t } from '../../i18n/id';
import { formatDateTime } from '../../lib/format';

/** `Layanan Maju Jaya` → `layanan-maju-jaya`; huruf beraksen dibuang aksennya. */
export function fileSlug(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'akun';
}

/** Nama berkas unduhan kode cadangan; memuat nama produk dari branding (white-label). */
export function backupCodesFileName(productName: string): string {
  return t.twoFactor.backupCodes.fileName(fileSlug(productName));
}

/** Isi berkas `.txt` kode cadangan: judul, akun, waktu dibuat, cara pakai, lalu kodenya. */
export function backupCodesFileContent(input: {
  productName: string;
  email: string;
  codes: readonly string[];
  generatedAt: string;
}): string {
  const copy = t.twoFactor.backupCodes.file;
  return [
    copy.heading(input.productName),
    copy.account(input.email),
    copy.generated(formatDateTime(input.generatedAt)),
    '',
    copy.usage,
    copy.keepSafe,
    '',
    ...input.codes.map((code, index) => `${String(index + 1).padStart(2, ' ')}. ${code}`),
    '',
  ].join('\n');
}

/**
 * Unduh teks sebagai berkas tanpa server: Blob + tautan `download` sementara. URL Blob dicabut
 * segera setelah dipakai supaya isinya tidak tertinggal di memori halaman.
 */
export function downloadTextFile(fileName: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
