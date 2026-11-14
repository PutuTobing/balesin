import type { Page } from '@playwright/test';
import { expect, expectNoHorizontalScroll, isHp, mainNav, submitLogin, test } from './fixtures';
import { createUser, e2eSql, enableTwoFactorViaApi, nextTotp } from './pengguna';
import { totpAtStep, totpStep, wrongTotp } from './two-factor';

/**
 * Verifikasi dua langkah untuk peran selain Owner, di HP (390) dan desktop (1440), melawan API
 * sungguhan. Setiap tes membuat penggunanya sendiri (lihat `pengguna.ts`), jadi tidak berbagi
 * akun dengan tes lain dan aman dijalankan paralel:
 *  - CS mengaktifkan 2FA sendiri, masuk dua langkah dengan kode tempelan, lalu menonaktifkannya;
 *  - Admin wajib mendaftar: sesi terbatas, URL langsung ditolak, muat ulang = QR baru;
 *  - Teknisi ber-2FA: 3 kode salah, tantangan kedaluwarsa, lalu kunci 15 menit (429).
 *
 * Email pemberitahuan 2FA TIDAK diperiksa di sini: email pengirim organisasi E2E baru diatur
 * oleh `email-pengirim.spec.ts` (paralel), jadi belum tentu ada saat tes ini berjalan. Email
 * dijaga tes integrasi worker/API dan diperiksa manual di Mailpit oleh QA.
 *
 * Jatah per IP yang dipakai (batas 30 verifikasi gagal / 15 menit): 6 per proyek.
 */
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 120_000 });

const ME = '/api/v1/auth/me';
const LOGIN = '/api/v1/auth/login';
const VERIFY = '/api/v1/auth/2fa/verify';
const ENROLL = '/api/v1/auth/2fa/enroll';
const CONFIRM = '/api/v1/auth/2fa/enroll/confirm';

const label = (page: Page) => (isHp(page) ? 'hp' : 'desktop');

async function signOut(page: Page): Promise<void> {
  if (isHp(page)) {
    await mainNav(page).getByRole('link', { name: 'Lainnya' }).click();
    await page.getByRole('button', { name: 'Keluar' }).click();
  } else {
    await mainNav(page)
      .getByRole('button', { name: /^Akun / })
      .click();
    await page.getByRole('menuitem', { name: 'Keluar' }).click();
  }
  await expect(page).toHaveURL(/\/masuk$/);
}

/** Rahasia dari teks "kunci pengaturan" di langkah 2 pendaftaran. */
async function readSecret(page: Page): Promise<string> {
  const addStep = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Tambahkan akunmu ke aplikasi' }) });
  await expect(addStep.locator('code')).toHaveText(/^[A-Z2-7 ]{32,}$/);
  return ((await addStep.locator('code').textContent()) ?? '').replace(/\s/g, '');
}

const codeHeading = (page: Page) =>
  page.getByRole('heading', { level: 1, name: 'Masukkan kode verifikasi' });

