import { expect, isHp, openApp, test } from './fixtures';

/**
 * Notifikasi + PWA melawan stack sungguhan (Fase 2 butir 10). Berlangganan Web Push sungguhan butuh
 * layanan push browser (FCM) — tidak tersedia di CI; alur izin/berlangganan diuji di tes komponen.
 * Di sini: service worker terpasang, manifest dilayani, preferensi tersimpan di server.
 */
test.describe.configure({ mode: 'serial' });

test('service worker terpasang dan manifest PWA dilayani', async ({ page }) => {
  await openApp(page, '/inbox');
  const active = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.scriptURL ?? null;
  });
  expect(active).toMatch(/\/sw\.js$/);
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const manifest = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return (await response.json()) as { display: string; start_url: string; icons: unknown[] };
  }, href ?? '/manifest.webmanifest');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toMatch(/\/inbox$/);
  expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
});

test('preferensi notifikasi tersimpan (jam tenang), lalu dikembalikan', async ({ page }) => {
  test.skip(isHp(page), 'preferensi per pengguna: cukup sekali (desktop)');
  await openApp(page, '/pengaturan');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Notifikasi/ })
    .click();
  await expect(page).toHaveURL(/\/pengaturan\/notifikasi$/);
  await expect(page.getByRole('heading', { level: 2, name: 'Perangkat ini' })).toBeVisible();

  const quiet = page.getByRole('checkbox', { name: /^Jam tenang/ });
  await quiet.check();
  await page.getByLabel('Mulai').fill('22:00');
  await page.getByLabel('Selesai').fill('06:30');
  await page.getByRole('button', { name: 'Simpan preferensi' }).click();
  await expect(page.getByText('Preferensi notifikasi disimpan.')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('checkbox', { name: /^Jam tenang/ })).toBeChecked();
  await expect(page.getByLabel('Mulai')).toHaveValue('22:00');

  await page.getByRole('checkbox', { name: /^Jam tenang/ }).uncheck();
  await page.getByRole('button', { name: 'Simpan preferensi' }).click();
  await expect(page.getByText('Preferensi notifikasi disimpan.')).toBeVisible();
});

test('Owner: isi notifikasi organisasi bawaan mati, bisa diubah dan dikembalikan', async ({
  page,
}) => {
  test.skip(isHp(page), 'pengaturan organisasi: cukup sekali (desktop)');
  await openApp(page, '/pengaturan/notifikasi');
  const card = page.getByRole('region', { name: 'Isi notifikasi di organisasi' });
  const contactName = card.getByRole('checkbox', { name: /^Tampilkan nama kontak/ });
  await expect(contactName).not.toBeChecked();
  await contactName.check();
  await card.getByRole('button', { name: 'Simpan pengaturan organisasi' }).click();
  await expect(card.getByText('Pengaturan notifikasi organisasi disimpan.')).toBeVisible();
  await contactName.uncheck();
  await card.getByRole('button', { name: 'Simpan pengaturan organisasi' }).click();
  await expect(card.getByText('Pengaturan notifikasi organisasi disimpan.')).toBeVisible();
});
