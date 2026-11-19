import { expect, isHp, openApp, test } from './fixtures';

/**
 * Pengaturan → Channel: bagian "Channel lain" (Telegram, Email, Messenger, Instagram) melawan stack
 * sungguhan. Stack E2E belum punya Telegram Bot API / IMAP tiruan, jadi tes ini berhenti sebelum
 * kredensial dikirim: daftar jenis dari server, wizard, dan validasi di browser (tanpa permintaan
 * ke server). Alur buat/tes/hapus dicakup tes komponen (`Connections.test.tsx`).
 */
test('kartu jenis channel dari server + validasi wizard Telegram & Email', async ({ page }) => {
  await openApp(page, '/pengaturan/channel');
  const add = page.getByRole('heading', { name: 'Tambah channel' });
  await expect(add).toBeVisible();
  for (const label of ['Telegram', 'Email', 'Messenger', 'Instagram']) {
    await expect(page.getByRole('link', { name: new RegExp(`Hubungkan ${label}`) })).toBeVisible();
  }
  await expect(page.getByText('Butuh App Review Meta').first()).toBeVisible();

  await page.getByRole('link', { name: /Hubungkan Telegram/ }).click();
  await expect(page.getByRole('heading', { name: 'Hubungkan Telegram' })).toBeVisible();
  await page.getByLabel('Nama channel').fill('Bot CS E2E');
  await page.getByLabel('Token bot').fill('bukan-token');
  await page.getByRole('button', { name: 'Hubungkan', exact: true }).click();
  await expect(page.getByText(/Token bot tidak valid/)).toBeVisible();
  // Token tidak pernah jadi atribut DOM.
  await expect(page.getByLabel('Token bot')).not.toHaveAttribute('value', /.+/);

  await page.goto('/pengaturan/channel/baru/email');
  await expect(page.getByRole('heading', { name: 'Hubungkan Email' })).toBeVisible();
  await page.getByLabel('Nama channel').fill('Email CS E2E');
  await page.getByLabel('Host IMAP').fill('http://mail.contoh.id/');
  await page.getByRole('button', { name: 'Hubungkan', exact: true }).click();
  await expect(page.getByText(/Host IMAP tidak valid/)).toBeVisible();
  if (isHp(page)) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
