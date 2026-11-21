import type { Page } from '@playwright/test';
import { expect, expectNoHorizontalScroll, openApp, test } from './fixtures';
import { confirmAsOwner } from './identitas';
import { expectNoTokenInUrl, openWatchedPage } from './konteks';
import { totpAtStep, totpStep } from './two-factor';

/**
 * Pengaturan → Tim TANPA email pengirim (keadaan organisasi setelah `alur-awal`): tautan undangan
 * tampil sekali untuk disalin, penerima membuat akun dari tautan itu.
 *
 * Proyek `tanpa-email` berjalan SEBELUM proyek desktop/HP (email pengirim baru diatur di
 * `email-pengirim.spec.ts`), satu per satu (serial), di 1440 px; penerima CS memakai HP 390 px.
 */
// Konfirmasi identitas Owner memakai kode TOTP sekali pakai: bisa menunggu langkah 30 detik berikutnya.
test.describe.configure({ mode: 'serial', timeout: 90_000 });

const stamp = Date.now().toString(36);
const CS_EMAIL = `citra-${stamp}@majujaya.test`;
const ADMIN_EMAIL = `agus-${stamp}@majujaya.test`;
const PASSWORD = 'Teh-Manis-Hangat-77';

/** Tautan undangan dari dialog sekali tampil (diisi tes pertama). */
const links: { cs?: string; admin?: string } = {};

