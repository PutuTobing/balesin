import type { Page } from '@playwright/test';
import { teamUserDetail, teamUsers, PHOTO_TEAM, PHOTO_USER_IDS } from './mocks-tim';
import {
  CS_INBOX_FOLDER,
  CS_VENDOR_FOLDER,
  MAIL_MESSAGE_IDS,
  MAIL_PHOTO_IDS,
  mailAccess,
  mailAccounts,
  mailMessages,
  mailWizard,
  teamMailAccess,
} from './mocks-mail';
import type { Screen } from './screens';

/**
 * Fase 9 tahap 9A bagian 1 — menu Email (kosong & kerangka), Pengaturan → Akun email, wizard
 * Hubungkan akun email (4 langkah + galat tes), akses akun, dan Tim → Akses email.
 */

const WIZARD = 'Hubungkan akun email';
const EMAIL = 'billing@majujaya.co.id';
const CS_USER = PHOTO_TEAM.find((user) => user.id === PHOTO_USER_IDS.cs)!;

async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

function wizard(page: Page) {
  return page.getByRole('dialog', { name: WIZARD });
}

/** Langkah 1 terisi (alamat dikenali → kartu cPanel "Cocok untuk …"). */
async function wizardStep1(page: Page): Promise<void> {
  const dialog = wizard(page);
  await dialog.waitFor();
  await dialog.getByLabel('Alamat email').fill(EMAIL);
  await dialog.getByRole('button', { name: 'Kenali pengaturan server' }).click();
  await dialog.getByText('Cocok untuk @majujaya.co.id').waitFor();
  await settle(page);
}

async function wizardStep2(page: Page): Promise<void> {
  await wizardStep1(page);
  const dialog = wizard(page);
  await dialog.getByRole('button', { name: 'Lanjut' }).click();
  await dialog.getByText('Pengaturan server terdeteksi untuk majujaya.co.id').waitFor();
  await dialog.getByLabel('Nama akun').fill('Billing');
  await dialog.getByLabel('Password atau sandi aplikasi').fill('contoh-sandi-aplikasi');
  await settle(page);
}

async function wizardStep3(page: Page): Promise<void> {
  await wizardStep2(page);
  const dialog = wizard(page);
  await dialog.getByRole('button', { name: 'Tes koneksi' }).click();
  await dialog
    .getByText(/Masuk ke SMTP (berhasil|gagal)|Server SMTP belum bisa dihubungi/)
    .waitFor();
  await settle(page);
}

async function wizardStep4(page: Page): Promise<void> {
  await wizardStep3(page);
  const dialog = wizard(page);
  await dialog.getByRole('button', { name: 'Lanjut' }).click();
  await dialog.getByRole('button', { name: 'Tambah orang atau departemen' }).click();
  await dialog.getByRole('button', { name: 'Beri akses ke Keuangan' }).click();
  await dialog.getByRole('button', { name: 'Beri akses ke Sari Wulandari' }).click();
  await dialog.getByRole('button', { name: 'Selesai', exact: true }).click();
  await dialog.getByLabel('Hak akses Sari Wulandari').selectOption('manage');
  await dialog.getByRole('radio', { name: 'Toska' }).check();
  await settle(page);
}

