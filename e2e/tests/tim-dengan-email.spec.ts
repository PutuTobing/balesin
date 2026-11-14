import { request, type Page } from '@playwright/test';
import { MAILPIT_SMTP, OWNER_STATE_PATH } from '../stack/env';
import { BASE_URL } from '../viewports';
import { expect, openApp, owner, submitLogin, test } from './fixtures';
import { expectNoTokenInUrl, openWatchedPage } from './konteks';
import { findMail, waitForTokenLink } from './mailpit';
import { createUser, e2eSql, enableTwoFactorViaApi, nextTotp } from './pengguna';
import { wrongTotp } from './two-factor';

/**
 * Undangan, lupa/atur ulang password, dan verifikasi email DENGAN email pengirim (Mailpit): email
 * benar-benar tiba, tautannya diambil dari isi email.
 *
 * Proyek `dengan-email` berjalan SETELAH proyek desktop/HP (pengaturan email organisasi dibagi
 * bersama; `email-pengirim.spec.ts` memeriksa keadaan "Belum diatur" di awal), satu per satu.
 */
test.describe.configure({ mode: 'serial' });

const stamp = Date.now().toString(36);
const PASSWORD = 'Teh-Manis-Hangat-77';
const NEW_PASSWORD = 'Gunung-Biru-Pagi-81';

/** Email pengirim organisasi → Mailpit (lewat API sebagai Owner; idempoten). */
test.beforeAll(async () => {
  const api = await request.newContext({
    baseURL: BASE_URL,
    storageState: OWNER_STATE_PATH,
    extraHTTPHeaders: { origin: BASE_URL },
  });
  try {
    const me = (await (await api.get('/api/v1/auth/me')).json()) as { csrfToken: string };
    const saved = await api.put('/api/v1/settings/email', {
      headers: { 'x-csrf-token': me.csrfToken },
      data: {
        fromName: 'CS Maju Jaya',
        fromAddress: 'cs@majujaya.test',
        replyTo: null,
        host: MAILPIT_SMTP.host,
        port: Number(MAILPIT_SMTP.port),
        security: 'none',
        username: MAILPIT_SMTP.username,
        password: MAILPIT_SMTP.password,
      },
    });
    if (!saved.ok()) throw new Error(`Simpan email (${saved.status()}): ${await saved.text()}`);
  } finally {
    await api.dispose();
  }
});

/** Isi form lupa password lalu kembalikan kalimat jawabannya. */
async function requestReset(page: Page, email: string): Promise<string> {
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Kirim tautan' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Periksa email-mu' })).toBeFocused();
  return (await page.getByRole('main').locator('p').first().textContent()) ?? '';
}

async function fillNewPassword(page: Page, password: string): Promise<void> {
  await page.getByLabel('Password baru', { exact: true }).fill(password);
  await page.getByLabel('Ulangi password baru').fill(password);
}

