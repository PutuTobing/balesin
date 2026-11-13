import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { E2E_SETUP_TOKEN, MAILPIT_SMTP, OWNER_STATE_PATH } from '../stack/env';
import { expect, mainNav, owner, submitLogin, test } from './fixtures';
import { findMail } from './mailpit';

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

/**
 * Isian salah di setiap langkah wizard, melawan API sungguhan SEBELUM setup diselesaikan
 * (docs/PENGATURAN-UI.md, DoD tambahan: pesan error per kesalahan isian lewat UI). Tes ini
 * tidak pernah berhasil menyelesaikan setup: satu-satunya `complete` yang dikirim membawa logo
 * palsu, jadi ditolak 400 dan tidak ada yang dibuat. Tes utama di bawahnya mulai dari nol lagi.
 *
 * Jatah yang dipakai (direset tiap run): 1 token salah (batas 10/15 menit per IP) dan 4 tes
 * email (batas 10/5 menit per IP; tes utama memakai 1 lagi).
 */
test('wizard: token lewat tautan, lalu pesan error per isian salah di setiap langkah', async ({
  page,
  expectHttpError,
}) => {
  test.setTimeout(150_000);
  expectHttpError(ME, 401);
  expectHttpError('/api/v1/setup/verify-token', 403);
  expectHttpError('/api/v1/setup/complete', 400);
  const tokenField = page.getByLabel('Token setup');
  const next = page.getByRole('button', { name: 'Lanjut' });
  const heading = (name: string) => page.getByRole('heading', { level: 1, name });

  // ── Token salah lewat tautan: diperiksa otomatis, ditolak, dan hilang dari alamat ──
  await page.goto('/setup#token=token-tautan-yang-salah');
  await expect(page.getByText(/Token setup salah/)).toBeVisible();
  await expect(tokenField).toHaveAttribute('aria-invalid', 'true');
  expect(new URL(page.url()).hash).toBe('');

  // ── Token benar lewat tautan (muat halaman baru): langsung ke Organisasi ──
  await page.goto('about:blank');
  await page.goto(`/setup#token=${encodeURIComponent(E2E_SETUP_TOKEN)}`);
  await expect(heading('Tentang organisasimu')).toBeFocused();
  expect(page.url()).not.toContain(E2E_SETUP_TOKEN);
  await page.getByRole('button', { name: 'Kembali' }).click();
  await expect(page.getByText('Token dari tautan setup sudah terisi.')).toBeVisible();
  await expect(tokenField).toHaveValue(E2E_SETUP_TOKEN);
  await next.click();
  await page.getByLabel('Nama perusahaan').fill(owner.organization);
  await next.click();

  // ── Owner: isian kosong, email salah, password pendek / umum / memuat data pemilik ──
  await expect(heading('Buat akun Owner')).toBeFocused();
  await next.click();
  await expect(page.getByText('Nama wajib diisi.')).toBeVisible();
  await expect(page.getByText('Alamat email wajib diisi.')).toBeVisible();
  await expect(page.getByText('Password minimal 10 karakter.')).toBeVisible();
  await page.getByLabel('Nama lengkap').fill(owner.name);
  await page.getByLabel('Email', { exact: true }).fill('bukan-alamat-email');
  await next.click();
  await expect(page.getByText(/Alamat email tidak valid/)).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(owner.email);
  const password = page.getByLabel('Password', { exact: true });
  const repeat = page.getByLabel('Ulangi password');
  for (const [weak, message] of [
    ['qwertyuiop', /terlalu umum dan mudah ditebak/],
    ['rina-kartika-2026', /tidak boleh memuat nama, email, atau nama perusahaanmu/],
  ] as const) {
    await password.fill(weak);
    await repeat.fill(weak);
    await next.click();
    await expect(page.getByText(message).first()).toBeVisible();
    await expect(heading('Buat akun Owner')).toBeVisible();
    await expect(password).toHaveAttribute('aria-invalid', 'true');
  }
  await password.fill(owner.password);
  await repeat.fill(owner.password);
  await expect(page.getByText('Siap dipakai.')).toBeVisible();
  await next.click();

  // ── Tampilan: logo SVG, GIF, dan > 256 KB ditolak di browser ──
  await expect(heading('Sesuaikan tampilan')).toBeFocused();
  const logoInput = page.locator('input[type="file"]');
  await logoInput.setInputFiles({
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  });
  await expect(page.getByText('Logo harus berupa gambar PNG, JPG, atau WebP.')).toBeVisible();
  await logoInput.setInputFiles({
    name: 'logo.gif',
    mimeType: 'image/gif',
    buffer: Buffer.from('GIF89a'),
  });
  await expect(page.getByText('Logo harus berupa gambar PNG, JPG, atau WebP.')).toBeVisible();
  await logoInput.setInputFiles({
    name: 'besar.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(300 * 1024, 1),
  });
  await expect(page.getByText(/Ukuran logo 300 KB, maksimal 256 KB/)).toBeVisible();
  await expect(page.getByRole('img', { name: 'Pratinjau logo' })).toHaveCount(0);
  // Berkas berakhiran .png yang isinya bukan gambar lolos di browser; server yang menolaknya.
  await logoInput.setInputFiles({
    name: 'palsu.png',
    mimeType: 'image/png',
    buffer: Buffer.from('ini teks biasa, bukan gambar PNG'),
  });
  await expect(page.getByText(/palsu\.png/)).toBeVisible();
  await next.click();

  // ── Email: kesalahan isian ditandai per isian; kesalahan sambungan dijelaskan server ──
  await expect(heading('Email pengirim')).toBeFocused();
  await next.click();
  await expect(page.getByText('Nama pengirim wajib diisi.')).toBeVisible();
  await expect(page.getByText('Host SMTP wajib diisi.')).toBeVisible();
  await page.getByRole('radio', { name: 'Lainnya' }).click();
  await page.getByLabel('Nama pengirim').fill('CS Maju Jaya');
  await page.getByLabel('Alamat email pengirim').fill('cs@majujaya.test');
  await expect(page.getByLabel('Username')).toHaveValue('cs@majujaya.test');
  await page.getByLabel('Host SMTP').fill('http://localhost/');
  await page.getByLabel('Port').fill('abc');
  await page.getByRole('button', { name: 'Tes koneksi' }).click();
  await expect(page.getByText(/Host SMTP tidak valid/)).toBeVisible();
  await expect(page.getByText('Port wajib diisi dengan angka.')).toBeVisible();

  const result = page.getByRole('region', { name: 'Tes pengaturan' });
  const runTest = async (expected: RegExp) => {
    await page.getByRole('button', { name: 'Tes koneksi' }).click();
    await expect(result.getByText(expected)).toBeVisible({ timeout: 20_000 });
  };
  await page.getByLabel('Host SMTP').fill(MAILPIT_SMTP.host);
  await page.getByLabel('Keamanan').selectOption({ label: 'Tanpa enkripsi' });
  await page.getByLabel('Username').fill(MAILPIT_SMTP.username);
  await page.getByLabel('Password', { exact: true }).fill(MAILPIT_SMTP.password);
  // "Tanpa enkripsi" + username: peringatan password terkirim polos.
  const plaintextWarning = page.getByText(/Tanpa enkripsi, password email terkirim tanpa/);
  await expect(plaintextWarning).toBeVisible();

  // Port salah (diizinkan, tetapi tidak ada server email di sana).
  await page.getByLabel('Port').fill('2525');
  await runTest(/Server menolak sambungan di port ini/);
  // Host salah.
  await page.getByLabel('Port').fill(MAILPIT_SMTP.port);
  await page.getByLabel('Host SMTP').fill('smtp.tidak-ada.invalid');
  await runTest(/Server email tidak ditemukan/);
  // Password salah.
  await page.getByLabel('Host SMTP').fill(MAILPIT_SMTP.host);
  await page.getByLabel('Password', { exact: true }).fill('password-salah');
  await runTest(/Username atau password ditolak server email/);

  // Benar → kirim email tes ke Owner dan pastikan BENAR-BENAR tiba di Mailpit.
  await page.getByLabel('Password', { exact: true }).fill(MAILPIT_SMTP.password);
  const recipient = `wizard-${Date.now()}@majujaya.test`;
  await expect(page.getByLabel('Kirim email tes ke')).toHaveValue(owner.email);
  await page.getByLabel('Kirim email tes ke').fill(recipient);
  await page.getByRole('button', { name: 'Kirim email tes' }).click();
  await expect(
    result.getByText(`Email tes terkirim ke ${recipient}.`, { exact: false }),
  ).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => (await findMail(recipient)).length, { timeout: 20_000 })
    .toBeGreaterThan(0);

  // Username dikosongkan → peringatan hilang; diisi lagi → muncul lagi.
  await page.getByLabel('Username').fill('');
  await expect(plaintextWarning).toBeHidden();
  await page.getByLabel('Username').fill(MAILPIT_SMTP.username);
  await expect(plaintextWarning).toBeVisible();
  await next.click();

  // ── Ringkasan → Selesai: logo palsu ditolak server, wizard kembali ke langkah Tampilan ──
  await expect(heading('Periksa lalu selesaikan')).toBeFocused();
  await page.getByRole('button', { name: 'Selesai dan masuk' }).click();
  await expect(heading('Sesuaikan tampilan')).toBeFocused();
  await expect(page.getByText(/Logo harus berupa gambar PNG, JPG, atau WebP/)).toBeVisible();
  // Isian langkah lain tetap ada.
  await page.getByRole('button', { name: 'Kembali' }).click();
  await expect(page.getByLabel('Nama lengkap')).toHaveValue(owner.name);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue(owner.password);

  // Muat ulang di tengah wizard: semua isian (termasuk token & password) sengaja tidak disimpan.
  await page.reload();
  await expect(heading('Masukkan token setup')).toBeVisible();
  await expect(tokenField).toHaveValue('');
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(E2E_SETUP_TOKEN);
  expect(stored).not.toContain(owner.password);
});

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
  await expect(page.getByText('Siap dipakai.')).toBeVisible();
  await page.getByRole('button', { name: 'Lanjut' }).click();

  // ── Tampilan (opsional) ───────────────────────────────────────────────────
  await expect(page.getByRole('heading', { level: 1, name: 'Sesuaikan tampilan' })).toBeVisible();
  await page.getByLabel('Nama aplikasi').fill('Balesin Maju Jaya');
  // Warna utama tidak ditawarkan sampai tema organisasi diterapkan (DECISIONS 2026-11-13).
  await expect(page.getByLabel(/Warna utama/)).toHaveCount(0);
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

  // Tab kedua membuka wizard sebelum setup selesai (status "perlu setup" sudah termuat).
  const lateTab = await browser.newContext({ baseURL });
  const late = await lateTab.newPage();
  await late.goto('/setup');
  await expect(late.getByRole('heading', { level: 1, name: 'Masukkan token setup' })).toBeVisible();

  await page.getByRole('button', { name: 'Selesai dan masuk' }).click();

  // Langsung masuk ke Inbox dengan merek baru.
  await expect(page).toHaveURL(/\/inbox$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await expect(page).toHaveTitle('Inbox · Balesin Maju Jaya');
  // Token dan password tidak pernah disimpan di penyimpanan browser.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(E2E_SETUP_TOKEN);
  expect(stored).not.toContain(owner.password);

  // Tab kedua melanjutkan wizard setelah setup selesai di tab pertama → layar "sudah selesai",
  // tidak ada Owner kedua. (Tombol "Ke halaman masuk" di layar itu: lihat setup-wizard.spec.ts.)
  await late.getByLabel('Token setup').fill(E2E_SETUP_TOKEN);
  await late.getByRole('button', { name: 'Lanjut' }).click();
  await expect(late.getByRole('heading', { level: 1, name: 'Setup sudah selesai' })).toBeVisible();
  await expect(late.getByRole('link', { name: 'Ke halaman masuk' })).toBeVisible();
  await lateTab.close();

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
  await expect(locked).toContainText('Masuk dikunci sementara');
  // Sisa waktu ada di label tombol yang nonaktif (bukan di dalam role="alert").
  await expect(locked).not.toContainText(/\d[.:]\d{2}/);
  await expect(
    login.getByRole('button', { name: /^Coba lagi dalam 1[45]:[0-5]\d$/ }),
  ).toBeDisabled();
  // Password benar pun ditolak selama terkunci.
  await login.reload();
  await submitLogin(login, owner.email, owner.password);
  await expect(login.getByRole('alert')).toContainText('Masuk dikunci sementara');
  await intruder.close();
});