test('CS mengaktifkan 2FA sendiri, masuk dua langkah dengan kode tempelan, lalu menonaktifkannya', async ({
  page,
  context,
  expectHttpError,
}) => {
  expectHttpError(ME, 401);
  expectHttpError(ENROLL, 400);
  expectHttpError(CONFIRM, 400);
  expectHttpError('/api/v1/auth/2fa/disable', 400);
  const cs = await createUser('cs', label(page));

  // ── Tanpa 2FA: CS langsung masuk (peran tidak wajib) ──
  await page.goto('/masuk');
  await submitLogin(page, cs.email, cs.password);
  await expect(page).toHaveURL(/\/inbox$/);

  // ── Keamanan akun → Aktifkan (konfirmasi password dulu) ──
  await page.goto('/pengaturan/keamanan');
  const twoFactor = page.getByRole('region', { name: 'Verifikasi dua langkah' });
  await expect(twoFactor.getByText('Belum aktif', { exact: true })).toBeVisible();
  await expect(twoFactor.getByText(/Tidak wajib untuk peranmu/)).toBeVisible();
  await page.getByRole('link', { name: 'Aktifkan' }).click();
  await expect(page).toHaveURL(/\/pengaturan\/keamanan\/aktifkan$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Aktifkan verifikasi dua langkah' }),
  ).toBeVisible();
  const password = page.getByLabel('Password', { exact: true });
  await password.fill('bukan-password-cs-ini');
  await page.getByRole('button', { name: 'Lanjut' }).click();
  await expect(page.getByText('Password salah. Periksa lagi lalu coba kembali.')).toBeVisible();
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await password.fill(cs.password);
  await page.getByRole('button', { name: 'Lanjut' }).click();

  await expect(
    page.getByRole('img', { name: 'Kode QR untuk ditambahkan ke aplikasi autentikator' }),
  ).toBeVisible();
  const secret = await readSecret(page);
  await expectNoHorizontalScroll(page);
  const codeField = page.getByLabel('Kode 6 digit');
  await codeField.fill(wrongTotp(secret));
  await page.getByRole('button', { name: 'Aktifkan', exact: true }).click();
  await expect(page.getByText(/^Kode tidak cocok\./)).toBeVisible();
  await expect(codeField).toHaveAttribute('aria-invalid', 'true');
  const enrolledStep = totpStep();
  await codeField.fill(totpAtStep(secret, enrolledStep));
  await page.getByRole('button', { name: 'Aktifkan', exact: true }).click();

  // ── Kode cadangan (di dalam halaman: judul level 2) ──
  await expect(page.getByRole('heading', { level: 2, name: 'Simpan kode cadangan' })).toBeFocused();
  const codes = await page
    .getByRole('list', { name: 'Daftar kode cadangan' })
    .locator('code')
    .allTextContents();
  expect(codes).toHaveLength(10);
  await page
    .getByRole('checkbox', { name: 'Saya sudah menyimpan kode ini di tempat yang aman' })
    .check();
  await page.getByRole('button', { name: 'Selesai' }).click();
  await expect(page).toHaveURL(/\/pengaturan\/keamanan$/);
  await expect(twoFactor.getByText('Aktif', { exact: true })).toBeVisible();
  await expect(page.getByText('10 dari 10 kode tersisa')).toBeVisible();
  // Sudah aktif: halaman Aktifkan dialihkan kembali ke Keamanan akun.
  await page.goto('/pengaturan/keamanan/aktifkan');
  await expect(page).toHaveURL(/\/pengaturan\/keamanan$/);

  // ── Keluar → masuk dua langkah; kode ditempel dengan spasi ("123 456") ──
  // Keluar dari Inbox: keluar langsung dari Keamanan akun memicu BUG QA-2FA-5 (dikunci di bawah).
  await page.goto('/inbox');
  await signOut(page);
  await submitLogin(page, cs.email, cs.password);
  await expect(codeHeading(page)).toBeVisible();
  const { code } = await nextTotp(secret, enrolledStep);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(
    (text) => navigator.clipboard.writeText(text),
    `${code.slice(0, 3)} ${code.slice(3)}`,
  );
  const totpField = page.getByLabel('Kode verifikasi');
  await expect(totpField).toBeFocused();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(totpField).toHaveValue(code);
  await page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
  await expect(page).toHaveURL(/\/inbox$/);

  // ── Nonaktifkan: password + kode (kode salah dulu, lalu kode cadangan) ──
  await page.goto('/pengaturan/keamanan');
  await page.getByRole('button', { name: 'Nonaktifkan verifikasi dua langkah' }).click();
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  await page.getByLabel('Password', { exact: true }).fill(cs.password);
  await page.getByLabel('Kode verifikasi').fill(wrongTotp(secret));
  await page.getByRole('button', { name: 'Nonaktifkan', exact: true }).click();
  await expect(page.getByText(/^Kode salah\./)).toBeVisible();
  await page.getByLabel('Kode verifikasi').fill((codes[0] ?? '').toUpperCase());
  await page.getByRole('button', { name: 'Nonaktifkan', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Verifikasi dua langkah sudah dinonaktifkan.' }),
  ).toBeVisible();
  await expect(twoFactor.getByText('Belum aktif', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Kode cadangan' })).toHaveCount(0);

  // Masuk lagi tanpa langkah kedua.
  await page.goto('/inbox');
  await signOut(page);
  await submitLogin(page, cs.email, cs.password);
  await expect(page).toHaveURL(/\/inbox$/);
});

test('Admin wajib mendaftar 2FA: sesi terbatas, URL langsung ditolak, muat ulang membuat QR baru', async ({
  page,
  expectHttpError,
}) => {
  expectHttpError(ME, 401);
  expectHttpError(CONFIRM, 400);
  expectHttpError('/api/v1/settings/email', 403);
  const admin = await createUser('admin', label(page));

  await page.goto('/kontak');
  await expect(page).toHaveURL(/\/masuk\?redirect=%2Fkontak$/);
  await submitLogin(page, admin.email, admin.password);
  await expect(page).toHaveURL(/\/verifikasi-dua-langkah\?redirect=%2Fkontak$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Aktifkan verifikasi dua langkah' }),
  ).toBeVisible();
  await expect(
    page.getByText(/^Sebagai Admin, kamu wajib memakai verifikasi dua langkah/),
  ).toBeVisible();
  // Email akun di bilah atas hanya tampil di layar lebar.
  if (!isHp(page)) await expect(page.getByText(`Masuk sebagai ${admin.email}`)).toBeVisible();

  // Halaman aplikasi lewat URL langsung → kembali ke pendaftaran; API menolak 403.
  await page.goto('/pengaturan/keamanan');
  await expect(page).toHaveURL(/\/verifikasi-dua-langkah\?redirect=%2Fpengaturan%2Fkeamanan$/);
  await expect(mainNav(page)).toHaveCount(0);
  const blocked = await page.request.get('/api/v1/settings/email');
  expect(blocked.status()).toBe(403);
  expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
    'TWO_FACTOR_ENROLLMENT_REQUIRED',
  );
  await page.goto('/verifikasi-dua-langkah?redirect=%2Fkontak');

  // Muat ulang di tengah pendaftaran: rahasia baru, kode dari rahasia lama tidak berlaku.
  const first = await readSecret(page);
  await page.reload();
  const second = await readSecret(page);
  expect(second).not.toBe(first);
  const codeField = page.getByLabel('Kode 6 digit');
  const step = totpStep();
  const stale = totpAtStep(first, step);
  // (Peluang kode rahasia lama kebetulan sama dengan kode rahasia baru: diabaikan.)
  expect(stale).not.toBe(totpAtStep(second, step));
  await codeField.fill(stale);
  await page.getByRole('button', { name: 'Aktifkan', exact: true }).click();
  await expect(page.getByText(/^Kode tidak cocok\./)).toBeVisible();
  await codeField.fill(totpAtStep(second, totpStep()));
  await page.getByRole('button', { name: 'Aktifkan', exact: true }).click();

  // Kode cadangan: wajib dicentang sebelum lanjut ke tujuan awal (/kontak).
  await expect(page.getByRole('heading', { level: 1, name: 'Simpan kode cadangan' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Keluar' })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  const codes = await page
    .getByRole('list', { name: 'Daftar kode cadangan' })
    .locator('code')
    .allTextContents();
  const saved = page.getByRole('checkbox', {
    name: 'Saya sudah menyimpan kode ini di tempat yang aman',
  });
  await page.getByRole('button', { name: 'Lanjut', exact: true }).click();
  await expect(page.getByText('Centang dulu setelah kode cadangan tersimpan.')).toBeVisible();
  await expect(saved).toBeFocused();
  await saved.check();
  await page.getByRole('button', { name: 'Lanjut', exact: true }).click();
  await expect(page).toHaveURL(/\/kontak$/);
  await expect(mainNav(page)).toBeVisible();

  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(second);
  expect(stored).not.toContain(codes[0]);
  expect(page.url()).not.toContain(codes[0] ?? '-');
});

test('Teknisi ber-2FA: 3 kode salah, tantangan kedaluwarsa, lalu langkah kedua dikunci 15 menit', async ({
  page,
  expectHttpError,
}) => {
  expectHttpError(ME, 401);
  expectHttpError(VERIFY, 400);
  expectHttpError(VERIFY, 401);
  expectHttpError(VERIFY, 429);
  expectHttpError(LOGIN, 429);
  const teknisi = await createUser('teknisi', label(page));
  const { secret } = await enableTwoFactorViaApi(teknisi);
  const totpField = page.getByLabel('Kode verifikasi');
  const verifyButton = page.getByRole('button', { name: 'Verifikasi', exact: true });
  const loginHeading = page.getByRole('heading', { level: 1, name: /^Masuk ke / });

  // ── 3 kode salah pada satu tantangan → kembali ke password dengan pesan ──
  await page.goto('/masuk');
  await submitLogin(page, teknisi.email, teknisi.password);
  await expect(codeHeading(page)).toBeVisible();
  await totpField.fill(wrongTotp(secret));
  await verifyButton.click();
  await expect(page.getByText(/Sisa 2 percobaan\./)).toBeVisible();
  await totpField.fill(wrongTotp(secret));
  await verifyButton.click();
  await expect(page.getByText(/Sisa 1 percobaan\./)).toBeVisible();
  await totpField.fill(wrongTotp(secret));
  await verifyButton.click();
  await expect(loginHeading).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Kode salah 3 kali.');
  await expect(page.getByLabel('Email')).toHaveValue(teknisi.email);
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();

  // ── Tantangan kedaluwarsa di server (5 menit) → kembali ke password ──
  await submitLogin(page, teknisi.email, teknisi.password);
  await expect(codeHeading(page)).toBeVisible();
  await e2eSql(
    `update two_factor_challenges set expires_at = now() - interval '1 second'
     where used_at is null and user_id = (select id from users where email = $1)`,
    [teknisi.email],
  );
  await totpField.fill(wrongTotp(secret));
  await verifyButton.click();
  await expect(loginHeading).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('sudah tidak berlaku');

  // ── Kode salah ke-4 dan ke-5 untuk akun ini → langkah kedua dikunci (429) ──
  await submitLogin(page, teknisi.email, teknisi.password);
  await expect(codeHeading(page)).toBeVisible();
  await totpField.fill(wrongTotp(secret));
  await verifyButton.click();
  await expect(page.getByText(/Sisa 2 percobaan\./)).toBeVisible();
  await totpField.fill(wrongTotp(secret));
  await verifyButton.click();
  const locked = page.getByRole('alert');
  await expect(locked).toContainText('Verifikasi dikunci sementara');
  await expect(locked).toContainText('Terlalu banyak kode verifikasi yang salah');
  await expect(
    page.getByRole('button', { name: /^Coba lagi dalam 1[45]:[0-5]\d$/ }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Pakai kode cadangan' })).toBeDisabled();
  await expectNoHorizontalScroll(page);

  // Password benar pun ditolak selama langkah kedua dikunci.
  await page.getByRole('button', { name: 'Kembali ke email dan password' }).click();
  await page.getByLabel('Password', { exact: true }).fill(teknisi.password);
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Masuk dikunci sementara');
  await expect(codeHeading(page)).toHaveCount(0);
});

/**
 * Bug terbuka (dilaporkan QA, belum diperbaiki). Tes ditandai `test.fail`: lulus selama bug masih
 * ada, dan langsung ketahuan bila sudah diperbaiki (hapus tandanya). Pemeriksaan yang memastikan
 * bug-nya diletakkan PALING AKHIR; langkah sebelumnya sudah dijaga tes lain di berkas ini.
 */
test.describe('bug QA 2FA (terbuka)', () => {
  /** Teknisi tanpa 2FA → Keamanan akun → Aktifkan → layar kode cadangan (belum dicentang). */
  async function openFreshBackupCodes(page: Page, name: string): Promise<void> {
    const teknisi = await createUser('teknisi', `${label(page)}-${name}`);
    await page.goto('/masuk');
    await submitLogin(page, teknisi.email, teknisi.password);
    await expect(page).toHaveURL(/\/inbox$/);
    await page.goto('/pengaturan/keamanan');
    await page.getByRole('link', { name: 'Aktifkan' }).click();
    await page.getByLabel('Password', { exact: true }).fill(teknisi.password);
    await page.getByRole('button', { name: 'Lanjut' }).click();
    const secret = await readSecret(page);
    await page.getByLabel('Kode 6 digit').fill(totpAtStep(secret, totpStep()));
    await page.getByRole('button', { name: 'Aktifkan', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Simpan kode cadangan' }),
    ).toBeVisible();
  }

  /** Kode masih tampil, ATAU pengguna diperingatkan (dialog) sebelum kode dibuang. */
  async function expectCodesKeptOrWarned(page: Page, warned: () => boolean): Promise<void> {
    await expect
      .poll(
        async () =>
          warned() || (await page.getByRole('list', { name: 'Daftar kode cadangan' }).isVisible()),
        { timeout: 3_000 },
      )
      .toBe(true);
  }

  // Kode cadangan "hanya ditampilkan sekali" hilang tanpa peringatan bila layar ditinggalkan
  // di dalam aplikasi sebelum "sudah disimpan" dicentang (peringatan hanya untuk tutup tab/muat
  // ulang lewat `beforeunload`). Sama untuk layar setelah wizard setup (Back → /setup → Inbox)
  // dan "Kode cadangan baru" di Keamanan akun — keduanya diperiksa manual oleh QA.
  test.fail(
    'BUG QA-2FA-1: tombol Back browser di layar kode cadangan membuang kode tanpa peringatan',
    async ({ page, expectHttpError }) => {
      expectHttpError(ME, 401);
      await openFreshBackupCodes(page, 'back');
      let warned = false;
      page.on('dialog', (dialog) => {
        warned = true;
        void dialog.dismiss();
      });
      await page.goBack();
      // Kenyataan: kembali ke /pengaturan/keamanan, kode hilang tanpa peringatan.
      await expectCodesKeptOrWarned(page, () => warned);
    },
  );

  test.fail(
    'BUG QA-2FA-2: pindah lewat menu navigasi di layar kode cadangan membuang kode tanpa peringatan',
    async ({ page, expectHttpError }) => {
      expectHttpError(ME, 401);
      await openFreshBackupCodes(page, 'nav');
      let warned = false;
      page.on('dialog', (dialog) => {
        warned = true;
        void dialog.dismiss();
      });
      await mainNav(page).getByRole('link', { name: 'Inbox', exact: true }).click();
      // Kenyataan: pindah ke Inbox, kode hilang tanpa peringatan.
      await expectCodesKeptOrWarned(page, () => warned);
    },
  );

  // Keluar dari halaman Keamanan akun (menu akun di desktop): `clearSessionData` membuang query
  // status 2FA yang masih dipakai halaman itu, sehingga `GET /auth/2fa` dikirim ulang SETELAH
  // sesi dicabut → 401 + error console.
  test.fail(
    'BUG QA-2FA-5: keluar dari Keamanan akun tidak memicu permintaan status 2FA yang gagal (401)',
    async ({ page, expectHttpError }) => {
      test.skip(isHp(page), 'Menu akun dengan Keluar hanya ada di halaman ini pada desktop');
      expectHttpError(ME, 401);
      // Diizinkan di fixture supaya kegagalan tes datang dari pemeriksaan eksplisit di bawah.
      expectHttpError('/api/v1/auth/2fa', 401);
      const cs = await createUser('cs', `${label(page)}-keluar`);
      await page.goto('/masuk');
      await submitLogin(page, cs.email, cs.password);
      await expect(page).toHaveURL(/\/inbox$/);
      await page.goto('/pengaturan/keamanan');
      await expect(page.getByRole('heading', { level: 1, name: 'Keamanan akun' })).toBeVisible();
      const failed: string[] = [];
      page.on('response', (response) => {
        if (response.status() === 401 && response.url().endsWith('/api/v1/auth/2fa'))
          failed.push(response.url());
      });
      await signOut(page);
      await expect(page.getByText('Kamu sudah keluar. Sampai jumpa lagi!')).toBeVisible();
      await page.waitForLoadState('networkidle');
      // Kenyataan: GET /api/v1/auth/2fa → 401 setelah keluar.
      expect(failed).toEqual([]);
    },
  );
});