test('Owner mengundang CS lewat email: email tiba, CS membuat akun, email-nya terverifikasi', async ({
  page,
  browser,
}) => {
  const email = `citra-email-${stamp}@majujaya.test`;
  const since = new Date();
  await openApp(page, '/pengaturan/tim');
  await expect(page.getByText(/Undangan dikirim ke email penerima/)).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Peran').selectOption({ label: 'CS' });
  await page.getByRole('button', { name: 'Kirim undangan' }).click();
  await expect(page.getByText(`Undangan untuk ${email} dibuat`)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Status pengiriman berganti sendiri setelah worker mengirim.
  const row = page.getByRole('listitem', { name: `Undangan untuk ${email}` });
  await expect(row).toContainText('Email terkirim', { timeout: 30_000 });

  const link = await waitForTokenLink(email, '/undangan', since);
  const guest = await openWatchedPage(browser, { hp: true });
  guest.allow('/api/v1/auth/me', 401);
  try {
    await guest.page.goto(link);
    await expectNoTokenInUrl(guest.page);
    await guest.page.getByLabel('Nama lengkap').fill('Citra Maharani');
    await guest.page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await guest.page.getByLabel('Ulangi password').fill(PASSWORD);
    await guest.page.getByRole('button', { name: 'Buat akun' }).click();
    await expect(guest.page).toHaveURL(/\/inbox$/);
    await guest.page.goto('/pengaturan/keamanan');
    await expect(guest.page.getByRole('region', { name: 'Email akun' })).toContainText(
      'Terverifikasi',
    );
    guest.expectClean();
  } finally {
    await guest.close();
  }
  // Undangan yang diterima hilang dari daftar Owner.
  await page.reload();
  await expect(page.getByRole('listitem', { name: `Undangan untuk ${email}` })).toHaveCount(0);
});

test('lupa password: jawaban sama untuk email tak terdaftar; reset mencabut sesi lama; tautan sekali pakai', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const user = await createUser('cs', 'reset');
  const unknown = `tidak-ada-${stamp}@majujaya.test`;

  // Sesi lama di browser lain.
  const old = await openWatchedPage(browser);
  old.allow('/api/v1/auth/me', 401);
  const guest = await openWatchedPage(browser);
  guest.allow('/api/v1/auth/me', 401);
  try {
    await old.page.goto('/masuk');
    await submitLogin(old.page, user.email, user.password);
    await expect(old.page).toHaveURL(/\/inbox$/);

    const since = new Date();
    await guest.page.goto('/masuk');
    await guest.page.getByLabel('Email').fill(unknown);
    await guest.page.getByRole('link', { name: 'Lupa password?' }).click();
    // Email yang sudah diketik ikut terbawa (lewat memori, bukan alamat).
    await expect(guest.page.getByLabel('Email')).toHaveValue(unknown);
    await expect(guest.page).toHaveURL(/\/lupa-password$/);
    const unknownAnswer = await requestReset(guest.page, unknown);
    expect(unknownAnswer).not.toMatch(/email terkirim/i);
    await guest.page.getByRole('button', { name: 'Pakai email lain' }).click();
    const knownAnswer = await requestReset(guest.page, user.email);
    // Kalimat yang sama persis (selain alamatnya): tidak membuka ada/tidaknya akun.
    expect(knownAnswer.replace(user.email, 'X')).toBe(unknownAnswer.replace(unknown, 'X'));

    const link = await waitForTokenLink(user.email, '/atur-ulang-password', since);
    expect(await findMail(unknown)).toHaveLength(0);

    await guest.page.goto(link);
    await expect(
      guest.page.getByRole('heading', { level: 1, name: 'Buat password baru' }),
    ).toBeVisible();
    await expectNoTokenInUrl(guest.page);
    // Akun tanpa 2FA: tidak ada isian kode.
    await expect(guest.page.getByLabel('Kode verifikasi')).toHaveCount(0);
    await fillNewPassword(guest.page, NEW_PASSWORD);
    await guest.page.getByRole('button', { name: 'Simpan password baru' }).click();
    await expect(guest.page).toHaveURL(/\/masuk$/);
    await expect(guest.page.getByText(/Password sudah diganti/)).toBeVisible();
    await expect(guest.page.getByLabel('Email')).toHaveValue(user.email);

    // Sesi lama di browser lain sudah tidak berlaku.
    old.allow('/api/v1/auth/me', 401);
    await old.page.goto('/inbox');
    await expect(old.page).toHaveURL(/\/masuk/);

    // Password lama ditolak, password baru diterima.
    guest.allow('/api/v1/auth/login', 401);
    await submitLogin(guest.page, user.email, user.password);
    await expect(guest.page.getByRole('alert')).toContainText('Email atau password salah');
    await submitLogin(guest.page, user.email, NEW_PASSWORD);
    await expect(guest.page).toHaveURL(/\/inbox$/);

    // Tautan yang sama dibuka lagi → penjelasan (410).
    guest.allow('/api/v1/auth/password-reset/inspect', 410);
    await guest.page.goto(link);
    await expect(
      guest.page.getByRole('heading', { level: 1, name: 'Tautan tidak bisa dipakai' }),
    ).toBeVisible();
    await expect(guest.page.getByRole('link', { name: 'Minta tautan baru' })).toBeVisible();
    old.expectClean();
    guest.expectClean();
  } finally {
    await old.close();
    await guest.close();
  }
});

