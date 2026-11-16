/**
 * Isian batas kirim: hanya digit; titik/spasi pemisah ribuan ("5.000") diabaikan. Selain itu `NaN`
 * supaya skema Zod menampilkan pesan "harus angka".
 */
export function parseLimit(raw: string): number {
  const cleaned = raw.trim().replace(/[.\s]/g, '');
  return /^\d{1,9}$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}
