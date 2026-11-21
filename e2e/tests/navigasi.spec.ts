import { expect, expectNoHorizontalScroll, isHp, mainNav, openApp, test } from './fixtures';

const PRIMARY = [
  { name: 'Inbox', path: '/inbox' },
  { name: 'Kontak', path: '/kontak' },
  { name: 'Broadcast', path: '/broadcast' },
] as const;

const SECONDARY = [
  { name: 'Tiket', path: '/tiket' },
  { name: 'Laporan', path: '/laporan' },
  { name: 'Pengaturan', path: '/pengaturan' },
] as const;

test.describe('navigasi utama', () => {
  test('alamat / dialihkan ke /inbox', async ({ page }) => {
    await openApp(page, '/');
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  });

  for (const item of PRIMARY) {
    test(`menu ${item.name} membuka halamannya`, async ({ page }) => {
      await openApp(page, '/inbox');
      const link = mainNav(page).getByRole('link', { name: item.name, exact: true });
      await link.click();
      await expect(page).toHaveURL(new RegExp(`${item.path}$`));
      await expect(page.getByRole('heading', { level: 1, name: item.name })).toBeVisible();
      await expect(page).toHaveTitle(new RegExp(`^${item.name} · `));
      await expect(link).toHaveAttribute('aria-current', 'page');
      await expectNoHorizontalScroll(page);
    });
  }

  for (const item of SECONDARY) {
    test(`${item.name} dapat dibuka`, async ({ page }) => {
      await openApp(page, '/inbox');
      if (isHp(page)) {
        // HP: Tiket/Laporan/Pengaturan ada di balik "Lainnya".
        await expect(mainNav(page).getByRole('link', { name: item.name })).toHaveCount(0);
        await mainNav(page).getByRole('link', { name: 'Lainnya' }).click();
        await expect(page).toHaveURL(/\/lainnya$/);
        await page
          .getByRole('navigation', { name: 'Menu lainnya' })
          .getByRole('link', { name: item.name })
          .click();
      } else {
        await mainNav(page).getByRole('link', { name: item.name, exact: true }).click();
      }
      await expect(page).toHaveURL(new RegExp(`${item.path}$`));
      await expect(page.getByRole('heading', { level: 1, name: item.name })).toBeVisible();
      await expectNoHorizontalScroll(page);
    });
  }

  test('HP: "Lainnya" aktif sebagai bagian saat membuka Tiket; ada tombol kembali', async ({
    page,
  }) => {
    test.skip(!isHp(page), 'Khusus HP');
    await openApp(page, '/tiket');
    await expect(mainNav(page).getByRole('link', { name: 'Lainnya' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await page.getByRole('link', { name: 'Kembali ke Lainnya' }).click();
    await expect(page).toHaveURL(/\/lainnya$/);
    await expect(page.getByText(/versi \d+\.\d+\.\d+/)).toBeVisible();
  });

  test('desktop: rail memuat semua menu dan lebarnya 64px', async ({ page }) => {
    test.skip(isHp(page), 'Khusus desktop');
    await openApp(page, '/inbox');
    for (const name of ['Inbox', 'Kontak', 'Broadcast', 'Tiket', 'Laporan', 'Pengaturan']) {
      await expect(mainNav(page).getByRole('link', { name, exact: true })).toBeVisible();
    }
    await expect(mainNav(page).getByRole('link', { name: 'Lainnya' })).toBeHidden();
    const box = await mainNav(page).boundingBox();
    expect(box?.width).toBe(64);
  });

  test('HP: navigasi bawah berisi 4 item, menempel di dasar layar', async ({ page }) => {
    test.skip(!isHp(page), 'Khusus HP');
    await openApp(page, '/inbox');
    const links = mainNav(page).getByRole('link').filter({ visible: true });
    await expect(links).toHaveCount(4);
    const box = await mainNav(page).boundingBox();
    const viewport = page.viewportSize()!;
    expect(box!.y + box!.height).toBeCloseTo(viewport.height, 0);
    expect(box!.width).toBe(viewport.width);
  });

  test('target sentuh/klik navigasi minimal 44px', async ({ page }) => {
    await openApp(page, '/inbox');
    const links = mainNav(page).getByRole('link').filter({ visible: true });
    const count = await links.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await links.nth(i).boundingBox();
      expect(box!.height, `tinggi item ${i}`).toBeGreaterThanOrEqual(44);
      expect(box!.width, `lebar item ${i}`).toBeGreaterThanOrEqual(44);
    }
  });

  test('tombol kembali/maju browser mengikuti riwayat', async ({ page }) => {
    await openApp(page, '/inbox');
    const go = (name: string) => mainNav(page).getByRole('link', { name, exact: true }).click();
    await go('Kontak');
    await go('Broadcast');
    await page.goBack();
    await expect(page).toHaveURL(/\/kontak$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Kontak' })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/inbox$/);
    await page.goForward();
    await expect(page).toHaveURL(/\/kontak$/);
  });

  test('muat ulang di rute dalam tetap di halaman yang sama', async ({ page }) => {
    await openApp(page, '/laporan');
    await page.reload();
    await expect(page).toHaveURL(/\/laporan$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Laporan' })).toBeVisible();
  });

  test('alamat dengan garis miring penutup tetap terbuka', async ({ page }) => {
    await openApp(page, '/kontak/');
    await expect(page.getByRole('heading', { level: 1, name: 'Kontak' })).toBeVisible();
  });

  test('pindah halaman memindahkan fokus ke konten utama', async ({ page }) => {
    await openApp(page, '/inbox');
    await mainNav(page).getByRole('link', { name: 'Kontak', exact: true }).click();
    await expect(page.getByRole('main')).toBeFocused();
  });
});

test.describe('halaman tidak ditemukan', () => {
  test('alamat ngawur menampilkan 404 di dalam kerangka aplikasi', async ({ page }) => {
    await openApp(page, '/halaman-yang-tidak-ada');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Halaman tidak ditemukan' }),
    ).toBeVisible();
    await expect(page.getByText('/halaman-yang-tidak-ada')).toBeVisible();
    await expect(mainNav(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole('link', { name: 'Kembali ke Inbox' }).click();
    await expect(page).toHaveURL(/\/inbox$/);
  });

  test('judul tab 404 memakai nama halaman', async ({ page }) => {
    await openApp(page, '/tidak-ada');
    await expect(page).toHaveTitle(/^Halaman tidak ditemukan · /);
  });
});