test('atur ulang password akun ber-2FA wajib dengan kode; masuk berikutnya tetap dua langkah', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const user = await createUser('cs', 'reset2fa');
  const { secret, lastStep } = await enableTwoFactorViaApi(user);
  const guest = await openWatchedPage(browser, { hp: true });
  guest.allow('/api/v1/auth/me', 401);
  try {
    const since = new Date();
    await guest.page.goto('/lupa-password');
    await requestReset(guest.page, user.email);
    const link = await waitForTokenLink(user.email, '/atur-ulang-password', since);

    await guest.page.goto(link);
    await expect(guest.page.getByText('Akun ini memakai verifikasi dua langkah')).toBeVisible();
    await fillNewPassword(guest.page, NEW_PASSWORD);
    // Tanpa kode → ditolak di browser.
    await guest.page.getByRole('button', { name: 'Simpan password baru' }).click();
    await expect(guest.page.getByLabel('Kode verifikasi')).toHaveAttribute('aria-invalid', 'true');
    // Kode salah → ditolak server di isian kode dengan sisa percobaan; tautan tetap bisa dipakai.
    guest.allow('/api/v1/auth/password-reset/complete', 400);
    await guest.page.getByLabel('Kode verifikasi').fill(wrongTotp(secret));
    await guest.page.getByRole('button', { name: 'Simpan password baru' }).click();
    await expect(guest.page.getByText(/Sisa 2 percobaan/)).toBeVisible();
    await expect(guest.page.getByLabel('Kode verifikasi')).toHaveAttribute('aria-invalid', 'true');
    await expect(guest.page.getByLabel('Kode verifikasi')).toBeFocused();
    await expect(guest.page.getByLabel('Password baru', { exact: true })).toHaveValue(NEW_PASSWORD);
    const { code, step } = await nextTotp(secret, lastStep);
    await guest.page.getByLabel('Kode verifikasi').fill(code);
    await guest.page.getByRole('button', { name: 'Simpan password baru' }).click();
    await expect(guest.page).toHaveURL(/\/masuk$/);
    await expect(guest.page.getByText(/Password sudah diganti/)).toBeVisible();

    await submitLogin(guest.page, user.email, NEW_PASSWORD);
    await expect(
      guest.page.getByRole('heading', { level: 1, name: 'Masukkan kode verifikasi' }),
    ).toBeVisible();
    const next = await nextTotp(secret, step);
    await guest.page.getByLabel('Kode verifikasi').fill(next.code);
    await guest.page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
    await expect(guest.page).toHaveURL(/\/inbox$/);
    guest.expectClean();
  } finally {
    await guest.close();
  }
});

test('Owner memverifikasi email-nya dari Keamanan akun', async ({ page }) => {
  await openApp(page, '/pengaturan/keamanan');
  const card = page.getByRole('region', { name: 'Email akun' });
  await expect(card).toContainText('Belum diverifikasi');
  const since = new Date();
  await card.getByRole('button', { name: 'Kirim email verifikasi' }).click();
  await expect(card.getByText(`Email verifikasi sedang dikirim ke ${owner.email}`)).toBeVisible();

  const link = await waitForTokenLink(owner.email, '/verifikasi-email', since);
  await page.goto(link);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Email sudah terverifikasi' }),
  ).toBeVisible();
  await expectNoTokenInUrl(page);
  await page.getByRole('link', { name: 'Buka aplikasi' }).click();
  await openApp(page, '/pengaturan/keamanan');
  await expect(page.getByRole('region', { name: 'Email akun' })).toContainText('Terverifikasi');
});

