import { expect, expectNoHorizontalScroll, isHp, mainNav, openApp, test } from './fixtures';

const ROUTES = ['/inbox', '/kontak', '/broadcast', '/tiket', '/laporan', '/pengaturan', '/lainnya'];

test.describe('keyboard dan aksesibilitas dasar', () => {
  test('skip link: tab pertama, tampil saat fokus, memindahkan fokus ke konten', async ({
    page,
  }) => {
    test.skip(isHp(page), 'Keyboard fisik: desktop');
    await openApp(page, '/inbox');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Lewati ke konten' });
    await expect(skip).toBeFocused();
    const box = await skip.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
  });

  test('fokus terlihat pada link navigasi', async ({ page }) => {
    test.skip(isHp(page), 'Keyboard fisik: desktop');
    await openApp(page, '/inbox');
    await page.keyboard.press('Tab'); // skip link
    await page.keyboard.press('Tab'); // logo
    await page.keyboard.press('Tab'); // Inbox
    const focused = page.locator(':focus');
    await expect(focused).toHaveAttribute('href', '/inbox');
    const ring = await focused.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), shadow: s.boxShadow };
    });
    const visible = (ring.style !== 'none' && ring.width > 0) || ring.shadow !== 'none';
    expect(visible, JSON.stringify(ring)).toBe(true);
  });

  test('fokus terlihat pada kolom pencarian, tab, dan tombol (keyboard)', async ({ page }) => {
    test.skip(isHp(page), 'Keyboard fisik: desktop');
    await openApp(page, '/inbox');
    const targets = [
      page.getByRole('searchbox', { name: 'Cari chat' }),
      page.getByRole('tab', { name: 'Semua' }),
      page.getByRole('button', { name: 'Sembunyikan detail' }),
    ];
    for (const locator of targets) {
      // Fokus lewat keyboard (bukan klik) supaya :focus-visible aktif.
      await page.keyboard.press('Tab');
      await locator.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(locator).toBeFocused();
      const ring = await locator.evaluate((el) => {
        const s = getComputedStyle(el);
        const p = getComputedStyle(el.parentElement!);
        return [s.outlineStyle, s.outlineWidth, s.boxShadow, p.boxShadow, p.outlineStyle].join('|');
      });
      expect(ring, 'tidak ada indikator fokus').not.toBe('none|0px|none|none|none');
    }
  });

  test('menu tema bisa dipakai keyboard; Escape menutup dan fokus kembali', async ({ page }) => {
    test.skip(isHp(page), 'Menu tema ada di rail desktop');
    await openApp(page, '/inbox');
    const trigger = mainNav(page).getByRole('button', { name: 'Ganti tema' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('tiap halaman: satu h1, satu main, satu nav utama, lang=id', async ({ page }) => {
    for (const path of ROUTES) {
      await openApp(page, path);
      await expect(page.getByRole('heading', { level: 1 }), path).toHaveCount(1);
      await expect(page.getByRole('main'), path).toHaveCount(1);
      await expect(mainNav(page), path).toHaveCount(1);
      await expect(page.locator('html')).toHaveAttribute('lang', 'id');
    }
  });

  test('tidak ada gambar tanpa alt dan tombol/link tanpa nama', async ({ page }) => {
    for (const path of ROUTES) {
      await openApp(page, path);
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        document
          .querySelectorAll('img:not([alt])')
          .forEach((e) => out.push(`img tanpa alt: ${e.outerHTML.slice(0, 80)}`));
        document.querySelectorAll('button, a[href]').forEach((el) => {
          const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
          if (!name && !el.getAttribute('aria-labelledby')) {
            out.push(`tanpa nama: ${el.outerHTML.slice(0, 100)}`);
          }
        });
        return out;
      });
      expect(bad, path).toEqual([]);
    }
  });

  test('prefers-reduced-motion: tidak ada transisi/animasi panjang', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page, '/inbox');
    const longest = await page.evaluate(() => {
      let max = 0;
      document.querySelectorAll('*').forEach((el) => {
        const s = getComputedStyle(el);
        for (const raw of [...s.transitionDuration.split(','), ...s.animationDuration.split(',')]) {
          const v = raw.trim();
          const ms = v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000;
          if (!Number.isNaN(ms)) max = Math.max(max, ms);
        }
      });
      return max;
    });
    expect(longest).toBeLessThanOrEqual(10);
  });
});

