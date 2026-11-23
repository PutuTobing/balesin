import { expect, openApp, test } from './fixtures';

/**
 * Pengaturan → Batas kirim melawan stack sungguhan: nilai dari server, validasi klien, dan dialog
 * rem darurat. Rem TIDAK benar-benar ditarik di sini: berlaku untuk seluruh organisasi dan akan
 * mengganggu spec kirim lain yang berjalan bersamaan (tarik/lanjutkan diuji di tes api + komponen).
 */
test('Owner membuka Batas kirim dari Pengaturan: nilai server, validasi, dialog rem bisa dibatalkan', async ({
  page,
}) => {
  await openApp(page, '/pengaturan');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Batas kirim/ })
    .click();
  await expect(page).toHaveURL(/\/pengaturan\/batas-kirim$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Batas kirim' })).toBeVisible();
  await expect(
    page.getByRole('meter', { name: 'Pemakaian batas harian organisasi' }),
  ).toBeVisible();
  await expect(page.getByLabel('Batas harian organisasi', { exact: true })).not.toHaveValue('');

  const perMinute = page.getByLabel('Batas per percakapan per menit');
  await perMinute.fill('500');
  // `exact`: bila channel Email ada (spec lain), tiap pengirim punya tombol "Simpan batas
  // penerima per jam <nama>" di halaman yang sama (9.1).
  await page.getByRole('button', { name: 'Simpan batas', exact: true }).click();
  await expect(page.getByText(/paling banyak 120/)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Rem darurat: dialog menjelaskan akibatnya; Batal tidak mengubah apa pun.
  const brakeState = page.getByText(/^Pengiriman (berjalan|sedang dihentikan)$/);
  const before = await brakeState.textContent();
  if (before === 'Pengiriman berjalan') {
    await page.getByRole('button', { name: 'Tarik rem darurat' }).click();
    const dialog = page.getByRole('dialog', { name: 'Hentikan semua pengiriman?' });
    await expect(dialog.getByText(/Semua pesan keluar langsung berhenti/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Batal' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Tarik rem darurat' })).toBeFocused();
  }
  await expect(brakeState).toHaveText(before ?? '');
});
