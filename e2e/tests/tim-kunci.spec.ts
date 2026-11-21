import type { Browser, Page } from '@playwright/test';
import { Redis } from 'ioredis';
import { E2E_REDIS_URL } from '../stack/env';
import { expect, isHp, submitLogin, test } from './fixtures';
import { openWatchedPage, type WatchedPage } from './konteks';
import {
  createUser,
  e2eSql,
  enableTwoFactorViaApi,
  enrollRequiredTwoFactorViaApi,
  nextTotp,
  userId,
  type ExtraUser,
} from './pengguna';

/**
 * Buka kunci (Fase 1 butir 6) dari Pengaturan → Tim, di HP dan desktop: kunci langkah kedua 15
 * menit (dibuka "Buka kunci"), dan kunci 2FA harian (review butir 6 Info 2) yang TIDAK dibuka
 * "Buka kunci" — kotak terkunci berganti isi dan aksinya "Atur ulang 2FA".
 *
 * Kunci dipasang langsung di Redis E2E + audit `auth.account.locked` (persis seperti yang ditulis
 * server saat kunci terjadi), bukan dengan menebak password/kode: batas per IP (20 password salah /
 * 30 verifikasi per 15 menit) dipakai bersama semua tes paralel dari 127.0.0.1, dan kunci harian
 * butuh 20 kode salah dalam 24 jam (melewati kunci 15 menit berkali-kali). Bahwa kunci itu sungguh
 * menahan masuk diperiksa dari browser pemilik akun (429), sebelum dan sesudah dibuka.
 */
test.describe.configure({ timeout: 150_000 });

const ME = '/api/v1/auth/me';
const LOGIN = '/api/v1/auth/login';
const label = (page: Page) => (isHp(page) ? 'hp' : 'desktop');

type LockFlag = '2fa-akun-terkunci' | '2fa-akun-terkunci-harian';

