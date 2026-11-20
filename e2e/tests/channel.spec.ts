import type { Page } from '@playwright/test';
import { handshakeQuery } from '../../apps/api/src/testing/fake-meta';
import { FAKE_META } from '../stack/fake-meta-data';
import { E2E_OWNER } from '../stack/env';
import { expect, isHp, submitLogin, test } from './fixtures';
import { openWatchedPage } from './konteks';
import { createUser, e2eSql, enrollRequiredTwoFactorViaApi, nextTotp } from './pengguna';

/**
 * Pengaturan → Channel melawan API sungguhan + server Meta TIRUAN (`stack/fake-meta-server.ts`,
 * `META_GRAPH_BASE_URL` loopback): wizard tambah nomor dengan konfirmasi identitas, tes koneksi
 * gagal (token tidak dikenal Meta tiruan) lalu berhasil setelah ganti token, profil bisnis,
 * nonaktifkan, hapus.
 *
 * Alur lengkap dijalankan OWNER KEDUA yang dibuat khusus tes ini (rahasia TOTP + kode cadangan
 * sendiri): empat konfirmasi identitas tidak memakai kode Owner utama, yang dipakai bergantian
 * oleh semua tes paralel (`withOwnerCode`). Perubahan oleh Owner tercatat `info`, jadi tidak
 * memunculkan banner peringatan di tes lain.
 */
test.describe.configure({ timeout: 240_000 });

const heading2 = (page: Page, name: string) => page.getByRole('heading', { level: 2, name });

interface ChannelOwner {
  email: string;
  password: string;
  secret: string;
  lastStep: number;
  backupCodes: string[];
}

/** Owner kedua di organisasi E2E, 2FA aktif (hash password disalin dari Owner utama). */
async function createChannelOwner(): Promise<ChannelOwner> {
  const email = `owner-channel-${Date.now().toString(36)}@majujaya.test`;
  const rows = await e2eSql(
    `insert into users (id, organization_id, email, name, password_hash, role, email_verified_at)
     select gen_random_uuid(), organization_id, $1, 'Dewi Lestari', password_hash, 'owner'::user_role, now()
     from users where email = $2
     returning id`,
    [email, E2E_OWNER.email],
  );
  if (rows.length !== 1) throw new Error('Owner E2E belum ada (alur-awal belum jalan?)');
  const password = E2E_OWNER.password;
  const twoFactor = await enrollRequiredTwoFactorViaApi({
    email,
    password,
    name: 'Dewi Lestari',
    role: 'admin',
  });
  return { email, password, ...twoFactor };
}

