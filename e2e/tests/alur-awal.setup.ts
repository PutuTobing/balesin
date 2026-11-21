import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { E2E_SETUP_TOKEN, MAILPIT_SMTP, OWNER_STATE_PATH } from '../stack/env';
import { expect, mainNav, owner, submitLogin, test } from './fixtures';
import { findMail } from './mailpit';
import { releaseLoginIpBudget } from './pengguna';
import {
  replaceOwnerBackupCodes,
  saveOwnerTwoFactor,
  withOwnerCode,
  wrongTotp,
} from './two-factor';

/**
 * Alur utama Fase 1 melawan API sungguhan, dari instalasi kosong (database & Redis direset
 * oleh `stack/start-backend.mjs`):
 *   setup dari nol → sesi terbatas → pendaftaran 2FA Owner (rahasia dibaca dari layar, kode TOTP
 *   dihitung `two-factor.ts`) → kode cadangan → keluar → masuk dua langkah (kode salah lalu benar)
 *   → open redirect ditolak (masuk dengan kode cadangan) → kode cadangan sekali pakai → buat
 *   ulang kode cadangan → password salah → akun terkunci setelah 5 kali.
 *
 * Sesi Owner disimpan ke `OWNER_STATE_PATH` SEBELUM akun dikunci, lalu dipakai proyek
 * `desktop-1440` dan `hp-390` (sesi yang sudah ada tetap berlaku saat akun terkunci).
 */
const ME = '/api/v1/auth/me';
const LOGIN = '/api/v1/auth/login';
const VERIFY = '/api/v1/auth/2fa/verify';

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
  await page.getByLabel('Keamanan', { exact: true }).selectOption({ label: 'Tanpa enkripsi' });
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

