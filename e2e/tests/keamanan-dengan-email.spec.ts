import { request, type APIRequestContext } from '@playwright/test';
import { BASE_URL } from '../viewports';
import { expect, openApp, test } from './fixtures';
import { createUser, enrollRequiredTwoFactorViaApi, type ExtraUser } from './pengguna';

/**
 * Banner peringatan keamanan Owner setelah ADMIN mengubah email pengirim (review RBAC S1): kejadian
 * `email_sender_changed` di ringkasan keamanan → banner di semua halaman aplikasi Owner, tautan ke
 * Audit log tersaring, dan bisa ditutup (status disimpan di perangkat).
 *
 * Berjalan di proyek `dengan-email` (email pengirim organisasi sudah diatur ke Mailpit), karena
 * pemberitahuan ke Owner dikirim lewat pengaturan lama; perubahan Admin hanya alamat pengirim
 * (server & port tetap Mailpit) dan dikembalikan di akhir.
 */
test.describe.configure({ timeout: 120_000 });

interface EmailSettingsBody {
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  host: string;
  port: number;
  security: string;
  username: string | null;
}

/** Masuk lewat API sebagai Admin ber-2FA (langkah kedua dengan kode cadangan). */
async function adminApi(admin: ExtraUser, backupCode: string) {
  const api = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { origin: BASE_URL },
    storageState: { cookies: [], origins: [] },
  });
  const login = (await (
    await api.post('/api/v1/auth/login', { data: { email: admin.email, password: admin.password } })
  ).json()) as { status: string; challengeToken: string };
  expect(login.status).toBe('two_factor_required');
  const verify = await api.post('/api/v1/auth/2fa/verify', {
    data: { challengeToken: login.challengeToken, code: backupCode },
  });
  expect(verify.ok(), await verify.text()).toBe(true);
  const { csrfToken } = (await verify.json()) as { csrfToken: string };
  return { api, csrfToken };
}

async function saveSettings(api: APIRequestContext, csrfToken: string, body: EmailSettingsBody) {
  const response = await api.put('/api/v1/settings/email', {
    headers: { 'x-csrf-token': csrfToken },
    data: body,
  });
  expect(response.ok(), await response.text()).toBe(true);
}

test('Admin mengubah alamat email pengirim → Owner melihat banner, membuka Audit log, lalu banner hilang', async ({
  page,
}) => {
  const admin = await createUser('admin', 'banner');
  const { backupCodes } = await enrollRequiredTwoFactorViaApi(admin);
  const { api, csrfToken } = await adminApi(admin, backupCodes[0] ?? '');
  try {
    const current = (await (await api.get('/api/v1/settings/email')).json()) as {
      settings: EmailSettingsBody;
    };
    const original: EmailSettingsBody = {
      fromName: current.settings.fromName,
      fromAddress: current.settings.fromAddress,
      replyTo: current.settings.replyTo,
      host: current.settings.host,
      port: current.settings.port,
      security: current.settings.security,
      username: current.settings.username,
    };
    await saveSettings(api, csrfToken, {
      ...original,
      fromAddress: `pengirim-${Date.now().toString(36)}@majujaya.test`,
    });

    await openApp(page, '/inbox');
    const banner = page.getByRole('region', { name: /kejadian keamanan baru$/ });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Terbaru: Email pengirim diubah oleh selain Owner');
    await expect(banner).toContainText(`Oleh ${admin.name} (Admin).`);
    // Bukan pengumuman berulang: tidak memakai peran alert.
    await expect(page.getByRole('alert')).toHaveCount(0);

    await banner.getByRole('link', { name: 'Periksa di Audit log' }).click();
    // Satu jenis kejadian → saringan aksinya; beberapa jenis (mis. akun dikunci dari alur awal) →
    // hanya rentang tanggal. Persempit sendiri ke perubahan email pengirim.
    await expect(page).toHaveURL(/\/pengaturan\/audit\?.*from=\d{4}-\d{2}-\d{2}/);
    await page.getByLabel('Aksi').selectOption({ label: 'Email pengirim diubah' });
    await expect(page).toHaveURL(/action=settings\.email\.updated/);
    const list = page.getByRole('list', { name: 'Entri audit log' });
    await expect(list.getByRole('listitem').first()).toContainText('Email pengirim diubah');
    await expect(list.getByRole('listitem').first()).toContainText(admin.name);
    // Membuka tautannya = sudah dilihat (disimpan per pengguna di perangkat ini).
    await expect(page.getByRole('region', { name: /kejadian keamanan baru$/ })).toHaveCount(0);
    await page.goto('/inbox');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: /kejadian keamanan baru$/ })).toHaveCount(0);

    await saveSettings(api, csrfToken, original);
  } finally {
    await api.dispose();
  }
});
