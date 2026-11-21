import { randomInt } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, openApp, test } from './fixtures';
import { signIn } from './inbox-bantu';
import { createUser } from './pengguna';

/**
 * Pengaturan → Merek (white-label, docs/KONTRAK-API-AUTH.md "Pengaturan → Merek") melawan stack
 * sungguhan: Owner mengganti nama aplikasi, nama maskot, warna utama, dan logo → halaman masuk,
 * warna aksen, favicon, dan manifest PWA berganti; peran lain tidak melihat menunya. Proyek
 * `berurutan`: merek berlaku untuk seluruh organisasi (halaman masuk tes lain), jadi selalu
 * dikembalikan ke bawaan.
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

/** PNG 1×1 sungguhan (server memeriksa isi gambar, lalu membuat favicon & ikon PWA darinya). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function brandingForm(page: Page) {
  await openApp(page, '/pengaturan');
  await page.getByRole('link', { name: /^Merek/ }).click();
  await expect(page).toHaveURL(/\/pengaturan\/merek$/);
  await expect(page.getByLabel('Nama aplikasi')).toBeVisible();
}

test('Owner mengganti merek → halaman masuk, warna, favicon & manifest berganti; lalu kembali ke bawaan', async ({
  page,
  browser,
}) => {
  const name = `Layanan Maju ${String(randomInt(100, 999))}`;
  await brandingForm(page);
  await page.getByLabel('Nama aplikasi').fill(name);
  await page.getByLabel('Nama maskot').fill('Mbak Ayu');
  await page.getByLabel('Kode warna').fill('#1b3557');
  await page.getByTestId('merek-logo-berkas').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });
  await page.getByRole('button', { name: 'Simpan perubahan' }).click();
  await expect(page.getByText('Merek tersimpan.', { exact: false })).toBeVisible();
  await expect(page.getByText(/Logo tersimpan/)).toBeVisible();

  // Warna aksen (tema terang) dan favicon dari logo — tanpa memuat ulang halaman.
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
      ),
    )
    .toBe('#1b3557');
  const favicon = page.locator('link[rel="icon"][data-brand]');
  await expect(favicon).toHaveAttribute('href', /\/branding\/icons\/favicon-32\.png\?v=/);
  const faviconResponse = await page.request.get((await favicon.getAttribute('href')) ?? '');
  expect(faviconResponse.status()).toBe(200);
  expect(faviconResponse.headers()['content-type']).toContain('image/png');

  // Manifest PWA: nama baru, ikon dari logo menggantikan seluruh ikon bawaan.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', /^blob:/);
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href ?? '';
    return (await (await fetch(href)).json()) as {
      name: string;
      icons: { src: string; purpose: string }[];
    };
  });
  expect(manifest.name).toBe(name);
  expect(manifest.icons.length).toBeGreaterThanOrEqual(4);
  for (const icon of manifest.icons) expect(icon.src).toMatch(/\/api\/v1\/branding\/icons\//);
  expect(manifest.icons.map((icon) => icon.purpose)).toContain('maskable');

  // Tamu di halaman masuk melihat merek baru.
  const guest = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const login = await guest.newPage();
    await login.goto('/masuk');
    await expect(login.getByRole('img', { name })).toBeVisible();
    await expect(login).toHaveTitle(new RegExp(name));
  } finally {
    await guest.close();
  }

  // Kembali ke bawaan: kosongkan isian, hapus logo.
  await brandingForm(page);
  await page.getByLabel('Nama aplikasi').fill('');
  await page.getByLabel('Nama maskot').fill('');
  await page.getByLabel('Kode warna').fill('');
  await page.getByRole('button', { name: 'Hapus logo' }).click();
  await page.getByRole('button', { name: 'Simpan perubahan' }).click();
  await expect(page.getByText('Merek tersimpan.', { exact: false })).toBeVisible();
  await expect(page.getByText(/Belum ada logo/)).toBeVisible();
  await expect(page.locator('link[rel="icon"][data-brand]')).toHaveCount(0);
});

test('peran selain Owner tidak melihat menu Merek dan dialihkan dari alamatnya', async ({
  browser,
}) => {
  const cs = await createUser('cs', 'merek');
  const watched = await signIn(browser, cs, false);
  try {
    const { page } = watched;
    await page.goto('/pengaturan');
    await expect(page.getByRole('heading', { level: 1, name: 'Pengaturan' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Merek/ })).toHaveCount(0);
    await page.goto('/pengaturan/merek');
    await expect(page).toHaveURL(/\/pengaturan$/);
    watched.expectClean();
  } finally {
    await watched.close();
  }
});
