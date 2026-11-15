import type { Page } from '@playwright/test';
import { apiError, json } from './mocks';

/**
 * Jawaban API tiruan untuk Pengaturan → Channel (Fase 2 butir 1–2): daftar nomor, wizard tambah
 * nomor, halaman nomor, dan profil bisnis. Bentuknya mengikuti `packages/shared/src/channels.ts`.
 * Tidak ada token/App Secret sungguhan di sini — hanya petunjuk tersamar seperti dari server.
 */
const API = '**/api/v1';
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

export const PHOTO_CHANNEL_IDS = {
  main: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01',
  second: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02',
  untested: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e03',
  disabled: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e04',
  created: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e05',
} as const;

const HTTPS_WARNING =
  'Meta hanya menerima URL webhook https yang bisa diakses dari internet. Atur API_URL server ke alamat https publik (lihat panduan instalasi) sebelum memasang webhook.';

type PhotoChannel = Record<string, unknown> & { id: string; name: string };

function number(overrides: Record<string, unknown> = {}) {
  return {
    displayPhoneNumber: '+62 811-7200-345',
    verifiedName: 'Maju Jaya Net',
    qualityRating: 'GREEN',
    status: 'CONNECTED',
    nameStatus: 'APPROVED',
    codeVerificationStatus: 'VERIFIED',
    messagingLimit: 'TIER_10K',
    throughputLevel: 'STANDARD',
    fetchedAt: ago(1),
    ...overrides,
  };
}

export function photoChannel(
  overrides: Partial<PhotoChannel> & Pick<PhotoChannel, 'id' | 'name'>,
): PhotoChannel {
  return {
    type: 'whatsapp',
    enabled: true,
    status: 'connected',
    phoneNumberId: '106540352242922',
    wabaId: '102290129340398',
    accessTokenHint: '••••Q2ZD',
    appSecretHint: '••••91af',
    webhookUrl: `https://balesin.majujaya.co.id/api/webhooks/whatsapp/${overrides.id}`,
    lastTest: {
      ok: true,
      code: 'ok',
      message: 'Koneksi berhasil. Token, App Secret, Phone Number ID, dan WABA ID cocok.',
      testedAt: ago(1),
    },
    number: number(),
    warnings: [],
    credentialsUpdatedAt: ago(24 * 6),
    createdAt: ago(24 * 6),
    updatedAt: ago(1),
    ...overrides,
  };
}

const TOKEN_INVALID =
  'Token System User ditolak Meta (salah, dicabut, atau milik aplikasi lain). Buat token baru di Pengaturan Bisnis → Pengguna Sistem, lalu ganti token di pengaturan channel.';

export const PHOTO_CHANNELS: PhotoChannel[] = [
  photoChannel({ id: PHOTO_CHANNEL_IDS.main, name: 'CS Utama' }),
  photoChannel({
    id: PHOTO_CHANNEL_IDS.second,
    name: 'CS Kedua',
    status: 'failed',
    phoneNumberId: '106540352242933',
    lastTest: { ok: false, code: 'token_invalid', message: TOKEN_INVALID, testedAt: ago(3) },
    number: number({
      displayPhoneNumber: '+62 811-7200-678',
      qualityRating: 'YELLOW',
      messagingLimit: 'TIER_1K',
    }),
  }),
  photoChannel({
    id: PHOTO_CHANNEL_IDS.untested,
    name: 'Teknisi Lapangan',
    status: 'untested',
    phoneNumberId: '106540352242944',
    lastTest: null,
    number: null,
  }),
  photoChannel({
    id: PHOTO_CHANNEL_IDS.disabled,
    name: 'Promo Lama',
    enabled: false,
    phoneNumberId: '106540352242955',
    number: number({ displayPhoneNumber: '+62 811-7200-901', qualityRating: 'RED' }),
  }),
];

export const byChannelId = (id: string) => PHOTO_CHANNELS.find((channel) => channel.id === id)!;

/** `GET /settings/channels`. */
export async function channelList(
  page: Page,
  options: { channels?: PhotoChannel[]; canStoreSecrets?: boolean; maxChannels?: number } = {},
): Promise<void> {
  await page.route(`${API}/settings/channels`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, {
      channels: options.channels ?? PHOTO_CHANNELS,
      canStoreSecrets: options.canStoreSecrets ?? true,
      maxChannels: options.maxChannels ?? 20,
    });
  });
}

export function photoWebhook(id: string, warning: string | null = null) {
  return {
    channelId: id,
    callbackUrl: warning
      ? `http://127.0.0.1:3100/webhooks/whatsapp/${id}`
      : `https://balesin.majujaya.co.id/api/webhooks/whatsapp/${id}`,
    verifyToken: 'q7Vb2kLx9TzR4mWn8PcY3sHd6JfA1uGe5oKi0NvB2xE',
    verifyTokenRotatedAt: ago(24 * 6),
    subscribeFields: ['messages', 'message_template_status_update', 'account_update'],
    warning,
  };
}

export const PHOTO_PROFILE = {
  about: 'Internet cepat untuk rumah dan kantor. Balasan CS 08.00–21.00.',
  address: 'Jl. Pahlawan No. 12, Bandar Lampung',
  description:
    'Penyedia layanan internet rumah dan bisnis. Pasang baru, ganti paket, dan laporan gangguan bisa lewat chat ini.',
  email: 'cs@majujaya.co.id',
  websites: ['https://majujaya.co.id'],
  vertical: 'PROF_SERVICES',
};

