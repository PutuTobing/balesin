import type { Page, Route } from '@playwright/test';
import { E2E_SETUP_TOKEN } from '../stack/env';
import { expect, test } from './fixtures';

/**
 * Wizard setup di browser sungguhan: riwayat (Back/Forward), token yang ditempel di tab yang
 * sudah terbuka, dan fokus ke isian yang salah (BUG-QA4, QA5, QA6). Instalasi E2E sudah
 * selesai, jadi jawaban API setup ditiru seperti di `setup-wizard.spec.ts`.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(({ expectHttpError }) => {
  expectHttpError('/api/v1/auth/me', 401);
});

async function mockFreshInstall(page: Page) {
  const json = (route: Route, body: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/v1/setup/status', (route) =>
    json(route, { needsSetup: true, setupTokenConfigured: true, canStoreSecrets: true }),
  );
  await page.route('**/api/v1/setup/verify-token', (route) => json(route, { valid: true }));
  await page.route('**/api/v1/setup/check-password', (route) =>
    json(route, { acceptable: true, message: null }),
  );
}

const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const next = (page: Page) => page.getByRole('button', { name: 'Lanjut' });

test('QA4: Back browser mundur satu langkah, isian tetap; Forward maju lagi', async ({ page }) => {
  await mockFreshInstall(page);
  await page.goto('/setup');
  await page.getByLabel('Token setup').fill(E2E_SETUP_TOKEN);
  await next(page).click();
  await expect(heading(page, 'Tentang organisasimu')).toBeVisible();
  await page.getByLabel('Nama perusahaan').fill('PT Riwayat');
  await next(page).click();
  await expect(heading(page, 'Buat akun Owner')).toBeVisible();
  await page.getByLabel('Nama lengkap').fill('Sari Riwayat');

  await page.goBack();
  await expect(heading(page, 'Tentang organisasimu')).toBeVisible();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByLabel('Nama perusahaan')).toHaveValue('PT Riwayat');

  await page.goBack();
  await expect(heading(page, 'Masukkan token setup')).toBeVisible();
  await expect(page.getByLabel('Token setup')).toHaveValue(E2E_SETUP_TOKEN);

  await page.goForward();
  await page.goForward();
  await expect(heading(page, 'Buat akun Owner')).toBeVisible();
  await expect(page.getByLabel('Nama lengkap')).toHaveValue('Sari Riwayat');

  // Token dan password tidak ikut tersimpan di entri riwayat.
  const historyState = await page.evaluate(() => JSON.stringify(window.history.state));
  expect(historyState).not.toContain(E2E_SETUP_TOKEN);
});

test('QA5: tautan bertoken ditempel di tab /setup yang sudah terbuka → dipakai lalu dihapus dari alamat', async ({
  page,
}) => {
  await mockFreshInstall(page);
  await page.goto('/setup');
  await expect(heading(page, 'Masukkan token setup')).toBeVisible();

  // Sama dengan menempel tautan di bilah alamat: hanya fragment yang berubah, tanpa muat ulang.
  await page.evaluate((token) => {
    window.location.hash = `token=${token}`;
  }, E2E_SETUP_TOKEN);

  await expect(heading(page, 'Tentang organisasimu')).toBeVisible();
  await expect(page).toHaveURL(/\/setup$/);
  expect(page.url()).not.toContain(E2E_SETUP_TOKEN);
});

test('QA6: validasi gagal → fokus di isian pertama yang salah', async ({ page }) => {
  await mockFreshInstall(page);
  await page.goto('/setup');
  await page.getByLabel('Token setup').fill(E2E_SETUP_TOKEN);
  await next(page).click();
  await expect(heading(page, 'Tentang organisasimu')).toBeVisible();
  await next(page).click();
  await expect(page.getByLabel('Nama perusahaan')).toBeFocused();

  await page.getByLabel('Nama perusahaan').fill('PT Fokus');
  await next(page).click();
  await expect(heading(page, 'Buat akun Owner')).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill('bukan-email');
  await next(page).click();
  // Isian pertama yang salah dalam urutan form: Nama lengkap (kosong), bukan Email.
  await expect(page.getByLabel('Nama lengkap')).toBeFocused();
});

test('QA6: halaman masuk — isian kosong memindahkan fokus ke Email', async ({ page }) => {
  await page.goto('/masuk');
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page.getByLabel('Email')).toBeFocused();
});
