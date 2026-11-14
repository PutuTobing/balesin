import type { Page } from '@playwright/test';
import { expect, expectNoHorizontalScroll, isHp, openApp, test } from './fixtures';
import { createUser, e2eSql, userId } from './pengguna';

/**
 * Pengaturan → Audit log (Fase 1 butir 6), di HP dan desktop: halaman per 50 entri dengan "Muat
 * lagi" (kursor), tanpa entri ganda, dan saringan tanggal terbalik.
 *
 * Entri dibuat langsung di database (60 baris `auth.login.success` milik satu pengguna baru, waktu
 * berurutan) supaya jumlahnya pasti walau tes lain menulis audit bersamaan; daftar disaring ke
 * pengguna itu lewat `?userId=` (tautan yang sama dengan "Lihat semua" di detail anggota).
 */
test.describe.configure({ timeout: 90_000 });

async function seedEntries(email: string, count: number): Promise<string> {
  const id = await userId(email);
  await e2eSql(
    `insert into audit_logs (id, organization_id, actor_user_id, action, target_type, target_id, metadata, ip_address, user_agent, created_at)
     select gen_random_uuid(), u.organization_id, u.id, 'auth.login.success', 'invitation', gen_random_uuid()::text,
            jsonb_build_object('urutan', n), '203.0.113.7',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
            now() - make_interval(secs => n)
     from users u, generate_series(1, $2::int) as n
     where u.id = $1`,
    [id, count],
  );
  return id;
}

async function openFiltered(page: Page, id: string): Promise<ReturnType<Page['getByRole']>> {
  await openApp(page, `/pengaturan/audit?userId=${id}&action=auth.login.success`);
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
  return page.getByRole('list', { name: 'Entri audit log' });
}

test('Muat lagi: 50 entri pertama, lalu sisanya tanpa ganda; tombol hilang di akhir daftar', async ({
  page,
}) => {
  const user = await createUser('teknisi', `audit-${isHp(page) ? 'hp' : 'desktop'}`);
  const id = await seedEntries(user.email, 60);
  const list = await openFiltered(page, id);
  const items = list.getByRole('listitem');
  await expect(items).toHaveCount(50);
  await expectNoHorizontalScroll(page);

  const more = page.getByRole('button', { name: 'Muat lagi' });
  await more.click();
  await expect(items).toHaveCount(60);
  await expect(more).toHaveCount(0);

  // Tidak ada entri ganda di sambungan halaman: ID target tiap entri unik (atribut title).
  const ids = await list.evaluate((ol) =>
    Array.from(ol.querySelectorAll(':scope > li [title]')).map((el) => el.getAttribute('title')),
  );
  expect(ids).toHaveLength(60);
  expect(new Set(ids).size).toBe(ids.length);
});

test('setelah halaman terakhir dimuat, fokus keyboard tidak jatuh ke <body>', async ({ page }) => {
  test.fail(
    true,
    'BUG: tombol "Muat lagi" yang sedang difokus dihapus setelah halaman terakhir; fokus ke <body>',
  );
  const user = await createUser('teknisi', `audit-fokus-${isHp(page) ? 'hp' : 'desktop'}`);
  const id = await seedEntries(user.email, 55);
  const list = await openFiltered(page, id);
  await expect(list.getByRole('listitem')).toHaveCount(50);
  const more = page.getByRole('button', { name: 'Muat lagi' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(list.getByRole('listitem')).toHaveCount(55);
  await expect(more).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName), { timeout: 2_000 })
    .not.toBe('BODY');
});

test('rentang tanggal terbalik: pesan di isian, daftar tidak disaring tanggal', async ({
  page,
}) => {
  await openApp(page, '/pengaturan/audit?from=2026-11-20&to=2026-11-10');
  if (isHp(page)) await page.getByRole('button', { name: /^Saringan/ }).click();
  await expect(page.getByText('Tanggal akhir tidak boleh sebelum tanggal mulai.')).toBeVisible();
  await expect(page.getByLabel('Sampai tanggal')).toHaveAttribute('aria-invalid', 'true');
  await expectNoHorizontalScroll(page);
});
