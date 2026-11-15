import {
  INVITATION_PATH,
  PHOTO_INVITATIONS,
  RESET_PATH,
  VERIFY_PATH,
  apiError,
  asGuest,
  emailVerificationStatus,
  hang,
  inspectInvitation,
  inspectPasswordReset,
  invitationList,
  json,
  mockCreateInvitation,
  passwordResetAvailable,
  photoInvitation,
  sessionAs,
  submitInvitation,
  openInvitationConfirm,
  fillIdentityDialog,
  validationError,
} from './mocks';
import type { Page } from '@playwright/test';
import type { Screen } from './screens';

/** Gulir kartu Email akun (paling bawah di Keamanan akun) ke tengah layar. */
async function showEmailCard(page: Page): Promise<void> {
  await page
    .getByRole('heading', { level: 2, name: 'Email akun' })
    .evaluate((el) => el.scrollIntoView({ block: 'center' }));
}

/**
 * Layar Fase 1 butir 4: Pengaturan → Tim, halaman tautan email (undangan, lupa/atur ulang
 * password, verifikasi email), kartu Email akun di Keamanan akun, dan pratinjau template email.
 * Keadaan yang tidak bisa dipicu berulang melawan API sungguhan memakai jawaban tiruan.
 */
export const accountScreens: Screen[] = [
  // ── Pengaturan → Tim (Owner & Admin) ──
  {
    name: 'tim-kosong',
    path: '/pengaturan/tim',
    before: (page) => invitationList(page, { emailDelivery: true }),
    waitFor: 'h1',
  },
  {
    name: 'tim-daftar',
    path: '/pengaturan/tim',
    before: (page) => invitationList(page, { invitations: PHOTO_INVITATIONS }),
    waitFor: 'h1',
  },
  {
    // Admin: tanpa pilihan Admin; undangan Admin buatan Owner tidak bisa dikelola.
    name: 'tim-admin',
    path: '/pengaturan/tim',
    before: async (page) => {
      await sessionAs(page, 'admin');
      await invitationList(page, {
        invitableRoles: ['supervisor', 'cs', 'teknisi'],
        emailDelivery: true,
        invitations: [
          photoInvitation(5, {
            email: 'citra@majujaya.co.id',
            role: 'cs',
            invitedBy: 'Dimas Pratama',
          }),
          photoInvitation(6, {
            email: 'agus.pratama@majujaya.co.id',
            role: 'admin',
            canManage: false,
          }),
        ],
      });
    },
    waitFor: 'h1',
  },
  {
    name: 'tim-tanpa-email',
    path: '/pengaturan/tim',
    before: (page) =>
      invitationList(page, {
        emailDelivery: false,
        invitations: [
          photoInvitation(7, {
            email: 'citra@majujaya.co.id',
            role: 'cs',
            deliveryStatus: 'link',
          }),
        ],
      }),
    waitFor: 'h1',
  },
  {
    name: 'tim-terkirim',
    path: '/pengaturan/tim',
    before: async (page) => {
      await invitationList(page, { emailDelivery: true });
      await mockCreateInvitation(page, false);
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await submitInvitation(page, 'tono@majujaya.co.id', 'Teknisi');
      await page.getByText('Undangan untuk tono@majujaya.co.id dibuat', { exact: false }).waitFor();
    },
  },
  {
    // Konfirmasi identitas sebelum undangan dibuat (semua peran, Owner juga).
    name: 'tim-konfirmasi-undangan',
    path: '/pengaturan/tim',
    before: (page) => invitationList(page, { emailDelivery: true }),
    waitFor: 'h1',
    prepare: async (page) => {
      await openInvitationConfirm(page, 'tono@majujaya.co.id', 'Teknisi');
      await fillIdentityDialog(page);
      await page.getByRole('dialog').getByLabel('Password', { exact: true }).focus();
    },
  },
  {
    name: 'tim-isian-salah',
    path: '/pengaturan/tim',
    before: async (page) => {
      await invitationList(page, { emailDelivery: true });
      await page.route('**/api/v1/invitations', (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        const message = 'Email ini sudah terdaftar sebagai pengguna di organisasimu.';
        return json(
          route,
          {
            error: {
              code: 'CONFLICT',
              message,
              details: [{ location: 'body', field: 'email', message }],
              requestId: 'req-foto',
            },
          },
          409,
        );
      });
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await submitInvitation(page, 'rina@majujaya.co.id', 'CS');
      await page.getByText('sudah terdaftar sebagai pengguna').first().waitFor();
    },
  },
  {
    name: 'tim-tautan',
    path: '/pengaturan/tim',
    before: async (page) => {
      await invitationList(page, { emailDelivery: false });
      await mockCreateInvitation(page, true);
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await submitInvitation(page, 'citra@majujaya.co.id', 'CS');
      await page.getByRole('dialog').waitFor();
    },
  },
  {
    name: 'tim-tautan-belum-disalin',
    path: '/pengaturan/tim',
    before: async (page) => {
      await invitationList(page, { emailDelivery: false });
      await mockCreateInvitation(page, true);
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await submitInvitation(page, 'citra@majujaya.co.id', 'CS');
      await page.getByRole('dialog').getByRole('button', { name: 'Selesai' }).click();
      await page.getByRole('button', { name: 'Tutup tanpa menyalin' }).waitFor();
    },
  },
  {
    name: 'tim-batalkan',
    path: '/pengaturan/tim',
    before: (page) => invitationList(page, { invitations: PHOTO_INVITATIONS }),
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Batalkan' }).first().click();
      await page.getByRole('dialog').waitFor();
    },
  },
  {
    name: 'tim-memuat',
    path: '/pengaturan/tim',
    waitUntil: 'domcontentloaded',
    before: async (page) => {
      await hang(page, '/invitations');
      await hang(page, '/users');
    },
    waitFor: '[role="status"]',
  },
  {
    name: 'pengaturan-admin',
    path: '/pengaturan',
    before: async (page) => {
      await sessionAs(page, 'admin');
      await invitationList(page, { invitations: PHOTO_INVITATIONS.slice(0, 2) });
    },
    waitFor: '[role="radiogroup"]',
  },

  // ── Undangan (penerima, publik) ──
  {
    name: 'undangan',
    path: INVITATION_PATH,
    before: async (page) => {
      await asGuest(page);
      await inspectInvitation(page, 'cs');
    },
    waitFor: 'h1',
  },
  {
    name: 'undangan-wajib-2fa',
    path: INVITATION_PATH,
    before: async (page) => {
      await asGuest(page);
      await inspectInvitation(page, 'admin');
    },
    waitFor: 'h1',
  },
  {
    // Browser sedang masuk sebagai Owner (sesi foto sungguhan).
    name: 'undangan-sedang-masuk',
    path: INVITATION_PATH,
    before: (page) => inspectInvitation(page, 'cs'),
    waitFor: 'h1',
  },
  {
    name: 'undangan-password-ditolak',
    path: INVITATION_PATH,
    before: async (page) => {
      await asGuest(page);
      await inspectInvitation(page, 'cs');
      await page.route('**/api/v1/auth/invitation/accept', (route) =>
        validationError(
          route,
          'password',
          'Password ini terlalu umum dan mudah ditebak. Pakai gabungan beberapa kata acak yang tidak berhubungan, misalnya tiga atau empat kata.',
        ),
      );
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByLabel('Nama lengkap').fill('Citra Maharani');
      await page.getByLabel('Password', { exact: true }).fill('password12345');
      await page.getByLabel('Ulangi password').fill('password12345');
      await page.getByRole('button', { name: 'Buat akun' }).click();
      await page.getByText('Password ini terlalu umum', { exact: false }).first().waitFor();
    },
  },
  {
    name: 'undangan-memuat',
    path: INVITATION_PATH,
    waitUntil: 'domcontentloaded',
    before: async (page) => {
      await asGuest(page);
      await hang(page, '/auth/invitation/inspect');
    },
    waitFor: '[role="status"]',
  },
  {
    name: 'undangan-tidak-berlaku',
    path: INVITATION_PATH,
    before: async (page) => {
      await asGuest(page);
      await page.route('**/api/v1/auth/invitation/inspect', (route) =>
        apiError(
          route,
          410,
          'TOKEN_INVALID',
          'Undangan ini sudah kedaluwarsa. Minta Owner atau Admin di tempatmu mengirim ulang undangannya.',
        ),
      );
    },
    waitFor: 'h1',
  },
  {
    name: 'undangan-terkunci',
    path: INVITATION_PATH,
    before: async (page) => {
      await asGuest(page);
      await page.route('**/api/v1/auth/invitation/inspect', (route) =>
        apiError(
          route,
          429,
          'RATE_LIMITED',
          'Terlalu banyak percobaan membuka tautan dari jaringanmu.',
          { 'retry-after': '840' },
        ),
      );
    },
    waitFor: 'h1',
  },

  // ── Lupa password & atur ulang password (publik) ──
  {
    name: 'lupa-password',
    path: '/lupa-password',
    before: async (page) => {
      await asGuest(page);
      await passwordResetAvailable(page, true);
    },
    waitFor: 'h1',
  },
  {
    name: 'lupa-password-terkirim',
    path: '/lupa-password',
    before: async (page) => {
      await asGuest(page);
      await passwordResetAvailable(page, true);
      await page.route('**/api/v1/auth/password-reset/request', (route) =>
        json(route, { status: 'accepted', validMinutes: 30 }, 202),
      );
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByLabel('Email').fill('citra@majujaya.co.id');
      await page.getByRole('button', { name: 'Kirim tautan' }).click();
      await page.getByRole('heading', { level: 1, name: 'Periksa email-mu' }).waitFor();
    },
  },
  {
    name: 'lupa-password-tidak-tersedia',
    path: '/lupa-password',
    before: async (page) => {
      await asGuest(page);
      await passwordResetAvailable(page, false);
    },
    waitFor: 'h1',
  },
  {
    name: 'lupa-password-terkunci',
    path: '/lupa-password',
    before: async (page) => {
      await asGuest(page);
      await passwordResetAvailable(page, true);
      await page.route('**/api/v1/auth/password-reset/request', (route) =>
        apiError(
          route,
          429,
          'RATE_LIMITED',
          'Terlalu banyak permintaan atur ulang password untuk email ini dari jaringanmu.',
          { 'retry-after': '1800' },
        ),
      );
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByLabel('Email').fill('citra@majujaya.co.id');
      await page.getByRole('button', { name: 'Kirim tautan' }).click();
      await page.locator('[data-locked]').waitFor();
    },
  },
  {
    name: 'lupa-password-memuat',
    path: '/lupa-password',
    waitUntil: 'domcontentloaded',
    before: async (page) => {
      await asGuest(page);
      await hang(page, '/auth/password-reset');
    },
    waitFor: '[role="status"]',
  },
  {
    name: 'atur-ulang-password',
    path: RESET_PATH,
    before: async (page) => {
      await asGuest(page);
      await inspectPasswordReset(page, false);
    },
    waitFor: 'h1',
  },
  {
    name: 'atur-ulang-password-2fa',
    path: RESET_PATH,
    before: async (page) => {
      await asGuest(page);
      await inspectPasswordReset(page, true);
    },
    waitFor: 'h1',
  },
  {
    name: 'atur-ulang-password-kode-salah',
    path: RESET_PATH,
    before: async (page) => {
      await asGuest(page);
      await inspectPasswordReset(page, true);
      await page.route('**/api/v1/auth/password-reset/complete', (route) =>
        validationError(route, 'code', 'Kode verifikasi salah. Sisa 2 percobaan.'),
      );
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByLabel('Password baru', { exact: true }).fill('Gunung-Biru-Pagi-81');
      await page.getByLabel('Ulangi password baru').fill('Gunung-Biru-Pagi-81');
      await page.getByLabel('Kode verifikasi').fill('123456');
      await page.getByRole('button', { name: 'Simpan password baru' }).click();
      const error = page.getByText('Sisa 2 percobaan', { exact: false });
      await error.waitFor();
      await error.scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'atur-ulang-password-memuat',
    path: RESET_PATH,
    waitUntil: 'domcontentloaded',
    before: async (page) => {
      await asGuest(page);
      await hang(page, '/auth/password-reset/inspect');
    },
    waitFor: '[role="status"]',
  },
  {
    name: 'atur-ulang-password-tidak-berlaku',
    path: RESET_PATH,
    before: async (page) => {
      await asGuest(page);
      await page.route('**/api/v1/auth/password-reset/inspect', (route) =>
        apiError(
          route,
          410,
          'TOKEN_INVALID',
          'Tautan ini sudah dipakai. Kalau kamu masih perlu mengganti password, minta tautan baru.',
        ),
      );
    },
    waitFor: 'h1',
  },
  {
    // Atur ulang berhasil → halaman masuk dengan pesan, email sudah terisi.
    name: 'masuk-password-diganti',
    path: RESET_PATH,
    before: async (page) => {
      await asGuest(page);
      await inspectPasswordReset(page, false);
      await page.route('**/api/v1/auth/password-reset/complete', (route) =>
        json(route, { status: 'password_reset' }),
      );
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByLabel('Password baru', { exact: true }).fill('Gunung-Biru-Pagi-81');
      await page.getByLabel('Ulangi password baru').fill('Gunung-Biru-Pagi-81');
      await page.getByRole('button', { name: 'Simpan password baru' }).click();
      await page.getByText('Password sudah diganti', { exact: false }).waitFor();
    },
  },

  // ── Verifikasi email ──
  {
    name: 'verifikasi-email-berhasil',
    path: VERIFY_PATH,
    before: async (page) => {
      await asGuest(page);
      await page.route('**/api/v1/auth/email/verify', (route) =>
        json(route, { status: 'verified', email: 'rina@majujaya.co.id' }),
      );
    },
    waitFor: 'h1',
  },
  {
    name: 'verifikasi-email-tidak-berlaku',
    path: VERIFY_PATH,
    before: async (page) => {
      await asGuest(page);
      await page.route('**/api/v1/auth/email/verify', (route) =>
        apiError(
          route,
          410,
          'TOKEN_INVALID',
          'Tautan verifikasi ini sudah kedaluwarsa (berlaku 24 jam). Kirim ulang email verifikasi dari Pengaturan → Keamanan akun.',
        ),
      );
    },
    waitFor: 'h1',
  },
  {
    name: 'verifikasi-email-memuat',
    path: VERIFY_PATH,
    waitUntil: 'domcontentloaded',
    before: async (page) => {
      await asGuest(page);
      await hang(page, '/auth/email/verify');
    },
    waitFor: '[role="status"]',
  },

  // ── Keamanan akun: kartu Email akun ──
  {
    name: 'keamanan-email-belum',
    path: '/pengaturan/keamanan',
    before: (page) => emailVerificationStatus(page, { verified: false, canSend: true }),
    waitFor: 'h1',
    prepare: showEmailCard,
  },
  {
    name: 'keamanan-email-terkirim',
    path: '/pengaturan/keamanan',
    before: async (page) => {
      await emailVerificationStatus(page, { verified: false, canSend: true });
      await page.route('**/api/v1/auth/email/verification', (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        return json(
          route,
          { status: 'queued', expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
          202,
        );
      });
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Kirim email verifikasi' }).click();
      await page.getByText('Email verifikasi sedang dikirim', { exact: false }).waitFor();
      await page.mouse.move(1, 1);
      await showEmailCard(page);
    },
  },
  {
    name: 'keamanan-email-tanpa-pengirim',
    path: '/pengaturan/keamanan',
    before: (page) => emailVerificationStatus(page, { verified: false, canSend: false }),
    waitFor: 'h1',
    prepare: showEmailCard,
  },
  {
    name: 'keamanan-email-terverifikasi',
    path: '/pengaturan/keamanan',
    before: (page) => emailVerificationStatus(page, { verified: true, canSend: true }),
    waitFor: 'h1',
    prepare: showEmailCard,
  },

  // ── Email pengirim dibuka Admin (izin settings.email.manage): catatan pemberitahuan ke Owner ──
  {
    name: 'email-pengirim-admin',
    path: '/pengaturan/email',
    before: (page) => sessionAs(page, 'admin'),
    waitFor: 'h1',
    prepare: async (page) => {
      await page
        .getByRole('button', { name: 'Simpan' })
        .evaluate((el) => el.scrollIntoView({ block: 'center' }));
    },
  },

  // ── Pratinjau template email (Pengaturan → Email pengirim, API sungguhan) ──
  {
    name: 'email-pengirim-pratinjau',
    path: '/pengaturan/email',
    waitFor: 'h1',
    prepare: async (page) => {
      await page.locator('iframe').waitFor();
      await page
        .getByRole('heading', { name: 'Pratinjau email' })
        .evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'email-pengirim-pratinjau-teks',
    path: '/pengaturan/email',
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByLabel('Template').selectOption({ label: 'Atur ulang password' });
      await page.getByRole('radio', { name: 'Teks polos' }).click();
      await page.locator('pre').waitFor();
      await page
        .getByRole('heading', { name: 'Pratinjau email' })
        .evaluate((el) => el.scrollIntoView({ block: 'start' }));
    },
  },
];
