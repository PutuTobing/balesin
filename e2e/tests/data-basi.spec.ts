import { request, type Browser } from '@playwright/test';
import { OWNER_STATE_PATH } from '../stack/env';
import { BASE_URL } from '../viewports';
import { expect, isHp, openApp, submitLogin, test } from './fixtures';
import { confirmAsOwner, withOwnerConfirmation } from './identitas';
import { openWatchedPage, type WatchedPage } from './konteks';
import { createUser, type ExtraUser } from './pengguna';

/**
 * Aksi pada data yang sudah basi (diubah di tab/perangkat lain sebelum daftar dimuat ulang), di HP
 * dan desktop: server menjawab 404 dengan pesan yang jelas, daftar dimuat ulang — pesan itu harus
 * TETAP terbaca dan fokus tidak jatuh ke <body>.
 *
 * Bug QA butir 4/6 (sudah diperbaiki, dijaga tes ini): dulu pesan error ditempel di baris yang
 * barusan diklik, lalu daftar dimuat ulang dan baris itu hilang — pesan ikut hilang tanpa jejak,
 * fokus ke <body>. Sekarang pesan 404 tampil di kartu dan fokus pindah ke judul kartu. Berkas:
 * `apps/web/src/features/team/TeamPage.tsx` (`InvitationsCard.fail`),
 * `apps/web/src/features/security/SessionsCard.tsx` (`revoke`), pola yang sama di
 * `apps/web/src/features/team-user/TeamUserPage.tsx` (`UserSessionsCard.revoke`).
 */
test.describe.configure({ timeout: 120_000 });

const ME = '/api/v1/auth/me';

async function ownerApi() {
  const api = await request.newContext({
    baseURL: BASE_URL,
    storageState: OWNER_STATE_PATH,
    extraHTTPHeaders: { origin: BASE_URL },
  });
  const me = (await (await api.get(ME)).json()) as { csrfToken: string };
  return { api, headers: { 'x-csrf-token': me.csrfToken } };
}

async function signIn(browser: Browser, hp: boolean, user: ExtraUser): Promise<WatchedPage> {
  const watched = await openWatchedPage(browser, { hp });
  watched.allow(ME, 401);
  await watched.page.goto('/masuk');
  await submitLogin(watched.page, user.email, user.password);
  await expect(watched.page).toHaveURL(/\/inbox$/);
  return watched;
}

test('undangan dibatalkan di tab lain → "Kirim ulang" di daftar basi: pesan tetap terbaca, fokus tidak hilang', async ({
  page,
  expectHttpError,
}) => {
  const tag = isHp(page) ? 'hp' : 'desktop';
  const email = `basi-${tag}-${Date.now().toString(36)}@majujaya.test`;
  const { api, headers } = await ownerApi();
  try {
    const created = await withOwnerConfirmation((confirmation) =>
      api.post('/api/v1/invitations', { headers, data: { email, role: 'cs', confirmation } }),
    );
    expect(created.status()).toBe(201);
    const { invitation } = (await created.json()) as { invitation: { id: string } };

    await openApp(page, '/pengaturan/tim');
    const row = page.getByRole('listitem', { name: `Undangan untuk ${email}` });
    await expect(row).toBeVisible();
    // Tab lain (Owner yang sama) membatalkannya; daftar di tab ini belum dimuat ulang.
    expect((await api.delete(`/api/v1/invitations/${invitation.id}`, { headers })).ok()).toBe(true);

    expectHttpError(`/api/v1/invitations/${invitation.id}/resend`, 404);
    await row.getByRole('button', { name: 'Kirim ulang' }).click();
    // Konfirmasi identitas dulu; server lalu menjawab 404 dan dialognya tertutup.
    await confirmAsOwner(page, 'Kirim ulang undangan ini?', 'Kirim ulang');
    // Daftar dimuat ulang (benar) …
    await expect(row).toHaveCount(0);
    // … tetapi pesan server harus tetap terbaca di luar baris yang hilang.
    await expect(
      page.getByText('Undangan tidak ditemukan, atau sudah diterima atau dibatalkan.'),
    ).toBeVisible({ timeout: 3_000 });
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  } finally {
    await api.dispose();
  }
});

test('sesi lain sudah keluar sendiri → "Keluarkan sesi" di daftar basi: pesan tetap terbaca, fokus tidak hilang', async ({
  browser,
  page: projectPage,
}) => {
  const hp = isHp(projectPage);
  const cs = await createUser('cs', `basi-sesi-${hp ? 'hp' : 'desktop'}`);
  // Sesi lama lebih dulu, supaya dari sesi baru ia bisa dikeluarkan satu klik (tanpa dialog).
  const older = await signIn(browser, hp, cs);
  const current = await signIn(browser, hp, cs);
  try {
    await current.page.goto('/pengaturan/keamanan');
    const card = current.page.getByRole('region', { name: 'Sesi aktif' });
    await expect(card.getByRole('listitem')).toHaveCount(2);

    // Sesi lama keluar sendiri (tombol Keluar di perangkat itu); daftar di sini belum dimuat ulang.
    const csrf = (await (await older.page.request.get(ME)).json()) as { csrfToken: string };
    const logout = await older.page.request.post('/api/v1/auth/logout', {
      headers: { 'x-csrf-token': csrf.csrfToken, origin: BASE_URL },
    });
    expect(logout.ok()).toBe(true);

    // 404 `DELETE /auth/sessions/:id` memang diharapkan (pengawas browser ini tidak diperiksa).
    await card.getByRole('button', { name: /^Keluarkan sesi / }).click();
    await expect(card.getByRole('listitem')).toHaveCount(1);
    await expect(current.page.getByText('Sesi tidak ditemukan atau sudah berakhir.')).toBeVisible({
      timeout: 3_000,
    });
    expect(await current.page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
  } finally {
    await older.close();
    await current.close();
  }
});
