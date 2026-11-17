import type { Page } from '@playwright/test';
import { json } from './mocks';
import { PHOTO_CONVERSATIONS, inboxMocks } from './mocks-inbox';
import { quietSecurity } from './mocks-tim';
import type { Screen } from './screens';

/**
 * Fase 4: Pengaturan → Template WhatsApp (daftar, editor + pratinjau, preset), kirim template di
 * luar sesi 24 jam, dan percakapan baru. Data tiruan = bentuk `messageTemplateSchema` bersama.
 */
const API = '**/api/v1';
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const CS = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01';
const BILLING = '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e02';
const EXPIRED = PHOTO_CONVERSATIONS[5]!;

const CHANNELS = [
  {
    id: CS,
    type: 'whatsapp',
    name: 'CS Maju Jaya',
    enabled: true,
    displayPhoneNumber: '+62 811-7200-345',
  },
  {
    id: BILLING,
    type: 'whatsapp',
    name: 'Tagihan Maju Jaya',
    enabled: true,
    displayPhoneNumber: '+62 811-7200-346',
  },
];

function template<T extends Record<string, unknown>>(n: number, init: T) {
  return {
    id: `7e1a2b3c-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
    channelId: CS,
    wabaId: '100000000000999',
    metaTemplateId: `98765432100${String(n).padStart(2, '0')}`,
    language: 'id',
    category: 'UTILITY',
    status: 'APPROVED',
    rejectedReason: null as string | null,
    qualityScore: 'GREEN' as string | null,
    source: 'balesin',
    presetKey: null,
    localChanges: false,
    lastSyncedAt: ago(2 * HOUR),
    submittedAt: ago(3 * 24 * HOUR),
    createdAt: ago(5 * 24 * HOUR),
    updatedAt: ago(n * 5 * HOUR),
    ...init,
  };
}

const content = (body: string, examples: Record<string, string>, extra = {}) => ({
  parameterFormat: 'positional',
  header: null,
  body: { text: body, examples },
  footer: null,
  buttons: [],
  authentication: null,
  ...extra,
});

const TAGIHAN = template(1, {
  name: 'tagihan_jatuh_tempo',
  content: content(
    'Halo {{1}}, tagihan internet periode {{2}} sebesar {{3}} jatuh tempo pada {{4}}. Abaikan pesan ini bila sudah membayar.',
    { '1': 'Budi', '2': 'November 2026', '3': 'Rp150.000', '4': '20 November 2026' },
    {
      header: { format: 'TEXT', text: 'Pengingat Tagihan Internet' },
      footer: { text: 'Balas pesan ini bila butuh bantuan.' },
      buttons: [
        { type: 'QUICK_REPLY', text: 'Sudah bayar' },
        { type: 'QUICK_REPLY', text: 'Butuh bantuan' },
      ],
    },
  ),
});
const GANGGUAN = template(2, {
  name: 'gangguan_jaringan',
  channelId: BILLING,
  status: 'PENDING',
  qualityScore: null,
  content: content(
    'Halo {{1}}, saat ini ada gangguan jaringan di area {{2}}. Tim kami sedang menanganinya.',
    { '1': 'Budi', '2': 'Way Halim' },
  ),
});
const PROMO = template(3, {
  name: 'promo_upgrade_desember',
  category: 'MARKETING',
  status: 'REJECTED',
  rejectedReason: 'INVALID_FORMAT',
  qualityScore: null,
  content: content(
    'Halo {{1}}! Upgrade ke {{2}} cukup tambah {{3}} per bulan. Tawaran berlaku sampai akhir Desember.',
    { '1': 'Budi', '2': '50 Mbps', '3': 'Rp50.000' },
    { buttons: [{ type: 'URL', text: 'Lihat paket', url: 'https://majujaya.test/paket' }] },
  ),
});
const TEKNISI = template(4, {
  name: 'jadwal_teknisi',
  localChanges: true,
  qualityScore: 'YELLOW',
  content: content(
    'Halo {{1}}, teknisi kami {{2}} akan datang pada {{3}}. Mohon pastikan ada yang di rumah.',
    { '1': 'Budi', '2': 'Agus', '3': 'Selasa, 08.00–10.00' },
  ),
});
const OTP = template(5, {
  name: 'kode_verifikasi',
  category: 'AUTHENTICATION',
  source: 'meta',
  content: content(
    '*{{1}}* adalah kode verifikasi Anda.',
    {},
    {
      buttons: [{ type: 'COPY_CODE', example: '123456' }],
      authentication: { addSecurityRecommendation: true, codeExpirationMinutes: 10 },
    },
  ),
});
const BERGAMBAR = template(6, {
  name: 'promo_bergambar',
  category: 'MARKETING',
  source: 'meta',
  content: content(
    'Promo akhir tahun untuk pelanggan setia {{1}}. Lihat detailnya di gambar.',
    {
      '1': 'Maju Jaya',
    },
    { header: { format: 'IMAGE' } },
  ),
});
const ALL = [TAGIHAN, GANGGUAN, PROMO, TEKNISI, OTP, BERGAMBAR];

const PRESETS = [
  {
    key: 'isp_tagihan_jatuh_tempo',
    industry: 'isp',
    title: 'Pengingat tagihan jatuh tempo',
    description: 'Dikirim beberapa hari sebelum / saat jatuh tempo.',
    name: 'tagihan_jatuh_tempo',
    language: 'id',
    category: 'UTILITY',
    content: TAGIHAN.content,
  },
  {
    key: 'isp_gangguan_jaringan',
    industry: 'isp',
    title: 'Info gangguan jaringan',
    description: 'Dikirim saat ada gangguan di area pelanggan.',
    name: 'gangguan_jaringan',
    language: 'id',
    category: 'UTILITY',
    content: GANGGUAN.content,
  },
  {
    key: 'isp_penawaran_upgrade',
    industry: 'isp',
    title: 'Penawaran upgrade paket',
    description: 'Promosi paket lebih cepat untuk pelanggan aktif.',
    name: 'penawaran_upgrade',
    language: 'id',
    category: 'MARKETING',
    content: PROMO.content,
  },
  {
    key: 'isp_kode_verifikasi',
    industry: 'isp',
    title: 'Kode verifikasi',
    description: 'Kode sekali pakai untuk masuk ke aplikasi pelanggan.',
    name: 'kode_verifikasi',
    language: 'id',
    category: 'AUTHENTICATION',
    content: OTP.content,
  },
];

async function templateMocks(page: Page, list: unknown[] = ALL): Promise<void> {
  await quietSecurity(page);
  await page.route(`${API}/channels`, (route) => json(route, { channels: CHANNELS }));
  await page.route(/\/api\/v1\/templates(\?|$)/, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const status = query.get('status');
    return json(route, {
      templates: (list as { status: string }[]).filter((item) => !status || item.status === status),
    });
  });
  await page.route(`${API}/templates/presets`, (route) => json(route, { presets: PRESETS }));
  for (const item of ALL) {
    await page.route(`${API}/templates/${item.id}`, (route) => json(route, { template: item }));
  }
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
}

export const templateScreens: Screen[] = [
  {
    name: 'template-daftar',
    path: '/pengaturan/template',
    before: (page) => templateMocks(page),
    waitFor: 'text=tagihan_jatuh_tempo',
    prepare: settle,
  },
  {
    name: 'template-kosong',
    path: '/pengaturan/template',
    before: (page) => templateMocks(page, []),
    waitFor: 'text=Belum ada template',
    prepare: settle,
  },
  {
    name: 'template-preset',
    path: '/pengaturan/template',
    before: (page) => templateMocks(page),
    waitFor: 'text=tagihan_jatuh_tempo',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Pakai preset' }).click();
      await page
        .getByRole('dialog', { name: 'Pilih preset template' })
        .getByText('Kode verifikasi', { exact: true })
        .waitFor();
      await settle(page);
    },
  },
  {
    name: 'template-baru',
    path: '/pengaturan/template/baru',
    before: (page) => templateMocks(page),
    waitFor: 'text=Pratinjau',
    prepare: async (page) => {
      await page.getByLabel('Nama template').fill('info_pemeliharaan');
      await page
        .getByRole('textbox', { name: 'Isi pesan' })
        .fill('Halo {{1}}, akan ada pemeliharaan jaringan pada {{2}} pukul {{3}}.');
      await page.getByLabel('Contoh {{1}}').fill('Budi');
      await page.getByLabel('Contoh {{2}}').fill('Sabtu, 30 November');
      await page.getByRole('radio', { name: 'Teks' }).click();
      await page.getByLabel('Teks judul').fill('Jadwal Pemeliharaan');
      await page.getByRole('button', { name: 'Tambah tombol: Balasan cepat' }).click();
      await page.getByLabel('Teks tombol').fill('Oke, terima kasih');
      await settle(page);
    },
  },
  {
    name: 'template-ditolak',
    path: `/pengaturan/template/${PROMO.id}`,
    before: (page) => templateMocks(page),
    waitFor: 'text=Alasan dari Meta',
    prepare: settle,
  },
  {
    name: 'template-ditinjau',
    path: `/pengaturan/template/${GANGGUAN.id}`,
    before: (page) => templateMocks(page),
    waitFor: 'text=sedang ditinjau Meta',
    prepare: settle,
  },
  {
    name: 'template-otp',
    path: `/pengaturan/template/${OTP.id}`,
    before: (page) => templateMocks(page),
    waitFor: 'text=Pengaturan kode OTP',
    prepare: settle,
  },
  // Inbox: sesi habis → "Kirim template" (aksi nyata), dialog isi variabel, percakapan baru.
  {
    name: 'inbox-kirim-template',
    path: `/inbox?chat=${EXPIRED.id}`,
    before: async (page) => {
      await inboxMocks(page);
      await templateMocks(page);
    },
    waitFor: '[aria-label="Ruang chat"] [data-tone="expired"]',
    prepare: async (page) => {
      await page
        .getByRole('region', { name: 'Ruang chat' })
        .getByRole('button', { name: 'Kirim template', exact: true })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Kirim template WhatsApp' });
      await dialog.getByRole('button', { name: /tagihan_jatuh_tempo/ }).click();
      await dialog.getByLabel('Nilai {{1}}', { exact: true }).fill('Budi');
      await dialog.getByLabel('Nilai {{2}}', { exact: true }).fill('Desember 2026');
      await settle(page);
    },
  },
  {
    name: 'inbox-pilih-template',
    path: `/inbox?chat=${EXPIRED.id}`,
    before: async (page) => {
      await inboxMocks(page);
      await templateMocks(page);
    },
    waitFor: '[aria-label="Ruang chat"] [data-tone="expired"]',
    prepare: async (page) => {
      await page
        .getByRole('region', { name: 'Ruang chat' })
        .getByRole('button', { name: 'Kirim template', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Kirim template WhatsApp' })
        .getByRole('button', { name: /kode_verifikasi/ })
        .waitFor();
      await settle(page);
    },
  },
  {
    name: 'inbox-percakapan-baru',
    path: '/inbox',
    before: async (page) => {
      await inboxMocks(page);
      await templateMocks(page);
    },
    waitFor: 'text=Budi Santoso',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Percakapan baru' }).click();
      const dialog = page.getByRole('dialog', { name: 'Mulai percakapan baru' });
      await dialog.getByLabel('Nomor tujuan').fill('+6281298765432');
      await dialog.getByRole('button', { name: /jadwal_teknisi/ }).click();
      await dialog.getByLabel('Nilai {{1}}', { exact: true }).fill('Bu Rina');
      await settle(page);
    },
  },
];
