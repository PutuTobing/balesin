import { test as base, expect, type Page } from '@playwright/test';
import { E2E_OWNER } from '../stack/env';

/**
 * Respons gagal yang memang diharapkan sebuah tes, mis. `{ path: '/api/v1/auth/me', status: 401 }`
 * di halaman masuk (belum ada sesi). Selain yang didaftarkan, setiap respons ≥ 400 menggagalkan tes.
 */
export interface ExpectedHttpError {
  path: string;
  status: number;
}

/**
 * Fixture bersama: setiap tes otomatis gagal bila ada error/peringatan console,
 * error halaman yang tak tertangkap, atau request yang gagal / berstatus >= 400
 * (kecuali yang didaftarkan lewat `expectHttpError`).
 */
export const test = base.extend<{
  httpAllowList: ExpectedHttpError[];
  expectHttpError: (path: string, status: number) => void;
  problems: string[];
}>({
  // eslint-disable-next-line no-empty-pattern -- Playwright mewajibkan destrukturisasi fixture
  httpAllowList: async ({}, use) => {
    await use([]);
  },
  expectHttpError: async ({ httpAllowList }, use) => {
    await use((path, status) => {
      httpAllowList.push({ path, status });
    });
  },
  problems: [
    async ({ page, httpAllowList }, use) => {
      const isExpected = (url: string, status: number) => {
        let pathname = url;
        try {
          pathname = new URL(url).pathname;
        } catch {
          // URL tidak lengkap: pakai apa adanya.
        }
        return httpAllowList.some((rule) => rule.status === status && pathname === rule.path);
      };

      const problems: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() !== 'error' && msg.type() !== 'warning') return;
        // Browser mencatat setiap respons ≥ 400 sebagai error console; yang diharapkan diabaikan.
        const failed = /status of (\d{3})/.exec(msg.text());
        if (failed && isExpected(msg.location().url, Number(failed[1]))) return;
        problems.push(`console.${msg.type()}: ${msg.text()}`);
      });
      page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
      page.on('requestfailed', (request) => {
        // Pembatalan karena navigasi/preload bukan kegagalan sungguhan.
        if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
        problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`);
      });
      page.on('response', (response) => {
        if (response.status() >= 400 && !isExpected(response.url(), response.status())) {
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

/** Isi form masuk dan kirim. */
export async function submitLogin(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
}

export const owner = E2E_OWNER;
