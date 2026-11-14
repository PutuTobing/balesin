import { request, type APIRequestContext } from '@playwright/test';
import { BASE_URL } from '../viewports';
import { expect, openApp, owner, submitLogin, test } from './fixtures';
import { openWatchedPage } from './konteks';
import { findMail } from './mailpit';
import {
  createUser,
  enableTwoFactorViaApi,
  enrollRequiredTwoFactorViaApi,
  type ExtraUser,
} from './pengguna';

/**
 * Banner peringatan keamanan Owner setelah ADMIN mengubah email pengirim (review RBAC S1): kejadian
 * `email_sender_changed` di ringkasan keamanan → banner di semua halaman aplikasi Owner, tautan ke
 * Audit log tersaring, dan bisa ditutup (status disimpan di perangkat).
 *
 * Berjalan di proyek `dengan-email` (email pengirim organisasi sudah diatur ke Mailpit), karena
 * pemberitahuan ke Owner dikirim lewat pengaturan lama; perubahan Admin hanya alamat pengirim
 * (server & port tetap Mailpit) dan dikembalikan di akhir.
 */
// Serial: tes kedua membuat kejadian keamanan baru yang akan mengubah "Terbaru:" tes pertama.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

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
    await expect(banner).toContainText(
      `Terbaru: Email pengirim diubah oleh ${admin.name} (Admin), `,
    );
    await expect(banner).not.toContainText('selain Owner');
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

// ── Tambahan QA butir 6: perubahan tim oleh Admin → email ke Owner/sasaran + banner Owner ──

/** Email untuk `to` yang tiba setelah `since` dan subjeknya cocok. */
async function expectMail(
  to: string,
  subject: RegExp | ((text: string) => boolean),
  since: Date,
): Promise<void> {
  const matches = (text: string) =>
    typeof subject === 'function' ? subject(text) : subject.test(text);
  await expect
    .poll(
      async () =>
        (await findMail(to)).some(
          (message) =>
            new Date(message.Created).getTime() >= since.getTime() - 1000 &&
            matches(message.Subject),
        ),
      { timeout: 30_000, message: `email pemberitahuan untuk ${to}` },
    )
    .toBe(true);
}

test('Admin mengatur ulang 2FA, mengubah peran, lalu menonaktifkan CS → email ke CS dan Owner; banner Owner; tutup banner bertahan setelah dimuat ulang', async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const admin = await createUser('admin', 'kelola-email');
  const { backupCodes } = await enrollRequiredTwoFactorViaApi(admin);
  const cs = await createUser('cs', 'kelola-email');
  await enableTwoFactorViaApi(cs);
  const codes = [...backupCodes];
  const next = () => codes.shift() ?? '';

  const adminBrowser = await openWatchedPage(browser);
  adminBrowser.allow('/api/v1/auth/me', 401);
  const ap = adminBrowser.page;
  try {
    await ap.goto('/masuk');
    await submitLogin(ap, admin.email, admin.password);
    await ap.getByRole('button', { name: 'Pakai kode cadangan' }).click();
    await ap.getByLabel('Kode cadangan').fill(next());
    await ap.getByRole('button', { name: 'Verifikasi', exact: true }).click();
    await ap.getByRole('button', { name: /^(Lanjut|Nanti saja)$/ }).click();
    await expect(ap).toHaveURL(/\/inbox$/);

    await ap.goto('/pengaturan/tim');
    await ap
      .getByRole('region', { name: /^Anggota tim/ })
      .getByRole('link', { name: cs.email })
      .click();
    await expect(ap.getByRole('heading', { level: 2, name: cs.name })).toBeVisible();

    const confirm = async (title: string, button: string) => {
      const dialog = ap.getByRole('dialog', { name: title });
      await dialog.getByLabel('Password-mu').fill(admin.password);
      await dialog.getByLabel('Kode verifikasi').fill(next());
      await dialog.getByRole('button', { name: button, exact: true }).click();
      await expect(dialog).toBeHidden();
    };

    const since = new Date();
    await ap.getByRole('button', { name: 'Atur ulang 2FA' }).click();
    await confirm('Atur ulang verifikasi dua langkah?', 'Atur ulang 2FA');
    await expect(ap.getByText(/sudah diatur ulang/)).toBeVisible();

    await ap.getByLabel('Peran baru').selectOption({ label: 'Teknisi' });
    await ap.getByRole('button', { name: 'Ubah peran', exact: true }).click();
    await confirm('Ubah peran menjadi Teknisi?', 'Ubah peran');
    await expect(ap.getByRole('status').filter({ hasText: 'sekarang Teknisi' })).toBeVisible();

    await ap.getByRole('button', { name: 'Nonaktifkan akun' }).click();
    await confirm('Nonaktifkan akun ini?', 'Nonaktifkan');
    await expect(ap.getByText(/sudah dinonaktifkan/)).toBeVisible();
    adminBrowser.expectClean();

    // (Masuk dengan akun nonaktif = pesan sama dengan password salah: dicakup tes integrasi
    // `auth.integration.test.ts`. Tidak diulang di sini: setiap masuk gagal memakai jatah 20/15
    // menit per IP yang dibagi SEMUA tes E2E dari 127.0.0.1, dan suite sudah di batas itu.)

    // Email: sasaran tahu 2FA-nya diatur ulang; Owner tahu ketiga perubahan oleh Admin.
    await expectMail(cs.email, /^Verifikasi dua langkah akun .+-mu diatur ulang$/, since);
    const subject = (prefix: string, suffix: string) => (text: string) =>
      text.startsWith(prefix) && text.endsWith(suffix);
    await expectMail(
      owner.email,
      subject(`Verifikasi dua langkah ${cs.name} (CS) di `, ' diatur ulang'),
      since,
    );
    await expectMail(
      owner.email,
      subject(`Peran ${cs.name} di `, ` diubah oleh ${admin.name} (Admin)`),
      since,
    );
    await expectMail(
      owner.email,
      subject(`${cs.name} di `, ` dinonaktifkan oleh ${admin.name} (Admin)`),
      since,
    );

    // Owner: banner peringatan, kejadian terbaru = penonaktifan oleh Admin.
    await openApp(page, '/inbox');
    const banner = page.getByRole('region', { name: /kejadian keamanan baru$/ });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(
      `Terbaru: Pengguna dinonaktifkan oleh ${admin.name} (Admin)`,
    );
    await banner.getByRole('button', { name: 'Tutup peringatan keamanan' }).click();
    await expect(banner).toHaveCount(0);
    // Fokus tidak hilang ke <body> setelah banner ditutup.
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: /kejadian keamanan baru$/ })).toHaveCount(0);
  } finally {
    await adminBrowser.close();
  }
});