/** Pasang kunci langkah kedua seperti server (`two-factor.service.ts` → `lock` / harian). */
async function seedTwoFactorLock(user: ExtraUser, flag: LockFlag, ttlSeconds: number) {
  const id = await userId(user.email);
  const redis = new Redis(E2E_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  try {
    await redis.set(`balesin:rl:flag:${flag}:${id}`, '1', 'EX', ttlSeconds);
  } finally {
    redis.disconnect();
  }
  const daily = flag === '2fa-akun-terkunci-harian';
  await e2eSql(
    `insert into audit_logs (id, organization_id, action, target_type, target_id, metadata, ip_address)
     select gen_random_uuid(), organization_id, 'auth.account.locked', 'user', id::text, $2::jsonb, '127.0.0.1'
     from users where id = $1`,
    [
      id,
      JSON.stringify({
        scope: 'two_factor',
        trustedDevice: false,
        failedAttempts: daily ? 20 : 5,
        trigger: 'login',
        lockedUntil: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        ...(daily ? { daily: true } : {}),
      }),
    ],
  );
}

/** Masuk sebagai Admin (kode cadangan) di browser terpisah. */
async function signInAdmin(browser: Browser, hp: boolean, admin: ExtraUser, backup: string) {
  const watched = await openWatchedPage(browser, { hp });
  watched.allow(ME, 401);
  await watched.page.goto('/masuk');
  await submitLogin(watched.page, admin.email, admin.password);
  await watched.page.getByRole('button', { name: 'Pakai kode cadangan' }).click();
  await watched.page.getByLabel('Kode cadangan').fill(backup);
  await watched.page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
  await watched.page.getByRole('button', { name: /^(Lanjut|Nanti saja)$/ }).click();
  await expect(watched.page).toHaveURL(/\/inbox$/);
  return watched;
}

async function openMember(page: Page, user: ExtraUser): Promise<void> {
  await page.goto('/pengaturan/tim');
  const members = page.getByRole('region', { name: /^Anggota tim/ });
  const row = members.getByRole('link', { name: new RegExp(user.email.replace(/[.]/g, '\\.')) });
  await expect(row).toContainText('Terkunci sementara');
  await row.click();
  await expect(page.getByRole('heading', { level: 2, name: user.name })).toBeVisible();
}

async function confirm(page: Page, title: string, button: string, password: string, code: string) {
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog.getByLabel('Password', { exact: true })).toBeFocused();
  await dialog.getByLabel('Password', { exact: true }).fill(password);
  await dialog.getByLabel('Kode verifikasi').fill(code);
  await dialog.getByRole('button', { name: button, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Pemilik akun mencoba masuk: password benar → 429 (terkunci) atau langkah kode. */
async function tryLogin(owner: WatchedPage, user: ExtraUser): Promise<void> {
  await owner.page.goto('/masuk');
  await submitLogin(owner.page, user.email, user.password);
}

test('Admin membuka kunci langkah kedua CS; CS bisa lanjut masuk', async ({
  browser,
  page: ownerPage,
}) => {
  const hp = isHp(ownerPage);
  const admin = await createUser('admin', `kunci-${label(ownerPage)}`);
  const { backupCodes } = await enrollRequiredTwoFactorViaApi(admin);
  const cs = await createUser('cs', `kunci-${label(ownerPage)}`);
  const csTfa = await enableTwoFactorViaApi(cs);
  await seedTwoFactorLock(cs, '2fa-akun-terkunci', 900);

  // Pemilik akun: password benar pun ditolak selama terkunci.
  const csBrowser = await openWatchedPage(browser, { hp });
  csBrowser.allow(ME, 401);
  csBrowser.allow(LOGIN, 429);
  await tryLogin(csBrowser, cs);
  await expect(csBrowser.page.getByRole('alert')).toContainText(/dikunci sementara/i);

  const adminBrowser = await signInAdmin(browser, hp, admin, backupCodes[0] ?? '');
  const { page } = adminBrowser;
  await openMember(page, cs);
  const lock = page.getByText('Akun terkunci sementara');
  await expect(lock).toBeVisible();
  await page.getByRole('button', { name: 'Buka kunci' }).click();
  await confirm(page, 'Buka kunci akun?', 'Buka kunci', admin.password, backupCodes[1] ?? '');
  await expect(
    page.getByRole('status').filter({ hasText: `Kunci akun ${cs.name} sudah dibuka` }),
  ).toBeVisible();
  await expect(lock).toHaveCount(0);
  await expect(page.getByText('Terkunci sementara')).toHaveCount(0);
  // Fokus ke pesan hasil (bukan <body>).
  await expect(page.locator(':focus')).toContainText('sudah dibuka');
  // Daftar Tim ikut diperbarui (tidak basi).
  await page.goto('/pengaturan/tim');
  await expect(
    page
      .getByRole('region', { name: /^Anggota tim/ })
      .getByRole('link', { name: new RegExp(cs.email.replace(/[.]/g, '\\.')) }),
  ).not.toContainText('Terkunci sementara');

  // Pemilik akun: sekarang lanjut ke langkah kode, lalu masuk.
  await csBrowser.page.reload();
  await tryLogin(csBrowser, cs);
  await expect(
    csBrowser.page.getByRole('heading', { level: 1, name: 'Masukkan kode verifikasi' }),
  ).toBeVisible();
  const { code } = await nextTotp(csTfa.secret, csTfa.lastStep);
  await csBrowser.page.getByLabel('Kode verifikasi').fill(code);
  await csBrowser.page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
  await expect(csBrowser.page).toHaveURL(/\/inbox$/);

  csBrowser.expectClean();
  adminBrowser.expectClean();
  await csBrowser.close();
  await adminBrowser.close();
});

test('kunci 2FA harian: "Buka kunci" tidak melepasnya; kotak berganti ke "Atur ulang 2FA" yang melepasnya', async ({
  browser,
  page: ownerPage,
}) => {
  const hp = isHp(ownerPage);
  const admin = await createUser('admin', `harian-${label(ownerPage)}`);
  const { backupCodes } = await enrollRequiredTwoFactorViaApi(admin);
  const teknisi = await createUser('teknisi', `harian-${label(ownerPage)}`);
  await enableTwoFactorViaApi(teknisi);
  await seedTwoFactorLock(teknisi, '2fa-akun-terkunci-harian', 23 * 60 * 60);

  const adminBrowser = await signInAdmin(browser, hp, admin, backupCodes[0] ?? '');
  const { page } = adminBrowser;
  await openMember(page, teknisi);
  await page.getByRole('button', { name: 'Buka kunci' }).click();
  await confirm(page, 'Buka kunci akun?', 'Buka kunci', admin.password, backupCodes[1] ?? '');

  // Masih terkunci: kotak yang sama berganti isi; tidak ada pesan "sudah dibuka".
  const daily = page.getByRole('status').filter({
    hasText: 'Kunci verifikasi dua langkah masih berlaku',
  });
  await expect(daily).toBeVisible();
  await expect(daily).toContainText('tidak bisa dibuka dari sini');
  await expect(page.getByText(/sudah dibuka/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Buka kunci' })).toHaveCount(0);
  await expect(page.locator(':focus')).toContainText('masih berlaku');

  // "Atur ulang 2FA" dari kotak itu melepas kunci harian.
  await daily.getByRole('button', { name: 'Atur ulang 2FA' }).click();
  await confirm(
    page,
    'Atur ulang verifikasi dua langkah?',
    'Atur ulang 2FA',
    admin.password,
    backupCodes[2] ?? '',
  );
  await expect(page.getByText(/verifikasi dua langkah .* sudah diatur ulang/i)).toBeVisible();
  await expect(page.getByText('Kunci verifikasi dua langkah masih berlaku')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: teknisi.name })).toBeVisible();
  await expect(page.getByText('Terkunci sementara')).toHaveCount(0);
  await expect(page.getByText('Akun terkunci sementara')).toHaveCount(0);

  // Teknisi (2FA tidak wajib) kini masuk dengan password saja.
  const tekBrowser = await openWatchedPage(browser, { hp });
  tekBrowser.allow(ME, 401);
  await tryLogin(tekBrowser, teknisi);
  await expect(tekBrowser.page).toHaveURL(/\/inbox$/);
  tekBrowser.expectClean();
  await tekBrowser.close();

  adminBrowser.expectClean();
  await adminBrowser.close();
});
