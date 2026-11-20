import { randomInt } from 'node:crypto';
import { expect, expectNoHorizontalScroll, test } from './fixtures';
import type { WatchedPage } from './konteks';
import {
  confirmAsSecondOwner,
  createSecondOwner,
  signInSecondOwner,
  type SecondOwner,
} from './owner-kedua';

/**
 * UI Fase 5 melawan stack sungguhan (docs/KONTRAK-API-CRM-TIKET.md, docs/KONTRAK-API-LAPORAN.md):
 * atribut kontak → impor CSV (periksa dulu) → detail & ubah atribut → ekspor (konfirmasi identitas);
 * board tiket → tiket baru → pindah kolom (keyboard di desktop, menu "Pindah ke…" di HP) → komentar;
 * departemen; CSAT; laporan. Owner kedua per proyek (kode cadangan sendiri, tanpa antre TOTP).
 */
test.describe.configure({ mode: 'serial', timeout: 180_000 });

let owner: SecondOwner;
let watched: WatchedPage;
let hp = false;
const suffix = `${Date.now().toString(36)}${String(randomInt(100, 999))}`;

test.beforeAll(async ({ browser }, testInfo) => {
  hp = testInfo.project.name.startsWith('hp');
  owner = await createSecondOwner(`crm${hp ? 'hp' : 'dt'}`);
  watched = await signInSecondOwner(browser, owner, { hp });
});

test.afterAll(async () => {
  await watched?.close();
});

