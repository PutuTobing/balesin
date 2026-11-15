import type { Page } from '@playwright/test';
import { apiError, hang, json, sessionAs } from './mocks';
import {
  PHOTO_CHANNELS,
  PHOTO_CHANNEL_IDS,
  byChannelId,
  channelDetail,
  channelList,
  channelTest,
  mockCreateChannel,
  wizardTo,
} from './mocks-channel';
import { quietSecurity } from './mocks-tim';
import type { Screen } from './screens';

const MAIN = byChannelId(PHOTO_CHANNEL_IDS.main);
const SECOND = byChannelId(PHOTO_CHANNEL_IDS.second);
const UNTESTED = byChannelId(PHOTO_CHANNEL_IDS.untested);
const DISABLED = byChannelId(PHOTO_CHANNEL_IDS.disabled);
const detailPath = (id: string) => `/pengaturan/channel/${id}`;
const WIZARD = '/pengaturan/channel/tambah';

/** Gulir wadah gulir halaman sampai judul kartu (h2) berada di atas. */
async function scrollTo(page: Page, heading: string): Promise<void> {
  await page.getByRole('heading', { level: 2, name: heading }).evaluate((el) => {
    let box: HTMLElement | null = el.parentElement;
    while (box && getComputedStyle(box).overflowY !== 'auto') box = box.parentElement;
    if (!box) return;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTop += top - 16;
  });
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
}

async function fillIdentity(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog.getByLabel('Password', { exact: true }).fill('Kopi-Senja-Tenang-42');
  await dialog.getByLabel('Kode verifikasi').fill('481 902');
}

/** Wizard dengan daftar channel kosong + POST tiruan. */
async function wizardMocks(page: Page): Promise<void> {
  await quietSecurity(page);
  await channelList(page, { channels: [] });
  await mockCreateChannel(page);
}

/**
 * Fase 2 butir 1–2: Pengaturan → Channel (daftar, kosong, tanpa kunci enkripsi, batas), wizard
 * tambah nomor (9 langkah + keadaan galat/konfirmasi/tinggalkan), halaman nomor (semua keadaan
 * status, profil bisnis, kredensial, dialog). Semua memakai API tiruan.
 */
