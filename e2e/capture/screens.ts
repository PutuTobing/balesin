import type { Page } from '@playwright/test';

export interface Screen {
  /** Nama berkas: e2e/screenshots/<name>--<viewport>-<tema>.png */
  name: string;
  /** Path yang dibuka (relatif ke baseURL). */
  path: string;
  /** Selector yang harus terlihat sebelum difoto (opsional). */
  waitFor?: string;
  /** Langkah tambahan sebelum difoto, mis. membuka menu atau mengisi form. */
  prepare?: (page: Page) => Promise<void>;
  /** Foto seluruh halaman (bukan hanya viewport). Default: false. */
  fullPage?: boolean;
}

/** Klik tombol bila tampil di ukuran layar ini (sebagian kontrol hanya ada di desktop). */
async function clickIfVisible(page: Page, name: string): Promise<boolean> {
  const button = page.getByRole('button', { name });
  if (!(await button.isVisible())) return false;
  await button.click();
  return true;
}

/**
 * Daftar layar yang difoto untuk penilaian desain.
 * Tambahkan entri setiap ada layar/keadaan baru (kosong, loading, error).
 *
 * Rute pratinjau (`/pratinjau/gagal`, `/inbox/pratinjau-memuat`, `/kontak/pratinjau-memuat`)
 * hanya ada di mode pengembangan: memperlihatkan keadaan memuat dan gagal yang belum bisa
 * dipicu dari UI selama belum ada data.
 */
export const screens: Screen[] = [
  // Inbox: kerangka tiga panel (desktop) / daftar chat (HP), semuanya kosong.
  { name: 'inbox', path: '/inbox', waitFor: 'h1' },
  {
    name: 'inbox-detail-tersembunyi',
    path: '/inbox',
    waitFor: 'h1',
    // Hanya berpengaruh di desktop; di HP panel detail memang tidak tampil.
    prepare: async (page) => {
      if (await clickIfVisible(page, 'Sembunyikan detail')) {
        await page.getByRole('button', { name: 'Tampilkan detail' }).waitFor();
        // Lepas hover/fokus supaya tooltip tidak ikut terfoto.
        await page.mouse.move(700, 600);
        await page.getByRole('button', { name: 'Tampilkan detail' }).blur();
      }
    },
  },
  { name: 'inbox-tab-belum-dilayani', path: '/inbox?tab=belum-dilayani', waitFor: 'h1' },
  {
    name: 'inbox-cari-tanpa-hasil',
    path: '/inbox',
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByRole('searchbox', { name: 'Cari chat' }).fill('Budi Santoso');
      await page.getByRole('heading', { name: /Tidak ketemu chat/ }).waitFor();
    },
  },
  { name: 'inbox-memuat', path: '/inbox/pratinjau-memuat', waitFor: '[role="status"]' },

  // Menu lain: keadaan kosong.
  { name: 'kontak', path: '/kontak', waitFor: 'h1' },
  { name: 'broadcast', path: '/broadcast', waitFor: 'h1' },
  { name: 'tiket', path: '/tiket', waitFor: 'h1' },
  { name: 'laporan', path: '/laporan', waitFor: 'h1' },
  { name: 'pengaturan', path: '/pengaturan', waitFor: '[role="radiogroup"]' },
  { name: 'lainnya', path: '/lainnya', waitFor: 'h1' },

  // Komponen kerangka.
  {
    name: 'menu-tema',
    path: '/inbox',
    waitFor: 'h1',
    // Menu tema ada di rail desktop; di HP tema diatur dari Pengaturan.
    prepare: async (page) => {
      if (await clickIfVisible(page, 'Ganti tema')) await page.getByRole('menu').waitFor();
    },
  },
  {
    name: 'fokus-keyboard',
    path: '/inbox',
    waitFor: 'h1',
    // Tab pertama memunculkan "Lewati ke konten" dengan cincin fokus.
    prepare: async (page) => {
      await page.keyboard.press('Tab');
    },
  },
  {
    name: 'fokus-navigasi',
    path: '/kontak',
    waitFor: 'h1',
    // Fokus keyboard di item navigasi: cincin fokus, plus tooltip di rail desktop.
    prepare: async (page) => {
      await page.getByRole('link', { name: 'Kontak', exact: true }).focus();
      await page.keyboard.press('Tab');
      // Tooltip muncul sesaat setelah fokus; di HP label sudah tampil tanpa tooltip.
      await page.waitForTimeout(400);
    },
  },

  // Keadaan memuat, gagal, tidak ditemukan.
  { name: 'halaman-memuat', path: '/kontak/pratinjau-memuat', waitFor: '[role="status"]' },
  { name: 'gagal-dimuat', path: '/pratinjau/gagal', waitFor: '[role="alert"]' },
  { name: 'tidak-ditemukan', path: '/alamat-yang-tidak-ada', waitFor: 'h1' },
];