test('pratinjau template email: iframe ber-sandbox dengan branding organisasi', async ({
  page,
}) => {
  await openApp(page, '/pengaturan/email');
  const frame = page.locator('iframe[title^="Pratinjau email"]');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(page.frameLocator('iframe[title^="Pratinjau email"]').locator('body')).toContainText(
    'PT Maju Jaya',
  );
  await page.getByLabel('Template').selectOption({ label: 'Atur ulang password' });
  await page.getByRole('radio', { name: 'Teks polos' }).click();
  await expect(page.locator('pre')).toContainText('CONTOH-TAUTAN-PRATINJAU');
});

// ── Tambahan QA butir 4: batas 72 jam undangan, tautan kedaluwarsa, tautan verifikasi dipakai ulang ──

test('undangan Supervisor lewat 72 jam: penerima melihat "kedaluwarsa"; kirim ulang membatalkan tautan lama dan tautan baru berlaku', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const email = `sari-kedaluwarsa-${stamp}@majujaya.test`;
  const since = new Date();
  await openApp(page, '/pengaturan/tim');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Peran').selectOption({ label: 'Supervisor' });
  await page.getByRole('button', { name: 'Kirim undangan' }).click();
  const row = page.getByRole('listitem', { name: `Undangan untuk ${email}` });
  await expect(row).toContainText('Email terkirim', { timeout: 30_000 });
  const oldLink = await waitForTokenLink(email, '/undangan', since);

  // Jam server tidak bisa dimajukan: batas 72 jam dilewati dengan memundurkan `expires_at`.
  await e2eSql(
    `update user_invitations set expires_at = now() - interval '1 minute'
     where email = $1 and accepted_at is null and revoked_at is null`,
    [email],
  );

  const guest = await openWatchedPage(browser, { hp: true });
  guest.allow('/api/v1/auth/me', 401);
  guest.allow('/api/v1/auth/invitation/inspect', 410);
  try {
    await guest.page.goto(oldLink);
    await expect(
      guest.page.getByRole('heading', { level: 1, name: 'Undangan tidak bisa dipakai' }),
    ).toBeVisible();
    await expect(guest.page.getByRole('main')).toContainText('sudah kedaluwarsa');
    await expect(guest.page.getByLabel('Nama lengkap')).toHaveCount(0);
    await expectNoTokenInUrl(guest.page);

    // Daftar Owner: "Kedaluwarsa" + "Kirim ulang" (tanpa memuat ulang manual → muat ulang halaman).
    await page.reload();
    await expect(row).toContainText('Kedaluwarsa');
    const resendSince = new Date();
    await row.getByRole('button', { name: 'Kirim ulang' }).click();
    await expect(row).not.toContainText('Kedaluwarsa');
    await expect(row).toContainText('Email terkirim', { timeout: 30_000 });
    const newLink = await waitForTokenLink(email, '/undangan', resendSince);
    expect(newLink).not.toBe(oldLink);

    // Tautan lama: tidak berlaku (diganti kirim ulang), bukan lagi "kedaluwarsa".
    await guest.page.goto('/masuk');
    await guest.page.goto(oldLink);
    await expect(
      guest.page.getByRole('heading', { level: 1, name: 'Undangan tidak bisa dipakai' }),
    ).toBeVisible();
    await expect(guest.page.getByRole('main')).toContainText('tidak berlaku');

    // Tautan baru: form, peran wajib 2FA → langsung ke pendaftaran 2FA setelah akun dibuat.
    await guest.page.goto('/masuk');
    await guest.page.goto(newLink);
    await expect(
      guest.page.getByText(/Peran Supervisor wajib verifikasi dua langkah/),
    ).toBeVisible();
    await guest.page.getByLabel('Nama lengkap').fill('Sari Wulandari');
    await guest.page.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await guest.page.getByLabel('Ulangi password').fill(PASSWORD);
    await guest.page.getByRole('button', { name: 'Buat akun' }).click();
    await expect(guest.page).toHaveURL(/\/verifikasi-dua-langkah$/);
    guest.expectClean();
  } finally {
    await guest.close();
  }
  await page.reload();
  await expect(row).toHaveCount(0);
});

