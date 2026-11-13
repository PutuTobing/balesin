import { MAILPIT_API_URL, MAILPIT_SMTP } from '../stack/env';
import { expect, expectNoHorizontalScroll, isHp, openApp, test } from './fixtures';

/**
 * Pengaturan → Email pengirim lewat UI dari nol (docs/PENGATURAN-UI.md, DoD tambahan):
 * password salah ditolak, tes koneksi berhasil, simpan, status jadi Terhubung, dan email tes
 * BENAR-BENAR tiba di Mailpit (dicek lewat API Mailpit).
 *
 * Hanya di desktop: pengaturan ini satu per organisasi dan jatah tes (10×/5 menit) dibagi
 * per pengguna, jadi tidak dijalankan dua kali bersamaan.
 */
interface MailpitSearch {
  messages: { Subject: string; To: { Address: string }[] }[];
}

async function findMail(to: string): Promise<MailpitSearch['messages']> {
  const response = await fetch(
    `${MAILPIT_API_URL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  if (!response.ok) throw new Error(`Mailpit menjawab ${response.status}`);
  return ((await response.json()) as MailpitSearch).messages;
}

test('Owner mengatur email pengirim ke Mailpit dan email tes tiba', async ({
  page,
  expectHttpError,
}) => {
  // Port di luar daftar izin ditolak 400 dengan nama isiannya.
  expectHttpError('/api/v1/settings/email/test-connection', 400);
  test.skip(isHp(page), 'Satu kali saja (desktop): pengaturan dan jatah tes dibagi bersama');
  test.setTimeout(120_000);
  const stamp = Date.now();
  const sender = `cs-${stamp}@majujaya.test`;
  const recipient = `penerima-${stamp}@majujaya.test`;

  await openApp(page, '/pengaturan');
  const menu = page.getByRole('link', { name: /Email pengirim/ });
  await expect(menu).toContainText('Belum diatur');
  await menu.click();
  await expect(page).toHaveURL(/\/pengaturan\/email$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Email pengirim' })).toBeVisible();
  await expect(page.getByText('Belum pernah dites')).toBeVisible();

  await page.getByRole('radio', { name: 'Lainnya' }).click();
  await page.getByLabel('Nama pengirim').fill('CS Maju Jaya');
  await page.getByLabel('Alamat email pengirim').fill(sender);
  await page.getByLabel('Host SMTP').fill(MAILPIT_SMTP.host);
  await page.getByLabel('Port').fill(MAILPIT_SMTP.port);
  await page.getByLabel('Keamanan').selectOption({ label: 'Tanpa enkripsi' });
  await page.getByLabel('Username').fill(MAILPIT_SMTP.username);

  // "Tanpa enkripsi" + username → peringatan password terkirim polos.
  const plaintextWarning = page.getByText(/Tanpa enkripsi, password email terkirim tanpa/);
  await expect(plaintextWarning).toBeVisible();
  const result = page.getByRole('region', { name: 'Tes pengaturan' });

  // Host salah, port salah, dan port di luar daftar izin: pesan jelas per kesalahan.
  await page.getByLabel('Password', { exact: true }).fill(MAILPIT_SMTP.password);
  await page.getByLabel('Host SMTP').fill('smtp.tidak-ada.invalid');
  await page.getByRole('button', { name: 'Tes koneksi' }).click();
  await expect(result.getByText(/Server email tidak ditemukan/)).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Host SMTP').fill(MAILPIT_SMTP.host);
  await page.getByLabel('Port').fill('2525');
  await page.getByRole('button', { name: 'Tes koneksi' }).click();
  await expect(result.getByText(/Server menolak sambungan di port ini/)).toBeVisible({
    timeout: 20_000,
  });
  await page.getByLabel('Port').fill('2526');
  await page.getByRole('button', { name: 'Tes koneksi' }).click();
  await expect(page.getByLabel('Port')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText(/Port ini tidak didukung/)).toBeVisible();
  await page.getByLabel('Port').fill(MAILPIT_SMTP.port);

  // Password salah → pesan server berbahasa Indonesia.
  await page.getByLabel('Password', { exact: true }).fill('password-salah');
  await page.getByRole('button', { name: 'Tes koneksi' }).click();
  await expect(page.getByText(/Username atau password ditolak server email/)).toBeVisible({
    timeout: 20_000,
  });

  await page.getByLabel('Password', { exact: true }).fill(MAILPIT_SMTP.password);
  await page.getByRole('button', { name: 'Tes koneksi' }).click();
  await expect(page.getByText(/Berhasil terhubung ke server email/)).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByText('Pengaturan email tersimpan.')).toBeVisible();
  await expect(page.getByText('Diatur di aplikasi')).toBeVisible();
  // Password tidak dikirim balik; kolom kosong dengan petunjuk "Tersimpan".
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByText(/Tersimpan.*Kosongkan untuk tetap memakai/)).toBeVisible();

  // Tes pengaturan tersimpan → status tercatat Terhubung beserta waktu tesnya.
  await page.getByRole('button', { name: 'Tes koneksi' }).click();
  const status = page.getByRole('term').filter({ hasText: 'Status' }).locator('..');
  await expect(status).toContainText('Terhubung', { timeout: 20_000 });
  await expect(
    page.getByRole('term').filter({ hasText: 'Tes terakhir' }).locator('..'),
  ).toContainText(/Hari ini, \d{2}\.\d{2}/);

  // Kirim email tes ke alamat unik, lalu pastikan benar-benar tiba di Mailpit.
  await page.getByLabel('Kirim email tes ke').fill(recipient);
  await page.getByRole('button', { name: 'Kirim email tes' }).click();
  await expect(page.getByText(`Email tes terkirim ke ${recipient}.`, { exact: false })).toBeVisible(
    {
      timeout: 20_000,
    },
  );
  await expect
    .poll(async () => (await findMail(recipient)).length, { timeout: 20_000 })
    .toBeGreaterThan(0);

  // Simpan lagi tanpa mengubah password (hanya nama pengirim): password tersimpan tetap dipakai.
  await page.getByLabel('Nama pengirim').fill('CS Maju Jaya Baru');
  await page.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByText('Pengaturan email tersimpan.')).toBeVisible();
  await expect(page.getByLabel('Nama pengirim')).toHaveValue('CS Maju Jaya Baru');
  await page.getByRole('button', { name: 'Tes koneksi' }).click();
  await expect(result.getByText(/Berhasil terhubung ke server email/)).toBeVisible({
    timeout: 20_000,
  });

  // Ganti host tanpa mengisi password → diminta memasukkan ulang password.
  await page.getByLabel('Host SMTP').fill('127.0.0.1');
  await page.getByRole('button', { name: 'Simpan' }).click();
  await expect(
    page.getByText(
      'Host, port, keamanan, atau username berubah, jadi password perlu dimasukkan ulang.',
    ),
  ).toBeVisible();

  // Menu di Pengaturan ikut menampilkan status terbaru.
  await page.getByRole('link', { name: 'Kembali ke Pengaturan' }).click();
  await expect(page.getByRole('link', { name: /Email pengirim/ })).toContainText('Terhubung');
});

test('HP: form email pengirim muat di 390px dan menandai isian salah sebelum dikirim', async ({
  page,
}) => {
  test.skip(!isHp(page), 'Khusus HP; alur lengkap (simpan & tes) dijalankan sekali di desktop');
  // Tidak menyimpan dan tidak menjalankan tes: aman berjalan bersamaan dengan tes desktop.
  let writes = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/settings/email') && request.method() !== 'GET') writes += 1;
  });
  await openApp(page, '/pengaturan/email');
  await expect(page.getByRole('heading', { level: 1, name: 'Email pengirim' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  // Panduan tertutup di HP, bisa dibuka.
  const guide = page.locator('details').filter({ hasText: 'Panduan singkat' });
  await expect(guide).not.toHaveAttribute('open', '');
  await guide.getByText('Panduan singkat').click();
  await expect(guide.getByText(/Pilih penyedia emailmu/)).toBeVisible();

  await page.getByLabel('Host SMTP').fill('');
  await page.getByLabel('Port').fill('abc');
  await page.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByText('Host SMTP wajib diisi.')).toBeVisible();
  await expect(page.getByText('Port wajib diisi dengan angka.')).toBeVisible();
  await expect(page.getByLabel('Host SMTP')).toHaveAttribute('aria-invalid', 'true');

  await page.getByLabel('Keamanan').selectOption({ label: 'Tanpa enkripsi' });
  await page.getByLabel('Username').fill('pengguna');
  await expect(page.getByText(/Tanpa enkripsi, password email terkirim tanpa/)).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(writes).toBe(0);
});