test.describe('ukuran antara dan tata letak', () => {
  for (const width of [641, 700, 768, 900, 1023, 1024, 1100]) {
    test(`tablet ${width}px: tanpa scroll horizontal, rail 64px, daftar+chat tampil`, async ({
      page,
    }) => {
      test.skip(isHp(page), 'Ukuran diatur sendiri; cukup satu project');
      await page.setViewportSize({ width, height: 800 });
      await openApp(page, '/inbox');
      await expectNoHorizontalScroll(page);
      expect((await mainNav(page).boundingBox())!.width).toBe(64);
      await expect(page.getByRole('region', { name: 'Daftar chat' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Ruang chat' })).toBeVisible();
    });
  }

  for (const width of [320, 360, 640]) {
    test(`HP sempit ${width}px: tanpa scroll horizontal, nav bawah muat`, async ({ page }) => {
      test.skip(isHp(page), 'Ukuran diatur sendiri; cukup satu project');
      await page.setViewportSize({ width, height: 700 });
      for (const path of ['/inbox', '/kontak', '/lainnya', '/pengaturan']) {
        await openApp(page, path);
        await expectNoHorizontalScroll(page);
      }
      const links = mainNav(page).getByRole('link').filter({ visible: true });
      const n = await links.count();
      for (let i = 0; i < n; i++) {
        const box = await links.nth(i).boundingBox();
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
      }
    });
  }

  test('tablet: panel detail melayang, tertutup bawaan, Escape (fokus di panel) menutup', async ({
    page,
  }) => {
    test.skip(isHp(page), 'Ukuran diatur sendiri');
    await page.setViewportSize({ width: 800, height: 800 });
    await openApp(page, '/inbox');
    const panel = page.getByRole('complementary', { name: 'Detail kontak' });
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: 'Tampilkan detail' }).focus();
    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  });

  // Dibuka dengan mouse/sentuh, fokus tidak masuk ke panel; Escape tetap harus menutupnya.
  test('tablet: Escape menutup panel yang dibuka dengan mouse', async ({ page }) => {
    test.skip(isHp(page), 'Ukuran diatur sendiri');
    await page.setViewportSize({ width: 800, height: 800 });
    await openApp(page, '/inbox');
    await page.getByRole('button', { name: 'Tampilkan detail' }).click();
    const panel = page.getByRole('complementary', { name: 'Detail kontak' });
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0, { timeout: 1500 });
  });

  test('tidak ada lompatan layout saat halaman dimuat', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __cls: number };
      w.__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as Array<{
          value: number;
          hadRecentInput: boolean;
        }>) {
          if (!e.hadRecentInput) w.__cls += e.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    for (const path of ['/inbox', '/kontak', '/pengaturan']) {
      await openApp(page, path);
      await page.waitForTimeout(500);
      const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
      expect(cls, path).toBeLessThan(0.02);
    }
  });

  test('teks tidak terpotong di wadahnya', async ({ page }) => {
    for (const path of ROUTES) {
      await openApp(page, path);
      const clipped = await page.evaluate(() => {
        const out: string[] = [];
        document.querySelectorAll('h1, h2, h3, button, a, [role=tab], p').forEach((el) => {
          const h = el as HTMLElement;
          const s = getComputedStyle(h);
          if (h.offsetParent === null) return;
          if (
            (s.overflow === 'hidden' || s.textOverflow === 'ellipsis') &&
            s.position !== 'absolute' &&
            h.scrollWidth > h.clientWidth + 1 &&
            h.clientWidth > 1
          ) {
            const text = (h.textContent ?? '').trim().slice(0, 40);
            out.push(`${h.tagName} "${text}" ${h.scrollWidth}>${h.clientWidth}`);
          }
        });
        return out;
      });
      expect(clipped, path).toEqual([]);
    }
  });
});