test('tautan atur ulang password lewat 30 menit → "kedaluwarsa" dengan tombol minta tautan baru', async ({
  browser,
}) => {
  const user = await createUser('teknisi', 'reset-kedaluwarsa');
  const guest = await openWatchedPage(browser);
  guest.allow('/api/v1/auth/me', 401);
  guest.allow('/api/v1/auth/password-reset/inspect', 410);
  try {
    const since = new Date();
    await guest.page.goto('/lupa-password');
    await requestReset(guest.page, user.email);
    const link = await waitForTokenLink(user.email, '/atur-ulang-password', since);
    await e2eSql(
      `update account_tokens set expires_at = now() - interval '1 minute'
       where purpose = 'password_reset' and used_at is null and revoked_at is null
         and user_id = (select id from users where email = $1)`,
      [user.email],
    );
    await guest.page.goto(link);
    await expect(
      guest.page.getByRole('heading', { level: 1, name: 'Tautan tidak bisa dipakai' }),
    ).toBeVisible();
    await expect(guest.page.getByRole('main')).toContainText('kedaluwarsa');
    await expectNoTokenInUrl(guest.page);
    await guest.page.getByRole('link', { name: 'Minta tautan baru' }).click();
    await expect(guest.page).toHaveURL(/\/lupa-password$/);
    await expect(guest.page.getByLabel('Email')).toBeVisible();
    guest.expectClean();
  } finally {
    await guest.close();
  }
});

test('CS memverifikasi email-nya; tautan verifikasi yang sama dibuka lagi → tidak bisa dipakai', async ({
  browser,
}) => {
  const user = await createUser('cs', 'verifikasi');
  await e2eSql(`update users set email_verified_at = null where email = $1`, [user.email]);
  const cs = await openWatchedPage(browser, { hp: true });
  cs.allow('/api/v1/auth/me', 401);
  try {
    await cs.page.goto('/masuk');
    await submitLogin(cs.page, user.email, user.password);
    await expect(cs.page).toHaveURL(/\/inbox$/);
    await cs.page.goto('/pengaturan/keamanan');
    const card = cs.page.getByRole('region', { name: 'Email akun' });
    await expect(card).toContainText('Belum diverifikasi');
    const since = new Date();
    await card.getByRole('button', { name: 'Kirim email verifikasi' }).click();
    await expect(card.getByText(`Email verifikasi sedang dikirim ke ${user.email}`)).toBeVisible();
    const link = await waitForTokenLink(user.email, '/verifikasi-email', since);

    await cs.page.goto(link);
    await expect(
      cs.page.getByRole('heading', { level: 1, name: 'Email sudah terverifikasi' }),
    ).toBeVisible();
    await expectNoTokenInUrl(cs.page);

    cs.allow('/api/v1/auth/email/verify', 410);
    await cs.page.goto('/inbox');
    await cs.page.goto(link);
    await expect(
      cs.page.getByRole('heading', { level: 1, name: 'Tautan verifikasi tidak bisa dipakai' }),
    ).toBeVisible();
    await expect(cs.page.getByRole('main')).toContainText(/sudah dipakai|sudah terverifikasi/);
    await expectNoTokenInUrl(cs.page);

    await cs.page.goto('/pengaturan/keamanan');
    await expect(cs.page.getByRole('region', { name: 'Email akun' })).toContainText(
      'Terverifikasi',
    );
    cs.expectClean();
  } finally {
    await cs.close();
  }
});
