import { expect, isHp, mainNav, submitLogin, test } from './fixtures';
import { openWatchedPage } from './konteks';
import { createUser } from './pengguna';

/**
 * Menu navigasi mengikuti izin peran (`permissions` di respons sesi), di HP (390) dan desktop
 * (1440): CS dan Teknisi tidak punya `broadcast.send`, jadi Broadcast tidak tampil di rail,
 * navigasi bawah, maupun layar "Lainnya"; menu lain yang memang boleh tetap ada. Owner (sesi
 * proyek) tetap melihat semua menu — dijaga `navigasi.spec.ts`.
 */
test.describe.configure({ timeout: 90_000 });

const ME = '/api/v1/auth/me';

for (const role of ['cs', 'teknisi'] as const) {
  test(`${role}: menu tanpa Broadcast; Inbox, Kontak, Tiket, Laporan, Pengaturan tetap`, async ({
    browser,
    page: ownerPage,
  }) => {
    const hp = isHp(ownerPage);
    const user = await createUser(role, `menu-${hp ? 'hp' : 'desktop'}`);
    const watched = await openWatchedPage(browser, { hp });
    watched.allow(ME, 401);
    const { page } = watched;
    try {
      await page.goto('/masuk');
      await submitLogin(page, user.email, user.password);
      await expect(page).toHaveURL(/\/inbox$/);

      const nav = mainNav(page);
      await expect(nav.getByRole('link', { name: 'Broadcast' })).toHaveCount(0);
      await expect(nav.getByRole('link', { name: 'Inbox', exact: true })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'Kontak' })).toBeVisible();

      if (hp) {
        await nav.getByRole('link', { name: 'Lainnya' }).click();
        const more = page.getByRole('navigation', { name: 'Menu lainnya' });
        await expect(more.getByRole('link', { name: 'Tiket' })).toBeVisible();
        await expect(more.getByRole('link', { name: 'Laporan' })).toBeVisible();
        await expect(more.getByRole('link', { name: 'Pengaturan' })).toBeVisible();
        await expect(more.getByRole('link', { name: 'Broadcast' })).toHaveCount(0);
      } else {
        for (const name of ['Tiket', 'Laporan', 'Pengaturan']) {
          await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
        }
      }
      watched.expectClean();
    } finally {
      await watched.close();
    }
  });
}
