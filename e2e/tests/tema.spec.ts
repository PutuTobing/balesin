import type { Page } from '@playwright/test';
import { expect, isHp, mainNav, openApp, test } from './fixtures';

const THEME_KEY = 'balesin.tema';

const dataTheme = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const bodyBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const stored = (page: Page) => page.evaluate((k) => localStorage.getItem(k), THEME_KEY);

/** Desktop: lewat menu di rail. HP: menu tema tidak ada di nav bawah, jadi lewat Pengaturan. */
async function chooseTheme(page: Page, label: string) {
  if (isHp(page)) {
    await page.goto('/pengaturan');
    await page.getByRole('radio', { name: label }).click();
  } else {
    await mainNav(page).getByRole('button', { name: 'Ganti tema' }).click();
    await page.getByRole('menuitemradio', { name: label }).click();
  }
}

test.describe('tema', () => {
  test.use({ colorScheme: 'light' });

  test('bawaan Ikuti sistem: tanpa data-theme dan tanpa penyimpanan', async ({ page }) => {
    await openApp(page, '/inbox');
    expect(await dataTheme(page)).toBeNull();
    expect(await stored(page)).toBeNull();
  });

  test('Ikuti sistem mengikuti prefers-color-scheme secara langsung', async ({ page }) => {
    await openApp(page, '/inbox');
    const light = await bodyBackground(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => bodyBackground(page)).not.toBe(light);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => bodyBackground(page)).toBe(light);
  });

  test('Gelap: berlaku langsung, tersimpan, bertahan setelah muat ulang', async ({ page }) => {
    await openApp(page, '/inbox');
    const light = await bodyBackground(page);
    await chooseTheme(page, 'Gelap');
    await expect.poll(() => dataTheme(page)).toBe('dark');
    expect(await bodyBackground(page)).not.toBe(light);
    expect(await stored(page)).toBe('dark');
    await page.reload();
    expect(await dataTheme(page)).toBe('dark');
  });

  test('pilihan Gelap mengalahkan sistem Terang, Terang mengalahkan sistem Gelap', async ({
    page,
  }) => {
    await openApp(page, '/inbox');
    await chooseTheme(page, 'Gelap');
    const dark = await bodyBackground(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await bodyBackground(page)).toBe(dark);
    await chooseTheme(page, 'Terang');
    await expect.poll(() => dataTheme(page)).toBe('light');
    expect(await bodyBackground(page)).not.toBe(dark);
  });

  test('kembali ke Ikuti sistem menghapus atribut dan kunci penyimpanan', async ({ page }) => {
    await openApp(page, '/inbox');
    await chooseTheme(page, 'Gelap');
    await chooseTheme(page, 'Ikuti sistem');
    await expect.poll(() => dataTheme(page)).toBeNull();
    expect(await stored(page)).toBeNull();
  });

  test('tanpa kedipan: atribut tema terpasang sebelum React dan tidak berubah', async ({
    page,
  }) => {
    await page.addInitScript((k) => localStorage.setItem(k, 'dark'), THEME_KEY);
    const seen: Array<string | null> = [];
    await page.exposeFunction('reportTheme', (v: string | null) => seen.push(v));
    await page.addInitScript(() => {
      const report = (window as unknown as { reportTheme: (v: string | null) => void }).reportTheme;
      // Skrip tambahan berjalan sebelum <html> ada: amati dokumen dengan subtree.
      new MutationObserver(() =>
        report(document.documentElement.getAttribute('data-theme')),
      ).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-theme'] });
    });
    await openApp(page, '/inbox');
    expect(await dataTheme(page)).toBe('dark');
    // Tidak pernah ada perubahan ke nilai selain "dark" selama pemuatan.
    expect(seen.every((v) => v === 'dark')).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
  });

  test('nilai tersimpan rusak diabaikan', async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, '<script>'), THEME_KEY);
    await openApp(page, '/inbox');
    expect(await dataTheme(page)).toBeNull();
  });

  test('penyimpanan diblokir: aplikasi tetap jalan', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('diblokir', 'SecurityError');
        },
      });
    });
    await openApp(page, '/inbox');
    await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  });

  test('tema diubah di tab lain ikut berubah di tab ini', async ({ page, context }) => {
    await openApp(page, '/inbox');
    const other = await context.newPage();
    await other.goto('/inbox');
    await other.evaluate((k) => localStorage.setItem(k, 'dark'), THEME_KEY);
    await expect.poll(() => dataTheme(page)).toBe('dark');
    await other.close();
  });

  test('Pengaturan: radio tema mencerminkan pilihan aktif dan bertahan', async ({ page }) => {
    await openApp(page, '/pengaturan');
    await expect(page.getByRole('radio', { name: 'Ikuti sistem' })).toBeChecked();
    await page.getByRole('radio', { name: 'Gelap' }).click();
    await expect(page.getByRole('radio', { name: 'Gelap' })).toBeChecked();
    await page.reload();
    await expect(page.getByRole('radio', { name: 'Gelap' })).toBeChecked();
  });

  test('tema gelap: tidak ada scroll horizontal di semua halaman', async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, 'dark'), THEME_KEY);
    for (const path of [
      '/inbox',
      '/kontak',
      '/broadcast',
      '/tiket',
      '/laporan',
      '/pengaturan',
      '/lainnya',
    ]) {
      await openApp(page, path);
      const over = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(over, path).toBeLessThanOrEqual(0);
    }
  });
});
