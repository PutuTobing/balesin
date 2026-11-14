import { readFileSync } from 'node:fs';
import type { Browser, Page } from '@playwright/test';
import {
  expect,
  expectNoHorizontalScroll,
  isHp,
  openApp,
  owner,
  submitLogin,
  test,
} from './fixtures';
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
import { withOwnerCode } from './two-factor';

/**
 * Manajemen pengguna, sesi aktif, dan audit log (Fase 1 butir 6) melawan API sungguhan, di HP (390)
 * dan desktop (1440). Setiap tes membuat penggunanya sendiri (`pengguna.ts`), jadi aman paralel.
 *
 * Kode TOTP Owner dipakai bersama tes lain lewat `withOwnerCode` (sekali pakai per langkah waktu),
 * jadi hanya SATU aksi memakai identitas Owner (ubah peran). Aksi lain dilakukan Admin milik tes ini
 * sendiri dengan kode cadangannya (tanpa menunggu langkah 30 detik berikutnya).
 */
test.describe.configure({ timeout: 180_000 });

const ME = '/api/v1/auth/me';
const LOGIN = '/api/v1/auth/login';
const label = (page: Page) => (isHp(page) ? 'hp' : 'desktop');

/** Masuk di browser terpisah (tamu) sebagai pengguna E2E; `code` = kode 2FA bila perlu. */
async function signIn(
  browser: Browser,
  hp: boolean,
  user: ExtraUser,
  code?: () => Promise<string>,
): Promise<WatchedPage> {
  const watched = await openWatchedPage(browser, { hp });
  watched.allow(ME, 401);
  await watched.page.goto('/masuk');
  await submitLogin(watched.page, user.email, user.password);
  if (code) {
    await expect(
      watched.page.getByRole('heading', { level: 1, name: 'Masukkan kode verifikasi' }),
    ).toBeVisible();
    await watched.page.getByLabel('Kode verifikasi').fill(await code());
    await watched.page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
  }
  await expect(watched.page).toHaveURL(/\/inbox$/);
  return watched;
}

