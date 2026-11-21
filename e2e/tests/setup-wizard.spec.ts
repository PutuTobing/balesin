import type { Page, Route } from '@playwright/test';
import { E2E_SETUP_TOKEN } from '../stack/env';
import { expect, expectNoHorizontalScroll, test } from './fixtures';

/**
 * Perilaku layar wizard setup di HP (390) dan desktop (1440).
 *
 * Setup sungguhan hanya bisa dijalankan sekali (proyek `alur-awal`, melawan API asli). Di sini
 * instalasi sudah selesai, jadi jawaban API setup DITIRU lewat `page.route` untuk menguji hal
 * yang murni urusan layar: fokus saat ganti langkah, maju-mundur tanpa kehilangan isian, error
 * yang harus hilang setelah diperbaiki, dan pemetaan error server ke isiannya.
 *
 * Tes "BUG-QA…" mereproduksi bug yang dilaporkan QA (Fase 1); bugnya sudah diperbaiki dan tes
 * itu kini menjaga supaya tidak muncul lagi.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(({ expectHttpError }) => {
  expectHttpError('/api/v1/auth/me', 401);
});

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Tiru instalasi yang belum di-setup. `setup/complete` sengaja tidak ditiru. */
async function mockFreshInstall(page: Page) {
  await page.route('**/api/v1/setup/status', (route) =>
    json(route, { needsSetup: true, setupTokenConfigured: true, canStoreSecrets: true }),
  );
  await page.route('**/api/v1/setup/verify-token', (route) => json(route, { valid: true }));
  await page.route('**/api/v1/setup/check-password', (route) =>
    json(route, { acceptable: true, message: null }),
  );
  await page.route('**/api/v1/setup/email/detect-host', (route) =>
    json(route, { domain: 'majujaya.test', suggestions: [] }),
  );
}

const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });
const next = (page: Page) => page.getByRole('button', { name: 'Lanjut' });
const back = (page: Page) => page.getByRole('button', { name: 'Kembali' });

async function passToken(page: Page) {
  await page.goto('/setup');
  await page.getByLabel('Token setup').fill(E2E_SETUP_TOKEN);
  await next(page).click();
  await expect(heading(page, 'Tentang organisasimu')).toBeFocused();
}

async function passOrganizationAndOwner(page: Page) {
  await page.getByLabel('Nama perusahaan').fill('PT Uji Tampilan');
  await next(page).click();
  await page.getByLabel('Nama lengkap').fill('Dewi Lestari');
  await page.getByLabel('Email', { exact: true }).fill('dewi@ujitampilan.test');
  await page.getByLabel('Password', { exact: true }).fill('Bakso-Urat-Hujan-Sore-19');
  await page.getByLabel('Ulangi password').fill('Bakso-Urat-Hujan-Sore-19');
  await next(page).click();
  await expect(heading(page, 'Sesuaikan tampilan')).toBeFocused();
}