async function inviteAndReadLink(page: Page, email: string, role: string): Promise<string> {
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Peran').selectOption({ label: role });
  await page.getByRole('button', { name: 'Buat tautan undangan' }).click();
  await confirmAsOwner(page, 'Buat tautan undangan ini?', 'Buat tautan undangan');
  const dialog = page.getByRole('dialog', { name: 'Salin tautan undangan' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Kirim tautan ini sendiri ke ${email}`);
  await expect(dialog.getByText('Tautan ini setara kunci akses')).toBeVisible();
  const link = ((await dialog.locator('code').textContent()) ?? '').trim();
  expect(link).toMatch(/^http:\/\/localhost:\d+\/undangan#token=[A-Za-z0-9_-]{43}$/);

  // Salin → clipboard berisi tautan yang sama → "Selesai" menutup tanpa peringatan.
  await dialog.getByRole('button', { name: 'Salin tautan' }).click();
  await expect(dialog.getByRole('button', { name: 'Tersalin' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await dialog.getByRole('button', { name: 'Selesai' }).click();
  await expect(dialog).toBeHidden();
  // Fokus kembali ke isian email (bukan <body>).
  await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
  return link;
}

test('Owner mengundang CS dan Admin tanpa email pengirim: tautan tampil sekali untuk disalin', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openApp(page, '/pengaturan');
  const menu = page.getByRole('link', { name: /^Tim/ });
  await expect(menu).toContainText('1 anggota · belum ada undangan terbuka');
  await menu.click();
  await expect(page).toHaveURL(/\/pengaturan\/tim$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Tim' })).toBeVisible();
  await expect(page.getByText(/Email pengirim belum diatur, jadi tautan undangan/)).toBeVisible();
  // Owner: semua peran kecuali Owner.
  await expect(page.getByLabel('Peran').locator('option')).toHaveText([
    'Admin',
    'Supervisor',
    'CS',
    'Teknisi',
  ]);

  links.cs = await inviteAndReadLink(page, CS_EMAIL, 'CS');
  const csRow = page.getByRole('listitem', { name: `Undangan untuk ${CS_EMAIL}` });
  await expect(csRow).toContainText('Tautan disalin manual');

  // Tutup tanpa menyalin → peringatan "belum disalin" dulu.
  await page.getByLabel('Email', { exact: true }).fill(ADMIN_EMAIL);
  await page.getByLabel('Peran').selectOption({ label: 'Admin' });
  await page.getByRole('button', { name: 'Buat tautan undangan' }).click();
  await confirmAsOwner(page, 'Buat tautan undangan ini?', 'Buat tautan undangan');
  const dialog = page.getByRole('dialog', { name: 'Salin tautan undangan' });
  links.admin = ((await dialog.locator('code').textContent()) ?? '').trim();
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('alert')).toContainText('Tautan belum disalin');
  await dialog.getByRole('button', { name: 'Tutup tanpa menyalin' }).click();
  await expect(dialog).toBeHidden();

  // Tautan tidak pernah disimpan browser dan tidak tampil lagi setelah dimuat ulang.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain('token');
  await page.reload();
  await expect(page.getByRole('listitem', { name: `Undangan untuk ${ADMIN_EMAIL}` })).toBeVisible();
  await expect(page.getByText(/#token=/)).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test('CS menerima undangan di HP: masuk ke aplikasi, tanpa menu Tim, email belum terverifikasi', async ({
  browser,
}) => {
  test.skip(!links.cs, 'butuh tautan dari tes sebelumnya');
  const guest = await openWatchedPage(browser, { hp: true });
  const { page } = guest;
  guest.allow('/api/v1/auth/me', 401);
  try {
    await page.goto(links.cs ?? '');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Bergabung dengan PT Maju Jaya' }),
    ).toBeVisible();
    // Token langsung dibuang dari alamat (riwayat browser tidak menyimpannya).
    await expectNoTokenInUrl(page);
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue(CS_EMAIL);
    // Tamu: tidak ada peringatan "sedang masuk sebagai …".
    await expect(page.getByText(/Kamu sedang masuk sebagai/)).toHaveCount(0);
    await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('readonly', '');
    await expect(page.getByText(/sebagai CS di /)).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.getByLabel('Nama lengkap').fill('Citra Maharani');
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Ulangi password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Buat akun' }).click();
    await expect(page).toHaveURL(/\/inbox$/);

    // CS tidak melihat menu Tim dan tidak bisa membukanya lewat alamat.
    await page.goto('/pengaturan');
    await expect(page.getByRole('heading', { level: 1, name: 'Pengaturan' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Tim/ })).toHaveCount(0);
    await page.goto('/pengaturan/tim');
    await expect(page).toHaveURL(/\/pengaturan$/);

    // Akun dari tautan yang disalin manual belum dianggap email-terverifikasi.
    await page.goto('/pengaturan/keamanan');
    const card = page.getByRole('region', { name: 'Email akun' });
    await expect(card).toContainText('Belum diverifikasi');
    await expect(card).toContainText('email pengirim belum diatur');

    // Tautan yang sama dibuka lagi → layar penjelasan (410), bukan form.
    guest.allow('/api/v1/auth/invitation/inspect', 410);
    await page.goto(links.cs ?? '');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Undangan tidak bisa dipakai' }),
    ).toBeVisible();
    await expect(page.getByLabel('Nama lengkap')).toHaveCount(0);
    await expectNoTokenInUrl(page);

    // Masih masuk sebagai CS lalu membuka undangan lain: peringatan + keluar dulu di tempat.
    await page.goto(links.admin ?? '');
    const warning = page.getByText('Kamu sedang masuk sebagai Citra Maharani');
    await expect(warning).toBeVisible();
    await expect(page.getByText(/Menerima undangan akan mengeluarkanmu/)).toBeVisible();
    await page.getByRole('button', { name: 'Keluar dulu' }).click();
    await expect(page.getByText(/Kamu sudah keluar dari akun sebelumnya/)).toBeVisible();
    await expect(page).toHaveURL(/\/undangan$/);
    await expect(page.getByLabel('Nama lengkap')).toBeEnabled();
    guest.expectClean();
  } finally {
    await guest.close();
  }
});

test('Admin menerima undangan: wajib daftar 2FA dulu, lalu tidak bisa mengundang Admin', async ({
  browser,
}) => {
  test.skip(!links.admin, 'butuh tautan dari tes pertama');
  const guest = await openWatchedPage(browser);
  const { page } = guest;
  guest.allow('/api/v1/auth/me', 401);
  try {
    await page.goto(links.admin ?? '');
    await expect(page.getByText(/Peran Admin wajib verifikasi dua langkah/)).toBeVisible();
    await page.getByLabel('Nama lengkap').fill('Agus Pratama');
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await page.getByLabel('Ulangi password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Buat akun' }).click();

    // Sesi terbatas: langsung ke pendaftaran 2FA; halaman aplikasi belum bisa dibuka.
    await expect(page).toHaveURL(/\/verifikasi-dua-langkah$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Aktifkan verifikasi dua langkah' }),
    ).toBeVisible();
    const addStep = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Tambahkan akunmu ke aplikasi' }) });
    const secret = ((await addStep.locator('code').textContent()) ?? '').replace(/\s/g, '');
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    await page.getByLabel('Kode 6 digit').fill(totpAtStep(secret, totpStep()));
    await page.getByRole('button', { name: 'Aktifkan', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Simpan kode cadangan' }),
    ).toBeVisible();
    await page
      .getByRole('checkbox', { name: 'Saya sudah menyimpan kode ini di tempat yang aman' })
      .check();
    await page.getByRole('button', { name: 'Lanjut ke Inbox' }).click();
    await expect(page).toHaveURL(/\/inbox$/);

    // Admin memegang izin team.invite dan settings.email.manage: melihat Tim dan Email pengirim,
    // tetapi tidak bisa memilih Admin di form undangan.
    await page.goto('/pengaturan');
    await expect(page.getByRole('link', { name: /Email pengirim/ })).toBeVisible();
    await page.getByRole('link', { name: /^Tim/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tim' })).toBeVisible();
    await expect(page.getByLabel('Peran').locator('option')).toHaveText([
      'Supervisor',
      'CS',
      'Teknisi',
    ]);
    guest.expectClean();
  } finally {
    await guest.close();
  }
});

test('lupa password tanpa email pengirim: penjelasan tanpa form', async ({ browser }) => {
  const guest = await openWatchedPage(browser);
  const { page } = guest;
  guest.allow('/api/v1/auth/me', 401);
  try {
    await page.goto('/masuk');
    await page.getByRole('link', { name: 'Lupa password?' }).click();
    await expect(page).toHaveURL(/\/lupa-password$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Atur ulang password belum tersedia' }),
    ).toBeVisible();
    await expect(page.getByLabel('Email')).toHaveCount(0);
    await page.getByRole('link', { name: 'Kembali ke halaman masuk' }).click();
    await expect(page).toHaveURL(/\/masuk$/);
    guest.expectClean();
  } finally {
    await guest.close();
  }
});
