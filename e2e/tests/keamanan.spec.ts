import { expect, expectNoHorizontalScroll, isHp, mainNav, openApp, test } from './fixtures';

/**
 * Pengaturan → Keamanan akun dengan sesi Owner sungguhan (2FA aktif dari `alur-awal`), di HP dan
 * desktop. Alur yang mengubah data (masuk dua langkah, kode cadangan sekali pakai, buat ulang kode
 * cadangan, sesi terbatas) ada di `alur-awal.setup.ts` karena berbagi satu akun Owner.
 */
test('Keamanan akun terbuka dari menu akun; Owner wajib 2FA tanpa tombol menonaktifkan', async ({
  page,
}) => {
  await openApp(page, '/inbox');
  if (isHp(page)) {
    await mainNav(page).getByRole('link', { name: 'Lainnya' }).click();
    await page.getByRole('link', { name: 'Keamanan akun' }).click();
  } else {
    await mainNav(page)
      .getByRole('button', { name: /^Akun / })
      .click();
    await page.getByRole('menuitem', { name: 'Keamanan akun' }).click();
  }
  await expect(page).toHaveURL(/\/pengaturan\/keamanan$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Keamanan akun' })).toBeVisible();
  const twoFactor = page.getByRole('region', { name: 'Verifikasi dua langkah' });
  await expect(twoFactor.getByText('Aktif', { exact: true })).toBeVisible();
  await expect(twoFactor.getByText(/Peranmu sebagai Owner wajib/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Nonaktifkan/ })).toHaveCount(0);
  await expect(page.getByText(/dari 10 kode tersisa/)).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Form konfirmasi terbuka dengan fokus di password; Batal menutupnya tanpa mengirim apa pun.
  await page.getByRole('button', { name: 'Buat kode baru' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  // Kotak isian (bingkai 44 px; elemen <input> di dalamnya dikurangi garis tepi).
  const box = await page.getByLabel('Kode verifikasi').locator('..').boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Batal' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
});

test('menu Pengaturan menampilkan Keamanan akun beserta status 2FA', async ({ page }) => {
  await openApp(page, '/pengaturan');
  const link = page.getByRole('link', { name: /Keamanan akun/ });
  await expect(link).toContainText('Aktif');
  await link.click();
  await expect(page).toHaveURL(/\/pengaturan\/keamanan$/);
  await page.getByRole('link', { name: 'Kembali ke Pengaturan' }).click();
  await expect(page).toHaveURL(/\/pengaturan$/);
});