export const channelScreens: Screen[] = [
  // ── Menu Pengaturan dengan status Channel ──
  {
    name: 'pengaturan-channel',
    path: '/pengaturan',
    before: async (page) => {
      await quietSecurity(page);
      await channelList(page);
    },
    waitFor: 'h1',
  },

  // ── Daftar ──
  {
    name: 'channel-daftar',
    path: '/pengaturan/channel',
    before: async (page) => {
      await quietSecurity(page);
      await channelList(page);
    },
    waitFor: 'h2',
  },
  {
    name: 'channel-kosong',
    path: '/pengaturan/channel',
    before: async (page) => {
      await quietSecurity(page);
      await channelList(page, { channels: [] });
    },
    waitFor: 'h2',
  },
  {
    name: 'channel-kosong-tanpa-kunci',
    path: '/pengaturan/channel',
    before: async (page) => {
      await quietSecurity(page);
      await channelList(page, { channels: [], canStoreSecrets: false });
    },
    waitFor: 'h2',
  },
  {
    name: 'channel-batas',
    path: '/pengaturan/channel',
    before: async (page) => {
      await sessionAs(page, 'admin');
      await quietSecurity(page);
      await channelList(page, { channels: PHOTO_CHANNELS.slice(0, 2), maxChannels: 2 });
    },
    waitFor: 'h2',
  },
  {
    name: 'channel-memuat',
    path: '/pengaturan/channel',
    before: async (page) => {
      await quietSecurity(page);
      await hang(page, '/settings/channels');
    },
    waitUntil: 'domcontentloaded',
    waitFor: '[aria-busy="true"]',
  },
  {
    name: 'channel-gagal',
    path: '/pengaturan/channel',
    before: async (page) => {
      await quietSecurity(page);
      await page.route('**/api/v1/settings/channels', (route) =>
        apiError(route, 500, 'INTERNAL_ERROR', 'Terjadi kesalahan di server. Coba lagi.'),
      );
    },
    waitFor: 'h2',
  },

  // ── Wizard ──
  {
    name: 'wizard-meta-business',
    path: WIZARD,
    before: wizardMocks,
    waitFor: 'h2',
  },
  {
    name: 'wizard-salin-id-galat',
    path: WIZARD,
    before: wizardMocks,
    waitFor: 'h2',
    prepare: async (page) => {
      await wizardTo(page, 'ids');
      await page.getByLabel('Phone Number ID').fill('1065-4035');
      await page.getByRole('button', { name: 'Lanjut', exact: true }).click();
      await settle(page);
    },
  },
  {
    name: 'wizard-token',
    path: WIZARD,
    before: wizardMocks,
    waitFor: 'h2',
    prepare: async (page) => {
      await wizardTo(page, 'token');
      await settle(page);
    },
  },
  {
    name: 'wizard-app-secret',
    path: WIZARD,
    before: async (page) => {
      await sessionAs(page, 'admin');
      await wizardMocks(page);
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await wizardTo(page, 'secret');
      await page.getByLabel('App Secret').fill('9f2c4e6a8b0d1f3e5a7c9e1b3d5f7a91');
      await settle(page);
    },
  },
  {
    name: 'wizard-konfirmasi',
    path: WIZARD,
    before: wizardMocks,
    waitFor: 'h2',
    prepare: async (page) => {
      await wizardTo(page, 'confirm');
      await settle(page);
    },
  },
  {
    name: 'wizard-webhook',
    path: WIZARD,
    before: wizardMocks,
    waitFor: 'h2',
    prepare: async (page) => {
      await wizardTo(page, 'webhook');
      await settle(page);
    },
  },
  {
    name: 'wizard-tes-berhasil',
    path: WIZARD,
    before: async (page) => {
      await wizardMocks(page);
      await channelTest(page, PHOTO_CHANNEL_IDS.created, 'ok');
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await wizardTo(page, 'test');
      await page.getByRole('button', { name: 'Tes koneksi', exact: true }).click();
      await page.getByText(/^Koneksi berhasil./).waitFor();
      await settle(page);
    },
  },
  {
    name: 'wizard-tes-gagal',
    path: WIZARD,
    before: async (page) => {
      await wizardMocks(page);
      await channelTest(page, PHOTO_CHANNEL_IDS.created, 'token_invalid');
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await wizardTo(page, 'test');
      await page.getByRole('button', { name: 'Tes koneksi', exact: true }).click();
      await page.getByText('Koneksi gagal', { exact: true }).waitFor();
      await settle(page);
    },
  },
  {
    name: 'wizard-pembayaran',
    path: WIZARD,
    before: wizardMocks,
    waitFor: 'h2',
    prepare: async (page) => {
      await wizardTo(page, 'billing');
      await settle(page);
    },
  },
  {
    name: 'wizard-tinggalkan',
    path: WIZARD,
    before: wizardMocks,
    waitFor: 'h2',
    prepare: async (page) => {
      await wizardTo(page, 'ids');
      await page.getByLabel('Nama channel').fill('CS Utama');
      await page.getByRole('link', { name: 'Kembali ke Channel' }).click();
      await page.getByRole('dialog').waitFor();
      await settle(page);
    },
  },
  {
    name: 'wizard-tanpa-kunci',
    path: WIZARD,
    before: async (page) => {
      await quietSecurity(page);
      await channelList(page, { channels: [], canStoreSecrets: false });
    },
    waitFor: 'h2',
  },

  // ── Halaman nomor ──
  {
    name: 'nomor',
    path: detailPath(MAIN.id),
    before: async (page) => {
      await quietSecurity(page);
      await channelDetail(page, MAIN);
    },
    waitFor: 'h2',
  },
  {
    name: 'nomor-webhook',
    path: detailPath(MAIN.id),
    before: async (page) => {
      await quietSecurity(page);
      await channelDetail(page, MAIN, { webhookWarning: true });
    },
    waitFor: 'h2',
    prepare: (page) => scrollTo(page, 'Webhook'),
  },
  {
    name: 'nomor-profil',
    path: detailPath(MAIN.id),
    before: async (page) => {
      await quietSecurity(page);
      await channelDetail(page, MAIN);
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await page.getByLabel('Info', { exact: true }).waitFor();
      await scrollTo(page, 'Profil bisnis');
    },
  },
  {
    name: 'nomor-profil-gagal',
    path: detailPath(MAIN.id),
    before: async (page) => {
      await quietSecurity(page);
      await channelDetail(page, MAIN, { profile: 'meta-error' });
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await page.getByText('Profil bisnis belum bisa dimuat').waitFor();
      await scrollTo(page, 'Profil bisnis');
    },
  },
  {
    name: 'nomor-profil-konfirmasi',
    path: detailPath(MAIN.id),
    before: async (page) => {
      await quietSecurity(page);
      await channelDetail(page, MAIN);
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await page.getByLabel('Website 2').fill('https://majujaya.co.id/promo');
      await page.getByRole('button', { name: 'Simpan profil', exact: true }).click();
      await fillIdentity(page);
      await settle(page);
    },
  },
  {
    name: 'nomor-bawah',
    path: detailPath(MAIN.id),
    before: async (page) => {
      await sessionAs(page, 'admin');
      await quietSecurity(page);
      await channelDetail(page, MAIN);
    },
    waitFor: 'h2',
    prepare: (page) => scrollTo(page, 'Kredensial Meta'),
  },
  {
    name: 'nomor-ganti-kredensial',
    path: detailPath(MAIN.id),
    before: async (page) => {
      await quietSecurity(page);
      await channelDetail(page, MAIN);
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Ganti kredensial', exact: true }).click();
      await page.getByLabel('Token System User').fill(`EAAG${'y'.repeat(60)}`);
      await scrollTo(page, 'Kredensial Meta');
      await settle(page);
    },
  },
  {
    name: 'nomor-gagal-tes',
    path: detailPath(SECOND.id),
    before: async (page) => {
      await quietSecurity(page);
      await channelDetail(page, SECOND);
    },
    waitFor: 'h2',
  },
  {
    name: 'nomor-belum-dites',
    path: detailPath(UNTESTED.id),
    before: async (page) => {
      await quietSecurity(page);
      await channelDetail(page, UNTESTED, { webhookWarning: true });
    },
    waitFor: 'h2',
  },
  {
    name: 'nomor-tes-berhasil',
    path: detailPath(UNTESTED.id),
    before: async (page) => {
      await quietSecurity(page);
      await channelDetail(page, UNTESTED);
      await channelTest(page, UNTESTED.id, 'ok');
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Tes koneksi', exact: true }).click();
      await page.getByText(/^Koneksi berhasil./).waitFor();
      await settle(page);
    },
  },
  {
    name: 'nomor-tes-dibatasi',
    path: detailPath(SECOND.id),
    before: async (page) => {
      await quietSecurity(page);
      await channelDetail(page, SECOND);
      await channelTest(page, SECOND.id, 'limited');
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Tes koneksi', exact: true }).click();
      await page.getByText('Tes koneksi dibatasi sementara').waitFor();
      await settle(page);
    },
  },
  {
    name: 'nomor-nonaktif',
    path: detailPath(DISABLED.id),
    before: async (page) => {
      await quietSecurity(page);
      await channelDetail(page, DISABLED);
    },
    waitFor: 'h2',
  },
  {
    name: 'nomor-buat-ulang-token',
    path: detailPath(MAIN.id),
    before: async (page) => {
      await quietSecurity(page);
      await channelDetail(page, MAIN);
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Buat ulang verify token', exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await settle(page);
    },
  },
  {
    name: 'nomor-hapus',
    path: detailPath(MAIN.id),
    before: async (page) => {
      await quietSecurity(page);
      await channelDetail(page, MAIN);
    },
    waitFor: 'h2',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Hapus channel', exact: true }).click();
      await fillIdentity(page);
      await settle(page);
    },
  },
  {
    name: 'nomor-tidak-ditemukan',
    path: detailPath('6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3eff'),
    before: async (page) => {
      await quietSecurity(page);
      await page.route(
        '**/api/v1/settings/channels/6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3eff**',
        (route) =>
          apiError(route, 404, 'NOT_FOUND', 'Channel tidak ditemukan. Mungkin sudah dihapus.'),
      );
    },
    waitFor: 'h2',
  },
  {
    name: 'nomor-memuat',
    path: detailPath(MAIN.id),
    before: async (page) => {
      await quietSecurity(page);
      await hang(page, `/settings/channels/${MAIN.id}`);
      await page.route(`**/api/v1/settings/channels/${MAIN.id}/webhook`, (route) =>
        json(route, {}),
      );
    },
    waitUntil: 'domcontentloaded',
    waitFor: '[aria-busy="true"]',
  },
];