/** Halaman nomor: channel, webhook, dan profil bisnis. */
export async function channelDetail(
  page: Page,
  channel: PhotoChannel,
  options: { profile?: 'ok' | 'meta-error' | 'hang'; webhookWarning?: boolean } = {},
): Promise<void> {
  const base = `${API}/settings/channels/${channel.id}`;
  await page.route(base, (route) =>
    route.request().method() === 'GET' ? json(route, { channel }) : route.fallback(),
  );
  await page.route(`${base}/webhook`, (route) =>
    json(route, photoWebhook(channel.id, options.webhookWarning ? HTTPS_WARNING : null)),
  );
  await page.route(`${base}/business-profile`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (options.profile === 'hang') return undefined;
    if (options.profile === 'meta-error') {
      return apiError(
        route,
        502,
        'META_REQUEST_FAILED',
        'Token belum punya izin yang dibutuhkan. Pastikan Pengguna Sistem diberi aset aplikasi + akun WhatsApp (kontrol penuh) dan token dibuat dengan izin whatsapp_business_messaging dan whatsapp_business_management.',
      );
    }
    return json(route, { profile: PHOTO_PROFILE, fetchedAt: ago(0.2) });
  });
}

/** `POST …/test` tiruan: berhasil, token ditolak, atau dibatasi (429). */
export async function channelTest(
  page: Page,
  id: string,
  outcome: 'ok' | 'token_invalid' | 'limited',
): Promise<void> {
  await page.route(`${API}/settings/channels/${id}/test`, (route) => {
    if (outcome === 'limited') {
      return apiError(
        route,
        429,
        'RATE_LIMITED',
        'Batas tes koneksi (10 kali per 5 menit) sudah tercapai.',
        { 'retry-after': '184' },
      );
    }
    const ok = outcome === 'ok';
    return json(route, {
      ok,
      code: outcome,
      message: ok
        ? 'Koneksi berhasil. Token, App Secret, Phone Number ID, dan WABA ID cocok.'
        : TOKEN_INVALID,
      testedAt: new Date().toISOString(),
      number: ok ? number({ qualityRating: 'YELLOW', nameStatus: 'PENDING_REVIEW' }) : null,
      warnings: ok
        ? [
            {
              code: 'quality_medium',
              message:
                'Kualitas nomor Sedang. Pantau keluhan dan blokir dari pelanggan supaya tidak turun menjadi Rendah.',
            },
            {
              code: 'display_name_not_approved',
              message:
                'Nama tampilan belum disetujui Meta. Periksa statusnya di WhatsApp Manager → Nomor telepon.',
            },
          ]
        : [],
    });
  });
}

/** Wizard: `POST /settings/channels` berhasil (201) dengan channel baru + webhook ber-peringatan. */
export async function mockCreateChannel(page: Page): Promise<void> {
  const created = photoChannel({
    id: PHOTO_CHANNEL_IDS.created,
    name: 'CS Utama',
    status: 'untested',
    lastTest: null,
    number: null,
  });
  await page.route(`${API}/settings/channels`, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return json(route, { channel: created, webhook: photoWebhook(created.id, HTTPS_WARNING) }, 201);
  });
}

/** Isi langkah wizard sampai langkah tertentu (isian contoh, tanpa rahasia sungguhan). */
export async function wizardTo(
  page: Page,
  step: 'ids' | 'token' | 'secret' | 'confirm' | 'webhook' | 'test' | 'billing',
): Promise<void> {
  const next = () => page.getByRole('button', { name: 'Lanjut', exact: true }).click();
  const heading = (name: string) => page.getByRole('heading', { level: 2, name }).waitFor();
  await heading('Siapkan Meta Business');
  for (const title of ['Buat aplikasi Meta', 'Pilih nomor', 'Salin ID nomor']) {
    await next();
    await heading(title);
  }
  if (step === 'ids') return;
  await page.getByLabel('Nama channel').fill('CS Utama');
  await page.getByLabel('Phone Number ID').fill('106540352242922');
  await page.getByLabel('WhatsApp Business Account ID').fill('102290129340398');
  await next();
  await heading('Buat token permanen');
  if (step === 'token') return;
  await page.getByLabel('Token System User').fill(`EAAG${'x'.repeat(60)}`);
  await next();
  await heading('Salin App Secret');
  if (step === 'secret') return;
  await page.getByLabel('App Secret').fill('9f2c4e6a8b0d1f3e5a7c9e1b3d5f7a91');
  await page.getByRole('button', { name: 'Simpan channel', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByLabel('Password', { exact: true }).fill('Kopi-Senja-Tenang-42');
  await dialog.getByLabel('Kode verifikasi').fill('481 902');
  if (step === 'confirm') return;
  await dialog.getByRole('button', { name: 'Simpan channel', exact: true }).click();
  await heading('Pasang webhook');
  if (step === 'webhook') return;
  await next();
  await heading('Tes koneksi');
  if (step === 'test') return;
  await next();
  await heading('Tambahkan metode pembayaran');
}
