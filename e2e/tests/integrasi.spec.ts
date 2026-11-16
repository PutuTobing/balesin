import { randomInt } from 'node:crypto';
import { expect, isHp, openApp, test } from './fixtures';
import { confirmAsOwner } from './identitas';

/**
 * Pengaturan → API key & Webhook melawan stack sungguhan (Fase 3): buat dengan konfirmasi identitas
 * Owner → rahasia tampil SEKALI → hilang setelah ditutup; cabut / event tes / hapus.
 * Desktop saja (konfirmasi identitas memakai kode TOTP Owner bersama).
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.beforeEach(({ page }) => {
  test.skip(isHp(page), 'konfirmasi identitas Owner: sekali (desktop)');
});

test('API key: buat → kunci utuh sekali → cabut', async ({ page }) => {
  const name = `E2E key ${String(randomInt(10_000, 99_999))}`;
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
  await confirmAsOwner(page, 'Buat API key baru?', 'Buat key');

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
  await expect(row.getByText('Dicabut', { exact: true })).toBeVisible();
});

test('Webhook: tambah → rahasia sekali → event tes di riwayat → hapus', async ({ page }) => {
  const url = `https://n8n-${String(randomInt(10_000, 99_999))}.contoh.test/webhook/inbox`;
  await openApp(page, '/pengaturan/webhook');
  await page.getByRole('button', { name: 'Tambah webhook' }).click();
  const form = page.getByRole('dialog', { name: 'Tambah webhook' });
  await form.getByLabel('URL penerima').fill(url);
  await form.getByLabel('Keterangan').fill('Uji E2E');
  await form.getByRole('button', { name: 'Simpan' }).click();
  await confirmAsOwner(page, 'Tambah webhook baru?', 'Simpan');

  const secretDialog = page.getByRole('dialog', { name: 'Salin rahasia webhook sekarang' });
  await expect(secretDialog.locator('code')).toHaveText(/^whsec_/);
  await secretDialog.getByRole('button', { name: 'Sudah saya simpan' }).click();

  const row = page.getByRole('listitem').filter({ hasText: url });
  await expect(row.getByText('Aktif')).toBeVisible();
  await row.getByRole('button', { name: 'Kirim event tes' }).click();
  await expect(row.getByText(/Event tes diantre/)).toBeVisible();
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
});
