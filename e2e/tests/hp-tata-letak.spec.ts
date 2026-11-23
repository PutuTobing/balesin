import type { Page } from '@playwright/test';
import { inboxMocks, PHOTO_CHAT } from '../capture/mocks-inbox';
import { expect, expectNoHorizontalScroll, isHp, openApp, test } from './fixtures';

/**
 * Tampilan HP penuh (Fase 2 butir 11): di 390 dan 360 px setiap layar utama tidak punya scroll
 * horizontal dan semua target sentuh ≥ 44 px (DESIGN §2/§5). Inbox memakai data tiruan supaya
 * daftar, ruang chat, dan detail selalu berisi (bentuk data = skema bersama).
 */
test.describe.configure({ timeout: 180_000 });

const TOUCH = 44;
const CHAT = `/inbox?chat=${PHOTO_CHAT.id}`;

interface SmallTarget {
  label: string;
  width: number;
  height: number;
}

/** Elemen interaktif terlihat yang lebih kecil dari 44×44 (tautan di dalam kalimat dikecualikan). */
async function smallTargets(page: Page): Promise<SmallTarget[]> {
  return page.evaluate((min) => {
    const selector = [
      'button',
      'a[href]',
      '[role="tab"]',
      '[role="radio"]',
      '[role="menuitem"]',
      'select',
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
      'textarea',
      'label:has(input[type="checkbox"])',
      'label:has(input[type="radio"])',
    ].join(',');
    const found: { label: string; width: number; height: number }[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || element.closest('[aria-hidden="true"]')) continue;
      // Tautan di tengah kalimat (WCAG 2.5.8 pengecualian "inline").
      if (element.tagName === 'A' && element.closest('p, li > span, dd')) {
        const parent = element.parentElement;
        if (parent && parent.textContent.trim() !== element.textContent.trim()) continue;
      }
      // Elemen di luar layar (mis. panel tersembunyi yang digeser) tidak bisa diketuk.
      if (rect.right <= 0 || rect.left >= window.innerWidth) continue;
      // Isian/tombol di dalam bingkai ber-garis tepi 1px (kolom isian, saklar segmen): area
      // ketuknya = bingkai itu.
      const frame = element.parentElement?.getBoundingClientRect();
      const framed =
        frame !== undefined &&
        frame.height >= min - 0.5 &&
        frame.height <= min + 16 &&
        frame.top <= rect.top + 0.5 &&
        frame.bottom >= rect.bottom - 0.5;
      const height = framed ? Math.max(rect.height, frame.height) : rect.height;
      if (rect.width + 0.5 < min || height + 0.5 < min) {
        const name =
          element.getAttribute('aria-label') ??
          element.textContent.trim().slice(0, 40) ??
          element.tagName;
        found.push({
          label: `${element.tagName.toLowerCase()} "${name}"`,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }
    return found;
  }, TOUCH);
}

async function audit(page: Page, name: string): Promise<void> {
  await expectNoHorizontalScroll(page);
  expect.soft(await smallTargets(page), `target sentuh < 44px di ${name}`).toEqual([]);
}

const SCREENS: { name: string; path: string; ready: string; mock?: boolean }[] = [
  { name: 'inbox', path: '/inbox', ready: 'text=Budi Santoso', mock: true },
  { name: 'ruang chat', path: CHAT, ready: '[aria-label="Tulis balasan"]', mock: true },
  { name: 'detail chat', path: `${CHAT}&detail=1`, ready: 'text=Nama profil WhatsApp', mock: true },
  { name: 'lainnya', path: '/lainnya', ready: 'h1' },
  { name: 'pengaturan', path: '/pengaturan', ready: '[role="radiogroup"]' },
  { name: 'keamanan', path: '/pengaturan/keamanan', ready: 'h2' },
  { name: 'tim', path: '/pengaturan/tim', ready: 'h2' },
  { name: 'channel', path: '/pengaturan/channel', ready: 'h2' },
  { name: 'email', path: '/pengaturan/email', ready: 'h2' },
  { name: 'audit', path: '/pengaturan/audit', ready: 'h1' },
  { name: 'balasan cepat', path: '/pengaturan/balasan-cepat', ready: 'h1' },
  { name: 'batas kirim', path: '/pengaturan/batas-kirim', ready: 'text=Rem darurat', mock: true },
  { name: 'notifikasi', path: '/pengaturan/notifikasi', ready: 'text=Perangkat ini' },
  { name: 'api key', path: '/pengaturan/api-key', ready: 'text=Daftar API key' },
  { name: 'webhook', path: '/pengaturan/webhook', ready: 'text=Daftar webhook' },
  { name: 'kontak', path: '/kontak', ready: 'h1' },
  { name: 'broadcast', path: '/broadcast', ready: 'h1' },
];

for (const width of [390, 360]) {
  test(`HP ${String(width)} px: tanpa scroll horizontal, target sentuh ≥ 44px`, async ({
    page,
  }) => {
    test.skip(!isHp(page), 'audit tata letak HP');
    await page.setViewportSize({ width, height: 844 });
    for (const screen of SCREENS) {
      await test.step(screen.name, async () => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        if (screen.mock) await inboxMocks(page);
        await openApp(page, screen.path);
        await page.locator(screen.ready).first().waitFor();
        await audit(page, `${screen.name} (${String(width)} px)`);
      });
    }
  });
}

test('layar bertumpuk HP: inbox → chat → detail → berkas, kembali lewat tombol & gesture', async ({
  page,
}) => {
  test.skip(!isHp(page), 'navigasi bertumpuk HP');
  await inboxMocks(page);
  await openApp(page, '/inbox');
  const nav = page.getByRole('navigation', { name: 'Navigasi utama' });
  await page.getByRole('region', { name: 'Daftar chat' }).getByText('Budi Santoso').click();
  await expect(page).toHaveURL(/chat=/);
  await expect(nav).toBeHidden();

  // Kepala chat → detail (layar ketiga), lalu tab Berkas.
  await page
    .getByRole('button', { name: /Lihat detail|Tampilkan detail/ })
    .first()
    .click();
  await expect(page).toHaveURL(/detail=1/);
  const detail = page.getByRole('complementary', { name: 'Detail kontak' });
  await detail.getByRole('tab', { name: 'Berkas' }).click();
  await expect(detail.getByRole('radio', { name: 'Media' })).toBeVisible();

  // Gesture/tombol kembali browser: detail → chat → daftar.
  await page.goBack();
  await expect(page).not.toHaveURL(/detail=1/);
  await expect(page.getByRole('textbox', { name: 'Tulis balasan' })).toBeVisible();
  await page.goBack();
  await expect(page).not.toHaveURL(/chat=/);
  await expect(nav).toBeVisible();

  // Tombol kembali di layar: chat → detail → "Kembali ke chat" → panah kembali → daftar.
  await page.getByRole('region', { name: 'Daftar chat' }).getByText('Budi Santoso').click();
  await page
    .getByRole('button', { name: /Lihat detail|Tampilkan detail/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Kembali ke chat' }).click();
  await expect(page).not.toHaveURL(/detail=1/);
  await page
    .getByRole('button', { name: /^Kembali/ })
    .first()
    .click();
  await expect(page).not.toHaveURL(/chat=/);
});

test('Pengaturan HP: sub-halaman punya tombol kembali, gesture kembali ke Pengaturan', async ({
  page,
}) => {
  test.skip(!isHp(page), 'navigasi bertumpuk HP');
  await openApp(page, '/pengaturan');
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Notifikasi/ })
    .click();
  await expect(page).toHaveURL(/\/pengaturan\/notifikasi$/);
  // Nama lengkap, bukan `/^Kembali/` + first(): selagi sub-halaman (lazy) dimuat, header
  // Pengaturan lama ("Kembali ke Lainnya") masih terpasang dan bisa terklik lebih dulu.
  await page.getByRole('link', { name: 'Kembali ke Pengaturan', exact: true }).click();
  await expect(page).toHaveURL(/\/pengaturan$/);
  await page
    .getByRole('main')
    .getByRole('link', { name: /^Keamanan akun/ })
    .click();
  await expect(page).toHaveURL(/\/pengaturan\/keamanan$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/pengaturan$/);
});

test('keyboard layar (CS3): composer tetap terlihat saat visualViewport mengecil', async ({
  page,
}) => {
  test.skip(!isHp(page), 'keyboard HP');
  // iOS Safari: keyboard mengecilkan visualViewport TANPA mengecilkan jendela (tiruan).
  await page.addInitScript(() => {
    const fake = new EventTarget();
    let height = window.innerHeight;
    Object.defineProperties(fake, {
      height: { get: () => height },
      width: { get: () => window.innerWidth },
      offsetTop: { get: () => 0 },
      offsetLeft: { get: () => 0 },
      pageTop: { get: () => 0 },
      pageLeft: { get: () => 0 },
      scale: { get: () => 1 },
    });
    Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
    Object.assign(window, {
      setKeyboard: (open: number) => {
        height = window.innerHeight - open;
        fake.dispatchEvent(new Event('resize'));
      },
    });
  });
  await inboxMocks(page);
  await openApp(page, CHAT);
  const box = page.getByRole('textbox', { name: 'Tulis balasan' });
  await box.focus();
  await page.evaluate(() =>
    (window as unknown as { setKeyboard: (n: number) => void }).setKeyboard(340),
  );
  const visible = await page.evaluate(() => window.innerHeight - 340);
  await expect
    .poll(async () => {
      const rect = await box.boundingBox();
      return rect ? rect.y + rect.height : Infinity;
    })
    .toBeLessThanOrEqual(visible);
  await expect(page.getByRole('button', { name: 'Kirim', exact: true })).toBeInViewport();
  await expectNoHorizontalScroll(page);

  // Keyboard ditutup → kerangka kembali ke tinggi penuh.
  await page.evaluate(() =>
    (window as unknown as { setKeyboard: (n: number) => void }).setKeyboard(0),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (document.querySelector('main')?.parentElement as HTMLElement).style.height,
      ),
    )
    .toBe('');

  // Android/Chrome (resizes-content): jendela sendiri yang mengecil.
  await page.setViewportSize({ width: 390, height: 480 });
  await expect(box).toBeInViewport();
});
