import type { Page } from '@playwright/test';
import { json } from './mocks';
import { quietSecurity } from './mocks-tim';
import type { Screen } from './screens';

/**
 * Fase 4: Broadcast (daftar, wizard, detail, persetujuan, jeda otomatis), Pengaturan → Batas kirim
 * (bagian broadcast), Konektor data, Alarm Telegram. Data tiruan = bentuk skema bersama.
 */
const API = '**/api/v1';
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
const CHANNEL = { id: '6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e01', name: 'CS Maju Jaya' };
const AGUS = { id: 'a1a2b3c4-0000-4000-8000-0000000000a2', name: 'Agus Saputra' };
const TEMPLATE_ID = '7e1a2b3c-0000-4000-8000-000000000001';

const TEMPLATE = {
  id: TEMPLATE_ID,
  channelId: CHANNEL.id,
  wabaId: '100000000000999',
  metaTemplateId: '9876543210001',
  name: 'tagihan_jatuh_tempo',
  language: 'id',
  category: 'UTILITY',
  status: 'APPROVED',
  rejectedReason: null,
  qualityScore: 'GREEN',
  content: {
    parameterFormat: 'positional',
    header: { format: 'TEXT', text: 'Pengingat Tagihan Internet' },
    body: {
      text: 'Halo {{1}}, tagihan internet periode {{2}} sebesar {{3}} jatuh tempo pada {{4}}. Abaikan pesan ini bila sudah membayar.',
      examples: { '1': 'Budi', '2': 'November 2026', '3': 'Rp150.000', '4': '20 November 2026' },
    },
    footer: null,
    buttons: [
      { type: 'QUICK_REPLY', text: 'Sudah bayar' },
      { type: 'QUICK_REPLY', text: 'Butuh bantuan' },
    ],
    authentication: null,
  },
  source: 'balesin',
  presetKey: null,
  localChanges: false,
  lastSyncedAt: null,
  submittedAt: ago(3 * 24 * HOUR),
  createdAt: ago(5 * 24 * HOUR),
  updatedAt: ago(2 * 24 * HOUR),
};

const COLUMNS = ['nomor', 'nama', 'periode', 'tagihan', 'jatuh_tempo'];
const MAPPING = {
  body: {
    '1': { kind: 'column', column: 'nama' },
    '2': { kind: 'column', column: 'periode' },
    '3': { kind: 'column', column: 'tagihan' },
    '4': { kind: 'column', column: 'jatuh_tempo' },
  },
  header: null,
  buttons: {},
};
const ESTIMATE = {
  currency: 'IDR',
  category: 'UTILITY',
  recipients: 1248,
  billable: 1190,
  free: 58,
  unknownRate: 0,
  total: 431_970,
  rateSource:
    'Perkiraan bawaan: tarif Meta untuk nomor Indonesia seperti tampil di penyedia lain per 30 Sep 2026. Periksa rate card resmi Meta lalu sesuaikan.',
  computedAt: ago(5 * 60_000),
};

