import { randomInt } from 'node:crypto';
import { expect, isHp, openApp, test } from './fixtures';
import { confirmAsSecondOwner, createSecondOwner, signInSecondOwner } from './owner-kedua';

/**
 * Pengaturan → API key & Webhook melawan stack sungguhan (Fase 3): buat dengan konfirmasi identitas
 * Owner → rahasia tampil SEKALI → hilang setelah ditutup; cabut / kejadian tes / hapus.
 * Desktop saja. Konfirmasi identitas memakai Owner KEDUA milik tes ini (kode cadangannya sendiri),
 * bukan kode TOTP Owner utama yang diantre bersama tes lain.
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.beforeEach(({ page }) => {
  test.skip(isHp(page), 'konfirmasi identitas Owner: sekali (desktop)');
});

test('API key: buat → kunci utuh sekali → cabut', async ({ browser }) => {
  const name = `E2E key ${String(randomInt(10_000, 99_999))}`;
  const owner = await createSecondOwner('apikey');
  const watched = await signInSecondOwner(browser, owner);
  const { page } = watched;
  await openApp(page, '/pengaturan');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^API key/ })
    .click();
  await expect(page).toHaveURL(/\/pengaturan\/api-key$/);
  await page.getByRole('button', { name: 'Buat API key' }).click();
  const form = page.getByRole('dialog', { name: 'Buat API key' });
  await form.getByLabel('Nama', { exact: true }).fill(name);
  await form.getByRole('button', { name: 'Buat key' }).click();
  await confirmAsSecondOwner(page, owner, 'Buat API key baru?', 'Buat key');

  const secretDialog = page.getByRole('dialog', { name: 'Salin API key sekarang' });
  const secret = await secretDialog.locator('code').textContent();
  expect(secret).toMatch(/^blsn_live_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  await secretDialog.getByRole('button', { name: 'Sudah saya simpan' }).click();
  await expect(page.getByText(secret ?? '')).toHaveCount(0);

  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row.getByText('Aktif')).toBeVisible();
  await row.getByRole('button', { name: `Cabut ${name}` }).click();
  await page
    .getByRole('dialog', { name: `Cabut API key ${name}?` })
    .getByRole('button', { name: 'Cabut key' })
    .click();
  await expect(page.getByText(`API key ${name} dicabut.`)).toBeVisible();
  // Key dicabut pindah ke bagian lipatan "Dicabut & kedaluwarsa".
  await page.getByText(/^Dicabut & kedaluwarsa/).click();
  await expect(
    page.getByRole('listitem').filter({ hasText: name }).getByText('Dicabut', { exact: true }),
  ).toBeVisible();
  watched.expectClean();
  await watched.close();
});

test('Webhook: tambah → rahasia sekali → kejadian tes di riwayat → hapus', async ({ browser }) => {
  const url = `https://n8n-${String(randomInt(10_000, 99_999))}.contoh.test/webhook/inbox`;
  const owner = await createSecondOwner('webhook');
  const watched = await signInSecondOwner(browser, owner);
  const { page } = watched;
  await page.goto('/pengaturan/webhook');
  await page.getByRole('button', { name: 'Buat webhook' }).click();
  const form = page.getByRole('dialog', { name: 'Buat webhook' });
  await form.getByLabel('URL penerima').fill(url);
  await form.getByLabel('Keterangan').fill('Uji E2E');
  await form.getByRole('button', { name: 'Simpan' }).click();
  await confirmAsSecondOwner(page, owner, 'Buat webhook baru?', 'Simpan');

  const secretDialog = page.getByRole('dialog', { name: 'Salin rahasia webhook sekarang' });
  await expect(secretDialog.locator('code')).toHaveText(/^whsec_/);
  await secretDialog.getByRole('button', { name: 'Sudah saya simpan' }).click();

  const row = page.getByRole('listitem').filter({ hasText: url });
  await expect(row.getByText('Aktif')).toBeVisible();
  await row.getByRole('button', { name: 'Kirim kejadian tes' }).click();
  await expect(row.getByText(/Kejadian tes diantre/)).toBeVisible();
  await row.getByRole('button', { name: 'Riwayat' }).click();
  const history = page.getByRole('dialog', { name: 'Riwayat pengiriman' });
  await expect(history.getByText('webhook.test')).toBeVisible();
  await history.getByRole('button', { name: 'Tutup' }).last().click();

  await row.getByRole('button', { name: 'Tindakan lain' }).click();
  await page.getByRole('menuitem', { name: 'Hapus' }).click();
  await page
    .getByRole('dialog', { name: 'Hapus webhook ini?' })
    .getByRole('button', { name: 'Hapus webhook' })
    .click();
  await expect(page.getByText('Webhook dihapus.')).toBeVisible();
  await expect(page.getByText(url)).toHaveCount(0);
  watched.expectClean();
  await watched.close();
});

test('Webhook MobiChat: key ditempel utuh → kartu ••••akhir, key tidak pernah tampil; rotasi cabut rahasia lama', async ({
  browser,
}) => {
  const owner = await createSecondOwner('mobichat');
  const watched = await signInSecondOwner(browser, owner);
  const { page } = watched;
  const keyName = `E2E mobichat ${String(randomInt(10_000, 99_999))}`;

  // API key khusus bot.
  await page.goto('/pengaturan/api-key');
  await page.getByRole('button', { name: 'Buat API key' }).click();
  const form = page.getByRole('dialog', { name: 'Buat API key' });
  await form.getByLabel('Nama', { exact: true }).fill(keyName);
  await form.getByRole('button', { name: 'Buat key' }).click();
  await confirmAsSecondOwner(page, owner, 'Buat API key baru?', 'Buat key');
  const secretDialog = page.getByRole('dialog', { name: 'Salin API key sekarang' });
  const key = (await secretDialog.locator('code').textContent()) ?? '';
  await secretDialog.getByRole('button', { name: 'Sudah saya simpan' }).click();

  // Webhook format MobiChat dengan key itu.
  const url = `https://n8n-${String(randomInt(10_000, 99_999))}.contoh.test/webhook/ulan`;
  await page.goto('/pengaturan/webhook');
  await page.getByRole('button', { name: 'Buat webhook' }).click();
  const hookForm = page.getByRole('dialog', { name: 'Buat webhook' });
  await hookForm.getByRole('radio', { name: 'MobiChat' }).click();
  await expect(
    hookForm.getByText('Mode MobiChat hanya mengirim pesan masuk dari pelanggan.'),
  ).toBeVisible();
  await hookForm.getByLabel('URL penerima').fill(url);
  await hookForm.getByLabel(/^API key untuk alur n8n/).fill(key);
  await hookForm.getByRole('button', { name: 'Simpan' }).click();
  await confirmAsSecondOwner(page, owner, 'Buat webhook baru?', 'Simpan');
  await page
    .getByRole('dialog', { name: 'Salin rahasia webhook sekarang' })
    .getByRole('button', { name: 'Sudah saya simpan' })
    .click();

  const row = page.getByRole('listitem').filter({ hasText: url });
  await expect(row.getByText('MobiChat', { exact: true })).toBeVisible();
  await expect(row.getByText(new RegExp(`API key ••••${key.slice(-4)} · aktif`))).toBeVisible();
  await expect(page.locator('body')).not.toContainText(key);

  // Rotasi dengan "Cabut rahasia lama sekarang".
  await row.getByRole('button', { name: 'Tindakan lain' }).click();
  await page.getByRole('menuitem', { name: 'Buat rahasia baru' }).click();
  const options = page.getByRole('dialog', { name: 'Buat rahasia webhook baru' });
  await options.getByRole('checkbox', { name: /Cabut rahasia lama sekarang/ }).check();
  await options.getByRole('button', { name: 'Buat rahasia baru' }).click();
  await confirmAsSecondOwner(page, owner, 'Buat rahasia webhook baru?', 'Buat rahasia baru');
  await page
    .getByRole('dialog', { name: 'Salin rahasia webhook sekarang' })
    .getByRole('button', { name: 'Sudah saya simpan' })
    .click();
  await expect(row.getByText(/Rahasia lama masih ikut ditandatangani/)).toHaveCount(0);

  await row.getByRole('button', { name: 'Tindakan lain' }).click();
  await page.getByRole('menuitem', { name: 'Hapus' }).click();
  await page
    .getByRole('dialog', { name: 'Hapus webhook ini?' })
    .getByRole('button', { name: 'Hapus webhook' })
    .click();
  await expect(page.getByText('Webhook dihapus.')).toBeVisible();
  watched.expectClean();
  await watched.close();
});
