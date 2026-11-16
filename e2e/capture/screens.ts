import type { Page } from '@playwright/test';
import {
  PHOTO_BACKUP_CODES,
  apiError,
  asGuest,
  emailTestResult,
  enrollmentScreen,
  fillEmailStep,
  freshInstall,
  hang,
  json,
  mockConfirmEnrollment,
  mockEnroll,
  mockVerifyWithBackupCode,
  savedEmailSettings,
  fillIdentityDialog,
  sessionAs,
  toCodeStep,
  twoFactorChallenge,
  twoFactorStatus,
  validationError,
  wizardTo,
} from './mocks';
import { accountScreens } from './screens-akun';
import { channelScreens } from './screens-channel';
import { inboxScreens } from './screens-inbox';
import { notificationScreens } from './screens-notifikasi';
import { integrationScreens } from './screens-integrasi';
import { teamScreens } from './screens-tim';

export interface Screen {
  /** Nama berkas: e2e/screenshots/<name>--<viewport>-<tema>.png */
  name: string;
  /** Path yang dibuka (relatif ke baseURL). */
  path: string;
  /** Selector yang harus terlihat sebelum difoto (opsional). */
  waitFor?: string;
  /** Disiapkan sebelum halaman dibuka, mis. jawaban API tiruan atau menghapus sesi. */
  before?: (page: Page) => Promise<unknown>;
  /** Bawaan `networkidle`; layar memuat memakai `domcontentloaded`. */
  waitUntil?: 'networkidle' | 'domcontentloaded';
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