test('maju-mundur: fokus pindah ke judul langkah, isian tetap ada, tanpa scroll horizontal', async ({
  page,
}) => {
  await mockFreshInstall(page);
  await passToken(page);
  await expectNoHorizontalScroll(page);
  await passOrganizationAndOwner(page);
  await page.getByLabel('Nama aplikasi').fill('Balesin Uji');
  await next(page).click();
  await expect(heading(page, 'Email pengirim')).toBeFocused();
  await page.getByLabel('Nama pengirim').fill('CS Uji');
  await expectNoHorizontalScroll(page);

  // Mundur sampai Organisasi: setiap langkah memfokuskan judulnya dan isiannya utuh.
  await back(page).click();
  await expect(heading(page, 'Sesuaikan tampilan')).toBeFocused();
  await expect(page.getByLabel('Nama aplikasi')).toHaveValue('Balesin Uji');
  await back(page).click();
  await expect(heading(page, 'Buat akun Owner')).toBeFocused();
  await expect(page.getByLabel('Ulangi password')).toHaveValue('Bakso-Urat-Hujan-Sore-19');
  await back(page).click();
  await expect(heading(page, 'Tentang organisasimu')).toBeFocused();
  await expect(page.getByLabel('Nama perusahaan')).toHaveValue('PT Uji Tampilan');

  // Maju lagi: tidak perlu mengisi ulang apa pun.
  await next(page).click();
  await next(page).click();
  await next(page).click();
  await expect(heading(page, 'Email pengirim')).toBeFocused();
  await expect(page.getByLabel('Nama pengirim')).toHaveValue('CS Uji');
  await page.getByRole('button', { name: 'Lewati' }).click();
  await expect(heading(page, 'Periksa lalu selesaikan')).toBeFocused();
  await expect(page.getByText('Balesin Uji')).toBeVisible();
  await expect(page.getByText('Dilewati, atur nanti')).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('Tampilan: "Lewati" mengosongkan isian langkah itu, langkah lain tetap', async ({ page }) => {
  await mockFreshInstall(page);
  await passToken(page);
  await passOrganizationAndOwner(page);
  await page.getByLabel('Nama aplikasi').fill('Nama Yang Dilewati');
  await page.getByRole('button', { name: 'Lewati' }).click();
  await page.getByRole('button', { name: 'Lewati' }).click();
  await expect(heading(page, 'Periksa lalu selesaikan')).toBeVisible();
  await expect(page.getByText('Nama Yang Dilewati')).toHaveCount(0);
  await expect(page.getByText('PT Uji Tampilan')).toBeVisible();
});

test.describe('bug QA Fase 1 (sudah diperbaiki, dijaga tes)', () => {
  test('BUG-QA1: error warna/nama tetap tampil setelah isian diperbaiki', async ({ page }) => {
    await mockFreshInstall(page);
    await passToken(page);
    await next(page).click();
    await expect(page.getByText('Nama perusahaan wajib diisi.')).toBeVisible();
    await page.getByLabel('Nama perusahaan').fill('PT Uji Tampilan');
    await expect(page.getByText('Nama perusahaan wajib diisi.')).toBeHidden({ timeout: 2_000 });
  });

  // Isian warna utama dihapus dari wizard (DECISIONS 2026-11-13); bug yang sama diuji lewat
  // isian lain di langkah Tampilan.
  test('BUG-QA1: nama aplikasi sudah benar tetapi error format masih tampil', async ({ page }) => {
    await mockFreshInstall(page);
    await passToken(page);
    await passOrganizationAndOwner(page);
    await page.getByLabel('Nama aplikasi').fill('A');
    await next(page).click();
    await expect(page.getByText('Nama aplikasi minimal 2 karakter.')).toBeVisible();
    await page.getByLabel('Nama aplikasi').fill('Balesin Uji');
    await expect(page.getByLabel('Nama aplikasi')).not.toHaveAttribute('aria-invalid', 'true', {
      timeout: 2_000,
    });
  });

  test('BUG-QA2: port di luar daftar izin saat "Tes koneksi" ditandai di isian Port', async ({
    page,
    expectHttpError,
  }) => {
    expectHttpError('/api/v1/setup/email/test-connection', 400);
    await mockFreshInstall(page);
    // Jawaban API sungguhan untuk port 2526 (diambil dari server Fase 1).
    await page.route('**/api/v1/setup/email/test-connection', (route) =>
      json(
        route,
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Data yang dikirim tidak valid. Periksa lagi isiannya.',
            details: [
              {
                location: 'body',
                field: 'settings.port',
                message:
                  'Port ini tidak didukung. Pakai 465 (SSL/TLS), 587 (STARTTLS), atau 25/2525 (tanpa enkripsi).',
              },
            ],
            requestId: 'qa-mock',
          },
        },
        400,
      ),
    );
    await passToken(page);
    await passOrganizationAndOwner(page);
    await next(page).click();
    await page.getByRole('radio', { name: 'Lainnya' }).click();
    await page.getByLabel('Nama pengirim').fill('CS Uji');
    await page.getByLabel('Alamat email pengirim').fill('cs@majujaya.test');
    await page.getByLabel('Host SMTP').fill('mail.majujaya.test');
    await page.getByLabel('Port').fill('2526');
    await page.getByLabel('Password', { exact: true }).fill('rahasia-sekali');
    await page.getByRole('button', { name: 'Tes koneksi' }).click();
    await expect(page.getByLabel('Port')).toHaveAttribute('aria-invalid', 'true', {
      timeout: 5_000,
    });
    await expect(page.getByText(/Port ini tidak didukung/)).toBeVisible();
  });

  test('BUG-QA3: "Setup sudah selesai" → "Ke halaman masuk" benar-benar membuka halaman masuk', async ({
    page,
    expectHttpError,
  }) => {
    // Tab yang membuka wizard sebelum setup selesai di tempat lain: status awal "perlu setup",
    // lalu API sungguhan menjawab 409 karena setup sudah selesai.
    expectHttpError('/api/v1/setup/verify-token', 409);
    await page.route('**/api/v1/setup/status', (route) =>
      json(route, { needsSetup: true, setupTokenConfigured: true, canStoreSecrets: true }),
    );
    await page.goto('/setup');
    await expect(heading(page, 'Masukkan token setup')).toBeVisible();
    await page.unroute('**/api/v1/setup/status');
    await page.getByLabel('Token setup').fill(E2E_SETUP_TOKEN);
    await next(page).click();
    await expect(heading(page, 'Setup sudah selesai')).toBeVisible();
    await page.getByRole('link', { name: 'Ke halaman masuk' }).click();
    await expect(page).toHaveURL(/\/masuk$/, { timeout: 5_000 });
  });
});

test('setelah setup selesai: /setup#token=… diarahkan ke halaman masuk tanpa token di alamat', async ({
  page,
}) => {
  await page.goto(`/setup#token=${encodeURIComponent(E2E_SETUP_TOKEN)}`);
  await expect(page).toHaveURL(/\/masuk$/);
  expect(page.url()).not.toContain(E2E_SETUP_TOKEN);
  await expect(page.getByRole('heading', { level: 1, name: /^Masuk ke / })).toBeVisible();
});
