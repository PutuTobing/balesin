import type { Page } from '@playwright/test';
import { teamUserDetail, teamUsers, PHOTO_TEAM, PHOTO_USER_IDS } from './mocks-tim';
import {
  CS_INBOX_FOLDER,
  CS_VENDOR_FOLDER,
  MAIL_MESSAGE_IDS,
  MAIL_PHOTO_IDS,
  mailAccess,
  mailAccounts,
  mailCompose,
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

// ── 9B: tulis, balas, teruskan ──────────────────────────────────────────

/** Buka jendela tulis: FAB "Tulis" di HP, tombol "Tulis email" di kolom folder desktop/tablet. */
async function openNewCompose(page: Page): Promise<void> {
  const fab = page.getByRole('button', { name: 'Tulis', exact: true });
  if (await fab.isVisible()) await fab.click();
  else await page.getByRole('button', { name: 'Tulis email', exact: true }).click();
  await page.getByRole('dialog', { name: /^Tulis email:/ }).waitFor();
  await page.getByRole('combobox', { name: 'Penerima (Kepada)' }).waitFor();
}

/** Kepada dari saran kontak + subjek + isi pendek di atas tanda tangan. */
async function fillNewCompose(page: Page, body: string): Promise<void> {
  const to = page.getByRole('combobox', { name: 'Penerima (Kepada)' });
  await to.fill('ri');
  await page.getByRole('option', { name: /Rina Wulandari/ }).click();
  await page.getByLabel('Subjek').fill('Penawaran paket Bisnis 50 Mbps');
  const editor = page.getByRole('textbox', { name: 'Isi email' });
  await editor.focus();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type(body);
}

async function openReply(page: Page): Promise<void> {
  await readyFrame(page);
  await page
    .getByRole('group', { name: 'Balas atau teruskan' })
    .getByRole('button', { name: 'Balas', exact: true })
    .click();
  await page.getByRole('dialog', { name: /^Tulis email: Balas:/ }).waitFor();
}

const COMPOSE_BODY = [
  'Halo Bu Rina,',
  'Terima kasih atas permintaannya. Penawaran paket Bisnis 50 Mbps untuk kantor cabang Sukadana kami kirim lewat email ini. Kalau sudah cocok, cukup balas email ini ya, Bu.',
].join('\n');

async function withCompose(page: Page, options?: Parameters<typeof mailCompose>[1]) {
  await mailAccounts(page);
  await mailCompose(page, options);
}

async function withSettings(page: Page) {
  await mailAccounts(page);
  await mailAccess(page);
  await mailCompose(page);
}

export const composeScreens: Screen[] = [
  // Desktop: jendela mengambang 600×600 di kanan bawah. HP: layar penuh (FAB "Tulis").
  {
    name: 'email-tulis',
    path: `/email?f=${CS_INBOX_FOLDER}`,
    before: (page) => withCompose(page),
    waitFor: 'h1',
    prepare: async (page) => {
      await openNewCompose(page);
      await fillNewCompose(page, COMPOSE_BODY);
      await page
        .getByText(/Draf tersimpan · /)
        .first()
        .waitFor();
      await settle(page);
    },
  },
  // Balas: penerima & subjek terisi, kutipan email asli di iframe ber-token (bukan di editor).
  {
    name: 'email-balas',
    path: `/email?m=${MAIL_MESSAGE_IDS.noc}`,
    before: (page) => withCompose(page),
    waitFor: 'iframe',
    prepare: async (page) => {
      await openReply(page);
      await page.getByRole('button', { name: /Tampilkan kutipan email/ }).click();
      await page.frameLocator('iframe[title="Kutipan email asli"]').locator('table').waitFor();
      await settle(page);
    },
  },
  // Lampiran: satu siap, satu sedang diunggah (progres), satu ditolak sebelum diunggah.
  {
    name: 'email-tulis-lampiran',
    path: `/email?f=${CS_INBOX_FOLDER}`,
    before: (page) => withCompose(page, { hangUpload: true }),
    waitFor: 'h1',
    prepare: async (page) => {
      await openNewCompose(page);
      await fillNewCompose(page, 'Halo Bu Rina, rincian harga dan denah lokasi ada di lampiran.');
      const pdf = Buffer.from('%PDF-1.7');
      await page.locator('input[type="file"][multiple]').setInputFiles([
        { name: 'Penawaran-Bisnis-50Mbps.pdf', mimeType: 'application/pdf', buffer: pdf },
        { name: 'Denah-Lokasi-Sukadana.pdf', mimeType: 'application/pdf', buffer: pdf },
        {
          name: 'pemasang-driver.exe',
          mimeType: 'application/octet-stream',
          buffer: Buffer.from('MZ'),
        },
      ]);
      await page.getByText('Penawaran-Bisnis-50Mbps.pdf').first().waitFor();
      await page.getByRole('progressbar').waitFor();
      await settle(page);
    },
  },
  // Kirim → toast "Email akan dikirim dari … · Batalkan (hitung mundur) · Kirim sekarang".
  {
    name: 'email-terkirim-batalkan',
    path: `/email?f=${CS_INBOX_FOLDER}`,
    before: (page) => withCompose(page),
    waitFor: 'h1',
    prepare: async (page) => {
      await openNewCompose(page);
      await fillNewCompose(page, COMPOSE_BODY);
      const send = page.getByRole('button', { name: 'Kirim', exact: true });
      await send.click();
      await page.getByText('Email akan dikirim dari cs@majujaya.co.id').waitFor();
      await settle(page);
    },
  },
  // Ada email baru di utas sejak mulai menulis (409) → Lihat dulu / Tetap kirim.
  {
    name: 'email-utas-baru-409',
    path: `/email?m=${MAIL_MESSAGE_IDS.noc}`,
    before: (page) => withCompose(page, { threadConflict: true }),
    waitFor: 'iframe',
    prepare: async (page) => {
      await openReply(page);
      await page.getByRole('button', { name: 'Kirim', exact: true }).click();
      await page.getByRole('dialog', { name: 'Ada email baru di utas ini' }).waitFor();
      await page.mouse.move(1, 1);
    },
  },
  // Pengaturan → Akun email → CS: alamat pengirim (utama terverifikasi + alias menunggu kode).
  {
    name: 'akun-identitas',
    path: `/pengaturan/akun-email/${MAIL_PHOTO_IDS.cs}`,
    before: withSettings,
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByText('tagihan@majujaya.co.id').first().waitFor();
      await page
        .locator('#alamat-pengirim')
        .evaluate((node) => node.scrollIntoView({ block: 'start' }));
      await settle(page);
    },
  },
  {
    name: 'akun-tanda-tangan',
    path: `/pengaturan/akun-email/${MAIL_PHOTO_IDS.cs}`,
    before: withSettings,
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByText('Singkat untuk balasan').first().waitFor();
      await page
        .locator('#tanda-tangan')
        .evaluate((node) => node.scrollIntoView({ block: 'start' }));
      await settle(page);
    },
  },
  // Ubah tanda tangan: editor yang sama dengan jendela tulis + variabel + logo.
  {
    name: 'akun-tanda-tangan-ubah',
    path: `/pengaturan/akun-email/${MAIL_PHOTO_IDS.cs}`,
    before: withSettings,
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Ubah Formal' }).click();
      await page.getByRole('dialog', { name: 'Ubah tanda tangan' }).waitFor();
      await page.mouse.move(1, 1);
    },
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
