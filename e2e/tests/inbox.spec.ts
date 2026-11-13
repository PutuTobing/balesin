import { expect, expectNoHorizontalScroll, isHp, openApp, test } from './fixtures';

const TABS = [
  { name: 'Semua', param: null },
  { name: 'Bot', param: 'bot' },
  { name: 'Belum dilayani', param: 'belum-dilayani' },
  { name: 'Dilayani', param: 'dilayani' },
  { name: 'Selesai', param: 'selesai' },
] as const;

test.describe('inbox', () => {
  test('menampilkan lima tab, "Semua" terpilih secara bawaan', async ({ page }) => {
    await openApp(page, '/inbox');
    const tabs = page.getByRole('tablist', { name: 'Saring chat menurut status' });
    await expect(tabs.getByRole('tab')).toHaveCount(5);
    await expect(tabs.getByRole('tab', { name: 'Semua' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Belum ada chat', { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  for (const tab of TABS) {
    test(`tab ${tab.name} tersimpan di URL dan bertahan setelah muat ulang`, async ({ page }) => {
      await openApp(page, '/inbox');
      await page.getByRole('tab', { name: tab.name, exact: true }).click();
      if (tab.param) await expect(page).toHaveURL(new RegExp(`[?&]tab=${tab.param}$`));
      else await expect(page).not.toHaveURL(/tab=/);
      await page.reload();
      await expect(page.getByRole('tab', { name: tab.name, exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
  }

  test('membuka alamat dengan ?tab= langsung memilih tab itu', async ({ page }) => {
    await openApp(page, '/inbox?tab=dilayani');
    await expect(page.getByRole('tab', { name: 'Dilayani', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText('Belum ada chat yang dilayani')).toBeVisible();
  });

  test('ganti tab tidak menumpuk riwayat browser', async ({ page }) => {
    await openApp(page, '/kontak');
    await page.goto('/inbox');
    await page.getByRole('tab', { name: 'Bot' }).click();
    await page.getByRole('tab', { name: 'Selesai' }).click();
    await page.goBack();
    await expect(page).toHaveURL(/\/kontak$/);
  });

  for (const bad of [
    '?tab=ngawur',
    '?tab=',
    '?tab=bot&tab=selesai',
    '?tab[]=bot',
    '?tab=%00',
    '?x=1',
  ]) {
    test(`query tak dikenal "${bad}" tidak membuat halaman gagal`, async ({ page }) => {
      await openApp(page, `/inbox${bad}`);
      await expect(page.getByRole('tab', { selected: true })).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
    });
  }

  test('keyboard pada tab: panah kanan memilih tab berikutnya', async ({ page }) => {
    await openApp(page, '/inbox');
    await page.getByRole('tab', { name: 'Semua' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Bot' })).toBeFocused();
  });

  test('pencarian tanpa hasil menampilkan pesan dan bisa dihapus', async ({ page }) => {
    await openApp(page, '/inbox');
    const search = page.getByRole('searchbox', { name: 'Cari chat' });
    await search.fill('zzzz tidak ada');
    await expect(page.getByText('Tidak ketemu chat untuk “zzzz tidak ada”')).toBeVisible();
    await expect(page.getByText('Coba nama atau nomor lain.')).toBeVisible();
    await page.getByRole('button', { name: 'Hapus pencarian' }).last().click();
    await expect(search).toHaveValue('');
    await expect(page.getByText('Belum ada chat', { exact: true })).toBeVisible();
  });

  test('pencarian berisi HTML dan teks panjang tidak merusak tata letak', async ({ page }) => {
    await openApp(page, '/inbox');
    const search = page.getByRole('searchbox', { name: 'Cari chat' });
    await search.fill('<img src=x onerror=alert(1)>' + 'x'.repeat(300));
    await expect(page.getByText(/Tidak ketemu chat untuk/)).toBeVisible();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test('pencarian hanya spasi dianggap kosong', async ({ page }) => {
    await openApp(page, '/inbox');
    await page.getByRole('searchbox', { name: 'Cari chat' }).fill('   ');
    await expect(page.getByText('Belum ada chat', { exact: true })).toBeVisible();
  });

  test('pencarian bertahan saat pindah tab', async ({ page }) => {
    await openApp(page, '/inbox');
    const search = page.getByRole('searchbox', { name: 'Cari chat' });
    await search.fill('budi');
    await page.getByRole('tab', { name: 'Bot' }).click();
    await expect(search).toHaveValue('budi');
    await expect(page.getByText(/Tidak ketemu chat untuk “budi”/)).toBeVisible();
  });

  test('desktop: panel detail bisa disembunyikan, ditampilkan, dan pilihan diingat', async ({
    page,
  }) => {
    test.skip(isHp(page), 'Khusus desktop');
    await openApp(page, '/inbox');
    const panel = page.getByRole('complementary', { name: 'Detail kontak' });
    await expect(panel).toBeVisible();
    await page.getByRole('button', { name: 'Sembunyikan detail' }).click();
    await expect(panel).toHaveCount(0);
    await page.reload();
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: 'Tampilkan detail' }).click();
    await expect(panel).toBeVisible();
    await page.reload();
    await expect(panel).toBeVisible();
  });

  test('desktop: tiga panel berdampingan (daftar 360, detail 340)', async ({ page }) => {
    test.skip(isHp(page), 'Khusus desktop');
    await openApp(page, '/inbox');
    const list = await page.getByRole('region', { name: 'Daftar chat' }).boundingBox();
    const chat = await page.getByRole('region', { name: 'Ruang chat' }).boundingBox();
    const detail = await page.getByRole('complementary', { name: 'Detail kontak' }).boundingBox();
    expect(list!.width).toBeCloseTo(360, 0);
    expect(detail!.width).toBeCloseTo(340, 0);
    expect(chat!.width).toBeGreaterThan(300);
    expect(list!.x + list!.width).toBeLessThanOrEqual(chat!.x + 1);
    expect(chat!.x + chat!.width).toBeLessThanOrEqual(detail!.x + 1);
  });

  test('desktop: fokus keyboard pindah ke tombol pasangan saat panel ditutup/dibuka', async ({
    page,
  }) => {
    test.skip(isHp(page), 'Khusus desktop');
    await openApp(page, '/inbox');
    await page.getByRole('button', { name: 'Sembunyikan detail' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Tampilkan detail' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Sembunyikan detail' })).toBeFocused();
  });

  test('HP: daftar chat memenuhi layar, tanpa panel detail', async ({ page }) => {
    test.skip(!isHp(page), 'Khusus HP');
    await openApp(page, '/inbox');
    await expect(page.getByRole('complementary', { name: 'Detail kontak' })).toHaveCount(0);
    const list = await page.getByRole('region', { name: 'Daftar chat' }).boundingBox();
    expect(list!.width).toBeCloseTo(390, 0);
    await expect(page.getByRole('region', { name: 'Ruang chat' })).toBeHidden();
  });

  test('HP: kolom pencarian cukup besar dan font minimal 16px (tanpa zoom iOS)', async ({
    page,
  }) => {
    test.skip(!isHp(page), 'Khusus HP');
    await openApp(page, '/inbox');
    const field = page.getByRole('searchbox', { name: 'Cari chat' });
    const box = await field.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    const size = await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(16);
  });

  test('HP: tinggi tab nyaman disentuh', async ({ page }) => {
    test.skip(!isHp(page), 'Khusus HP');
    await openApp(page, '/inbox');
    const tabs = page.getByRole('tab');
    for (let i = 0; i < 5; i++) {
      const box = await tabs.nth(i).boundingBox();
      expect(box!.height, `tinggi tab ${i}`).toBeGreaterThanOrEqual(36);
    }
  });
});
