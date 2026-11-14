import type { Page, Route } from '@playwright/test';
import { E2E_SETUP_TOKEN } from '../stack/env';

/**
 * Jawaban API tiruan untuk memotret keadaan yang tidak bisa (atau tidak boleh berulang kali)
 * dipicu melawan API sungguhan: wizard setup setelah setup selesai, akun terkunci, hasil tes
 * email gagal, memuat, gagal. Bentuk jawabannya mengikuti skema `@balesin/shared`.
 */
const API = '**/api/v1';

export function json(
  route: Route,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers,
    body: JSON.stringify(body),
  });
}

export function apiError(
  route: Route,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
) {
  return json(route, { error: { code, message, requestId: 'req-foto' } }, status, headers);
}

/** Permintaan yang tidak pernah dijawab (untuk memotret keadaan memuat). */
export async function hang(page: Page, path: string): Promise<void> {
  await page.route(`${API}${path}`, () => undefined);
}

/** Tamu: tanpa cookie sesi. */
export async function asGuest(page: Page): Promise<void> {
  await page.context().clearCookies();
}

/** Instalasi baru: wizard setup tampil, merek masih bawaan. */
export async function freshInstall(
  page: Page,
  status: { setupTokenConfigured?: boolean; canStoreSecrets?: boolean } = {},
): Promise<void> {
  await asGuest(page);
  await page.route(`${API}/setup/status`, (route) =>
    json(route, {
      needsSetup: true,
      setupTokenConfigured: status.setupTokenConfigured ?? true,
      canStoreSecrets: status.canStoreSecrets ?? true,
    }),
  );
  await page.route(`${API}/branding`, (route) =>
    json(route, {
      productName: 'Balesin',
      organizationName: null,
      primaryColor: null,
      logoUrl: null,
    }),
  );
  await page.route(`${API}/setup/verify-token`, (route) => json(route, { valid: true }));
  await page.route(`${API}/setup/check-password`, (route) => {
    const body = route.request().postDataJSON() as { password?: string };
    const weak = (body.password ?? '').toLowerCase().includes('password');
    return json(route, {
      acceptable: !weak,
      message: weak
        ? 'Password ini terlalu umum dan mudah ditebak. Pakai gabungan beberapa kata acak yang tidak berhubungan, misalnya tiga atau empat kata.'
        : null,
    });
  });
  await page.route(`${API}/setup/email/detect-host`, (route) =>
    json(route, {
      domain: 'majujaya.co.id',
      suggestions: [
        {
          presetId: 'cpanel',
          host: 'mail.majujaya.co.id',
          port: 465,
          security: 'ssl',
          reason: 'dns_found',
          description: 'Server email ditemukan di domain ini (hosting cPanel).',
        },
      ],
    }),
  );
}

export async function emailTestResult(page: Page, ok: boolean, area: 'setup' | 'settings') {
  const path =
    area === 'setup' ? '/setup/email/test-connection' : '/settings/email/test-connection';
  await page.route(`${API}${path}`, (route) =>
    json(route, {
      ok,
      code: ok ? 'ok' : 'auth_failed',
      message: ok
        ? 'Berhasil terhubung ke server email. Pengaturan ini siap dipakai.'
        : 'Username atau password ditolak server email. Periksa lagi keduanya. Untuk Gmail dan Microsoft 365, pakai app password, bukan password akun biasa.',
      testedAt: new Date().toISOString(),
    }),
  );
}

