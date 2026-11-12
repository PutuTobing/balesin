import { z } from 'zod';
import { id } from 'zod/locales';

/**
 * Menjadikan pesan validasi Zod bawaan berbahasa Indonesia, untuk api dan web.
 * Panggil sekali saat aplikasi mulai (pengaturannya global untuk seluruh proses/halaman).
 *
 * Pesan bawaan ini jaring pengaman; isian yang tampil di form sebaiknya tetap diberi pesan
 * khusus di skemanya, mis. `z.email({ error: 'Alamat email tidak valid.' })`.
 */
export function configureZodLocale(): void {
  z.config({
    ...id(),
    // Isian yang tidak dikirim sama sekali: lebih jelas daripada "diharapkan string, diterima undefined".
    customError: (issue) =>
      issue.code === 'invalid_type' && issue.input === undefined ? 'Wajib diisi.' : undefined,
  });
}
