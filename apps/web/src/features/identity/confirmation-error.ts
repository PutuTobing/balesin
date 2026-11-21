import { isApiError } from '../../lib/api/client';

/**
 * Error yang ditampilkan di dialog konfirmasi identitas, bukan di form/baris asalnya: password atau
 * kode konfirmasi salah (`confirmation.password` / `confirmation.code`), atau 429 (dialog terkunci
 * dengan hitung mundur dari `Retry-After`). Selain itu pemanggil menutup dialog dan menampilkan
 * pesannya di tempat biasa (mis. isian email, kotak di bawah tombol).
 */
export function isConfirmationError(caught: unknown): boolean {
  if (!isApiError(caught)) return false;
  if (caught.status === 429) return true;
  return caught.code === 'VALIDATION_ERROR' && needsConfirmation(caught);
}

/** Server menolak karena konfirmasi identitas belum/salah diisi (field `confirmation.*`). */
export function needsConfirmation(caught: unknown): boolean {
  return (
    isApiError(caught) && caught.details.some((detail) => detail.field.startsWith('confirmation.'))
  );
}