/** Wizard: buka lewat tautan bertoken lalu maju sampai langkah tertentu dengan isian contoh. */
export async function wizardTo(
  page: Page,
  step: 'organization' | 'owner' | 'branding' | 'email' | 'summary',
): Promise<void> {
  // Hanya fragment yang berbeda dari alamat sekarang = navigasi di dokumen yang sama (wizard
  // tidak dimuat ulang), jadi kosongkan halaman dulu.
  await page.goto('about:blank');
  await page.goto(`/setup#token=${E2E_SETUP_TOKEN}`);
  const next = () => page.getByRole('button', { name: 'Lanjut' }).click();
  await page.getByRole('heading', { level: 1, name: 'Tentang organisasimu' }).waitFor();
  if (step === 'organization') return;
  await page.getByLabel('Nama perusahaan').fill('PT Maju Jaya');
  await next();
  await page.getByRole('heading', { level: 1, name: 'Buat akun Owner' }).waitFor();
  if (step === 'owner') return;
  await page.getByLabel('Nama lengkap').fill('Rina Kartika');
  await page.getByLabel('Email', { exact: true }).fill('rina@majujaya.co.id');
  await page.getByLabel('Password', { exact: true }).fill('Kopi-Senja-Tenang-42');
  await page.getByLabel('Ulangi password').fill('Kopi-Senja-Tenang-42');
  await next();
  await page.getByRole('heading', { level: 1, name: 'Sesuaikan tampilan' }).waitFor();
  if (step === 'branding') return;
  await page.getByLabel('Nama aplikasi').fill('Balesin Maju Jaya');
  await next();
  await page.getByRole('heading', { level: 1, name: 'Email pengirim' }).waitFor();
  if (step === 'email') return;
  await page.getByRole('button', { name: 'Lewati' }).click();
  await page.getByRole('heading', { level: 1, name: 'Periksa lalu selesaikan' }).waitFor();
}

/** Isi langkah Email dengan contoh pengaturan hosting (host dari saran deteksi tiruan). */
export async function fillEmailStep(page: Page): Promise<void> {
  await page.getByLabel('Nama pengirim').fill('CS Maju Jaya');
  await page.getByLabel('Alamat email pengirim').fill('cs@majujaya.co.id');
  await page.getByText('Saran dipakai').waitFor();
  await page.getByLabel('Password', { exact: true }).fill('rahasia-email-123');
}

/** Pengaturan email tersimpan dan terhubung (halaman Pengaturan → Email pengirim). */
export async function savedEmailSettings(page: Page): Promise<void> {
  await page.route(`${API}/settings/email`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, {
      source: 'database',
      settings: {
        fromName: 'CS Maju Jaya',
        fromAddress: 'cs@majujaya.co.id',
        replyTo: null,
        host: 'mail.majujaya.co.id',
        port: 465,
        security: 'ssl',
        username: 'cs@majujaya.co.id',
        hasPassword: true,
        passwordHint: '••••a123',
      },
      status: 'connected',
      lastTest: {
        ok: true,
        code: 'ok',
        message: 'Berhasil terhubung ke server email. Pengaturan ini siap dipakai.',
        testedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
      },
      updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      canStoreSecrets: true,
    });
  });
}

// ── Verifikasi dua langkah ──────────────────────────────────────────────────

type Role = 'owner' | 'admin' | 'supervisor' | 'cs' | 'teknisi';

function sessionBody(status: 'authenticated' | 'two_factor_enrollment_required', role: Role) {
  const now = Date.now();
  return {
    status,
    user: {
      id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001',
      name: role === 'owner' ? 'Rina Kartika' : 'Dimas Pratama',
      email: role === 'owner' ? 'rina@majujaya.co.id' : 'dimas@majujaya.co.id',
      role,
    },
    organization: {
      id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0002',
      name: 'PT Maju Jaya',
      timezone: 'Asia/Jakarta',
    },
    csrfToken: 'csrf-foto',
    session: {
      idleExpiresAt: new Date(now + 30 * 60_000).toISOString(),
      absoluteExpiresAt: new Date(now + 30 * 86_400_000).toISOString(),
    },
  };
}

/** Sesi tiruan (menggantikan `/auth/me`): penuh dengan peran tertentu, atau terbatas. */
export async function sessionAs(
  page: Page,
  role: Role,
  status: 'authenticated' | 'two_factor_enrollment_required' = 'authenticated',
): Promise<void> {
  await page.route(`${API}/auth/me`, (route) => json(route, sessionBody(status, role)));
}

/** Contoh rahasia (base32) — hanya untuk foto. */
const PHOTO_SECRET = 'K5ZGQ3TBMVSWC4DFOJXW6YLSMR4XI2LQ';

