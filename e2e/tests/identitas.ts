import type { Page } from '@playwright/test';
import { expect, owner } from './fixtures';
import { withOwnerCode } from './two-factor';

/**
 * Konfirmasi ulang identitas (`IdentityDialog`): kini wajib untuk SEMUA peran, Owner juga, saat
 * membuat/mengirim ulang undangan dan mengubah jalur email pengirim (review akhir Fase 1 T1/T2).
 */

/** Isi dialog konfirmasi yang sedang terbuka sebagai Owner E2E, lalu tunggu dialog tertutup. */
export async function confirmAsOwner(
  page: Page,
  dialogName: string | RegExp,
  confirmLabel: string,
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible();
  const password = dialog.getByLabel('Password', { exact: true });
  await expect(password).toBeFocused();
  await password.fill(owner.password);
  // Satu kode TOTP sekali pakai per langkah waktu, dipakai bergantian oleh semua tes.
  await withOwnerCode(async ({ code }) => {
    await dialog.getByLabel('Kode verifikasi').fill(code);
    await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
    await expect(dialog).toBeHidden();
  });
}

/**
 * `confirmation` untuk permintaan API sebagai Owner (password + kode yang belum pernah dipakai).
 * `send` dijalankan selama kode itu dipegang supaya urutan langkah TOTP ke server tetap naik.
 */
export async function withOwnerConfirmation<T>(
  send: (confirmation: { password: string; code: string }) => Promise<T>,
): Promise<T> {
  return withOwnerCode(({ code }) => send({ password: owner.password, code }));
}
