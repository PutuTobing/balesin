import { randomInt } from 'node:crypto';
import { expect, test } from './fixtures';
import type { WatchedPage } from './konteks';
import {
  confirmAsSecondOwner,
  createSecondOwner,
  signInSecondOwner,
  type SecondOwner,
} from './owner-kedua';

/**
 * Pengaturan → Jam kerja & alokasi melawan stack sungguhan (docs/KONTRAK-API-INBOX.md "Jam kerja,
 * pesan otomatis, alokasi"): hari libur, mengaktifkan pesan otomatis dengan konfirmasi identitas,
 * pembagian round-robin + saklar "Tersedia" di inbox. Proyek `berurutan`: pengaturan ini berlaku
 * organisasi (pesan otomatis & pembagian chat memengaruhi tes inbox lain), jadi selalu dikembalikan.
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

let owner: SecondOwner;
let watched: WatchedPage;

test.beforeAll(async ({ browser }) => {
  owner = await createSecondOwner('jamkerja');
  watched = await signInSecondOwner(browser, owner);
});

test.afterAll(async () => {
  await watched?.close();
});

test('hari libur, pesan otomatis (konfirmasi), pembagian round-robin + saklar Tersedia', async () => {
  const page = watched.page;
  const holiday = `Libur E2E ${String(randomInt(100, 999))}`;
  await page.goto('/pengaturan/jam-kerja');

  const hours = page.getByRole('form', { name: 'Jam kerja tim' });
  await hours.getByLabel('Tanggal').fill('2027-03-08');
  await hours.getByLabel('Nama hari libur').fill(holiday);
  await hours.getByRole('button', { name: 'Tambah hari libur' }).click();
  await hours.getByRole('button', { name: 'Simpan' }).click();
  await expect(hours.getByText('Tersimpan.')).toBeVisible();
  await expect(hours.getByText(holiday)).toBeVisible();

  // Mengaktifkan sapaan = konfirmasi identitas; lalu dimatikan lagi (tanpa konfirmasi).
  const auto = page.getByRole('form', { name: 'Pesan otomatis' });
  const greeting = auto.getByLabel('Kirim pesan "Sapaan (dalam jam kerja)"');
  await greeting.check();
  await auto.getByRole('button', { name: 'Simpan' }).click();
  await confirmAsSecondOwner(page, owner, 'Simpan pesan otomatis?', 'Simpan pesan');
  await expect(auto.getByText('Tersimpan.')).toBeVisible();
  await greeting.uncheck();
  await auto.getByRole('button', { name: 'Simpan' }).click();
  await expect(auto.getByText('Tersimpan.')).toBeVisible();

  // Round-robin → saklar "Tersedia" tampil di inbox; lalu kembali ke ambil sendiri.
  const allocation = page.getByRole('form', { name: 'Pembagian chat' });
  await allocation.getByRole('radio', { name: /Bagi otomatis bergiliran/ }).click();
  await allocation.getByRole('button', { name: 'Simpan' }).click();
  await expect(allocation.getByText('Tersimpan.')).toBeVisible();
  const agents = page.getByRole('list', { name: 'Daftar agen' });
  await expect(agents).toBeVisible();

  // Owner bawaannya dikecualikan (KONTRAK-API-INBOX): di inbox saklarnya nonaktif dengan alasannya.
  const included = agents.getByRole('switch', { name: `Ikut pembagian otomatis: ${owner.name}` });
  await expect(included).toHaveAttribute('aria-checked', 'false');
  await page.goto('/inbox');
  await expect(
    page.getByRole('switch', { name: 'Tersedia untuk chat baru: Tidak ikut pembagian' }),
  ).toBeDisabled();

  // Diikutkan → saklar bisa dipakai sendiri.
  await page.goto('/pengaturan/jam-kerja');
  await included.click(); // terkendali server: berubah setelah PATCH + muat ulang daftar
  await expect(included).toHaveAttribute('aria-checked', 'true');
  await page.goto('/inbox');
  const toggle = page.getByRole('switch', { name: /Tersedia untuk chat baru/ });
  await expect(toggle).toBeEnabled();
  const before = await toggle.getAttribute('aria-checked');
  await toggle.click();
  await expect(toggle).not.toHaveAttribute('aria-checked', before ?? '');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', before ?? '');

  // Kembalikan: Owner dikecualikan lagi, pembagian kembali ambil sendiri.
  await page.goto('/pengaturan/jam-kerja');
  await included.click();
  await expect(included).toHaveAttribute('aria-checked', 'false');
  await page
    .getByRole('form', { name: 'Pembagian chat' })
    .getByRole('radio', { name: /Ambil sendiri dari antrian/ })
    .click();
  await page
    .getByRole('form', { name: 'Pembagian chat' })
    .getByRole('button', { name: 'Simpan' })
    .click();
  await expect(
    page.getByRole('form', { name: 'Pembagian chat' }).getByText('Tersimpan.'),
  ).toBeVisible();
  await page.goto('/inbox');
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await expect(page.getByRole('switch', { name: /Tersedia untuk chat baru/ })).toHaveCount(0);
  watched.expectClean();
});
