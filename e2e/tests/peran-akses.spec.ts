import type { Browser, Page } from '@playwright/test';
import {
  expect,
  expectNoHorizontalScroll,
  isHp,
  mainNav,
  owner,
  submitLogin,
  test,
} from './fixtures';
import { openWatchedPage, type WatchedPage } from './konteks';
import {
  createUser,
  enrollRequiredTwoFactorViaApi,
  userId,
  type ExtraRole,
  type ExtraUser,
} from './pengguna';

/**
 * RBAC di web (Fase 1 butir 5, PRD §4) untuk kelima peran, di HP (390) dan desktop (1440): menu
 * Pengaturan organisasi yang tampil sesuai izin, akses langsung lewat alamat ke halaman terlarang
 * (dialihkan ke Pengaturan, TANPA permintaan API yang ditolak — pengawas `openWatchedPage`
 * menggagalkan tes bila ada respons ≥ 400), dan banner keamanan hanya untuk pemegang `audit.view`.
 *
 * Owner memakai sesi bersama proyek; peran lain masuk lewat halaman masuk di browser terpisah
 * (Admin/Supervisor dengan kode cadangan supaya tidak menunggu langkah TOTP berikutnya).
 */
test.describe.configure({ timeout: 120_000 });

const ME = '/api/v1/auth/me';

interface Expectation {
  team: boolean;
  email: boolean;
  audit: boolean;
  /** Template percakapan (`quick_replies.manage`). */
  quickReplies: boolean;
}

/** Matriks izin halaman Pengaturan organisasi (team.invite/manage, settings.email.manage, audit.view). */
const MATRIX: Record<'owner' | ExtraRole, Expectation> = {
  owner: { team: true, email: true, audit: true, quickReplies: true },
  admin: { team: true, email: true, audit: true, quickReplies: true },
  supervisor: { team: false, email: false, audit: false, quickReplies: true },
  cs: { team: false, email: false, audit: false, quickReplies: false },
  teknisi: { team: false, email: false, audit: false, quickReplies: false },
};

