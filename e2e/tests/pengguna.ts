import { randomBytes } from 'node:crypto';
import { request } from '@playwright/test';
import { Redis } from 'ioredis';
import pg from 'pg';
import { E2E_ADMIN_DATABASE_URL, E2E_DATABASE_NAME, E2E_OWNER, E2E_REDIS_URL } from '../stack/env';
import { BASE_URL } from '../viewports';
import { totpAtStep, totpStep } from './two-factor';

/**
 * Pengguna tambahan untuk E2E (Admin, Supervisor, CS, Teknisi) bagi tes yang tidak menguji alur
 * undangan itu sendiri (alur undangan lewat UI: `tim-tanpa-email` / `tim-dengan-email`).
 *
 * Dibuat langsung di database E2E (`balesin_e2e`, direset tiap run) di organisasi Owner hasil
 * `alur-awal`. Hash password-nya disalin dari Owner, jadi password semua pengguna ini sama dengan
 * password Owner (`E2E_OWNER.password`) tanpa perlu pustaka argon2 di paket E2E. Email unik per
 * pemanggilan supaya tes paralel (HP & desktop) tidak berbagi akun.
 */
export type ExtraRole = 'admin' | 'supervisor' | 'cs' | 'teknisi';

export interface ExtraUser {
  email: string;
  name: string;
  password: string;
  role: ExtraRole;
}

function databaseUrl(): string {
  const url = new URL(E2E_ADMIN_DATABASE_URL);
  url.pathname = `/${E2E_DATABASE_NAME}`;
  return url.toString();
}

/** Satu kueri ke database E2E (koneksi dibuka dan ditutup per panggilan). */
export async function e2eSql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

const ROLE_NAMES: Record<ExtraRole, string> = {
  admin: 'Agus Pratama',
  supervisor: 'Sari Wulandari',
  cs: 'Citra Maharani',
  teknisi: 'Tono Saputra',
};