function campaign(n: number, init: Record<string, unknown>) {
  return {
    id: `b71a2b3c-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
    name: 'Pengingat tagihan November',
    status: 'draft',
    channel: CHANNEL,
    template: {
      id: TEMPLATE_ID,
      name: 'tagihan_jatuh_tempo',
      language: 'id',
      category: 'UTILITY',
      status: 'APPROVED',
    },
    source: { kind: 'upload', label: 'pelanggan-menunggak.xlsx', importedAt: ago(20 * 60_000) },
    columns: COLUMNS,
    phoneColumn: 'nomor',
    mapping: MAPPING,
    scheduledAt: null,
    ratePerSecond: 5,
    dedupe: { hours: 24, scope: 'template' },
    autoTag: null,
    counts: {
      sourceRows: 1252,
      rejectedRows: 4,
      recipients: 1248,
      pending: 1248,
      queued: 0,
      skipped: 0,
      cancelled: 0,
    },
    approval: {
      required: false,
      threshold: 50,
      requestedAt: null,
      decidedAt: null,
      decidedBy: null,
      rejectionReason: null,
    },
    estimate: null,
    pause: null,
    waiting: null,
    createdBy: AGUS,
    createdAt: ago(n * 6 * HOUR),
    updatedAt: ago(n * 5 * HOUR),
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    ...init,
  };
}

const RUNNING = campaign(1, {
  name: 'Pengingat tagihan November',
  status: 'running',
  estimate: ESTIMATE,
  startedAt: ago(25 * 60_000),
  counts: {
    sourceRows: 1252,
    rejectedRows: 4,
    recipients: 1248,
    pending: 412,
    queued: 830,
    skipped: 6,
    cancelled: 0,
  },
});
const PENDING = campaign(2, {
  name: 'Promo upgrade 50 Mbps',
  status: 'pending_approval',
  template: {
    id: TEMPLATE_ID,
    name: 'promo_upgrade_desember',
    language: 'id',
    category: 'MARKETING',
    status: 'APPROVED',
  },
  source: { kind: 'segment', label: 'Tag: Langganan 20 Mbps', importedAt: ago(40 * 60_000) },
  estimate: { ...ESTIMATE, total: 740_064 },
  approval: {
    required: true,
    threshold: 50,
    requestedAt: ago(30 * 60_000),
    decidedAt: null,
    decidedBy: null,
    rejectionReason: null,
  },
});
const PAUSED = campaign(3, {
  name: 'Info gangguan Way Halim',
  template: {
    id: TEMPLATE_ID,
    name: 'gangguan_jaringan',
    language: 'id',
    category: 'UTILITY',
    status: 'APPROVED',
  },
  source: { kind: 'connector', label: 'Billing: pelanggan area Way Halim', importedAt: ago(HOUR) },
  status: 'paused',
  pause: { reason: 'failure_spike', at: ago(8 * 60_000), by: null, requiresAdmin: true },
  counts: {
    sourceRows: 320,
    rejectedRows: 0,
    recipients: 320,
    pending: 180,
    queued: 140,
    skipped: 0,
    cancelled: 0,
  },
});
const SCHEDULED = campaign(4, {
  name: 'Jadwal pemeliharaan Sabtu',
  template: {
    id: TEMPLATE_ID,
    name: 'jadwal_pemeliharaan',
    language: 'id',
    category: 'UTILITY',
    status: 'APPROVED',
  },
  status: 'scheduled',
  scheduledAt: inFuture(20 * HOUR),
  counts: {
    sourceRows: 86,
    rejectedRows: 0,
    recipients: 86,
    pending: 86,
    queued: 0,
    skipped: 0,
    cancelled: 0,
  },
});
const COMPLETED = campaign(5, {
  name: 'Pengingat tagihan Oktober',
  status: 'completed',
  estimate: { ...ESTIMATE, total: 398_310 },
  completedAt: ago(30 * 24 * HOUR),
  counts: {
    sourceRows: 1100,
    rejectedRows: 2,
    recipients: 1098,
    pending: 0,
    queued: 1090,
    skipped: 8,
    cancelled: 0,
  },
});
const DRAFT = campaign(6, { name: 'Ucapan pelanggan baru', status: 'draft' });
const DRAFT_EMPTY = campaign(7, {
  name: 'Pengingat tagihan Desember',
  status: 'draft',
  source: null,
  columns: [],
  phoneColumn: null,
  mapping: { body: {}, header: null, buttons: {} },
  counts: {
    sourceRows: 0,
    rejectedRows: 0,
    recipients: 0,
    pending: 0,
    queued: 0,
    skipped: 0,
    cancelled: 0,
  },
});
const ALL = [RUNNING, PENDING, PAUSED, SCHEDULED, COMPLETED, DRAFT];

const REPORT = {
  broadcastId: RUNNING.id,
  status: 'running',
  recipients: 1248,
  rejectedRows: 4,
  pending: 412,
  skipped: 6,
  skippedByReason: {
    recently_sent: 6,
    missing_variable: 0,
    invalid_variable: 0,
    contact_unavailable: 0,
  },
  cancelled: 0,
  sending: 14,
  sent: 96,
  delivered: 402,
  read: 299,
  failed: 19,
  failures: [
    {
      reason: 'delivery_failed',
      errorCode: 131026,
      message:
        'Pesan tidak bisa diantar: nomor tidak memakai WhatsApp atau versi aplikasinya lama.',
      count: 15,
    },
    {
      reason: 'meta_rejected',
      errorCode: 131049,
      message: 'Meta menahan pesan pemasaran untuk menjaga pengalaman pengguna.',
      count: 4,
    },
  ],
  replied: 87,
  cost: { currency: 'IDR', billable: 701, total: 254_463 },
  estimate: ESTIMATE,
  startedAt: ago(25 * 60_000),
  completedAt: null,
};

const RECIPIENTS = [
  {
    status: 'queued',
    messageStatus: 'read',
    phone: '+6281234567890',
    row: 2,
    repliedAt: ago(5 * 60_000),
  },
  {
    status: 'queued',
    messageStatus: 'delivered',
    phone: '+6285267001122',
    row: 3,
    repliedAt: null,
  },
  { status: 'queued', messageStatus: 'failed', phone: '+6281377889900', row: 4, repliedAt: null },
  { status: 'skipped', messageStatus: null, phone: '+6282199001234', row: 5, repliedAt: null },
  { status: 'pending', messageStatus: null, phone: '+6281299998888', row: 6, repliedAt: null },
].map((item, index) => ({
  id: `7a1a2b3c-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
  row: item.row,
  phone: item.phone,
  status: item.status,
  skipReason: item.status === 'skipped' ? 'recently_sent' : null,
  messageStatus: item.messageStatus,
  failure:
    item.messageStatus === 'failed'
      ? {
          reason: 'delivery_failed',
          errorCode: 131026,
          message: 'Pesan tidak bisa diantar: nomor tidak memakai WhatsApp.',
        }
      : null,
  conversationId: item.messageStatus
    ? `c1a2b3c4-0000-4000-8000-0000000002${String(index).padStart(2, '0')}`
    : null,
  processedAt: item.messageStatus ? ago((index + 1) * 60_000) : null,
  repliedAt: item.repliedAt,
}));