async function signInAs(browser: Browser, hp: boolean, user: ExtraUser): Promise<WatchedPage> {
  let backup: string | undefined;
  if (user.role === 'admin' || user.role === 'supervisor') {
    backup = (await enrollRequiredTwoFactorViaApi(user)).backupCodes[0];
  }
  const watched = await openWatchedPage(browser, { hp });
  watched.allow(ME, 401);
  const { page } = watched;
  await page.goto('/masuk');
  await submitLogin(page, user.email, user.password);
  if (backup) {
    await expect(
      page.getByRole('heading', { level: 1, name: 'Masukkan kode verifikasi' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Pakai kode cadangan' }).click();
    await page.getByLabel('Kode cadangan').fill(backup);
    await page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Kamu masuk dengan kode cadangan' }),
    ).toBeVisible();
    await page.getByRole('button', { name: /^(Lanjut|Nanti saja)$/ }).click();
  }
  await expect(page).toHaveURL(/\/inbox$/);
  return watched;
}

/** Buka Pengaturan lewat navigasi (HP: lewat "Lainnya"), bukan lewat alamat. */
async function openSettingsFromNav(page: Page): Promise<void> {
  if (isHp(page)) {
    await mainNav(page).getByRole('link', { name: 'Lainnya' }).click();
    await page
      .getByRole('navigation', { name: 'Menu lainnya' })
      .getByRole('link', { name: 'Pengaturan' })
      .click();
  } else {
    await mainNav(page).getByRole('link', { name: 'Pengaturan', exact: true }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Pengaturan' })).toBeVisible();
}

async function expectSettingsMenu(page: Page, expected: Expectation): Promise<void> {
  const organization = page.getByRole('region', { name: 'Pengaturan organisasi' });
  const any = expected.team || expected.email || expected.audit || expected.quickReplies;
  await expect(organization).toHaveCount(any ? 1 : 0);
  const menu = (name: RegExp) => page.getByRole('main').getByRole('link', { name });
  await expect(menu(/^Tim/)).toHaveCount(expected.team ? 1 : 0);
  await expect(menu(/^Email pengirim/)).toHaveCount(expected.email ? 1 : 0);
  await expect(menu(/^Audit log/)).toHaveCount(expected.audit ? 1 : 0);
  await expect(menu(/^Template percakapan/)).toHaveCount(expected.quickReplies ? 1 : 0);
  // Semua peran: Keamanan akun.
  await expect(menu(/^Keamanan akun/)).toHaveCount(1);
  await expectNoHorizontalScroll(page);
}

/** Alamat terlarang → dialihkan ke Pengaturan tanpa layar error dan tanpa permintaan 403. */
async function expectRedirectedToSettings(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page).toHaveURL(/\/pengaturan$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Pengaturan' })).toBeVisible();
}

for (const role of ['admin', 'supervisor', 'cs', 'teknisi'] as const) {
  test(`${role}: menu Pengaturan sesuai matriks, alamat terlarang dialihkan, banner sesuai izin`, async ({
    browser,
    page: ownerPage,
  }) => {
    const hp = isHp(ownerPage);
    const user = await createUser(role, `akses-${hp ? 'hp' : 'desktop'}`);
    const ownerId = await userId(owner.email);
    const watched = await signInAs(browser, hp, user);
    const { page } = watched;
    try {
      const expected = MATRIX[role];
      await openSettingsFromNav(page);
      await expectSettingsMenu(page, expected);

      if (!expected.team) await expectRedirectedToSettings(page, '/pengaturan/tim');
      if (!expected.team) await expectRedirectedToSettings(page, `/pengaturan/tim/${ownerId}`);
      if (!expected.email) await expectRedirectedToSettings(page, '/pengaturan/email');
      if (!expected.audit) await expectRedirectedToSettings(page, '/pengaturan/audit');
      if (!expected.audit) {
        await expectRedirectedToSettings(page, `/pengaturan/audit?userId=${ownerId}`);
      }

      if (expected.team) {
        // Admin: Owner hanya dilihat (tanpa tombol kelola), lewat alamat langsung.
        await page.goto(`/pengaturan/tim/${ownerId}`);
        await expect(page.getByRole('heading', { level: 2, name: owner.name })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Ubah peran' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Nonaktifkan akun' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Atur ulang 2FA' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Keluarkan semua sesi' })).toHaveCount(0);
        // Detail ID yang tidak ada → "tidak ditemukan" dalam kerangka aplikasi.
        watched.allow('/api/v1/users/00000000-0000-4000-8000-000000000000', 404);
        await page.goto('/pengaturan/tim/00000000-0000-4000-8000-000000000000');
        await expect(page.getByRole('heading', { name: 'Anggota tidak ditemukan' })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Lihat daftar anggota' })).toBeVisible();
      }
      if (expected.audit) {
        await page.goto('/pengaturan/audit');
        await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
        await expect(page.getByRole('list', { name: 'Entri audit log' })).toBeVisible();
      }

      // Keamanan akun selalu bisa dibuka; peran tanpa izin email pengirim tidak diarahkan ke
      // Pengaturan → Email pengirim (tautan itu akan mati baginya).
      await page.goto('/pengaturan/keamanan');
      await expect(page.getByRole('heading', { level: 1, name: 'Keamanan akun' })).toBeVisible();
      if (!expected.email) {
        await expect(page.getByRole('main').locator('a[href="/pengaturan/email"]')).toHaveCount(0);
      }
      // Banner keamanan hanya untuk pemegang audit.view (tanpa izin: tidak ada permintaan pun).
      if (!expected.audit) {
        await expect(page.getByRole('region', { name: /kejadian keamanan baru$/ })).toHaveCount(0);
      }
      await expectNoHorizontalScroll(page);
      watched.expectClean();
    } finally {
      await watched.close();
    }
  });
}

test('owner: menu Pengaturan organisasi lengkap', async ({ page }) => {
  await page.goto('/inbox');
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await openSettingsFromNav(page);
  await expectSettingsMenu(page, MATRIX.owner);
});
