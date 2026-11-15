import type { Page } from '@playwright/test';
import {
  PHOTO_INVITATIONS,
  apiError,
  asGuest,
  hang,
  invitationList,
  json,
  sessionAs,
  twoFactorStatus,
  validationError,
} from './mocks';
import {
  PHOTO_TEAM,
  PHOTO_USER_IDS,
  auditExport,
  auditList,
  auditListError,
  ownPhotoSessions,
  ownSessions,
  photoAuditEntries,
  quietSecurity,
  securitySummary,
  teamAsAdmin,
  teamUserDetail,
  teamUsers,
} from './mocks-tim';
import type { Screen } from './screens';

const API = '**/api/v1';
const byId = (id: string) => PHOTO_TEAM.find((user) => user.id === id)!;
const CS = byId(PHOTO_USER_IDS.cs);
const SUPERVISOR = byId(PHOTO_USER_IDS.supervisor);
const TEKNISI = byId(PHOTO_USER_IDS.teknisi);
const DISABLED = byId(PHOTO_USER_IDS.disabled);
const detailPath = (id: string) => `/pengaturan/tim/${id}`;

/** Lepas penunjuk dan fokus supaya hover/tooltip tidak ikut terfoto. */
async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
}

async function scrollTo(page: Page, heading: string): Promise<void> {
  // Gulir wadah gulir halaman (bukan `scrollIntoView`, yang ikut menggeser leluhur ber-overflow
  // tersembunyi sehingga header halaman hilang dari foto).
  await page.getByRole('heading', { level: 2, name: heading }).evaluate((el) => {
    let box: HTMLElement | null = el.parentElement;
    while (box && getComputedStyle(box).overflowY !== 'auto') box = box.parentElement;
    if (!box) return;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTop += top - 16;
  });
}

/** Detail CS + dialog ubah peran ke Supervisor terbuka (password diisi). */
async function openRoleDialog(page: Page): Promise<void> {
  await page.getByLabel('Peran baru').selectOption({ label: 'Supervisor' });
  await page.getByRole('button', { name: 'Ubah peran', exact: true }).click();
  await page.getByRole('dialog').waitFor();
}

async function fillIdentity(page: Page, code = '481 902'): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Password', { exact: true }).fill('Kopi-Senja-Tenang-42');
  await dialog.getByLabel('Kode verifikasi').fill(code);
}

/**
 * Layar Fase 1 butir 6: daftar anggota di Tim, detail anggota (semua keadaan & dialog konfirmasi
 * identitas), Sesi aktif di Keamanan akun, Audit log, banner keamanan, dan penanganan batas daftar
 * 2FA yang lewat (halaman masuk & layar pendaftaran). Semua memakai API tiruan.
 */