const IMPORT_REPORT = {
  sourceRows: 1252,
  recipients: 1248,
  rejectedRows: 4,
  issues: [
    { row: 18, issue: 'phone_invalid' },
    { row: 207, issue: 'duplicate' },
    { row: 611, issue: 'phone_scientific' },
    { row: 940, issue: 'phone_missing' },
  ],
  issueCounts: {
    phone_missing: 1,
    phone_invalid: 1,
    phone_scientific: 1,
    duplicate: 1,
    value_too_long: 0,
  },
  columns: COLUMNS,
  phoneColumn: 'nomor',
};

async function broadcastMocks(page: Page, list: unknown[] = ALL): Promise<void> {
  await quietSecurity(page);
  await page.route(`${API}/channels`, (route) =>
    json(route, {
      channels: [
        { ...CHANNEL, type: 'whatsapp', enabled: true, displayPhoneNumber: '+62 811-7200-345' },
      ],
    }),
  );
  await page.route(/\/api\/v1\/templates(\?|$)/, (route) => json(route, { templates: [TEMPLATE] }));
  await page.route(`${API}/templates/${TEMPLATE_ID}`, (route) =>
    json(route, { template: TEMPLATE }),
  );
  await page.route(/\/api\/v1\/broadcasts(\?|$)/, (route) =>
    json(route, { broadcasts: list, nextCursor: null }),
  );
  await page.route(`${API}/broadcasts/connectors`, (route) =>
    json(route, {
      connectors: [
        { id: '7c1a2b3c-0000-4000-8000-000000000001', name: 'Billing: pelanggan menunggak' },
      ],
    }),
  );
  for (const item of [...ALL, DRAFT_EMPTY]) {
    await page.route(`${API}/broadcasts/${item.id}`, (route) => json(route, { broadcast: item }));
    await page.route(`${API}/broadcasts/${item.id}/report`, (route) =>
      json(route, { report: { ...REPORT, broadcastId: item.id } }),
    );
    // Kampanye yang belum mulai mengirim: penerima masih antre (tanpa status kirim/dibaca).
    const unsent = ['draft', 'pending_approval', 'scheduled'].includes(
      (item as { status: string }).status,
    );
    await page.route(new RegExp(`/api/v1/broadcasts/${item.id}/recipients(\\?|$)`), (route) =>
      json(route, {
        recipients: unsent
          ? RECIPIENTS.map((recipient) => ({
              ...recipient,
              status: 'pending',
              skipReason: null,
              messageStatus: null,
              failure: null,
              conversationId: null,
              processedAt: null,
              repliedAt: null,
            }))
          : RECIPIENTS,
        nextCursor: null,
      }),
    );
    await page.route(`${API}/broadcasts/${item.id}/estimate`, (route) =>
      json(route, { estimate: ESTIMATE }),
    );
    await page.route(`${API}/broadcasts/${item.id}/preview`, (route) =>
      json(route, {
        samples: [
          ['+6281234567890', 'Budi Santoso', 'November 2026', 'Rp150.000'],
          ['+6285267001122', 'Siti Aminah', 'November 2026', 'Rp275.000'],
        ].map(([phone, name, period, amount], index) => ({
          recipientId: `7a1a2b3c-0000-4000-8000-0000000003${String(index).padStart(2, '0')}`,
          row: index + 2,
          phone,
          headerText: null,
          text: `Halo ${name}, tagihan internet periode ${period} sebesar ${amount} jatuh tempo pada 20 November 2026. Abaikan pesan ini bila sudah membayar.`,
          missing: [],
          invalid: [],
        })),
        problems: { missing: 3, invalid: 0 },
      }),
    );
  }
  await page.route(`${API}/broadcasts/${DRAFT_EMPTY.id}/recipients/upload`, (route) =>
    json(route, {
      broadcast: { ...DRAFT_EMPTY, ...DRAFT, id: DRAFT_EMPTY.id, name: DRAFT_EMPTY.name },
      report: IMPORT_REPORT,
    }),
  );
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
}