test('kontak: atribut → impor CSV → detail & ubah → ekspor', async () => {
  const page = watched.page;
  const key = `paket-${suffix}`;
  const label = `Paket ${suffix}`;
  const name = `Pelanggan ${suffix}`;
  const phone = `0812${String(randomInt(10_000_000, 99_999_999))}`;

  // Pengaturan → Atribut kontak: definisi "Pilihan" (tidak wajib: kontak lain di suite tetap bisa disimpan).
  await page.goto('/pengaturan/atribut-kontak');
  await page.getByRole('button', { name: 'Buat atribut' }).click();
  const create = page.getByRole('dialog', { name: 'Buat atribut' });
  await create.getByLabel('Label').fill(label);
  await create.getByLabel('Kunci').fill(key);
  await create.getByLabel('Jenis').selectOption('select');
  await create.getByLabel('Pilihan').fill('Bronze\nGold');
  await create.getByRole('button', { name: 'Simpan' }).click();
  await expect(create).toBeHidden();
  await expect(page.getByText(label, { exact: true })).toBeVisible();

  // Impor: kolom ditebak dari judul, periksa dulu, lalu "hanya kontak baru" (tanpa konfirmasi).
  await page.goto('/kontak/impor');
  await page.getByTestId('impor-kontak-berkas').setInputFiles({
    name: 'pelanggan.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`nomor,nama,${key}\n${phone},${name},Gold\n`, 'utf8'),
  });
  await expect(page.getByText('3 kolom terbaca')).toBeVisible();
  await expect(page.getByLabel('Kolom nomor')).toHaveValue('nomor');
  await page.getByRole('radio', { name: /Lewati, hanya tambah kontak baru/ }).click();
  await page.getByRole('button', { name: 'Periksa dulu' }).click();
  await expect(page.getByRole('heading', { name: 'Hasil pemeriksaan' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Impor sekarang' }).click();
  await expect(page.getByRole('heading', { name: 'Impor selesai' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('link', { name: 'Lihat kontak' }).click();

  // Cari → detail: atribut tampil dengan labelnya.
  await page.getByRole('searchbox', { name: 'Cari kontak' }).fill(name);
  await page.getByRole('link', { name: `Buka kontak ${name}` }).click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
  const attributes = page.getByRole('region', { name: 'Atribut' });
  await expect(attributes.getByText('Gold', { exact: true })).toBeVisible();
  if (!hp) await expectNoHorizontalScroll(page);

  // Ubah atribut lewat isian bertipe.
  await page.getByRole('button', { name: 'Ubah kontak' }).click();
  const edit = page.getByRole('dialog', { name: 'Ubah kontak' });
  await edit.getByLabel(label).selectOption('Bronze');
  await edit.getByRole('button', { name: 'Simpan' }).click();
  await expect(edit).toBeHidden();
  await expect(attributes.getByText('Bronze', { exact: true })).toBeVisible();

  // Ekspor dengan saringan aktif (konfirmasi identitas) → berkas CSV.
  await page.goto(`/kontak?cari=${encodeURIComponent(name)}`);
  await expect(page.getByRole('link', { name: `Buka kontak ${name}` })).toBeVisible();
  await page.getByRole('button', { name: 'Ekspor CSV' }).click();
  const download = page.waitForEvent('download');
  await confirmAsSecondOwner(page, owner, 'Ekspor kontak ke CSV', 'Ekspor CSV');
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  await expect(page.getByText('1 kontak diunduh.')).toBeVisible();

  // Rapikan: definisi dihapus (nilai tetap ada sebagai atribut bebas).
  await page.goto('/pengaturan/atribut-kontak');
  await page.getByRole('button', { name: `Hapus ${label}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Hapus atribut' }).click();
  await expect(page.getByText(label, { exact: true })).toBeHidden();
  watched.expectClean();
});

test('tiket: board → tiket baru → pindah kolom → komentar', async () => {
  const page = watched.page;
  const board = `Gangguan ${suffix}`;
  const title = `Internet putus ${suffix}`;

  await page.goto('/tiket');
  // Board pertama (keadaan kosong) dan board berikutnya di desktop: tombol "Buat board". Sudah ada
  // board di HP: menu ⋯ → "Buat board".
  const first = page.getByRole('button', { name: 'Buat board' });
  const menu = page.getByRole('button', { name: 'Menu board' });
  await expect(first.or(menu).first()).toBeVisible();
  if (await first.isVisible()) {
    await first.click();
  } else {
    await menu.click();
    await page.getByRole('menuitem', { name: 'Buat board' }).click();
  }
  const dialog = page.getByRole('dialog', { name: 'Board baru' });
  await dialog.getByLabel('Nama board').fill(board);
  await dialog.getByRole('button', { name: 'Buat board' }).click();
  await expect(page.getByRole('list', { name: `Kanban ${board}` })).toBeVisible();

  await page.getByRole('button', { name: 'Buat tiket' }).click();
  const form = page.getByRole('dialog', { name: 'Tiket baru' });
  await form.getByLabel('Judul').fill(title);
  await form.getByLabel('Prioritas').selectOption('urgent');
  await form.getByRole('button', { name: 'Buat tiket' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const ticketUrl = page.url();

  await page.getByRole('link', { name: 'Kembali ke Tiket' }).click();
  await page.getByLabel('Board', { exact: true }).selectOption({ label: board });
  const card = page.getByRole('link', { name: new RegExp(`: ${title}$`) });
  await expect(card).toBeVisible();
  const number = /#(\d+)/.exec((await card.getAttribute('aria-label')) ?? '')?.[1] ?? '';

  if (hp) {
    await page.getByRole('button', { name: `Pindahkan tiket #${number} ke kolom lain` }).click();
    await page.getByRole('menuitem', { name: 'Dikerjakan' }).click();
    await page.getByLabel('Pilih kolom').selectOption({ label: 'Dikerjakan (1)' });
  } else {
    const handle = page.getByRole('button', { name: `Angkat tiket #${number} untuk dipindah` });
    await handle.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await expect(page.getByText(`Tiket #${number} dipindah ke Dikerjakan.`)).toBeAttached();
  }
  await expect(
    page.getByRole('listitem', { name: 'Dikerjakan, 1 tiket' }).getByRole('link', {
      name: new RegExp(`: ${title}$`),
    }),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.goto(ticketUrl);
  await expect(page.getByLabel('Kolom', { exact: true })).toHaveValue(/.+/);
  await page.getByLabel('Tulis komentar').fill('Teknisi berangkat jam 10.');
  await page.getByRole('button', { name: 'Kirim komentar' }).click();
  await expect(page.getByText('Teknisi berangkat jam 10.')).toBeVisible();
  await page.getByRole('tab', { name: 'Riwayat' }).click();
  await expect(page.getByText(/memindahkan tiket dari Baru ke Dikerjakan/)).toBeVisible();
  watched.expectClean();
});

test('departemen, CSAT, dan laporan', async () => {
  const page = watched.page;
  const department = `Teknisi ${suffix}`;

  await page.goto('/pengaturan/departemen');
  await page.getByRole('button', { name: 'Buat departemen' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Buat departemen' });
  await dialog.getByLabel('Nama departemen').fill(department);
  await dialog.getByRole('radio', { name: 'Jam kerja khusus' }).click();
  await dialog.getByRole('button', { name: 'Simpan' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: department, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Hapus ${department}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Hapus departemen' }).click();
  await expect(page.getByText('Departemen dihapus.')).toBeVisible();
  await expect(page.getByRole('heading', { name: department, exact: true })).toBeHidden();

  await page.goto('/pengaturan/csat');
  const interval = page.getByLabel('Jarak antar-survei (jam)');
  await interval.fill('48');
  await page.getByRole('button', { name: 'Simpan' }).click();
  await expect(page.getByText('Pengaturan CSAT tersimpan.')).toBeVisible();

  // Laporan bersamaan dibatasi 2 per organisasi; proyek desktop & HP berjalan bersamaan di organisasi
  // yang sama → 429 singkat yang diulang otomatis oleh layar laporan.
  watched.allow('/api/v1/reports/performance', 429);
  watched.allow('/api/v1/reports/costs', 429);
  await page.goto('/laporan');
  await expect(page.getByLabel('Rentang')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: /Belum ada percakapan di rentang ini|Per agen/ }).first(),
  ).toBeVisible({ timeout: 20_000 });
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Biaya Meta' }).click();
  await expect(page.getByText('Perkiraan', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  watched.expectClean();
});