  // ── Wizard setup (API tiruan: setup di server sudah selesai untuk sesi foto) ──
  {
    name: 'setup-token',
    path: '/setup',
    before: (page) => freshInstall(page),
    waitFor: 'h1',
  },
  {
    name: 'setup-token-salah',
    path: '/setup',
    before: async (page) => {
      await freshInstall(page);
      await page.route('**/api/v1/setup/verify-token', (route) =>
        apiError(
          route,
          403,
          'FORBIDDEN',
          'Token setup salah. Salin lagi nilai SETUP_TOKEN dari berkas .env server (atau dari keluaran installer), lalu coba lagi.',
        ),
      );
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByLabel('Token setup').fill('token-yang-salah');
      await page.getByRole('button', { name: 'Lanjut' }).click();
      await page.getByText(/Token setup salah/).waitFor();
    },
  },
  {
    name: 'setup-organisasi',
    path: '/setup',
    before: (page) => freshInstall(page),
    prepare: (page) => wizardTo(page, 'organization'),
  },
  {
    name: 'setup-organisasi-error',
    path: '/setup',
    before: (page) => freshInstall(page),
    prepare: async (page) => {
      await wizardTo(page, 'organization');
      await page.getByRole('button', { name: 'Lanjut' }).click();
      await page.getByText('Nama perusahaan wajib diisi.').waitFor();
    },
  },
  {
    name: 'setup-owner-lemah',
    path: '/setup',
    before: (page) => freshInstall(page),
    prepare: async (page) => {
      await wizardTo(page, 'owner');
      await page.getByLabel('Nama lengkap').fill('Rina Kartika');
      await page.getByLabel('Email', { exact: true }).fill('rina@majujaya.co.id');
      await page.getByLabel('Password', { exact: true }).fill('password123');
      await page.getByText(/terlalu umum/).waitFor();
    },
  },
  {
    name: 'setup-owner-kuat',
    path: '/setup',
    before: (page) => freshInstall(page),
    prepare: async (page) => {
      await wizardTo(page, 'owner');
      await page.getByLabel('Nama lengkap').fill('Rina Kartika');
      await page.getByLabel('Email', { exact: true }).fill('rina@majujaya.co.id');
      await page.getByLabel('Password', { exact: true }).fill('Kopi-Senja-Tenang-42');
      await page.getByLabel('Ulangi password').fill('Kopi-Senja-Tenang-42');
      await page.getByText('Siap dipakai.').waitFor();
    },
  },
  {
    name: 'setup-tampilan',
    path: '/setup',
    before: (page) => freshInstall(page),
    prepare: (page) => wizardTo(page, 'branding'),
  },
  {
    // Nama aplikasi diisi: pratinjau logo memakai nama itu, persis seperti di halaman masuk.
    name: 'setup-tampilan-terisi',
    path: '/setup',
    before: (page) => freshInstall(page),
    prepare: async (page) => {
      await wizardTo(page, 'branding');
      await page.getByLabel('Nama aplikasi').fill('CS Maju Jaya');
      await page.getByText('CS Maju Jaya', { exact: true }).waitFor();
    },
  },
  {
    name: 'setup-email',
    path: '/setup',
    before: (page) => freshInstall(page),
    prepare: (page) => wizardTo(page, 'email'),
  },
  {
    // Panduan langkah demi langkah dibuka, preset Gmail: langkah khusus + tautan resmi.
    name: 'setup-email-panduan-gmail',
    path: '/setup',
    before: (page) => freshInstall(page),
    prepare: async (page) => {
      await wizardTo(page, 'email');
      await page.getByRole('radio', { name: 'Gmail / Google Workspace' }).click();
      await page.getByText('Lihat panduan langkah demi langkah').click();
      const link = page.getByRole('link', { name: /sandi aplikasi Google/ });
      await link.waitFor();
      await link.scrollIntoViewIfNeeded();
    },
  },
  {
    // Preset Gmail dipilih, domain menunjuk hosting: saran ditawarkan sebagai pilihan ganti.
    name: 'setup-email-saran-ganti',
    path: '/setup',
    before: (page) => freshInstall(page),
    prepare: async (page) => {
      await wizardTo(page, 'email');
      await page.getByRole('radio', { name: 'Gmail / Google Workspace' }).click();
      await page.getByLabel('Alamat email pengirim').fill('cs@majujaya.co.id');
      const offer = page.getByText(/Ganti ke pengaturan ini\?/);
      await offer.waitFor();
      await offer.scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'setup-email-saran-host',
    path: '/setup',
    before: (page) => freshInstall(page),
    prepare: async (page) => {
      await wizardTo(page, 'email');
      await page.getByLabel('Nama pengirim').fill('CS Maju Jaya');
      await page.getByLabel('Alamat email pengirim').fill('cs@majujaya.co.id');
      await page.getByText('Saran dipakai').waitFor();
    },
  },
  {
    name: 'setup-email-tes-gagal',
    path: '/setup',
    before: async (page) => {
      await freshInstall(page);
      await emailTestResult(page, false, 'setup');
    },
    prepare: async (page) => {
      await wizardTo(page, 'email');
      await fillEmailStep(page);
      await page.getByRole('button', { name: 'Tes koneksi' }).click();
      const result = page.getByText(/Username atau password ditolak/);
      await result.waitFor();
      await result.scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'setup-email-tes-berhasil',
    path: '/setup',
    before: async (page) => {
      await freshInstall(page);
      await emailTestResult(page, true, 'setup');
    },
    prepare: async (page) => {
      await wizardTo(page, 'email');
      await fillEmailStep(page);
      await page.getByRole('button', { name: 'Tes koneksi' }).click();
      const result = page.getByText(/Berhasil terhubung/);
      await result.waitFor();
      await result.scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'setup-email-tanpa-master-key',
    path: '/setup',
    before: (page) => freshInstall(page, { canStoreSecrets: false }),
    prepare: (page) => wizardTo(page, 'email'),
  },
  {
    name: 'setup-ringkasan',
    path: '/setup',
    before: (page) => freshInstall(page),
    prepare: (page) => wizardTo(page, 'summary'),
  },
  {
    name: 'setup-ringkasan-error',
    path: '/setup',
    before: async (page) => {
      await freshInstall(page);
      await page.route('**/api/v1/setup/complete', (route) =>
        apiError(
          route,
          503,
          'SERVICE_UNAVAILABLE',
          'Layanan sedang tidak tersedia. Coba lagi beberapa saat lagi.',
        ),
      );
    },
    prepare: async (page) => {
      await wizardTo(page, 'summary');
      await page.getByRole('button', { name: 'Selesai dan masuk' }).click();
      await page.getByRole('alert').first().waitFor();
    },
  },
  {
    name: 'setup-token-belum-diatur',
    path: '/setup',
    before: (page) => freshInstall(page, { setupTokenConfigured: false }),
    waitFor: 'h1',
  },
  {
    name: 'setup-sudah-selesai',
    path: '/setup',
    before: async (page) => {
      await freshInstall(page);
      await page.route('**/api/v1/setup/verify-token', (route) =>
        apiError(route, 409, 'CONFLICT', 'Setup sudah selesai.'),
      );
    },
    prepare: async (page) => {
      await page.getByLabel('Token setup').fill('token-apa-saja');
      await page.getByRole('button', { name: 'Lanjut' }).click();
      await page.getByRole('heading', { name: 'Setup sudah selesai' }).waitFor();
    },
  },
  {
    name: 'setup-memuat',
    path: '/setup',
    waitUntil: 'domcontentloaded',
    before: async (page) => {
      await asGuest(page);
      await hang(page, '/setup/status');
    },
    waitFor: '[role="status"]',
  },
  {
    name: 'setup-gagal',
    path: '/setup',
    before: async (page) => {
      await asGuest(page);
      await page.route('**/api/v1/setup/status', (route) =>
        apiError(route, 502, 'BAD_GATEWAY', 'Server aplikasi belum bisa dihubungi.'),
      );
    },
    waitFor: 'h1',
  },

  // ── Halaman masuk (tamu) ──
  { name: 'masuk', path: '/masuk', before: asGuest, waitFor: 'h1' },
  {
    name: 'masuk-isian-kosong',
    path: '/masuk',
    before: asGuest,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Masuk', exact: true }).click();
      await page.getByText('Alamat email wajib diisi.').waitFor();
    },
  },
  {
    name: 'masuk-salah',
    path: '/masuk',
    before: async (page) => {
      await asGuest(page);
      await page.route('**/api/v1/auth/login', (route) =>
        apiError(
          route,
          401,
          'INVALID_CREDENTIALS',
          'Email atau password salah. Periksa lagi lalu coba masuk kembali.',
        ),
      );
    },
    prepare: async (page) => {
      await page.getByLabel('Email').fill('rina@majujaya.co.id');
      await page.getByLabel('Password', { exact: true }).fill('password-yang-salah');
      await page.getByRole('button', { name: 'Masuk', exact: true }).click();
      await page.getByRole('alert').waitFor();
      await page.mouse.move(0, 0);
    },
  },
  {
    name: 'masuk-terkunci',
    path: '/masuk',
    before: async (page) => {
      await asGuest(page);
      await page.route('**/api/v1/auth/login', (route) =>
        apiError(
          route,
          429,
          'RATE_LIMITED',
          'Akun ini dikunci sementara karena terlalu banyak percobaan masuk yang gagal.',
          { 'retry-after': '900' },
        ),
      );
    },
    prepare: async (page) => {
      await page.getByLabel('Email').fill('rina@majujaya.co.id');
      await page.getByLabel('Password', { exact: true }).fill('password-yang-salah');
      await page.getByRole('button', { name: 'Masuk', exact: true }).click();
      await page.getByText('Masuk dikunci sementara').waitFor();
    },
  },
  {
    name: 'masuk-sesi-berakhir',
    path: '/pengaturan',
    before: (page) =>
      page.route('**/api/v1/settings/email', (route) =>
        apiError(
          route,
          401,
          'UNAUTHENTICATED',
          'Sesi kamu sudah berakhir. Masuk lagi untuk melanjutkan.',
        ),
      ),
    prepare: async (page) => {
      await page.getByText('Sesimu sudah berakhir.', { exact: false }).waitFor();
    },
  },
  {
    name: 'masuk-memuat',
    path: '/masuk',
    waitUntil: 'domcontentloaded',
    before: async (page) => {
      await asGuest(page);
      await hang(page, '/auth/me');
    },
    waitFor: '[role="status"]',
  },

  // ── Kerangka aplikasi: memeriksa sesi ──
  {
    name: 'aplikasi-memuat',
    path: '/inbox',
    waitUntil: 'domcontentloaded',
    before: (page) => hang(page, '/auth/me'),
    waitFor: '[role="status"]',
  },
  {
    name: 'aplikasi-gagal',
    path: '/inbox',
    before: (page) =>
      page.route('**/api/v1/auth/me', (route) =>
        apiError(route, 503, 'SERVICE_UNAVAILABLE', 'Layanan sedang tidak tersedia.'),
      ),
    waitFor: 'h1',
  },

  // ── Akun & Pengaturan → Email pengirim (sesi Owner sungguhan) ──
  {
    name: 'menu-pengguna',
    path: '/inbox',
    waitFor: 'h1',
    // Menu akun ada di rail desktop; di HP akun dan Keluar ada di layar "Lainnya".
    prepare: async (page) => {
      const trigger = page.getByRole('button', { name: /^Akun / });
      if (await trigger.isVisible()) {
        await trigger.click();
        await page.getByRole('menu').waitFor();
      } else {
        await page.goto('/lainnya');
        await page.getByRole('heading', { level: 1, name: 'Lainnya' }).waitFor();
      }
    },
  },
  { name: 'email-pengirim', path: '/pengaturan/email', waitFor: 'h1' },
  {
    name: 'email-pengirim-terisi',
    path: '/pengaturan/email',
    before: savedEmailSettings,
    waitFor: 'h1',
  },
  {
    name: 'email-pengirim-tes-berhasil',
    path: '/pengaturan/email',
    before: async (page) => {
      await savedEmailSettings(page);
      await emailTestResult(page, true, 'settings');
    },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Tes koneksi' }).click();
      const result = page.getByText(/Berhasil terhubung/).last();
      await result.waitFor();
      await result.scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'email-pengirim-tes-gagal',
    path: '/pengaturan/email',
    before: async (page) => {
      await savedEmailSettings(page);
      await emailTestResult(page, false, 'settings');
    },
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Tes koneksi' }).click();
      const result = page.getByText(/Username atau password ditolak/);
      await result.waitFor();
      await result.scrollIntoViewIfNeeded();
    },
  },
  {
    // Server email diganti → konfirmasi identitas sebelum disimpan (semua peran, Owner juga).
    name: 'email-pengirim-konfirmasi',
    path: '/pengaturan/email',
    before: savedEmailSettings,
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByLabel('Host SMTP').fill('smtp.majujaya.co.id');
      await page.getByLabel('Password', { exact: true }).fill('sandi-smtp-baru');
      await page.getByRole('button', { name: 'Simpan' }).click();
      await page.getByRole('dialog').waitFor();
      await fillIdentityDialog(page);
      await page.getByRole('dialog').getByLabel('Password', { exact: true }).focus();
    },
  },
  {
    name: 'email-pengirim-password-ulang',
    path: '/pengaturan/email',
    before: savedEmailSettings,
    prepare: async (page) => {
      await page.getByLabel('Host SMTP').fill('smtp.majujaya.co.id');
      await page.getByRole('button', { name: 'Simpan' }).click();
      const error = page.getByText(/password perlu dimasukkan ulang/).first();
      await error.waitFor();
      await error.scrollIntoViewIfNeeded();
    },
  },
  {
    // Preset diganti ke Gmail: panduan di kolom kanan menampilkan langkah khusus Gmail.
    name: 'email-pengirim-panduan-gmail',
    path: '/pengaturan/email',
    before: savedEmailSettings,
    prepare: async (page) => {
      await page.getByRole('radio', { name: 'Gmail / Google Workspace' }).click();
      const guide = page.getByText('Panduan singkat');
      if (!(await page.getByRole('link', { name: /sandi aplikasi Google/ }).isVisible())) {
        await guide.click();
      }
      const link = page.getByRole('link', { name: /sandi aplikasi Google/ });
      await link.waitFor();
      await link.scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'email-pengirim-memuat',
    path: '/pengaturan/email',
    waitUntil: 'domcontentloaded',
    before: (page) => hang(page, '/settings/email'),
    waitFor: '[role="status"]',
  },
  {
    name: 'email-pengirim-env',
    path: '/pengaturan/email',
    before: (page) =>
      page.route('**/api/v1/settings/email', (route) =>
        json(route, {
          source: 'env',
          settings: {
            fromName: 'Balesin',
            fromAddress: 'noreply@majujaya.co.id',
            replyTo: null,
            host: 'smtp.majujaya.co.id',
            port: 587,
            security: 'starttls',
            username: 'noreply@majujaya.co.id',
            hasPassword: true,
            passwordHint: null,
          },
          status: 'untested',
          lastTest: null,
          updatedAt: null,
          canStoreSecrets: false,
        }),
      ),
    waitFor: 'h1',
  },
  // ── Masuk: langkah kedua (2FA) ──
  {
    name: 'masuk-kode',
    path: '/masuk',
    before: twoFactorChallenge,
    prepare: toCodeStep,
  },
  {
    name: 'masuk-kode-salah',
    path: '/masuk',
    before: async (page) => {
      await twoFactorChallenge(page);
      await page.route('**/api/v1/auth/2fa/verify', (route) =>
        validationError(
          route,
          'code',
          'Kode salah. Periksa kode terbaru di aplikasi autentikatormu (kode berganti tiap 30 detik), atau pakai kode cadangan. Sisa 2 percobaan.',
        ),
      );
    },
    prepare: async (page) => {
      await toCodeStep(page);
      await page.getByLabel('Kode verifikasi').fill('123456');
      await page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
      await page.getByText(/Sisa 2 percobaan/).waitFor();
    },
  },
  {
    name: 'masuk-kode-terkunci',
    path: '/masuk',
    before: async (page) => {
      await twoFactorChallenge(page);
      await page.route('**/api/v1/auth/2fa/verify', (route) =>
        apiError(
          route,
          429,
          'RATE_LIMITED',
          'Terlalu banyak kode verifikasi yang salah untuk akun ini.',
          { 'retry-after': '900' },
        ),
      );
    },
    prepare: async (page) => {
      await toCodeStep(page);
      await page.getByLabel('Kode verifikasi').fill('123456');
      await page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
      await page.getByText('Verifikasi dikunci sementara').waitFor();
    },
  },
  {
    name: 'masuk-kode-cadangan',
    path: '/masuk',
    before: twoFactorChallenge,
    prepare: async (page) => {
      await toCodeStep(page);
      await page.getByRole('button', { name: 'Pakai kode cadangan' }).click();
      await page.getByRole('heading', { level: 1, name: 'Masukkan kode cadangan' }).waitFor();
    },
  },
  {
    name: 'masuk-kode-cadangan-dipakai',
    path: '/masuk',
    before: async (page) => {
      await twoFactorChallenge(page);
      await mockVerifyWithBackupCode(page, 2);
    },
    prepare: async (page) => {
      await toCodeStep(page);
      await page.getByRole('button', { name: 'Pakai kode cadangan' }).click();
      await page.getByLabel('Kode cadangan').fill('k7m2p-x9q4r');
      await page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
      await page
        .getByRole('heading', { level: 1, name: 'Kamu masuk dengan kode cadangan' })
        .waitFor();
      await page.mouse.move(0, 0);
    },
  },
  {
    // Tantangan hangus (3 kode salah / kedaluwarsa) → kembali ke password dengan pesannya.
    name: 'masuk-kode-hangus',
    path: '/masuk',
    before: async (page) => {
      await twoFactorChallenge(page);
      await page.route('**/api/v1/auth/2fa/verify', (route) =>
        apiError(
          route,
          401,
          'TWO_FACTOR_CHALLENGE_INVALID',
          'Kode salah 3 kali. Masuk lagi dengan email dan password-mu.',
        ),
      );
    },
    prepare: async (page) => {
      await toCodeStep(page);
      await page.getByLabel('Kode verifikasi').fill('123456');
      await page.getByRole('button', { name: 'Verifikasi', exact: true }).click();
      await page.getByText('Kode salah 3 kali.', { exact: false }).waitFor();
    },
  },
  {
    // 5 menit berlalu tanpa kode (jam halaman dimajukan) → kembali ke password.
    name: 'masuk-kode-kedaluwarsa',
    path: '/masuk',
    before: async (page) => {
      await page.clock.install();
      await twoFactorChallenge(page);
    },
    prepare: async (page) => {
      await toCodeStep(page);
      await page.clock.fastForward('05:01');
      await page.getByText('Waktu memasukkan kode sudah habis.', { exact: false }).waitFor();
    },
  },

  // ── Pendaftaran 2FA wajib (sesi terbatas tiruan) ──
  {
    name: 'daftar-2fa',
    path: '/verifikasi-dua-langkah',
    before: enrollmentScreen,
    waitFor: 'svg[role="img"]',
  },
  {
    name: 'daftar-2fa-penuh',
    path: '/verifikasi-dua-langkah',
    before: enrollmentScreen,
    waitFor: 'svg[role="img"]',
    fullPage: true,
  },
  {
    name: 'daftar-2fa-memuat',
    path: '/verifikasi-dua-langkah',
    waitUntil: 'domcontentloaded',
    before: async (page) => {
      await sessionAs(page, 'owner', 'two_factor_enrollment_required');
      await hang(page, '/auth/2fa/enroll');
    },
    waitFor: 'h1',
  },
  {
    name: 'daftar-2fa-kode-salah',
    path: '/verifikasi-dua-langkah',
    before: async (page) => {
      await enrollmentScreen(page);
      await page.route('**/api/v1/auth/2fa/enroll/confirm', (route) =>
        validationError(
          route,
          'code',
          'Kode tidak cocok. Masukkan kode terbaru dari entri akun ini di aplikasi autentikator. Kalau kamu pernah memindai kode QR lain untuk akun ini, hapus entri lamanya. Pastikan juga jam di ponselmu tepat.',
        ),
      );
    },
    waitFor: 'svg[role="img"]',
    prepare: async (page) => {
      await page.getByLabel('Kode 6 digit').fill('123456');
      await page.getByRole('button', { name: 'Aktifkan', exact: true }).click();
      const error = page.getByText(/Kode tidak cocok/);
      await error.waitFor();
      await error.scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'daftar-2fa-kedaluwarsa',
    path: '/verifikasi-dua-langkah',
    before: async (page) => {
      await enrollmentScreen(page);
      await page.route('**/api/v1/auth/2fa/enroll/confirm', (route) =>
        apiError(route, 409, 'CONFLICT', 'Kode QR sudah kedaluwarsa. Mulai lagi.'),
      );
    },
    waitFor: 'svg[role="img"]',
    prepare: async (page) => {
      await page.getByLabel('Kode 6 digit').fill('123456');
      await page.getByRole('button', { name: 'Aktifkan', exact: true }).click();
      const notice = page.getByText('Kode QR sudah kedaluwarsa');
      await notice.waitFor();
      await notice.scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'daftar-2fa-gagal',
    path: '/verifikasi-dua-langkah',
    before: async (page) => {
      await sessionAs(page, 'owner', 'two_factor_enrollment_required');
      await page.route('**/api/v1/auth/2fa/enroll', (route) =>
        apiError(
          route,
          503,
          'SERVICE_UNAVAILABLE',
          'Verifikasi dua langkah belum bisa diaktifkan karena kunci enkripsi server belum diisi. Hubungi pengelola server.',
        ),
      );
    },
    waitFor: '[role="alert"]',
  },
  {
    name: 'kode-cadangan',
    path: '/verifikasi-dua-langkah',
    before: async (page) => {
      await enrollmentScreen(page);
      await mockConfirmEnrollment(page);
    },
    waitFor: 'svg[role="img"]',
    prepare: async (page) => {
      await page.getByLabel('Kode 6 digit').fill('123456');
      await page.getByRole('button', { name: 'Aktifkan', exact: true }).click();
      await page.getByText(PHOTO_BACKUP_CODES[0] ?? '').waitFor();
      await page.mouse.move(1, 1);
    },
  },
  {
    name: 'kode-cadangan-belum-dicentang',
    path: '/verifikasi-dua-langkah',
    before: async (page) => {
      await enrollmentScreen(page);
      await mockConfirmEnrollment(page);
    },
    waitFor: 'svg[role="img"]',
    prepare: async (page) => {
      await page.getByLabel('Kode 6 digit').fill('123456');
      await page.getByRole('button', { name: 'Aktifkan', exact: true }).click();
      await page.getByRole('button', { name: 'Lanjut ke Inbox' }).click();
      const error = page.getByText('Simpan kode cadangan dulu, lalu centang kotak ini.');
      await error.waitFor();
      await error.scrollIntoViewIfNeeded();
    },
  },

  // ── Pengaturan → Keamanan akun ──
  { name: 'keamanan', path: '/pengaturan/keamanan', waitFor: 'h1' },
  {
    name: 'keamanan-kode-sedikit',
    path: '/pengaturan/keamanan',
    before: (page) =>
      twoFactorStatus(page, { enabled: true, required: true, backupCodesRemaining: 2 }),
    waitFor: 'h1',
  },
  {
    name: 'keamanan-buat-ulang',
    path: '/pengaturan/keamanan',
    waitFor: 'h1',
    prepare: async (page) => {
      // Konfirmasi identitas: dialog yang sama dengan semua aksi sensitif (kritikus akhir W3).
      await page.getByRole('button', { name: 'Buat kode baru' }).click();
      await page
        .getByRole('dialog')
        .getByLabel('Password', { exact: true })
        .fill('Kopi-Senja-Tenang-42');
    },
  },
  {
    name: 'keamanan-kode-baru',
    path: '/pengaturan/keamanan',
    before: (page) =>
      page.route('**/api/v1/auth/2fa/backup-codes', (route) =>
        json(route, { codes: PHOTO_BACKUP_CODES, generatedAt: new Date().toISOString() }),
      ),
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Buat kode baru' }).click();
      await page.getByLabel('Password', { exact: true }).fill('Kopi-Senja-Tenang-42');
      await page.getByLabel('Kode verifikasi').fill('123456');
      await page.getByRole('dialog').getByRole('button', { name: 'Buat kode baru' }).click();
      await page.getByRole('heading', { level: 2, name: 'Kode cadangan baru' }).waitFor();
      await page.mouse.move(1, 1);
    },
  },
  {
    name: 'keamanan-terkunci',
    path: '/pengaturan/keamanan',
    before: (page) =>
      page.route('**/api/v1/auth/2fa/backup-codes', (route) =>
        apiError(route, 429, 'RATE_LIMITED', 'Terlalu banyak percobaan konfirmasi yang salah.', {
          'retry-after': '900',
        }),
      ),
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Buat kode baru' }).click();
      await page.getByLabel('Password', { exact: true }).fill('Kopi-Senja-Tenang-42');
      await page.getByLabel('Kode verifikasi').fill('123456');
      await page.getByRole('dialog').getByRole('button', { name: 'Buat kode baru' }).click();
      const alert = page.getByText('Konfirmasi dikunci sementara');
      await alert.waitFor();
      await alert.scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'keamanan-memuat',
    path: '/pengaturan/keamanan',
    waitUntil: 'domcontentloaded',
    before: (page) => hang(page, '/auth/2fa'),
    waitFor: '[role="status"]',
  },
  {
    name: 'keamanan-cs-belum-aktif',
    path: '/pengaturan/keamanan',
    before: async (page) => {
      await sessionAs(page, 'cs');
      await twoFactorStatus(page, { enabled: false, required: false });
    },
    waitFor: 'h1',
  },
  {
    name: 'keamanan-cs-nonaktifkan',
    path: '/pengaturan/keamanan',
    before: async (page) => {
      await sessionAs(page, 'cs');
      await twoFactorStatus(page, { enabled: true, required: false, backupCodesRemaining: 7 });
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Nonaktifkan verifikasi dua langkah' }).click();
      await page.getByRole('dialog').waitFor();
    },
  },
  {
    name: 'aktifkan-2fa-password',
    path: '/pengaturan/keamanan/aktifkan',
    before: async (page) => {
      await sessionAs(page, 'cs');
      await twoFactorStatus(page, { enabled: false, required: false });
    },
    waitFor: 'h1',
  },
  {
    name: 'aktifkan-2fa',
    path: '/pengaturan/keamanan/aktifkan',
    before: async (page) => {
      await sessionAs(page, 'cs');
      await twoFactorStatus(page, { enabled: false, required: false });
      await mockEnroll(page);
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByLabel('Password', { exact: true }).fill('Teh-Manis-Hangat-77');
      await page.getByRole('button', { name: 'Lanjut', exact: true }).click();
      await page.locator('svg[role="img"]').waitFor();
    },
  },
  {
    // Pindah halaman sebelum kode cadangan baru dinyatakan tersimpan → dialog konfirmasi.
    name: 'keamanan-kode-baru-tinggalkan',
    path: '/pengaturan/keamanan',
    before: (page) =>
      page.route('**/api/v1/auth/2fa/backup-codes', (route) =>
        json(route, { codes: PHOTO_BACKUP_CODES, generatedAt: new Date().toISOString() }),
      ),
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Buat kode baru' }).click();
      await page.getByLabel('Password', { exact: true }).fill('Kopi-Senja-Tenang-42');
      await page.getByLabel('Kode verifikasi').fill('123456');
      await page.getByRole('dialog').getByRole('button', { name: 'Buat kode baru' }).click();
      await page.getByRole('heading', { level: 2, name: 'Kode cadangan baru' }).waitFor();
      await page.getByRole('link', { name: 'Kembali ke Pengaturan' }).click();
      await page.getByRole('heading', { name: 'Tinggalkan kode cadangan?' }).waitFor();
      await page.mouse.move(1, 1);
    },
  },
  {
    name: 'kode-cadangan-dicentang',
    path: '/verifikasi-dua-langkah',
    before: async (page) => {
      await enrollmentScreen(page);
      await mockConfirmEnrollment(page);
    },
    waitFor: 'svg[role="img"]',
    prepare: async (page) => {
      await page.getByLabel('Kode 6 digit').fill('123456');
      await page.getByRole('button', { name: 'Aktifkan', exact: true }).click();
      const saved = page.getByRole('checkbox', {
        name: 'Saya sudah menyimpan kode ini di tempat yang aman',
      });
      await saved.check();
      await saved.scrollIntoViewIfNeeded();
      await page.mouse.move(1, 1);
    },
  },

  // Fase 1 butir 4: Tim, undangan, lupa/atur ulang password, verifikasi email, pratinjau.
  ...accountScreens,

  // Fase 1 butir 6: anggota tim, detail anggota, sesi aktif, audit log, banner keamanan.
  ...teamScreens,

  // Fase 2 butir 1–2: Channel (daftar, wizard tambah nomor, halaman nomor, profil bisnis).
  ...channelScreens,
  ...inboxScreens,
  ...notificationScreens,
  ...integrationScreens,
];
