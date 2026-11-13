import { test as base, expect, type Page } from '@playwright/test';

/**
 * Fixture bersama: setiap tes otomatis gagal bila ada error/peringatan console,
 * error halaman yang tak tertangkap, atau request yang gagal / berstatus >= 400.
 */
export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
          problems.push(`console.${msg.type()}: ${msg.text()}`);
        }
      });
      page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
      page.on('requestfailed', (request) => {
        // Pembatalan karena navigasi/preload bukan kegagalan sungguhan.
        if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
        problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`);
      });
      page.on('response', (response) => {
        if (response.status() >= 400) {
          problems.push(`http ${response.status()}: ${response.url()}`);
        }
      });
      await use(problems);
      expect(problems, 'error console / request gagal').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export function isHp(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1440) <= 640;
}

export function mainNav(page: Page) {
  return page.getByRole('navigation', { name: 'Navigasi utama' });
}

/** Lebar dokumen tidak boleh melebihi lebar jendela (tidak ada scroll horizontal). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.doc, 'scroll horizontal di <html>').toBeLessThanOrEqual(0);
  expect(overflow.body, 'scroll horizontal di <body>').toBeLessThanOrEqual(0);
}

/** Tunggu aplikasi selesai dimuat (konten utama muncul). */
export async function openApp(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('main')).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}