/** Isi dialog konfirmasi identitas lalu kirim; menunggu dialog tertutup. */
async function confirmIdentity(
  page: Page,
  dialogName: string | RegExp,
  confirmLabel: string,
  password: string,
  code?: string,
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Password-mu')).toBeFocused();
  await dialog.getByLabel('Password-mu').fill(password);
  if (code !== undefined) await dialog.getByLabel('Kode verifikasi').fill(code);
  await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** Buka detail anggota dari daftar Tim (baris dicari lewat email-nya). */
async function openMember(page: Page, email: string, name: string): Promise<void> {
  await page.goto('/pengaturan/tim');
  const members = page.getByRole('region', { name: /^Anggota tim/ });
  await members.getByRole('link', { name: new RegExp(email.replace(/[.]/g, '\\.')) }).click();
  await expect(page).toHaveURL(/\/pengaturan\/tim\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
}

test('Owner mengubah peran CS menjadi Supervisor (konfirmasi identitas); sesi lama CS berakhir', async ({
  page,
  browser,
}) => {
  const cs = await createUser('cs', label(page));
  const csBrowser = await signIn(browser, isHp(page), cs);

  await openApp(page, '/pengaturan/tim');
  await expectNoHorizontalScroll(page);
  const members = page.getByRole('region', { name: /^Anggota tim/ });
  // Baris diri sendiri ke Keamanan akun (akun sendiri tidak dikelola dari Tim).
  await expect(members.getByRole('link', { name: new RegExp(owner.email) })).toHaveAttribute(
    'href',
    '/pengaturan/keamanan',
  );
  const row = members.getByRole('link', { name: new RegExp(cs.email.replace(/[.]/g, '\\.')) });
  await expect(row).toContainText('1 sesi aktif');
  await expect(row).toContainText('Tanpa 2FA');
  await row.click();
  await expect(page.getByRole('heading', { level: 2, name: cs.name })).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.getByLabel('Peran baru').selectOption({ label: 'Supervisor' });
  await page.getByRole('button', { name: 'Ubah peran', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ubah peran menjadi Supervisor?' });
  await expect(dialog).toContainText('wajib verifikasi dua langkah');
  await dialog.getByLabel('Password-mu').fill(owner.password);
  await withOwnerCode(async ({ code }) => {
    await dialog.getByLabel('Kode verifikasi').fill(code);
    await dialog.getByRole('button', { name: 'Ubah peran', exact: true }).click();
    await expect(dialog).toBeHidden();
  });
  await expect(page.getByRole('status').filter({ hasText: 'sekarang Supervisor' })).toBeVisible();
  await expect(page.getByText('1 sesinya dikeluarkan')).toBeVisible();
  await expect(page.getByText('Belum daftar 2FA').first()).toBeVisible();

  // Browser CS: permintaan berikutnya ditolak 401 → halaman masuk.
  csBrowser.allow(ME, 401);
  await csBrowser.page.reload();
  await expect(csBrowser.page).toHaveURL(/\/masuk/);
  csBrowser.expectClean();
  await csBrowser.close();

  // Riwayat aktivitas anggota (audit `?userId=`) memuat perubahan itu.
  await expect(
    page.getByRole('list', { name: 'Riwayat aktivitas' }).getByText('Peran pengguna diubah'),
  ).toBeVisible();
});

test('Admin: tidak bisa mengelola Owner/Admin; atur ulang 2FA Teknisi, nonaktif/aktifkan, buka lagi pendaftaran 2FA, audit + CSV', async ({
  browser,
  page: ownerPage,
}) => {
  const hp = isHp(ownerPage);
  const tag = label(ownerPage);
  const admin = await createUser('admin', tag);
  const adminTfa = await enrollRequiredTwoFactorViaApi(admin);
  const otherAdmin = await createUser('admin', `${tag}-lain`);
  const teknisi = await createUser('teknisi', tag);
  await enableTwoFactorViaApi(teknisi);
  const supervisor = await createUser('supervisor', tag);
  // Batas pendaftaran 2FA peran wajib sudah lewat (sama dengan 72 jam tanpa mendaftar).
  await e2eSql(
    `update users set two_factor_enrollment_due_at = now() - interval '1 hour' where email = $1`,
    [supervisor.email],
  );
  const backup = [...adminTfa.backupCodes];
  const nextBackup = () => backup.shift() ?? '';

  const adminBrowser = await signIn(
    browser,
    hp,
    admin,
    async () => (await nextTotp(adminTfa.secret, adminTfa.lastStep)).code,
  );
  const page = adminBrowser.page;

  // ── Owner dan Admin lain: hanya dilihat, dengan penjelasan (tanpa tombol mati) ──
  await page.goto('/pengaturan/tim');
  const members = page.getByRole('region', { name: /^Anggota tim/ });
  await expect(members.getByRole('link', { name: new RegExp(owner.email) })).toContainText(
    'Hanya dilihat',
  );
  for (const target of [
    { email: owner.email, name: owner.name },
    { email: otherAdmin.email, name: otherAdmin.name },
  ]) {
    await openMember(page, target.email, target.name);
    await expect(
      page.getByText(/^Admin hanya bisa mengelola Supervisor, CS, dan Teknisi/),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ubah peran' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nonaktifkan akun' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Sesi aktif' })).toHaveCount(0);
  }

  // ── Teknisi: atur ulang 2FA ──
  await openMember(page, teknisi.email, teknisi.name);
  await expect(page.getByText('2FA aktif').first()).toBeVisible();
  await page.getByRole('button', { name: 'Atur ulang 2FA' }).click();
  await confirmIdentity(
    page,
    'Atur ulang verifikasi dua langkah?',
    'Atur ulang 2FA',
    admin.password,
    nextBackup(),
  );
  await expect(page.getByText(/verifikasi dua langkah .* sudah diatur ulang/i)).toBeVisible();
  await expect(page.getByText('Tanpa 2FA').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Atur ulang 2FA' })).toHaveCount(0);

  // ── Nonaktifkan lalu aktifkan lagi ──
  await page.getByRole('button', { name: 'Nonaktifkan akun' }).click();
  await confirmIdentity(page, 'Nonaktifkan akun ini?', 'Nonaktifkan', admin.password, nextBackup());
  await expect(page.getByText(/sudah dinonaktifkan dan dikeluarkan/)).toBeVisible();
  await expect(page.getByText('Akun nonaktif')).toBeVisible();
  await page.getByRole('button', { name: 'Aktifkan lagi' }).click();
  await confirmIdentity(page, 'Aktifkan lagi akun ini?', 'Aktifkan', admin.password, nextBackup());
  await expect(page.getByText(/aktif lagi\. Ia sudah bisa masuk/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nonaktifkan akun' })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // ── Supervisor dengan batas daftar 2FA lewat: tidak bisa masuk → dibuka lagi → bisa ──
  const supBrowser = await openWatchedPage(browser, { hp });
  supBrowser.allow(ME, 401);
  supBrowser.allow(LOGIN, 403);
  await supBrowser.page.goto('/masuk');
  await submitLogin(supBrowser.page, supervisor.email, supervisor.password);
  const closed = supBrowser.page.getByRole('alert');
  await expect(closed).toContainText('Pendaftaran 2FA sudah ditutup');
  await expect(closed).toContainText('Minta Owner atau Admin');
  await expect(supBrowser.page).toHaveURL(/\/masuk/);

  await openMember(page, supervisor.email, supervisor.name);
  await expect(page.getByText('Batas waktu daftar 2FA sudah lewat')).toBeVisible();
  await page.getByRole('button', { name: 'Buka lagi pendaftaran' }).click();
  await confirmIdentity(
    page,
    'Buka lagi pendaftaran 2FA?',
    'Buka lagi',
    admin.password,
    nextBackup(),
  );
  await expect(page.getByText(/dibuka lagi selama 72 jam/)).toBeVisible();

  await supBrowser.page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await expect(supBrowser.page).toHaveURL(/\/verifikasi-dua-langkah/);
  supBrowser.expectClean();
  await supBrowser.close();

  // ── Audit log tersaring + ekspor CSV ──
  const teknisiId = await userId(teknisi.email);
  await page.goto(`/pengaturan/audit?userId=${teknisiId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Entri audit log' });
  await expect(list.getByText('2FA pengguna diatur ulang')).toBeVisible();
  await expect(list.getByText('Pengguna diaktifkan kembali')).toBeVisible();
  if (hp) await page.getByRole('button', { name: /^Saringan/ }).click();
  await page.getByLabel('Aksi').selectOption({ label: 'Pengguna dinonaktifkan' });
  await expect(page).toHaveURL(/action=user\.disabled/);
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByRole('listitem').first()).toContainText(teknisi.name);
  await expectNoHorizontalScroll(page);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Ekspor CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^audit-log-[a-z0-9-]+-\d{8}\.csv$/);
  const csv = readFileSync(await file.path(), 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv).toContain('Pengguna dinonaktifkan');
  expect(csv).toContain(teknisi.name);
  expect(csv).not.toContain('Pengguna diaktifkan kembali');
  await expect(
    page.getByRole('status').filter({ hasText: /Berkas CSV berisi 1 entri/ }),
  ).toBeVisible();

  adminBrowser.expectClean();
  await adminBrowser.close();
});

test('Keamanan akun → Sesi aktif: keluarkan sesi lama satu klik, sesi lebih baru dengan password, lalu semua sesi lain', async ({
  browser,
  page: ownerPage,
}) => {
  const hp = isHp(ownerPage);
  const cs = await createUser('cs', `${label(ownerPage)}-sesi`);
  const sessionsCard = (page: Page) => page.getByRole('region', { name: 'Sesi aktif' });

  const first = await signIn(browser, hp, cs);
  const second = await signIn(browser, hp, cs);

  // Dari sesi KEDUA (lebih baru): sesi pertama lebih lama → satu klik, tanpa dialog.
  await second.page.goto('/pengaturan/keamanan');
  let card = sessionsCard(second.page);
  await expect(card.getByRole('listitem')).toHaveCount(2);
  await expect(card.getByRole('listitem').filter({ hasText: 'Sesi ini' })).toHaveCount(1);
  await card.getByRole('button', { name: /^Keluarkan sesi / }).click();
  await expect(second.page.getByRole('dialog')).toHaveCount(0);
  await expect(card.getByText(/sudah dikeluarkan\.$/)).toBeVisible();
  await expect(card.getByRole('listitem')).toHaveCount(1);
  await expect(card.getByText(/Hanya sesi ini yang aktif/)).toBeVisible();
  first.allow(ME, 401);
  await first.page.reload();
  await expect(first.page).toHaveURL(/\/masuk/);
  await first.close();

  // Sesi baru (lebih baru dari sesi kedua) → mengeluarkannya wajib konfirmasi password.
  const third = await signIn(browser, hp, cs);
  await second.page.reload();
  card = sessionsCard(second.page);
  await expect(card.getByRole('listitem')).toHaveCount(2);
  await card.getByRole('button', { name: /^Keluarkan sesi / }).click();
  await confirmIdentity(second.page, /^Keluarkan sesi .+\?$/, 'Keluarkan sesi', cs.password);
  await expect(card.getByRole('listitem')).toHaveCount(1);
  third.allow(ME, 401);
  await third.page.reload();
  await expect(third.page).toHaveURL(/\/masuk/);
  await third.close();

  // Keluarkan semua sesi lain (konfirmasi password; CS tanpa 2FA → tanpa isian kode).
  const fourth = await signIn(browser, hp, cs);
  await second.page.reload();
  card = sessionsCard(second.page);
  await expect(card.getByRole('listitem')).toHaveCount(2);
  await card.getByRole('button', { name: 'Keluarkan semua sesi lain' }).click();
  const dialog = second.page.getByRole('dialog', { name: 'Keluarkan semua sesi lain?' });
  await expect(dialog.getByLabel('Kode verifikasi')).toHaveCount(0);
  await confirmIdentity(
    second.page,
    'Keluarkan semua sesi lain?',
    'Keluarkan sesi lain',
    cs.password,
  );
  await expect(card.getByText('1 sesi lain sudah dikeluarkan.')).toBeVisible();
  await expectNoHorizontalScroll(second.page);
  fourth.allow(ME, 401);
  await fourth.page.reload();
  await expect(fourth.page).toHaveURL(/\/masuk/);
  await fourth.close();

  second.expectClean();
  await second.close();
});