export const PHOTO_BACKUP_CODES = [
  'k7m2p-x9q4r',
  'a3b4c-d5e6f',
  'g7h8j-k9m2n',
  'p3q4r-s5t6u',
  'v7w8x-y9z2a',
  'b3c4d-e5f6g',
  'h7j8k-m9n2p',
  'q3r4s-t5u6v',
  'w7x8y-z9a2b',
  'c3d4e-f5g6h',
];

/** `POST /auth/2fa/enroll` tiruan (rahasia contoh, berlaku 15 menit). */
export async function mockEnroll(page: Page): Promise<void> {
  await page.route(`${API}/auth/2fa/enroll`, (route) =>
    json(route, {
      otpauthUri: `otpauth://totp/Balesin%20Maju%20Jaya:rina%40majujaya.co.id?secret=${PHOTO_SECRET}&issuer=Balesin%20Maju%20Jaya&algorithm=SHA1&digits=6&period=30`,
      secret: PHOTO_SECRET,
      secretGrouped: PHOTO_SECRET.replace(/(.{4})/g, '$1 ').trim(),
      issuer: 'Balesin Maju Jaya',
      accountName: 'rina@majujaya.co.id',
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      digits: 6,
      periodSeconds: 30,
    }),
  );
}

/** Layar pendaftaran 2FA wajib: sesi terbatas + rahasia contoh. */
export async function enrollmentScreen(page: Page): Promise<void> {
  await sessionAs(page, 'owner', 'two_factor_enrollment_required');
  await mockEnroll(page);
}

/** Konfirmasi pendaftaran berhasil → sesi penuh + 10 kode cadangan contoh. */
export async function mockConfirmEnrollment(page: Page): Promise<void> {
  await page.route(`${API}/auth/2fa/enroll/confirm`, (route) =>
    json(route, {
      ...sessionBody('authenticated', 'owner'),
      backupCodes: { codes: PHOTO_BACKUP_CODES, generatedAt: new Date().toISOString() },
    }),
  );
}

/** Halaman masuk: password benar, akun memakai 2FA → langkah kode. */
export async function twoFactorChallenge(page: Page): Promise<void> {
  await asGuest(page);
  await page.route(`${API}/auth/login`, (route) =>
    json(route, {
      status: 'two_factor_required',
      challengeToken: 'tantangan-foto',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      attemptsRemaining: 3,
      methods: ['totp', 'backup_code'],
    }),
  );
}

/** Isi email + password lalu kirim, sampai langkah kode tampil. */
export async function toCodeStep(page: Page): Promise<void> {
  await page.getByLabel('Email').fill('rina@majujaya.co.id');
  await page.getByLabel('Password', { exact: true }).fill('Kopi-Senja-Tenang-42');
  await page.getByRole('button', { name: 'Masuk', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Masukkan kode verifikasi' }).waitFor();
}

/** Status 2FA tiruan untuk Keamanan akun. */
export async function twoFactorStatus(
  page: Page,
  status: {
    enabled: boolean;
    required: boolean;
    backupCodesRemaining?: number;
  },
): Promise<void> {
  const at = new Date(Date.now() - 2 * 86_400_000).toISOString();
  await page.route(`${API}/auth/2fa`, (route) =>
    json(route, {
      enabled: status.enabled,
      required: status.required,
      enabledAt: status.enabled ? at : null,
      backupCodesRemaining: status.backupCodesRemaining ?? (status.enabled ? 10 : 0),
      backupCodesGeneratedAt: status.enabled ? at : null,
      enrollmentPending: false,
    }),
  );
}

/** 400 VALIDATION_ERROR dengan pesan di satu isian. */
export function validationError(route: Route, field: string, message: string) {
  return json(
    route,
    {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Data yang dikirim tidak valid. Periksa lagi isiannya.',
        details: [{ location: 'body', field, message }],
        requestId: 'req-foto',
      },
    },
    400,
  );
}

/** Langkah kedua berhasil dengan kode cadangan (sisa kode tertentu). */
export async function mockVerifyWithBackupCode(page: Page, remaining: number): Promise<void> {
  await page.route(`${API}/auth/2fa/verify`, (route) =>
    json(route, {
      ...sessionBody('authenticated', 'owner'),
      twoFactor: { method: 'backup_code', backupCodesRemaining: remaining },
    }),
  );
}