export const mailScreens: Screen[] = [
  // Menu Email: belum ada akun.
  {
    name: 'email-kosong',
    path: '/email',
    before: (page) => mailAccounts(page, true),
    waitFor: 'h1',
  },
  // Menu Email: kolom folder (HP: laci tertutup) + daftar menyusul.
  {
    name: 'email-kerangka',
    path: '/email',
    before: (page) => mailAccounts(page),
    waitFor: 'h1',
  },
  {
    name: 'email-folder',
    path: `/email?f=${CS_INBOX_FOLDER}`,
    before: (page) => mailAccounts(page),
    waitFor: 'h1',
  },
  // HP/tablet: laci folder terbuka.
  {
    name: 'email-laci',
    path: '/email',
    before: (page) => mailAccounts(page),
    waitFor: 'h1',
    prepare: async (page) => {
      const open = page.getByRole('button', { name: 'Buka folder dan akun' });
      if (await open.isVisible()) {
        await open.click();
        await page.getByRole('button', { name: 'Tutup folder dan akun' }).first().waitFor();
      }
      await page.mouse.move(1, 1);
    },
  },
  {
    name: 'email-memuat',
    path: '/email',
    before: hangSidebar,
    waitUntil: 'domcontentloaded',
    waitFor: 'section [role="status"]',
  },

  // Daftar email & panel baca (9A bagian 2).
  {
    name: 'email-daftar-kosong',
    path: '/email',
    before: async (page) => {
      await mailAccounts(page);
      await mailMessages(page, { empty: true, zeroCounts: true });
    },
    waitFor: 'h1',
  },
  {
    name: 'email-folder-kosong',
    path: `/email?f=${CS_VENDOR_FOLDER}`,
    before: (page) => mailAccounts(page),
    waitFor: 'h1',
  },
  // HTML di iframe sandbox, gambar luar diblokir, lampiran (HP: baca layar penuh).
  {
    name: 'email-baca',
    path: `/email?m=${MAIL_MESSAGE_IDS.noc}`,
    before: (page) => mailAccounts(page),
    waitFor: 'iframe',
    prepare: readyFrame,
  },
  {
    name: 'email-baca-gambar',
    path: `/email?m=${MAIL_MESSAGE_IDS.noc}`,
    before: (page) => mailAccounts(page),
    waitFor: 'iframe',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Tampilkan gambar' }).click();
      await page.getByText('Gambar dari luar disembunyikan').waitFor({ state: 'detached' });
      await readyFrame(page);
    },
  },
  // Teks polos + gagal verifikasi + pengirim mirip + lampiran diblokir.
  {
    name: 'email-baca-peringatan',
    path: `/email?m=${MAIL_MESSAGE_IDS.faktur}`,
    before: (page) => mailAccounts(page),
    waitFor: 'article h2',
    prepare: async (page) => {
      await page.getByText('Pengirim email ini tidak lolos pemeriksaan').waitFor();
      await settle(page);
    },
  },
  {
    name: 'email-baca-memuat',
    path: `/email?m=${MAIL_MESSAGE_IDS.noc}`,
    before: async (page) => {
      await mailAccounts(page);
      await mailMessages(page, { bodyLoading: true });
    },
    waitFor: 'article h2',
    prepare: async (page) => {
      await page.getByText('Mengambil isi email dari server…').waitFor();
      await settle(page);
    },
  },

  // Pengaturan → Akun email.
  {
    name: 'akun-email-daftar',
    path: '/pengaturan/akun-email',
    before: (page) => mailAccounts(page),
    waitFor: 'h1',
    tall: true,
  },
  {
    name: 'akun-email-kosong',
    path: '/pengaturan/akun-email',
    before: (page) => mailAccounts(page, true),
    waitFor: 'h1',
  },
  {
    name: 'akun-email-menu',
    path: '/pengaturan/akun-email',
    before: (page) => mailAccounts(page),
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Aksi untuk Billing' }).click();
      await page.getByRole('menu').waitFor();
    },
  },

  // Wizard 4 langkah.
  {
    name: 'akun-wizard-1',
    path: '/pengaturan/akun-email?tambah=baru',
    before: async (page) => {
      await mailAccounts(page);
      await mailWizard(page);
    },
    prepare: wizardStep1,
  },
  {
    name: 'akun-wizard-2',
    path: '/pengaturan/akun-email?tambah=baru',
    before: async (page) => {
      await mailAccounts(page);
      await mailWizard(page);
    },
    prepare: wizardStep2,
  },
  {
    name: 'akun-wizard-3',
    path: '/pengaturan/akun-email?tambah=baru',
    before: async (page) => {
      await mailAccounts(page);
      await mailWizard(page);
    },
    prepare: wizardStep3,
  },
  {
    name: 'akun-wizard-3-galat',
    path: '/pengaturan/akun-email?tambah=baru',
    before: async (page) => {
      await mailAccounts(page);
      await mailWizard(page, false);
    },
    prepare: wizardStep3,
  },
  {
    name: 'akun-wizard-4',
    path: '/pengaturan/akun-email?tambah=baru',
    before: async (page) => {
      await mailAccounts(page);
      await mailWizard(page);
    },
    prepare: wizardStep4,
  },

  // Satu akun: ringkasan, tampilan, server, akses.
  {
    name: 'akun-akses',
    path: `/pengaturan/akun-email/${MAIL_PHOTO_IDS.cs}`,
    before: async (page) => {
      await mailAccounts(page);
      await mailAccess(page);
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByRole('heading', { name: 'Akses', exact: true }).waitFor();
      await page.getByLabel('Hak akses Sari Wulandari').waitFor();
    },
    tall: true,
  },
  {
    name: 'akun-email-galat',
    path: `/pengaturan/akun-email/${MAIL_PHOTO_IDS.notif}`,
    before: async (page) => {
      await mailAccounts(page);
      await mailAccess(page);
    },
    waitFor: 'h1',
  },
  // Tautan "Perbarui password" di daftar → halaman akun dengan dialog Ubah server langsung terbuka.
  {
    name: 'akun-email-perbarui-password',
    path: '/pengaturan/akun-email',
    before: async (page) => {
      await mailAccounts(page);
      await mailAccess(page);
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByRole('link', { name: 'Perbarui password' }).click();
      await page.getByRole('dialog', { name: 'Ubah server atau password' }).waitFor();
      await page.mouse.move(1, 1);
    },
  },

  // Tim → [CS] → Akses email.
  {
    name: 'tim-akses-email',
    path: `/pengaturan/tim/${CS_USER.id}`,
    before: async (page) => {
      await mailAccounts(page);
      await teamUsers(page);
      await teamUserDetail(page, CS_USER);
      await teamMailAccess(page, CS_USER.id);
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByRole('heading', { name: 'Akses email' }).waitFor();
      await page.getByLabel('Hak langsung di Billing').waitFor();
      await page.mouse.move(1, 1);
    },
    // Setinggi isi (kartu Akses email di bawah Detail anggota), tanpa hash yang menggeser shell.
    tall: true,
  },
];

/** Dokumen email di iframe sudah tampil (tabel jadwal), lalu tetikus dan fokus dirapikan. */
async function readyFrame(page: Page): Promise<void> {
  await page.frameLocator('iframe').locator('table').waitFor();
  await settle(page);
}

async function hangSidebar(page: Page): Promise<void> {
  await mailAccounts(page);
  await page.route('**/api/v1/mail/sidebar', () => undefined);
}
