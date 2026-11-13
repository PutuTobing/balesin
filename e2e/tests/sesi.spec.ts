import { readFileSync } from 'node:fs';
import { request, type BrowserContext, type Page } from '@playwright/test';
import { OWNER_STATE_PATH } from '../stack/env';
import { expect, isHp, mainNav, owner, submitLogin, test } from './fixtures';

/**
 * Sesi di tengah pemakaian, di HP dan desktop: sesi dicabut server, token CSRF tidak berlaku,
 * tombol Back/Forward setelah keluar, dan hitung mundur saat terkunci.
 *
 * Setiap tes masuk sendiri (sesi terpisah) supaya mencabut sesi tidak mengganggu tes lain yang
 * memakai sesi Owner bersama. Cookie "perangkat dikenal" dari alur awal ikut dipasang: akun Owner
 * sengaja dikunci untuk perangkat baru dari IP ini oleh `alur-awal`, perangkat dikenal tidak.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const ME = '/api/v1/auth/me';

async function signInFresh(context: BrowserContext, page: Page, path: string) {
  const state = JSON.parse(readFileSync(OWNER_STATE_PATH, 'utf8')) as {
    cookies: Parameters<BrowserContext['addCookies']>[0];
  };
  await context.addCookies(state.cookies.filter((cookie) => cookie.name.endsWith('_device')));
  await page.goto(path);
  await expect(page).toHaveURL(/\/masuk\?redirect=/);
  await submitLogin(page, owner.email, owner.password);
  await expect(page.getByRole('heading', { level: 1, name: 'Pengaturan' })).toBeVisible();
}

/** Cabut sesi browser ini dari luar (seperti keluar di perangkat lain / dicabut admin). */
async function revokeFromElsewhere(context: BrowserContext, baseURL: string) {
  const other = await request.newContext({
    baseURL,
    storageState: await context.storageState(),
    extraHTTPHeaders: { origin: baseURL },
  });
  const me = (await (await other.get(ME)).json()) as { csrfToken: string };
  const response = await other.post('/api/v1/auth/logout', {
    headers: { 'x-csrf-token': me.csrfToken },
  });
  expect(response.ok()).toBe(true);
  await other.dispose();
}