const CONNECTORS = [
  {
    id: '7c1a2b3c-0000-4000-8000-000000000001',
    name: 'Billing: pelanggan menunggak',
    url: 'https://billing.majujaya.co.id/api/v1/pelanggan/menunggak',
    authHeaderName: 'Authorization',
    authHeaderTail: 'f3a9',
    itemsPath: 'data.items',
    phoneField: 'no_hp',
    lastTest: {
      ok: true,
      code: 'ok',
      message: 'Data berhasil diambil.',
      items: 1248,
      at: ago(2 * HOUR),
    },
    createdAt: ago(10 * 24 * HOUR),
    updatedAt: ago(2 * HOUR),
  },
];

export const broadcastScreens: Screen[] = [
  {
    name: 'broadcast-kosong',
    path: '/broadcast',
    before: (page) => broadcastMocks(page, []),
    waitFor: 'text=Belum ada kampanye',
    prepare: settle,
  },
  {
    name: 'broadcast-daftar',
    path: '/broadcast',
    before: (page) => broadcastMocks(page),
    waitFor: 'text=Pengingat tagihan November',
    prepare: settle,
  },
  {
    name: 'broadcast-baru',
    path: '/broadcast/baru',
    before: (page) => broadcastMocks(page),
    waitFor: 'text=Nama kampanye',
    prepare: async (page) => {
      await page.getByLabel('Nama kampanye').fill('Pengingat tagihan Desember');
      await settle(page);
    },
  },
  {
    name: 'broadcast-penerima',
    path: `/broadcast/${DRAFT_EMPTY.id}`,
    before: (page) => broadcastMocks(page),
    waitFor: 'text=Sumber penerima',
    prepare: async (page) => {
      await page.getByTestId('broadcast-file').setInputFiles({
        name: 'pelanggan-menunggak.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: Buffer.from('nomor,nama\n', 'utf8'),
      });
      await page.getByText(/penerima siap/).waitFor();
      await settle(page);
    },
  },
  {
    name: 'broadcast-variabel',
    path: `/broadcast/${DRAFT.id}`,
    before: (page) => broadcastMocks(page),
    waitFor: 'text=Pratinjau beberapa penerima',
    prepare: async (page) => {
      await page.getByText(/Halo Budi Santoso/).waitFor();
      await settle(page);
    },
  },
  {
    name: 'broadcast-kirim',
    path: `/broadcast/${DRAFT.id}`,
    before: (page) => broadcastMocks(page),
    waitFor: 'text=Pratinjau beberapa penerima',
    prepare: async (page) => {
      await page.getByText(/Halo Budi Santoso/).waitFor();
      await page.getByRole('button', { name: 'Lanjut' }).click();
      await page.getByText('Perkiraan biaya').waitFor();
      await settle(page);
    },
  },
  {
    name: 'broadcast-berjalan',
    path: `/broadcast/${RUNNING.id}`,
    before: (page) => broadcastMocks(page),
    waitFor: 'text=Hasil kampanye',
    prepare: settle,
  },
  {
    name: 'broadcast-persetujuan',
    path: `/broadcast/${PENDING.id}`,
    before: (page) => broadcastMocks(page),
    waitFor: 'text=Menunggu persetujuan',
    prepare: settle,
  },
  {
    name: 'broadcast-dijeda',
    path: `/broadcast/${PAUSED.id}`,
    before: (page) => broadcastMocks(page),
    waitFor: 'text=Rem otomatis: terlalu banyak pesan gagal',
    prepare: settle,
  },
  {
    name: 'konektor-data',
    path: '/pengaturan/konektor-data',
    before: async (page) => {
      await quietSecurity(page);
      await page.route(`${API}/settings/broadcast-connectors`, (route) =>
        json(route, { connectors: CONNECTORS }),
      );
    },
    waitFor: 'text=Billing: pelanggan menunggak',
    prepare: settle,
  },
  {
    name: 'konektor-tambah',
    path: '/pengaturan/konektor-data',
    before: async (page) => {
      await quietSecurity(page);
      await page.route(`${API}/settings/broadcast-connectors`, (route) =>
        json(route, { connectors: CONNECTORS }),
      );
    },
    waitFor: 'text=Billing: pelanggan menunggak',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Buat konektor' }).click();
      const dialog = page.getByRole('dialog', { name: 'Buat konektor data' });
      await dialog.getByLabel('Nama', { exact: true }).fill('CRM: pelanggan aktif');
      await dialog
        .getByLabel('Alamat (GET, JSON)')
        .fill('https://crm.majujaya.co.id/api/pelanggan?status=aktif&api_key=abc123');
      await settle(page);
    },
  },
  {
    name: 'alarm-telegram',
    path: '/pengaturan/alarm',
    before: async (page) => {
      await quietSecurity(page);
      await page.route(`${API}/settings/alarms/telegram`, (route) =>
        json(route, {
          telegram: {
            configured: false,
            enabled: false,
            tokenTail: null,
            chatId: null,
            lastTest: null,
            updatedAt: null,
          },
        }),
      );
    },
    waitFor: 'text=Alarm Telegram belum diatur',
    prepare: settle,
  },
  {
    name: 'alarm-telegram-aktif',
    path: '/pengaturan/alarm',
    before: async (page) => {
      await quietSecurity(page);
      await page.route(`${API}/settings/alarms/telegram`, (route) =>
        json(route, {
          telegram: {
            configured: true,
            enabled: true,
            tokenTail: 'Hm9T',
            chatId: '-1001234567890',
            lastTest: {
              ok: true,
              code: 'ok',
              message: 'Pesan tes terkirim ke Telegram.',
              at: ago(HOUR),
            },
            updatedAt: ago(2 * HOUR),
          },
        }),
      );
    },
    waitFor: 'text=Kirim pesan tes',
    prepare: settle,
  },
  {
    name: 'pengaturan-broadcast',
    path: '/pengaturan/batas-kirim',
    before: async (page) => {
      await quietSecurity(page);
    },
    waitFor: 'text=Ambang persetujuan (penerima per 24 jam)',
    prepare: async (page) => {
      await page.getByText('Ambang persetujuan (penerima per 24 jam)').scrollIntoViewIfNeeded();
      await settle(page);
    },
  },
];