export const teamScreens: Screen[] = [
  // ── Tim: daftar anggota ──
  {
    name: 'tim-anggota',
    path: '/pengaturan/tim',
    before: async (page) => {
      await quietSecurity(page);
      await invitationList(page, { invitations: PHOTO_INVITATIONS.slice(0, 2) });
      await teamUsers(page);
    },
    waitFor: 'h1',
    prepare: (page) => scrollTo(page, 'Anggota tim 6'),
  },
  {
    name: 'tim-anggota-admin',
    path: '/pengaturan/tim',
    before: async (page) => {
      await sessionAs(page, 'admin');
      await quietSecurity(page);
      await invitationList(page, { invitableRoles: ['supervisor', 'cs', 'teknisi'] });
      await teamUsers(page, teamAsAdmin());
    },
    waitFor: 'h1',
    prepare: (page) => scrollTo(page, 'Anggota tim 6'),
  },

  // ── Detail anggota ──
  {
    name: 'anggota',
    path: detailPath(CS.id),
    before: async (page) => {
      await quietSecurity(page);
      await teamUserDetail(page, CS);
    },
    waitFor: 'h2',
  },
  {
    // Bagian bawah detail: sesi aktif, akses akun, riwayat aktivitas.
    name: 'anggota-bawah',
    path: detailPath(CS.id),
    before: async (page) => {
      await quietSecurity(page);
      await teamUserDetail(page, CS);
    },
    waitFor: 'h2',
    prepare: (page) => scrollTo(page, 'Sesi aktif'),
  },
  {
    name: 'anggota-terkunci',
    path: detailPath(TEKNISI.id),
    before: async (page) => {
      await quietSecurity(page);
      await teamUserDetail(page, TEKNISI);
    },
    waitFor: 'h2',
  },
  {
    name: 'anggota-batas-2fa-lewat',
    path: detailPath(SUPERVISOR.id),
    before: async (page) => {
      await quietSecurity(page);
      await teamUserDetail(page, SUPERVISOR, { sessions: [] });
    },
    waitFor: 'h2',
    prepare: (page) => scrollTo(page, 'Verifikasi dua langkah'),
  },
  {
    name: 'anggota-nonaktif',
    path: detailPath(DISABLED.id),
    before: async (page) => {
      await quietSecurity(page);
      await teamUserDetail(page, DISABLED, { sessions: [] });
    },
    waitFor: 'h2',
  },
  {
    // Admin membuka Owner: hanya dilihat, dengan penjelasan (tanpa tombol mati).
    name: 'anggota-hanya-lihat',
    path: detailPath(PHOTO_USER_IDS.owner),
    before: async (page) => {
      await sessionAs(page, 'admin');
      await quietSecurity(page);
      const owner = teamAsAdmin().find((user) => user.role === 'owner')!;
      await teamUserDetail(page, owner);
    },
    waitFor: 'h2',
  },
  {
    name: 'anggota-memuat',
    path: detailPath(CS.id),
    waitUntil: 'domcontentloaded',
    before: async (page) => {
      await quietSecurity(page);
      await hang(page, `/users/${CS.id}`);
    },
    waitFor: '[role="status"]',
  },
  {
    name: 'anggota-tidak-ditemukan',
    path: detailPath('3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b99'),
    before: async (page) => {
      await quietSecurity(page);
      await page.route(`${API}/users/3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b99`, (route) =>
        apiError(route, 404, 'NOT_FOUND', 'Pengguna tidak ditemukan.'),
      );
    },
    waitFor: 'h2',
  },
  {
    name: 'anggota-ubah-peran',
    path: detailPath(CS.id),
    before: async (page) => {
      await quietSecurity(page);
      await teamUserDetail(page, CS);
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await openRoleDialog(page);
      await fillIdentity(page, '');
      await page.getByRole('dialog').getByLabel('Password', { exact: true }).focus();
    },
  },
  {
    name: 'anggota-konfirmasi-salah',
    path: detailPath(CS.id),
    before: async (page) => {
      await quietSecurity(page);
      await teamUserDetail(page, CS);
      await page.route(`${API}/users/${CS.id}/role`, (route) =>
        validationError(
          route,
          'code',
          'Kode tidak cocok. Pastikan jam ponselmu tepat, lalu masukkan kode yang sedang tampil.',
        ),
      );
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await openRoleDialog(page);
      await fillIdentity(page);
      await page.getByRole('dialog').getByRole('button', { name: 'Ubah peran' }).click();
      await page.getByText('Kode tidak cocok.').waitFor();
    },
  },
  {
    name: 'anggota-konfirmasi-terkunci',
    path: detailPath(CS.id),
    before: async (page) => {
      await quietSecurity(page);
      await teamUserDetail(page, CS);
      await page.route(`${API}/users/${CS.id}/disable`, (route) =>
        apiError(
          route,
          429,
          'RATE_LIMITED',
          // Sama dengan API: sebab saja; durasi dari `Retry-After` di tombol hitung mundur.
          'Terlalu banyak percobaan konfirmasi yang salah.',
          { 'retry-after': '900' },
        ),
      );
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Nonaktifkan akun' }).click();
      await page.getByRole('dialog').waitFor();
      await fillIdentity(page);
      await page.getByRole('dialog').getByRole('button', { name: 'Nonaktifkan' }).click();
      await page.getByText('Konfirmasi dikunci sementara').waitFor();
    },
  },
  {
    // Buka kunci ditolak kunci 2FA harian: kotak terkunci berganti isi, aksinya Atur ulang 2FA.
    name: 'anggota-kunci-harian',
    path: detailPath(TEKNISI.id),
    before: async (page) => {
      await quietSecurity(page);
      await teamUserDetail(page, TEKNISI);
      const stillLocked = {
        ...TEKNISI,
        status: 'locked',
        lockedUntil: new Date(Date.now() + 20 * 3_600_000).toISOString(),
      };
      await page.route(`${API}/users/${TEKNISI.id}/unlock`, (route) =>
        json(route, { user: stillLocked, revokedSessions: 0, revokedInvitations: 0 }),
      );
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Buka kunci' }).click();
      await page.getByRole('dialog').waitFor();
      await fillIdentity(page);
      await page.getByRole('dialog').getByRole('button', { name: 'Buka kunci' }).click();
      await page.getByText('Kunci verifikasi dua langkah masih berlaku').waitFor();
      await settle(page);
    },
  },
  {
    name: 'anggota-berhasil',
    path: detailPath(CS.id),
    before: async (page) => {
      await quietSecurity(page);
      await teamUserDetail(page, CS);
      const promoted = {
        ...CS,
        role: 'supervisor',
        activeSessions: 0,
        twoFactor: { ...CS.twoFactor, required: true, enrollmentDueAt: null },
      };
      await page.route(`${API}/users/${CS.id}/role`, (route) =>
        json(route, { user: promoted, revokedSessions: 2, revokedInvitations: 0 }),
      );
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await openRoleDialog(page);
      await fillIdentity(page);
      await page.getByRole('dialog').getByRole('button', { name: 'Ubah peran' }).click();
      await page.getByText('sekarang Supervisor', { exact: false }).waitFor();
      await settle(page);
    },
  },

  // ── Keamanan akun → Sesi aktif ──
  {
    name: 'keamanan-sesi',
    path: '/pengaturan/keamanan',
    before: async (page) => {
      await quietSecurity(page);
      await twoFactorStatus(page, { enabled: true, required: true });
      await ownSessions(page, ownPhotoSessions());
    },
    waitFor: 'h1',
    prepare: (page) => scrollTo(page, 'Sesi aktif'),
  },
  {
    name: 'keamanan-sesi-satu',
    path: '/pengaturan/keamanan',
    before: async (page) => {
      await quietSecurity(page);
      await twoFactorStatus(page, { enabled: true, required: true });
      await ownSessions(page, ownPhotoSessions().slice(0, 1));
    },
    waitFor: 'h1',
    prepare: (page) => scrollTo(page, 'Sesi aktif'),
  },
  {
    name: 'keamanan-sesi-keluarkan-semua',
    path: '/pengaturan/keamanan',
    before: async (page) => {
      await quietSecurity(page);
      await twoFactorStatus(page, { enabled: true, required: true });
      await ownSessions(page, ownPhotoSessions());
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await scrollTo(page, 'Sesi aktif');
      await page.getByRole('button', { name: 'Keluarkan semua sesi lain' }).click();
      await page.getByRole('dialog').waitFor();
    },
  },
  {
    // Sesi yang lebih baru dari sesi ini: konfirmasi identitas khusus sesi itu.
    name: 'keamanan-sesi-lebih-baru',
    path: '/pengaturan/keamanan',
    before: async (page) => {
      await quietSecurity(page);
      await twoFactorStatus(page, { enabled: true, required: true });
      await ownSessions(page, ownPhotoSessions());
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await scrollTo(page, 'Sesi aktif');
      await page.getByRole('button', { name: 'Keluarkan sesi Firefox di Linux' }).click();
      await page.getByRole('dialog').waitFor();
    },
  },
  {
    name: 'keamanan-sesi-dikeluarkan',
    path: '/pengaturan/keamanan',
    before: async (page) => {
      await quietSecurity(page);
      await twoFactorStatus(page, { enabled: true, required: true });
      await ownSessions(page, ownPhotoSessions());
      await page.route(`${API}/auth/sessions/*`, (route) => json(route, { status: 'revoked' }));
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await scrollTo(page, 'Sesi aktif');
      await page.getByRole('button', { name: 'Keluarkan sesi Safari di iOS' }).click();
      await page.getByText('Sesi Safari di iOS sudah dikeluarkan.').waitFor();
      await settle(page);
    },
  },

  // ── Audit log ──
  {
    name: 'audit',
    path: '/pengaturan/audit',
    before: async (page) => {
      await quietSecurity(page);
      await teamUsers(page);
      await auditList(page, photoAuditEntries(), 'kursor-foto');
    },
    waitFor: 'ol',
  },
  {
    name: 'audit-rincian',
    path: '/pengaturan/audit',
    before: async (page) => {
      await quietSecurity(page);
      await teamUsers(page);
      await auditList(page, photoAuditEntries(), 'kursor-foto');
    },
    waitFor: 'ol',
    prepare: async (page) => {
      await page.getByText('Rincian').nth(1).click();
      await settle(page);
    },
  },
  {
    name: 'audit-tersaring',
    path: `/pengaturan/audit?userId=${CS.id}&action=user.role_changed&from=2026-11-07`,
    before: async (page) => {
      await quietSecurity(page);
      await teamUsers(page);
      await auditList(page, photoAuditEntries().slice(0, 1), null);
    },
    waitFor: 'ol',
    prepare: async (page) => {
      // Di HP saringan terlipat: buka supaya terlihat.
      const toggle = page.getByRole('button', { name: /^Saringan/ });
      if (await toggle.isVisible()) await toggle.click();
      await settle(page);
    },
  },
  {
    name: 'audit-kosong',
    path: '/pengaturan/audit',
    before: async (page) => {
      await quietSecurity(page);
      await teamUsers(page);
      await auditList(page, [], null);
    },
    waitFor: 'h2',
  },
  {
    name: 'audit-tidak-cocok',
    path: '/pengaturan/audit?action=user.unlocked',
    before: async (page) => {
      await quietSecurity(page);
      await teamUsers(page);
      await auditList(page, [], null);
    },
    waitFor: 'h2',
  },
  {
    name: 'audit-memuat',
    path: '/pengaturan/audit',
    waitUntil: 'domcontentloaded',
    before: async (page) => {
      await quietSecurity(page);
      await teamUsers(page);
      await page.route(
        (url) => url.pathname === '/api/v1/audit-logs',
        () => undefined,
      );
    },
    waitFor: '[role="status"]',
  },
  {
    name: 'audit-gagal',
    path: '/pengaturan/audit',
    before: async (page) => {
      await quietSecurity(page);
      await teamUsers(page);
      await auditListError(page, 503);
    },
    waitFor: 'h2',
  },
  {
    name: 'audit-terkunci',
    path: '/pengaturan/audit',
    before: async (page) => {
      await quietSecurity(page);
      await teamUsers(page);
      await auditListError(page, 429);
    },
    waitFor: 'h2',
  },
  {
    name: 'audit-ekspor-berhasil',
    path: '/pengaturan/audit',
    before: async (page) => {
      await quietSecurity(page);
      await teamUsers(page);
      await auditList(page, photoAuditEntries(), null);
      await auditExport(page, 'ok');
    },
    waitFor: 'ol',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Ekspor CSV' }).click();
      await page.getByText('Berkas CSV berisi', { exact: false }).waitFor();
      await settle(page);
    },
  },
  {
    name: 'audit-ekspor-terpotong',
    path: '/pengaturan/audit',
    before: async (page) => {
      await quietSecurity(page);
      await teamUsers(page);
      await auditList(page, photoAuditEntries(), null);
      await auditExport(page, 'truncated');
    },
    waitFor: 'ol',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Ekspor CSV' }).click();
      await page.getByText('Persempit rentang tanggal', { exact: false }).waitFor();
      await settle(page);
    },
  },
  {
    name: 'audit-ekspor-terkunci',
    path: '/pengaturan/audit',
    before: async (page) => {
      await quietSecurity(page);
      await teamUsers(page);
      await auditList(page, photoAuditEntries(), null);
      await auditExport(page, 'limited');
    },
    waitFor: 'ol',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Ekspor CSV' }).click();
      await page.getByText('Ekspor dibatasi sementara').waitFor();
      await settle(page);
    },
  },

  // ── Banner peringatan keamanan (Owner/Admin) ──
  {
    name: 'banner-keamanan',
    path: '/inbox',
    before: (page) => securitySummary(page),
    waitFor: 'h1',
  },
  {
    name: 'banner-keamanan-pengaturan',
    path: '/pengaturan',
    before: (page) => securitySummary(page, 1),
    waitFor: '[role="radiogroup"]',
  },
  {
    name: 'pengaturan-owner',
    path: '/pengaturan',
    before: async (page) => {
      await quietSecurity(page);
      await teamUsers(page);
      await invitationList(page, { invitations: PHOTO_INVITATIONS.slice(0, 2) });
    },
    waitFor: '[role="radiogroup"]',
  },

  // ── Batas daftar 2FA lewat ──
  {
    name: 'masuk-2fa-ditutup',
    path: '/masuk',
    before: async (page) => {
      await asGuest(page);
      await page.route(`${API}/auth/login`, (route) =>
        apiError(
          route,
          403,
          'TWO_FACTOR_ENROLLMENT_EXPIRED',
          'Batas waktu mendaftarkan verifikasi dua langkah untuk akunmu sudah lewat. Minta Owner atau Admin di tempatmu membuka lagi pendaftarannya, lalu masuk kembali.',
        ),
      );
    },
    waitFor: 'h1',
    prepare: async (page) => {
      await page.getByLabel('Email').fill('sari.wulandari@majujaya.co.id');
      await page.getByLabel('Password', { exact: true }).fill('Kopi-Senja-Tenang-42');
      await page.getByRole('button', { name: 'Masuk', exact: true }).click();
      await page.getByRole('alert').waitFor();
    },
  },
  {
    name: 'daftar-2fa-ditutup',
    path: '/verifikasi-dua-langkah',
    before: async (page) => {
      await sessionAs(page, 'supervisor', 'two_factor_enrollment_required');
      await page.route(`${API}/auth/2fa/enroll`, (route) =>
        apiError(
          route,
          403,
          'TWO_FACTOR_ENROLLMENT_EXPIRED',
          'Batas waktu mendaftarkan verifikasi dua langkah untuk akunmu sudah lewat. Minta Owner atau Admin di tempatmu membuka lagi pendaftarannya, lalu masuk kembali.',
        ),
      );
    },
    waitFor: 'h1:has-text("Pendaftaran verifikasi dua langkah sudah ditutup")',
  },
];