test('sesi dicabut di tengah pemakaian → halaman masuk dengan pesan, tanpa layar error', async ({
  page,
  context,
  baseURL,
  expectHttpError,
}) => {
  expectHttpError(ME, 401);
  expectHttpError('/api/v1/settings/email', 401);
  expectHttpError('/api/v1/settings/email/detect-host', 401);
  await signInFresh(context, page, '/pengaturan');
  // Catat setiap judul halaman yang sempat tampil, untuk menangkap kedipan layar error.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __h1: string[] }).__h1 = seen;
    new MutationObserver(() => {
      for (const h1 of document.querySelectorAll('h1')) seen.push(h1.textContent ?? '');
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });

  await revokeFromElsewhere(context, baseURL ?? '');
  // Data yang masih segar (< 30 detik) boleh tampil dari cache; permintaan berikutnya ke API
  // (di sini deteksi server email saat alamat pengirim diketik) yang menemukan sesi berakhir.
  await page.getByRole('link', { name: /Email pengirim/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Email pengirim' })).toBeVisible();
  await page.getByLabel('Alamat email pengirim').fill(`sesi-${Date.now()}@contoh-sesi.test`);

  await expect(page).toHaveURL(/\/masuk\?redirect=%2Fpengaturan%2Femail$/);
  await expect(page.getByRole('status')).toContainText(
    'Sesimu sudah berakhir. Masuk lagi untuk melanjutkan.',
  );
  const seen = await page.evaluate(() => (window as unknown as { __h1: string[] }).__h1);
  expect(seen).not.toContain('Halaman ini gagal dimuat');

  // Masuk lagi → kembali ke tujuan semula.
  await submitLogin(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/pengaturan\/email$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Email pengirim' })).toBeVisible();
});

test('token CSRF ditolak → diambil ulang dari /auth/me dan permintaan diulang sekali', async ({
  page,
  context,
  expectHttpError,
}) => {
  expectHttpError(ME, 401);
  expectHttpError('/api/v1/auth/logout', 403);
  await signInFresh(context, page, '/pengaturan');

  // Token di memori dianggap hilang/kedaluwarsa: kirim pertama tanpa header CSRF.
  let attempts = 0;
  await page.route('**/api/v1/auth/logout', async (route) => {
    attempts += 1;
    const headers = { ...route.request().headers() };
    if (attempts === 1) delete headers['x-csrf-token'];
    await route.continue({ headers });
  });
  // Satu halaman aplikasi lagi di riwayat, supaya Back setelah keluar menuju halaman aplikasi.
  await mainNav(page).getByRole('link', { name: 'Inbox', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  if (isHp(page)) {
    await mainNav(page).getByRole('link', { name: 'Lainnya' }).click();
    await page.getByRole('button', { name: 'Keluar' }).click();
  } else {
    await mainNav(page)
      .getByRole('button', { name: `Akun ${owner.name}` })
      .click();
    await page.getByRole('menuitem', { name: 'Keluar' }).click();
  }
  await expect(page.getByText('Kamu sudah keluar. Sampai jumpa lagi!')).toBeVisible();
  expect(attempts).toBe(2);
  await expect(page.getByText('Gagal keluar')).toHaveCount(0);

  // Back/Forward setelah keluar: tidak ada data aplikasi dari cache, selalu halaman masuk.
  await page.goBack();
  await expect(page).toHaveURL(/^http.*\/masuk/);
  await expect(page.getByRole('heading', { level: 1, name: /^Masuk ke / })).toBeVisible();
  await expect(mainNav(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Pengaturan' })).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: /^Masuk ke / })).toBeVisible();
  await expect(mainNav(page)).toHaveCount(0);
  // Sesi memang sudah dicabut di server.
  const me = await page.request.get(ME);
  expect(me.status()).toBe(401);
});

test('terkunci: tombol Masuk mati, hitung mundur berjalan, lalu aktif lagi', async ({
  page,
  expectHttpError,
}) => {
  expectHttpError(ME, 401);
  expectHttpError('/api/v1/auth/login', 401);
  expectHttpError('/api/v1/auth/login', 429);
  await page.clock.install();
  await page.goto('/masuk');
  // Email tidak terdaftar (diperlakukan sama persis dengan akun sungguhan), unik per proyek.
  const email = `kunci-${isHp(page) ? 'hp' : 'desktop'}@majujaya.test`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await submitLogin(page, email, `salah-${attempt}`);
    await expect(page.getByRole('alert')).toContainText('Email atau password salah');
  }
  await submitLogin(page, email, 'salah-5');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Masuk dikunci sementara');
  // Hitung mundur pindah ke label tombol nonaktif; tidak ada angka berjalan di role="alert".
  await expect(alert).not.toContainText(/\d[.:]\d{2}/);
  const submit = page.locator('form button[type="submit"]');
  // Format `m:ss` (titik dua): "15.00" terbaca sebagai jam.
  await expect(submit).toHaveAccessibleName(/^Coba lagi dalam 1[45]:[0-5]\d$/);
  await expect(submit).toBeDisabled();
  // Gaya terkunci: tidak dipudarkan, label sisa waktu tetap terbaca (kritikus W6).
  await expect(submit).toHaveAttribute('data-locked', '');
  await expect(submit).toHaveCSS('opacity', '1');
  // Fokus tidak jatuh ke <body>: kembali ke isian password yang tetap aktif.
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  // Enter di isian password juga tidak mengirim apa pun selama terkunci.
  let sent = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/api/v1/auth/login')) sent += 1;
  });
  await page.getByLabel('Password', { exact: true }).press('Enter');

  await page.clock.fastForward('14:30');
  await expect(submit).toHaveAccessibleName(/^Coba lagi dalam 0:[0-5]\d$/);
  await expect(submit).toBeDisabled();
  await page.clock.fastForward('01:00');
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveAccessibleName('Masuk');
  await expect(submit).not.toHaveAttribute('data-locked');
  // Pesan kunci yang basi hilang; pembaca layar diberi tahu sekali lewat wilayah status.
  await expect(alert).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: 'Kamu sudah bisa mencoba masuk lagi.' }),
  ).toHaveCount(1);
  expect(sent).toBe(0);
});
