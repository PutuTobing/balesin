import { expect, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { BASE_URL, VIEWPORTS } from '../viewports';
import type { ExpectedHttpError } from './fixtures';

/**
 * Browser kedua (penerima undangan, tamu yang lupa password, sesi lama) di dalam satu tes, dengan
 * pengawasan yang sama seperti fixture `page`: error console, error halaman, dan respons ≥ 400
 * yang tidak didaftarkan di `allow` menggagalkan tes lewat `expectClean()`.
 */
export interface WatchedPage {
  page: Page;
  allow: (path: string, status: number) => void;
  expectClean: () => void;
  close: () => Promise<void>;
}

export async function openWatchedPage(
  browser: Browser,
  options: BrowserContextOptions & { hp?: boolean } = {},
): Promise<WatchedPage> {
  const { hp = false, ...contextOptions } = options;
  const context = await browser.newContext({
    ...(hp
      ? { viewport: VIEWPORTS.hp, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: VIEWPORTS.desktop }),
    baseURL: BASE_URL,
    locale: 'id-ID',
    timezoneId: 'Asia/Jakarta',
    // WAJIB kosong: tanpa ini Playwright memakai `storageState` proyek (sesi Owner), dan
    // menerima undangan dari browser itu mencabut sesi Owner yang dipakai tes lain.
    storageState: { cookies: [], origins: [] },
    ...contextOptions,
  });
  const page = await context.newPage();
  const allowed: ExpectedHttpError[] = [];
  const problems: string[] = [];
  const isExpected = (url: string, status: number) => {
    let pathname = url;
    try {
      pathname = new URL(url).pathname;
    } catch {
      // URL tidak lengkap.
    }
    return allowed.some((rule) => rule.status === status && rule.path === pathname);
  };
  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const failed = /status of (\d{3})/.exec(msg.text());
    if (failed && isExpected(msg.location().url, Number(failed[1]))) return;
    // Sama dengan fixture `page` (fixtures.ts): skrip sisipan Playwright yang ditolak sandbox iframe
    // isi email menu Email (dokumen satu baris tanpa skrip → baris > 0 / tanpa URL = sisipan).
    const at = msg.location();
    if (
      /^Blocked script execution in 'https?:\/\/[^/']+\/api\/v1\/mail\/view\//.test(msg.text()) &&
      (at.url === '' || (at.url.includes('/api/v1/mail/view/') && at.lineNumber > 0))
    ) {
      return;
    }
    problems.push(`console.${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => {
    if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
    problems.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !isExpected(response.url(), response.status())) {
      problems.push(`http ${response.status()}: ${response.url()}`);
    }
  });
  return {
    page,
    allow: (path, status) => allowed.push({ path, status }),
    expectClean: () =>
      expect(problems, 'error console / request gagal (browser kedua)').toEqual([]),
    close: () => context.close(),
  };
}

/**
 * Token dari tautan email tidak boleh tersisa di alamat: fragment dibuang begitu halamannya
 * terbuka (ditunggu, karena halaman dimuat dulu sebelum membaca token).
 */
export async function expectNoTokenInUrl(page: Page): Promise<void> {
  await expect(page).not.toHaveURL(/#|token/);
}
