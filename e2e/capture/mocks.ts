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