/** Isi dialog konfirmasi identitas dengan password + satu kode cadangan Owner kedua. */
async function confirmWith(
  page: Page,
  owner: ChannelOwner,
  dialogName: string,
  confirmLabel: string,
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password', { exact: true }).fill(owner.password);
  await dialog.getByLabel('Kode verifikasi').fill(owner.backupCodes.shift() ?? '');
  await dialog.getByRole('button', { name: confirmLabel, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function next(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'Lanjut', exact: true }).click();
  await expect(heading2(page, title)).toBeFocused();
}

test('Owner: tambah nomor lewat wizard, tes gagal → ganti token → berhasil, profil bisnis, nonaktifkan, hapus', async ({
  browser,
  page: projectPage,
}) => {
  test.skip(isHp(projectPage), 'alur lengkap dengan konfirmasi identitas cukup di desktop');
  const number = FAKE_META.numbers.desktop;
  const name = 'CS E2E Desktop';
  const owner = await createChannelOwner();
  const watched = await openWatchedPage(browser);
  watched.allow('/api/v1/auth/me', 401);
  const { page } = watched;
  try {
    await page.goto('/masuk');
    await submitLogin(page, owner.email, owner.password);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Masukkan kode verifikasi' }),
    ).toBeVisible();
    const { code } = await nextTotp(owner.secret, owner.lastStep);
    await page.getByLabel('Kode verifikasi').fill(code);
    await page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
    await expect(page).toHaveURL(/\/inbox$/);

    // Menu Pengaturan → Channel.
    await page.goto('/pengaturan');
    await page.getByRole('link', { name: /^Channel/ }).click();
    await expect(page).toHaveURL(/\/pengaturan\/channel$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Channel' })).toBeVisible();
    await page.getByRole('link', { name: /^(Hubungkan nomor|Hubungkan nomor pertama)$/ }).click();

    // Wizard: langkah 1–3 teks, 4–6 isian.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Hubungkan nomor WhatsApp' }),
    ).toBeVisible();
    await expect(heading2(page, 'Siapkan Meta Business')).toBeVisible();
    await expect(
      page.getByRole('link', { name: /developers\.facebook\.com|business\.facebook\.com/ }).first(),
    ).toHaveAttribute('href', /^https:\/\/(business|developers)\.facebook\.com\//);
    await next(page, 'Buat aplikasi Meta');
    await next(page, 'Pilih nomor');
    await next(page, 'Salin ID nomor');
    await page.getByLabel('Nama channel').fill(name);
    await page.getByLabel('Phone Number ID').fill(number.id);
    await page.getByLabel('WhatsApp Business Account ID').fill(FAKE_META.wabaId);
    await next(page, 'Buat token permanen');
    // Token yang formatnya sah tetapi tidak dikenal Meta (tiruan) → tes koneksi gagal nanti.
    await page.getByLabel('Token System User').fill(FAKE_META.wrongToken);
    await next(page, 'Salin App Secret');
    await page.getByLabel('App Secret').fill(FAKE_META.appSecret);
    await page.getByRole('button', { name: 'Simpan channel', exact: true }).click();
    await confirmWith(page, owner, 'Simpan channel baru?', 'Simpan channel');

    // Webhook: URL + verify token dari server, peringatan https (API E2E memakai http lokal).
    await expect(heading2(page, 'Pasang webhook')).toBeVisible();
    await expect(
      page.getByText(`Channel ${name} sudah tersimpan.`, { exact: false }),
    ).toBeVisible();
    await expect(page.getByText(/\/webhooks\/whatsapp\/[0-9a-f-]{36}$/)).toBeVisible();
    await expect(page.getByText('URL ini belum bisa dipakai Meta')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Salin verify token' })).toBeVisible();

    // Nilai yang ditampilkan benar-benar dipakai server: jabat tangan Meta (GET hub.*) ke URL itu
    // dengan verify token itu dijawab challenge-nya; token lain ditolak.
    const callbackUrl = (await page
      .getByText(/\/webhooks\/whatsapp\/[0-9a-f-]{36}$/)
      .textContent())!;
    const verifyToken = (await page
      .getByText(/^[A-Za-z0-9_-]{43}$/)
      .first()
      .textContent())!;
    const handshake = await page.request.get(
      `${callbackUrl}?${handshakeQuery(verifyToken, 'e2e42')}`,
    );
    expect(handshake.status()).toBe(200);
    expect(await handshake.text()).toBe('e2e42');
    const forged = await page.request.get(
      `${callbackUrl}?${handshakeQuery(`${verifyToken.slice(0, -1)}x`, 'e2e42')}`,
    );
    expect(forged.status()).toBe(403);

    await next(page, 'Tes koneksi');
    await page.getByRole('button', { name: 'Tes koneksi', exact: true }).click();
    await expect(page.getByText('Koneksi gagal')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Token System User ditolak Meta/)).toBeVisible();
    await next(page, 'Tambahkan metode pembayaran');
    await page.getByRole('button', { name: 'Selesai', exact: true }).click();

    // Halaman nomor: status Gagal dari tes terakhir.
    await expect(page).toHaveURL(/\/pengaturan\/channel\/[0-9a-f-]{36}$/);
    await expect(heading2(page, name)).toBeVisible();
    await expect(page.getByText('Tes terakhir gagal')).toBeVisible();

    // Tes gagal karena token: aksi utama di kotak gagal membuka form ganti dengan Token terfokus.
    // Token lama tidak pernah ditampilkan, dan nilai baru tidak muncul sebagai atribut DOM.
    await page.getByRole('button', { name: 'Ganti kredensial', exact: true }).first().click();
    const token = page.getByLabel(/^Token System User/);
    await expect(token).toBeFocused();
    await expect(token).toHaveValue('');
    await expect(token).toHaveAttribute('autocomplete', 'new-password');
    await expect(token).toHaveAttribute('type', 'password');
    await token.fill(FAKE_META.token);
    expect(await page.content()).not.toContain(FAKE_META.token);
    await page.getByRole('button', { name: 'Simpan kredensial', exact: true }).click();
    await confirmWith(page, owner, 'Ganti kredensial channel?', 'Simpan kredensial');
    await expect(page.getByText('Kredensial diganti.', { exact: false })).toBeVisible();

    // Tes ulang → berhasil; data nomor dari Meta tiruan.
    await page.getByRole('button', { name: 'Tes koneksi', exact: true }).click();
    await expect(page.getByText(/^Koneksi berhasil\./)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(number.display).first()).toBeVisible();
    await expect(page.getByText('1.000 pelanggan per 24 jam')).toBeVisible();

    // Navigasi bagian (desktop): setiap lompatan — klik maupun Enter — menandai bagian yang dipilih,
    // termasuk bagian pendek dan bagian di dasar halaman; gulir sendiri sampai dasar → bagian terakhir.
    const sections = page.getByRole('navigation', { name: 'Bagian halaman nomor' });
    const labels = [
      'Ringkasan',
      'Webhook',
      'Profil bisnis',
      'Nama channel',
      'Kredensial Meta',
      'Akses channel',
    ];
    for (const viaKeyboard of [false, true]) {
      for (const label of labels) {
        const link = sections.getByRole('link', { name: label, exact: true });
        if (viaKeyboard) {
          await link.focus();
          await page.keyboard.press('Enter');
        } else {
          await link.click();
        }
        await expect(link).toHaveAttribute('aria-current', 'location');
        await expect(sections.locator('[aria-current]')).toHaveCount(1);
      }
    }
    await sections.getByRole('link', { name: 'Ringkasan', exact: true }).click();
    await page.mouse.move(400, 500);
    for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, 600);
    await expect(
      sections.getByRole('link', { name: 'Akses channel', exact: true }),
    ).toHaveAttribute('aria-current', 'location');
    await sections.getByRole('link', { name: 'Profil bisnis', exact: true }).click();

    // Profil bisnis: dibaca dari Meta tiruan; Tentang + situs web wajib konfirmasi identitas.
    const about = page.getByLabel('Tentang', { exact: true });
    await expect(about).toHaveValue(FAKE_META.profile.about);
    const newAbout = 'Balasan CS 08.00–21.00 setiap hari.';
    await about.fill(newAbout);
    await page.getByLabel(/^Situs web 2/).fill('https://majujaya.test/promo');
    await page.getByRole('button', { name: 'Simpan profil', exact: true }).click();
    await confirmWith(page, owner, 'Simpan profil bisnis?', 'Simpan profil');
    await expect(page.getByText('Profil bisnis tersimpan di Meta.')).toBeVisible({
      timeout: 30_000,
    });

    // Kategori saja: tanpa dialog konfirmasi.
    await page.getByLabel('Kategori').selectOption({ label: 'Belanja dan ritel' });
    await page.getByRole('button', { name: 'Simpan profil', exact: true }).click();
    await expect(page.getByText('Profil bisnis tersimpan di Meta.')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Muat ulang: nilai baru memang tersimpan di Meta (tiruan).
    await page.reload();
    await expect(page.getByLabel('Tentang', { exact: true })).toHaveValue(newAbout);
    await expect(page.getByLabel(/^Situs web 2/)).toHaveValue('https://majujaya.test/promo');
    await expect(page.getByLabel('Kategori')).toHaveValue('RETAIL');

    // Nonaktifkan (dialog konfirmasi biasa).
    await page.getByRole('button', { name: 'Nonaktifkan channel', exact: true }).click();
    const disable = page.getByRole('dialog', { name: 'Nonaktifkan channel ini?' });
    await disable.getByRole('button', { name: 'Nonaktifkan', exact: true }).click();
    await expect(page.getByText(/^Dinonaktifkan sejak /)).toBeVisible();

    // Hapus (konfirmasi identitas) → kembali ke daftar dengan pesan.
    await page.getByRole('button', { name: 'Hapus channel', exact: true }).click();
    await confirmWith(page, owner, `Hapus channel ${name}?`, 'Hapus channel');
    await expect(page).toHaveURL(/\/pengaturan\/channel$/);
    await expect(page.getByText(`Channel ${name} sudah dihapus.`, { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(`^${name}`) })).toHaveCount(0);
    watched.expectClean();
  } finally {
    await watched.close();
  }
});

test('HP: wizard maju-mundur tanpa kehilangan isian, error per isian, tinggalkan wizard minta konfirmasi', async ({
  page,
}) => {
  test.skip(!isHp(page), 'tata letak HP (bilah kemajuan, tanpa daftar langkah)');
  await page.goto('/pengaturan/channel/tambah');
  await expect(heading2(page, 'Siapkan Meta Business')).toBeVisible();
  await expect(page.getByText('Langkah 1 dari 9')).toBeVisible();
  // Daftar langkah samping hanya di desktop.
  await expect(page.getByRole('navigation', { name: 'Langkah menghubungkan nomor' })).toBeHidden();
  await next(page, 'Buat aplikasi Meta');
  await next(page, 'Pilih nomor');
  await next(page, 'Salin ID nomor');

  // Lanjut tanpa isian: pesan per isian dari skema yang sama dengan server, fokus ke isian pertama.
  await page.getByRole('button', { name: 'Lanjut', exact: true }).click();
  await expect(page.getByText('Nama channel wajib diisi.')).toBeVisible();
  await expect(page.getByLabel('Nama channel')).toBeFocused();
  await page.getByLabel('Nama channel').fill('CS E2E HP');
  await page.getByLabel('Phone Number ID').fill('1065-4035');
  await page.getByLabel('WhatsApp Business Account ID').fill(FAKE_META.wabaId);
  await page.getByRole('button', { name: 'Lanjut', exact: true }).click();
  await expect(page.getByText(/Phone Number ID hanya berisi angka/)).toBeVisible();
  await page.getByLabel('Phone Number ID').fill(FAKE_META.numbers.hp.id);
  await next(page, 'Buat token permanen');
  await page.getByLabel('Token System User').fill(FAKE_META.token);
  await next(page, 'Salin App Secret');

  // Mundur dua langkah lalu maju: isian (termasuk token, hanya di memori) tetap ada.
  await page.getByRole('button', { name: 'Kembali', exact: true }).click();
  await expect(page.getByLabel('Token System User')).toHaveValue(FAKE_META.token);
  await page.getByRole('button', { name: 'Kembali', exact: true }).click();
  await expect(page.getByLabel('Phone Number ID')).toHaveValue(FAKE_META.numbers.hp.id);
  // Rahasia tidak pernah ditulis ke storage browser.
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(FAKE_META.token);

  // Tinggalkan lewat tombol kembali header: dialog konfirmasi, "Tetap di sini" mempertahankan isian.
  await page.getByRole('link', { name: 'Kembali ke Channel' }).click();
  const leave = page.getByRole('dialog', { name: 'Batal menambah nomor?' });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: 'Tetap di sini' }).click();
  await expect(page.getByLabel('Nama channel')).toHaveValue('CS E2E HP');
  await page.getByRole('link', { name: 'Kembali ke Channel' }).click();
  await leave.getByRole('button', { name: 'Tinggalkan' }).click();
  await expect(page).toHaveURL(/\/pengaturan\/channel$/);
});

test('CS: tidak ada menu Channel; alamat langsung dialihkan ke Pengaturan', async ({
  browser,
  page: ownerPage,
}) => {
  const hp = isHp(ownerPage);
  const user = await createUser('cs', `channel-${hp ? 'hp' : 'desktop'}`);
  const watched = await openWatchedPage(browser, { hp });
  watched.allow('/api/v1/auth/me', 401);
  const { page } = watched;
  const channelRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/settings/channels')) channelRequests.push(request.url());
  });
  try {
    await page.goto('/masuk');
    await submitLogin(page, user.email, user.password);
    await expect(page).toHaveURL(/\/inbox$/);

    await page.goto('/pengaturan');
    await expect(page.getByRole('heading', { level: 1, name: 'Pengaturan' })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Channel/ })).toHaveCount(0);

    for (const path of ['/pengaturan/channel', '/pengaturan/channel/tambah']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/pengaturan$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Pengaturan' })).toBeVisible();
    }
    expect(channelRequests).toEqual([]);
    watched.expectClean();
  } finally {
    await watched.close();
  }
});