export async function createUser(role: ExtraRole, label: string): Promise<ExtraUser> {
  const suffix = `${label}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const user: ExtraUser = {
    email: `${role}-${suffix}@majujaya.test`.toLowerCase(),
    name: ROLE_NAMES[role],
    password: E2E_OWNER.password,
    role,
  };
  const rows = await e2eSql(
    `insert into users (id, organization_id, email, name, password_hash, role, email_verified_at)
     select gen_random_uuid(), organization_id, $1, $2, password_hash, $3::user_role, now()
     from users where email = $4
     returning id`,
    [user.email, user.name, role, E2E_OWNER.email],
  );
  if (rows.length !== 1) throw new Error('Owner E2E belum ada (alur-awal belum jalan?)');
  return user;
}

/**
 * Mengaktifkan 2FA pengguna yang perannya tidak wajib lewat API (password → rahasia → kode).
 * Mengembalikan rahasia TOTP dan langkah waktu yang sudah terpakai.
 */
export async function enableTwoFactorViaApi(
  user: ExtraUser,
): Promise<{ secret: string; lastStep: number; backupCodes: string[] }> {
  const api = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { origin: BASE_URL },
    // WAJIB kosong: di dalam tes, `request.newContext` memakai `storageState` proyek (sesi Owner),
    // dan masuk sebagai pengguna lain dengan cookie itu mencabut sesi Owner (rotasi sesi).
    storageState: { cookies: [], origins: [] },
  });
  try {
    const loginResponse = await api.post('/api/v1/auth/login', {
      data: { email: user.email, password: user.password },
    });
    const login = (await loginResponse.json()) as { status: string; csrfToken: string };
    if (login.status !== 'authenticated') throw new Error(`Login API: ${login.status}`);
    const headers = { 'x-csrf-token': login.csrfToken };
    const enroll = await api.post('/api/v1/auth/2fa/enroll', {
      headers,
      data: { password: user.password },
    });
    if (!enroll.ok()) throw new Error(`Daftar 2FA (${enroll.status()}): ${await enroll.text()}`);
    const { secret } = (await enroll.json()) as { secret: string };
    const step = totpStep();
    const confirm = await api.post('/api/v1/auth/2fa/enroll/confirm', {
      headers,
      data: { code: totpAtStep(secret, step) },
    });
    if (!confirm.ok()) {
      throw new Error(`Konfirmasi 2FA (${confirm.status()}): ${await confirm.text()}`);
    }
    const body = (await confirm.json()) as { backupCodes: { codes: string[] } };
    return { secret, lastStep: step, backupCodes: body.backupCodes.codes };
  } finally {
    await api.dispose();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Kode TOTP untuk langkah waktu SETELAH `lastStep` (server menolak langkah yang sudah dipakai),
 * menunggu bila langkah itu belum masuk jendela toleransi server (langkah sekarang ±1).
 */
export async function nextTotp(
  secret: string,
  lastStep: number,
): Promise<{ code: string; step: number }> {
  const step = Math.max(totpStep(), lastStep + 1);
  const waitMs = (step - 1) * 30_000 - Date.now() + 500;
  if (waitMs > 0) await sleep(waitMs);
  return { code: totpAtStep(secret, step), step };
}

/**
 * Mendaftarkan 2FA untuk peran WAJIB (Admin/Supervisor) yang belum punya: masuk → sesi terbatas
 * pendaftaran → rahasia → kode pertama. Mengembalikan rahasia, langkah waktu terpakai, dan kode
 * cadangan (dipakai sebagai kode konfirmasi identitas berikutnya tanpa menunggu 30 detik).
 */
export async function enrollRequiredTwoFactorViaApi(
  user: ExtraUser,
): Promise<{ secret: string; lastStep: number; backupCodes: string[] }> {
  const api = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { origin: BASE_URL },
    storageState: { cookies: [], origins: [] },
  });
  try {
    const loginResponse = await api.post('/api/v1/auth/login', {
      data: { email: user.email, password: user.password },
    });
    const login = (await loginResponse.json()) as { status: string; csrfToken: string };
    if (login.status !== 'two_factor_enrollment_required') {
      throw new Error(`Login API (wajib daftar 2FA): ${login.status}`);
    }
    const headers = { 'x-csrf-token': login.csrfToken };
    const enroll = await api.post('/api/v1/auth/2fa/enroll', { headers, data: {} });
    if (!enroll.ok()) throw new Error(`Daftar 2FA (${enroll.status()}): ${await enroll.text()}`);
    const { secret } = (await enroll.json()) as { secret: string };
    const step = totpStep();
    const confirm = await api.post('/api/v1/auth/2fa/enroll/confirm', {
      headers,
      data: { code: totpAtStep(secret, step) },
    });
    if (!confirm.ok()) {
      throw new Error(`Konfirmasi 2FA (${confirm.status()}): ${await confirm.text()}`);
    }
    const body = (await confirm.json()) as { backupCodes: { codes: string[] } };
    return { secret, lastStep: step, backupCodes: body.backupCodes.codes };
  } finally {
    await api.dispose();
  }
}

/** ID pengguna E2E dari email-nya. */
export async function userId(email: string): Promise<string> {
  const rows = await e2eSql<{ id: string }>('select id from users where email = $1', [email]);
  const id = rows[0]?.id;
  if (!id) throw new Error(`Pengguna ${email} tidak ada`);
  return id;
}

/**
 * Kosongkan hitungan "percobaan masuk gagal per IP" (`login-ip`, 20 / 15 menit) di Redis E2E.
 *
 * Semua tes E2E masuk dari 127.0.0.1, jadi jatah itu dipakai bersama seluruh suite; jatah diambil
 * SEBELUM password diperiksa (login sah yang sedang berjalan ikut terhitung sesaat). Tes yang
 * SENGAJA gagal masuk berkali-kali (penguncian akun) memanggil ini setelah asersinya selesai,
 * supaya tes lain yang masuk bersamaan tidak ikut terkena 429 "dari jaringanmu". Kunci akun/asal
 * yang sedang diuji tidak disentuh (kunci Redis lain).
 */
export async function releaseLoginIpBudget(): Promise<void> {
  const redis = new Redis(E2E_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  try {
    const keys = await redis.keys('balesin:rl:login-ip:*');
    if (keys.length > 0) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}

/**
 * Kosongkan jatah baca inbox per pengguna (`inbox-daftar` 240/menit, `inbox-cari` 60/menit) di Redis
 * E2E. Hampir semua tes memakai SATU Owner bersama dan membuka /inbox (halaman awal setelah masuk),
 * jadi suite paralel menghabiskan jatah yang untuk manusia sangat longgar. Dipanggil sebelum setiap
 * tes (fixture). Batas lajunya sendiri diuji di tes integrasi API.
 */
export async function releaseInboxReadBudget(): Promise<void> {
  const redis = new Redis(E2E_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  try {
    const keys = [
      ...(await redis.keys('balesin:rl:inbox-daftar:*')),
      ...(await redis.keys('balesin:rl:inbox-cari:*')),
    ];
    if (keys.length > 0) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}
