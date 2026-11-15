import { z } from 'zod';

import { loginPasswordSchema } from './password';
import { twoFactorCodeSchema } from './two-factor';

/**
 * Konfirmasi ulang identitas pelaku: password + kode 2FA pelaku (autentikator atau kode cadangan).
 * `code` wajib bila 2FA pelaku aktif — selalu begitu untuk Owner/Admin. Salah password/kode memakai
 * ember yang sama dengan halaman Keamanan akun (5 salah → 429; kode salah ikut mengunci langkah
 * kedua 15 menit).
 *
 * Dipakai setiap aksi yang memberi akses menetap atau membelokkan jalur komunikasi (kelola
 * pengguna, undangan, email pengirim, kredensial channel, …): cookie sesi curian saja tidak cukup
 * (DECISIONS 2026-11-14/15). Modul terpisah supaya `team.ts` dan `invitations.ts` bisa memakainya
 * tanpa saling mengimpor.
 */
export const identityConfirmationSchema = z.object({
  password: loginPasswordSchema,
  code: twoFactorCodeSchema.optional(),
});
export type IdentityConfirmation = z.input<typeof identityConfirmationSchema>;
