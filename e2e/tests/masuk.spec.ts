import { expect, expectNoHorizontalScroll, isHp, owner, submitLogin, test } from './fixtures';

/**
 * Halaman masuk untuk tamu (tanpa sesi). Alur lengkap (keluar, masuk lagi, terkunci) ada di
 * `alur-awal.setup.ts`; di sini tampilan dan pesan error di kedua ukuran layar.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(({ expectHttpError }) => {
  expectHttpError('/api/v1/auth/me', 401);
});

test('tamu diarahkan ke halaman masuk; tanpa pendaftaran publik', async ({ page }) => {
  await page.goto('/kontak');
  await expect(page).toHaveURL(/\/masuk\?redirect=%2Fkontak$/);
  await expect(
    page.getByRole('heading', { level: 1, name: `Masuk ke ${owner.organization}` }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/^Masuk · /);
  await expect(page.getByRole('link', { name: /daftar/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /lupa/i })).toHaveCount(0);
  await expect(page.getByLabel('Email')).toHaveAttribute('autocomplete', 'username');
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute(
    'autocomplete',
    'current-password',
  );
  await expectNoHorizontalScroll(page);
});

test('ilustrasi hanya di desktop; di HP form memenuhi layar', async ({ page }) => {
  await page.goto('/masuk');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const hero = page.locator('aside img');
  if (isHp(page)) {
    await expect(hero).toBeHidden();
    const box = await page.getByRole('button', { name: 'Masuk', exact: true }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  } else {
    await expect(hero).toBeVisible();
  }
});

test('isian kosong dan password salah menampilkan pesan yang jelas', async ({
  page,
  expectHttpError,
}) => {
  expectHttpError('/api/v1/auth/login', 401);
  await page.goto('/masuk');
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page.getByText('Alamat email wajib diisi.')).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');

  // Email yang tidak terdaftar: pesan sama dengan password salah (tidak membuka data akun).
  await submitLogin(page, `bukan-${isHp(page) ? 'hp' : 'desktop'}@majujaya.test`, 'apa-saja-123');
  await expect(page.getByRole('alert')).toContainText(
    'Email atau password salah. Periksa lagi lalu coba masuk kembali.',
  );
  // Password bisa ditampilkan untuk diperiksa.
  await page.getByRole('button', { name: 'Tampilkan password' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
});
