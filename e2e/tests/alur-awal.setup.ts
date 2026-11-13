import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { E2E_SETUP_TOKEN, MAILPIT_SMTP, OWNER_STATE_PATH } from '../stack/env';
import { expect, mainNav, owner, submitLogin, test } from './fixtures';

/**
 * Alur utama Fase 1 melawan API sungguhan, dari instalasi kosong (database & Redis direset
 * oleh `stack/start-backend.mjs`):
 *   setup dari nol → masuk otomatis → keluar → masuk lagi (kembali ke tujuan awal) →
 *   open redirect ditolak → password salah → akun terkunci setelah 5 kali.
 *
 * Sesi Owner disimpan ke `OWNER_STATE_PATH` SEBELUM akun dikunci, lalu dipakai proyek
 * `desktop-1440` dan `hp-390` (sesi yang sudah ada tetap berlaku saat akun terkunci).
 */
const ME = '/api/v1/auth/me';
const LOGIN = '/api/v1/auth/login';

test.describe.configure({ mode: 'serial' });

test('setup dari nol sampai Owner masuk, keluar, masuk lagi, lalu terkunci', async ({
  page,
  browser,
  expectHttpError,
  baseURL,
}) => {
  test.setTimeout(180_000);
  // Belum ada sesi (401 dari /auth/me), token salah (403), password salah (401), terkunci (429).
  expectHttpError(ME, 401);
  expectHttpError('/api/v1/setup/verify-token', 403);

  // ── Instalasi baru: semua alamat diarahkan ke wizard ─────────────────────
  await page.goto('/inbox');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page).toHaveTitle(/^Setup awal · /);
  await expect(page.getByRole('heading', { level: 1, name: 'Masukkan token setup' })).toBeVisible();

  // Token salah → pesan dari server di kolom token.
  const token = page.getByLabel('Token setup');
  await token.fill('token-yang-salah-sekali');
  await page.getByRole('button', { name: 'Lanjut' }).click();
  await expect(page.getByText(/Token setup salah/)).toBeVisible();
  await expect(token).toHaveAttribute('aria-invalid', 'true');

  await token.fill(E2E_SETUP_TOKEN);
  await page.getByRole('button', { name: 'Lanjut' }).click();

  // ── Organisasi ────────────────────────────────────────────────────────────
  const orgHeading = page.getByRole('heading', { level: 1, name: 'Tentang organisasimu' });
  await expect(orgHeading).toBeFocused();
  await page.getByRole('button', { name: 'Lanjut' }).click();
  await expect(page.getByText('Nama perusahaan wajib diisi.')).toBeVisible();
  await page.getByLabel('Nama perusahaan').fill(owner.organization);
  await expect(page.getByLabel('Zona waktu')).toHaveValue('Asia/Jakarta');
  await page.getByRole('button', { name: 'Lanjut' }).click();

  // ── Owner: password diperiksa server sebelum lanjut ──────────────────────
  await expect(page.getByRole('heading', { level: 1, name: 'Buat akun Owner' })).toBeFocused();
  await page.getByLabel('Nama lengkap').fill(owner.name);
  await page.getByLabel('Email', { exact: true }).fill(owner.email);
  const password = page.getByLabel('Password', { exact: true });
  await password.fill('password123');
  await page.getByLabel('Ulangi password').fill('password123');
  await page.getByRole('button', { name: 'Lanjut' }).click();
  await expect(page.getByText(/terlalu umum|mudah ditebak/).first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Buat akun Owner' })).toBeVisible();

  await password.fill(owner.password);
  await page.getByLabel('Ulangi password').fill(`${owner.password}x`);
  await page.getByRole('button', { name: 'Lanjut' }).click();
  await expect(
    page.getByText('Password tidak sama. Ketik ulang password yang sama.'),
  ).toBeVisible();
  await page.getByLabel('Ulangi password').fill(owner.password);
  await expect(page.getByText('Diterima server.')).toBeVisible();
  await page.getByRole('button', { name: 'Lanjut' }).click();

  // ── Tampilan (opsional) ───────────────────────────────────────────────────
  await expect(page.getByRole('heading', { level: 1, name: 'Sesuaikan tampilan' })).toBeVisible();
  await page.getByLabel('Nama aplikasi').fill('Balesin Maju Jaya');
  await page.getByLabel('Warna utama').fill('#7fb3ff');
  await expect(page.getByText(/Kontras dengan putih hanya 2,1:1/)).toBeVisible();
  await page.getByLabel('Warna utama').fill('#1b3557');
  await expect(page.getByText(/Teks mudah dibaca/)).toBeVisible();
  await page.getByRole('button', { name: 'Lanjut' }).click();

  // ── Email pengirim: tes koneksi ke Mailpit sungguhan, lalu dilewati ───────
  await expect(page.getByRole('heading', { level: 1, name: 'Email pengirim' })).toBeVisible();
  await page.getByRole('radio', { name: 'Lainnya' }).click();
  await page.getByLabel('Nama pengirim').fill('CS Maju Jaya');
  await page.getByLabel('Alamat email pengirim').fill('cs@majujaya.test');
  await page.getByLabel('Host SMTP').fill(MAILPIT_SMTP.host);
  await page.getByLabel('Port').fill(MAILPIT_SMTP.port);
  await page.getByLabel('Keamanan').selectOption({ label: 'Tanpa enkripsi' });
  await page.getByLabel('Username').fill(MAILPIT_SMTP.username);
  await page.getByLabel('Password', { exact: true }).fill(MAILPIT_SMTP.password);
  await page.getByRole('button', { name: 'Tes koneksi' }).click();
  await expect(page.getByText('Berhasil terhubung ke server email.', { exact: false })).toBeVisible(
    {
      timeout: 20_000,
    },
  );
  await page.getByRole('button', { name: 'Lewati' }).click();

  // ── Ringkasan: isian dari semua langkah, lalu selesai ─────────────────────
  await expect(
    page.getByRole('heading', { level: 1, name: 'Periksa lalu selesaikan' }),
  ).toBeVisible();
  await expect(page.getByText(owner.organization)).toBeVisible();
  await expect(page.getByText(owner.email)).toBeVisible();
  await expect(page.getByText('Dilewati, atur nanti')).toBeVisible();
  // Kembali ke langkah sebelumnya tidak menghapus isian.
  await page.getByRole('button', { name: 'Ubah Owner' }).click();
  await expect(page.getByLabel('Nama lengkap')).toHaveValue(owner.name);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue(owner.password);
  await page
    .getByRole('navigation', { name: 'Langkah setup' })
    .getByRole('button', {
      name: /Ringkasan/,
    })
    .click();
  await page.getByRole('button', { name: 'Selesai dan masuk' }).click();

  // Langsung masuk ke Inbox dengan merek baru.
  await expect(page).toHaveURL(/\/inbox$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await expect(page).toHaveTitle('Inbox · Balesin Maju Jaya');
  // Token dan password tidak pernah disimpan di penyimpanan browser.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(E2E_SETUP_TOKEN);
  expect(stored).not.toContain(owner.password);

  // Wizard sudah terkunci: /setup diarahkan ke halaman masuk → Inbox (sudah masuk).
  await page.goto('/setup');
  await expect(page).toHaveURL(/\/inbox$/);

  // ── Keluar ────────────────────────────────────────────────────────────────
  await mainNav(page)
    .getByRole('button', { name: `Akun ${owner.name}` })
    .click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText(owner.email)).toBeVisible();
  await expect(menu.getByText('Owner', { exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Keluar' }).click();
  await expect(page).toHaveURL(/\/masuk$/);
  await expect(page.getByText('Kamu sudah keluar. Sampai jumpa lagi!')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: `Masuk ke ${owner.organization}` }),
  ).toBeVisible();

  // Halaman aplikasi tanpa sesi → halaman masuk, tujuan disimpan dan dipakai setelah masuk.
  await page.goto('/pengaturan');
  await expect(page).toHaveURL(/\/masuk\?redirect=%2Fpengaturan$/);
  await submitLogin(page, owner.email, owner.password);
  await expect(page).toHaveURL(/\/pengaturan$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Pengaturan' })).toBeVisible();

  mkdirSync(path.dirname(OWNER_STATE_PATH), { recursive: true });
  await page.context().storageState({ path: OWNER_STATE_PATH });

  // ── Open redirect ditolak: tujuan luar diganti Inbox ──────────────────────
  const guest = await browser.newContext({ baseURL });
  const guestPage = await guest.newPage();
  await guestPage.goto('/masuk?redirect=%2F%2Fcontoh-jahat.test%2Fcuri');
  await submitLogin(guestPage, owner.email, owner.password);
  await expect(guestPage).toHaveURL(/\/inbox$/);
  await guest.close();

  // ── Password salah → terkunci setelah 5 kali ──────────────────────────────
  expectHttpError(LOGIN, 401);
  expectHttpError(LOGIN, 429);
  const intruder = await browser.newContext({ baseURL });
  const login = await intruder.newPage();
  await login.goto('/masuk');
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await submitLogin(login, owner.email, `salah-${attempt}`);
    await expect(login.getByRole('alert')).toContainText('Email atau password salah');
  }
  await submitLogin(login, owner.email, 'salah-5');
  const locked = login.getByRole('alert');
  await expect(locked).toContainText('Coba lagi sebentar lagi');
  await expect(locked).toContainText(/Tombol Masuk aktif lagi dalam 1[45] menit/);
  await expect(login.getByRole('button', { name: 'Masuk', exact: true })).toBeDisabled();
  // Password benar pun ditolak selama terkunci.
  await login.reload();
  await submitLogin(login, owner.email, owner.password);
  await expect(login.getByRole('alert')).toContainText('Coba lagi sebentar lagi');
  await intruder.close();
});