test('setup dari nol sampai Owner mendaftar 2FA, masuk dua langkah, lalu terkunci', async ({
  page,
  browser,
  expectHttpError,
  baseURL,
}) => {
  // Tiga kode TOTP berturut-turut: tiap kode menunggu langkah 30 detik berikutnya.
  test.setTimeout(300_000);
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
  await page.getByLabel('Keamanan', { exact: true }).selectOption({ label: 'Tanpa enkripsi' });
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

  // ── Owner wajib 2FA: sesi terbatas, langsung ke pendaftaran ───────────────
  await expect(page).toHaveURL(/\/verifikasi-dua-langkah$/, { timeout: 20_000 });
  const enrollHeading = page.getByRole('heading', {
    level: 1,
    name: 'Aktifkan verifikasi dua langkah',
  });
  await expect(enrollHeading).toBeVisible();
  await expect(page).toHaveTitle('Aktifkan verifikasi dua langkah · Balesin Maju Jaya');
  // Token dan password tidak pernah disimpan di penyimpanan browser.
  let stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(E2E_SETUP_TOKEN);
  expect(stored).not.toContain(owner.password);

  // Sesi terbatas tidak bisa membuka halaman aplikasi: diarahkan kembali ke pendaftaran
  // (tujuan awal dibawa), dan API menolak dengan 403 TWO_FACTOR_ENROLLMENT_REQUIRED.
  await page.goto('/kontak');
  await expect(page).toHaveURL(/\/verifikasi-dua-langkah\?redirect=%2Fkontak$/);
  await expect(enrollHeading).toBeVisible();
  await expect(mainNav(page)).toHaveCount(0);
  const blocked = await page.request.get('/api/v1/settings/email');
  expect(blocked.status()).toBe(403);
  expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
    'TWO_FACTOR_ENROLLMENT_REQUIRED',
  );
  await page.goto('/verifikasi-dua-langkah');

  // QR dibuat di browser; rahasia dibaca dari kunci untuk diketik manual.
  await expect(
    page.getByRole('img', { name: 'Kode QR untuk ditambahkan ke aplikasi autentikator' }),
  ).toBeVisible();
  const addStep = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Tambahkan akunmu ke aplikasi' }) });
  const secret = ((await addStep.locator('code').textContent()) ?? '').replace(/\s/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  saveOwnerTwoFactor({ secret, backupCodes: [], lastStep: null });
  await withOwnerCode(
    async ({ code }) => {
      await page.getByLabel('Kode 6 digit').fill(code);
      await page.getByRole('button', { name: 'Aktifkan', exact: true }).click();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Simpan kode cadangan' }),
      ).toBeFocused();
    },
    { allowBackup: false },
  );

  // ── Kode cadangan: tampil sekali, unduh .txt, wajib dicentang sebelum lanjut ──
  const codes = await page
    .getByRole('list', { name: 'Daftar kode cadangan' })
    .locator('code')
    .allTextContents();
  expect(codes).toHaveLength(10);
  for (const code of codes) expect(code).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Unduh .txt' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('kode-cadangan-balesin-maju-jaya.txt');
  const file = readFileSync(await download.path(), 'utf8');
  for (const code of codes) expect(file).toContain(code);
  expect(file).toContain(owner.email);

  const saved = page.getByRole('checkbox', {
    name: 'Saya sudah menyimpan kode ini di tempat yang aman',
  });
  await page.getByRole('button', { name: 'Lanjut ke Inbox' }).click();
  await expect(page.getByText('Simpan kode cadangan dulu, lalu centang kotak ini.')).toBeVisible();
  await expect(saved).toBeFocused();
  await expect(page).toHaveURL(/\/verifikasi-dua-langkah$/);
  await saved.check();
  await page.getByRole('button', { name: 'Lanjut ke Inbox' }).click();

  // Masuk ke Inbox dengan merek baru.
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await expect(page).toHaveTitle('Inbox · Balesin Maju Jaya');
  // Rahasia dan kode cadangan tidak tertinggal di penyimpanan browser.
  stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(secret);
  expect(stored).not.toContain(codes[0]);

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

  // ── Masuk dua langkah: password, lalu kode (salah sekali, lalu benar) ──────
  // Halaman aplikasi tanpa sesi → halaman masuk, tujuan disimpan dan dipakai setelah masuk.
  expectHttpError(VERIFY, 400);
  await page.goto('/pengaturan');
  await expect(page).toHaveURL(/\/masuk\?redirect=%2Fpengaturan$/);
  await submitLogin(page, owner.email, owner.password);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Masukkan kode verifikasi' }),
  ).toBeVisible();
  const totpField = page.getByLabel('Kode verifikasi');
  await expect(totpField).toBeFocused();
  await totpField.fill(wrongTotp(secret));
  await page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
  await expect(page.getByText(/Sisa 2 percobaan/)).toBeVisible();
  await expect(totpField).toHaveAttribute('aria-invalid', 'true');
  await withOwnerCode(
    async ({ code }) => {
      await totpField.fill(code);
      await page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
      await expect(page).toHaveURL(/\/pengaturan$/);
    },
    { allowBackup: false },
  );
  await expect(page.getByRole('heading', { level: 1, name: 'Pengaturan' })).toBeVisible();

  mkdirSync(path.dirname(OWNER_STATE_PATH), { recursive: true });
  await page.context().storageState({ path: OWNER_STATE_PATH });

  /** Masuk dari browser baru sampai langkah kode cadangan. */
  const signInWithBackup = async (redirect = '') => {
    const context = await browser.newContext({ baseURL });
    const guestPage = await context.newPage();
    await guestPage.goto(`/masuk${redirect}`);
    await submitLogin(guestPage, owner.email, owner.password);
    await guestPage.getByRole('button', { name: 'Pakai kode cadangan' }).click();
    await expect(
      guestPage.getByRole('heading', { level: 1, name: 'Masukkan kode cadangan' }),
    ).toBeVisible();
    const useCode = async (code: string) => {
      // Huruf besar diabaikan server (bentuk baku huruf kecil).
      await guestPage.getByLabel('Kode cadangan').fill(code.toUpperCase());
      await guestPage.getByRole('button', { name: 'Verifikasi', exact: true }).click();
    };
    return { context, guestPage, useCode };
  };
  const expectBackupUsed = async (guestPage: Page, remaining: number) => {
    await expect(
      guestPage.getByRole('heading', { level: 1, name: 'Kamu masuk dengan kode cadangan' }),
    ).toBeVisible();
    await expect(
      guestPage.getByText(`Sisa ${remaining} kode cadangan.`, { exact: false }),
    ).toBeVisible();
    await guestPage.getByRole('button', { name: 'Lanjut', exact: true }).click();
  };

  // ── Open redirect ditolak: tujuan luar diganti Inbox (masuk dengan kode cadangan) ──
  const first = await signInWithBackup('?redirect=%2F%2Fcontoh-jahat.test%2Fcuri');
  await first.useCode(codes[0] ?? '');
  await expectBackupUsed(first.guestPage, 9);
  await expect(first.guestPage).toHaveURL(/\/inbox$/);
  await first.context.close();

  // ── Kode cadangan sekali pakai: kode yang sama ditolak, kode lain diterima ──
  const second = await signInWithBackup();
  await second.useCode(codes[0] ?? '');
  await expect(second.guestPage.getByText(/Sisa 2 percobaan/)).toBeVisible();
  await second.useCode(codes[1] ?? '');
  await expectBackupUsed(second.guestPage, 8);
  await expect(second.guestPage).toHaveURL(/\/inbox$/);
  await second.context.close();

  // ── Buat ulang kode cadangan (password + kode) → semua kode lama batal ─────
  await page.goto('/pengaturan/keamanan');
  await expect(page.getByRole('heading', { level: 1, name: 'Keamanan akun' })).toBeVisible();
  await expect(page.getByText('8 dari 10 kode tersisa')).toBeVisible();
  // Owner wajib 2FA: penjelasan, tanpa tombol menonaktifkan.
  await expect(
    page.getByText(/^Sebagai Owner, kamu wajib memakai verifikasi dua langkah, jadi fitur ini/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Nonaktifkan/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Buat kode baru' }).click();
  await page.getByLabel('Password', { exact: true }).fill(owner.password);
  await withOwnerCode(
    async ({ code }) => {
      await page.getByLabel('Kode verifikasi').fill(code);
      await page.getByRole('dialog').getByRole('button', { name: 'Buat kode baru' }).click();
      await expect(
        page.getByRole('heading', { level: 2, name: 'Kode cadangan baru' }),
      ).toBeFocused();
    },
    { allowBackup: false },
  );
  const newCodes = await page
    .getByRole('list', { name: 'Daftar kode cadangan' })
    .locator('code')
    .allTextContents();
  expect(newCodes).toHaveLength(10);
  expect(newCodes).not.toContain(codes[2]);
  await page
    .getByRole('checkbox', { name: 'Saya sudah menyimpan kode ini di tempat yang aman' })
    .check();
  await page.getByRole('button', { name: 'Selesai' }).click();
  await expect(page.getByText('10 dari 10 kode tersisa')).toBeVisible();

  const third = await signInWithBackup();
  await third.useCode(codes[2] ?? '');
  await expect(third.guestPage.getByText(/Sisa 2 percobaan/)).toBeVisible();
  await third.useCode(newCodes[0] ?? '');
  await expectBackupUsed(third.guestPage, 9);
  await third.context.close();
  // Sisa kode baru dipakai tes paralel yang perlu masuk ulang sebagai Owner.
  replaceOwnerBackupCodes(newCodes.slice(1));

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
  // Jatah gagal per IP dipakai bersama semua tes (lihat `releaseLoginIpBudget`).
  await releaseLoginIpBudget();
});
