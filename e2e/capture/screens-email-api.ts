import type { Page } from '@playwright/test';
import { EMAIL_TEMPLATE_PRESETS } from '../../packages/shared/src/email-template-presets';
import { json } from './mocks';
import { inboxMocks } from './mocks-inbox';
import { quietSecurity } from './mocks-tim';
import type { Screen } from './screens';

/**
 * Fase 9.1 — Pengaturan → Template email (daftar, editor, pratinjau, riwayat), akses email API key,
 * riwayat email API, dan Batas kirim → Email per pengirim. Data tiruan = bentuk skema bersama
 * (`email-message-templates.ts`, `email-send.ts`, `api-keys.ts`). Pratinjau dirender server E2E
 * sungguhan (`POST …/preview`) dari isi tiruan, jadi bingkai merek & QRIS contoh asli.
 */
const API = '**/api/v1';
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
const RINA = { id: 'a1a2b3c4-0000-4000-8000-0000000000c1', name: 'Rina Kartika' };
const AGUS = { id: 'a1a2b3c4-0000-4000-8000-0000000000c2', name: 'Agus Pratama' };
const BILLING_CHANNEL = '6b1f2c3d-0000-4000-8000-000000000001';
const CS_CHANNEL = '6b1f2c3d-0000-4000-8000-000000000002';
const BILLING = `chn_${BILLING_CHANNEL}`;
const CS = `chn_${CS_CHANNEL}`;
const TEMPLATE_ID = '1e7d0000-0000-4000-8000-000000000001';

const preset = (key: string) => {
  const found = EMAIL_TEMPLATE_PRESETS.find((item) => item.key === key);
  if (!found) throw new Error(`Preset ${key} tidak ada`);
  return found;
};

const EXAMPLES: Record<string, string> = {
  nama: 'Budi',
  id_pelanggan: 'PLG-00873',
  periode: 'November 2026',
  total: 'Rp185.000',
  jatuh_tempo: '25 Nov 2026',
  bank_va: 'BRI',
  kode_va: '8808 0000 0000 0001',
  tautan_bayar: 'https://bayar.perusahaan.example/PLG-00873',
};

const tagihan = preset('tagihan-bulanan');
const CONTENT = {
  subject: tagihan.subject,
  html: tagihan.html,
  text: null,
  variables: tagihan.variables.map((variable) => ({
    ...variable,
    example: EXAMPLES[variable.name] ?? variable.example,
  })),
  layout: 'brand',
  footerText: tagihan.footerText,
};

const TEMPLATE = {
  id: TEMPLATE_ID,
  slug: 'tagihan-bulanan',
  name: 'Tagihan bulanan',
  description: 'Dikirim aplikasi billing tiap tanggal 20.',
  presetKey: 'tagihan-bulanan',
  archived: false,
  publishedVersion: 3,
  lastUsedAt: ago(40 * 60_000),
  // Draf sedikit berbeda dari versi terbit → "Ada perubahan belum terbit".
  draft: { ...CONTENT, footerText: `${tagihan.footerText ?? ''} Jam layanan 08.00–20.00.` },
  published: {
    ...CONTENT,
    version: 3,
    publishedAt: ago(2 * 24 * HOUR),
    publishedBy: RINA,
  },
  createdAt: ago(20 * 24 * HOUR),
  updatedAt: ago(25 * 60_000),
};

function summary(
  n: number,
  init: { name: string; slug: string; subject: string; publishedVersion: number | null } & Partial<{
    hasUnpublishedChanges: boolean;
    lastUsedAt: string | null;
    archived: boolean;
    updatedAt: string;
  }>,
) {
  return {
    id: `1e7d0000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
    description: null,
    presetKey: init.slug,
    archived: false,
    hasUnpublishedChanges: false,
    lastUsedAt: null,
    createdAt: ago(20 * 24 * HOUR),
    updatedAt: ago(n * 6 * HOUR),
    ...init,
  };
}

const SUMMARIES = [
  {
    ...summary(1, {
      name: 'Tagihan bulanan',
      slug: 'tagihan-bulanan',
      subject: tagihan.subject,
      publishedVersion: 3,
      hasUnpublishedChanges: true,
      lastUsedAt: ago(40 * 60_000),
      updatedAt: ago(25 * 60_000),
    }),
    id: TEMPLATE_ID,
  },
  summary(2, {
    name: 'Pengingat jatuh tempo',
    slug: 'pengingat-jatuh-tempo',
    subject: preset('pengingat-jatuh-tempo').subject,
    publishedVersion: 1,
    lastUsedAt: ago(26 * HOUR),
  }),
  summary(3, {
    name: 'Pembayaran diterima',
    slug: 'pembayaran-diterima',
    subject: preset('pembayaran-diterima').subject,
    publishedVersion: 2,
    lastUsedAt: ago(3 * HOUR),
  }),
  summary(4, {
    name: 'Layanan diisolir',
    slug: 'layanan-diisolir',
    subject: preset('layanan-diisolir').subject,
    publishedVersion: null,
    hasUnpublishedChanges: true,
  }),
];

const ARCHIVED = [
  summary(5, {
    name: 'Promo upgrade 2025',
    slug: 'promo-upgrade-2025',
    subject: 'Upgrade kecepatan internetmu',
    publishedVersion: 4,
    archived: true,
    lastUsedAt: ago(60 * 24 * HOUR),
  }),
];

const VERSIONS = [
  {
    version: 3,
    state: 'published',
    subject: tagihan.subject,
    createdBy: RINA,
    createdAt: ago(2 * 24 * HOUR),
    publishedBy: RINA,
    publishedAt: ago(2 * 24 * HOUR),
  },
  {
    version: 2,
    state: 'superseded',
    subject: 'Tagihan {{periode}} untuk {{id_pelanggan}}',
    createdBy: AGUS,
    createdAt: ago(9 * 24 * HOUR),
    publishedBy: AGUS,
    publishedAt: ago(9 * 24 * HOUR),
  },
  {
    version: 1,
    state: 'superseded',
    subject: 'Tagihan internet {{periode}}',
    createdBy: RINA,
    createdAt: ago(20 * 24 * HOUR),
    publishedBy: RINA,
    publishedAt: ago(20 * 24 * HOUR),
  },
];

const CHANNELS = [
  {
    id: BILLING_CHANNEL,
    type: 'email',
    name: 'Billing',
    enabled: true,
    displayPhoneNumber: null,
    emailAddresses: ['billing@majujaya.co.id'],
  },
  {
    id: CS_CHANNEL,
    type: 'email',
    name: 'CS Maju Jaya',
    enabled: true,
    displayPhoneNumber: null,
    emailAddresses: ['cs@majujaya.co.id'],
  },
];

const SENDERS = [
  {
    id: BILLING,
    kind: 'channel',
    name: 'Billing',
    address: 'billing@majujaya.co.id',
    smtpMode: 'custom',
    hourlyLimit: 150,
    sentLastHour: 128,
    queued: 42,
    state: 'throttled',
    throttledUntil: inFuture(9 * 60_000),
    blockedReason: null,
    pausedBy: null,
    pausedAt: null,
  },
  {
    id: CS,
    kind: 'channel',
    name: 'CS Maju Jaya',
    address: 'cs@majujaya.co.id',
    smtpMode: 'custom',
    hourlyLimit: 100,
    sentLastHour: 0,
    queued: 6,
    state: 'blocked',
    throttledUntil: null,
    blockedReason: 'smtp_auth_failed',
    pausedBy: null,
    pausedAt: null,
  },
  {
    id: 'chn_6b1f2c3d-0000-4000-8000-000000000003',
    kind: 'channel',
    name: 'Notifikasi',
    address: 'notifikasi@majujaya.co.id',
    smtpMode: 'system',
    hourlyLimit: 100,
    sentLastHour: 17,
    queued: 0,
    state: 'ok',
    throttledUntil: null,
    blockedReason: null,
    pausedBy: null,
    pausedAt: null,
  },
];

const senderRef = (id: string) => {
  const found = SENDERS.find((sender) => sender.id === id);
  return { id, kind: 'channel', name: found?.name ?? '', address: found?.address ?? '' };
};

const API_KEYS = [
  {
    id: '7b8c9d0e-0000-4000-8000-000000000011',
    name: 'Aplikasi billing',
    displayPrefix: 'blsn_live_9c1e7a20b4d35f86_',
    scopes: ['email:send', 'messages:initiate'],
    allowedIps: ['203.0.113.10'],
    dailySendLimit: 2000,
    expiresAt: inFuture(300 * 24 * HOUR),
    revokedAt: null,
    lastUsedAt: ago(40 * 60_000),
    createdBy: RINA,
    createdAt: ago(20 * 24 * HOUR),
    status: 'active',
    emailSenders: [senderRef(BILLING)],
    emailAttachmentHosts: ['billing.btd.co.id', '*.majujaya.co.id'],
  },
  {
    id: '7b8c9d0e-0000-4000-8000-000000000012',
    name: 'Pemantau status (n8n)',
    displayPrefix: 'blsn_live_5d2a9e14c07b3f61_',
    scopes: ['email:read'],
    allowedIps: null,
    dailySendLimit: 500,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: ago(3 * 60_000),
    createdBy: RINA,
    createdAt: ago(6 * 24 * HOUR),
    status: 'active',
    emailSenders: [senderRef(BILLING), senderRef(CS)],
    emailAttachmentHosts: [],
  },
  {
    id: '7b8c9d0e-0000-4000-8000-000000000013',
    name: 'n8n produksi',
    displayPrefix: 'blsn_live_3f9a1c2b7d4e8f60_',
    scopes: ['messages:send', 'contacts:write'],
    allowedIps: null,
    dailySendLimit: 1000,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: ago(12 * 60_000),
    createdBy: RINA,
    createdAt: ago(40 * 24 * HOUR),
    status: 'active',
    emailSenders: [],
    emailAttachmentHosts: [],
  },
];

const outbound = (
  n: number,
  init: Partial<{
    status: string;
    source: string;
    recipients: string[];
    recipientCount: number;
    subject: string;
    template: { id: string; slug: string; version: number | null } | null;
    metadata: Record<string, string> | null;
    sentAt: string | null;
    failure: { reason: string; message: string; smtpCode: number | null } | null;
    sender: string;
    apiKey: { id: string; name: string } | null;
  }>,
) => ({
  id: `9d2f0000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  status: 'sent',
  source: 'api',
  apiKey: { id: API_KEYS[0]!.id, name: API_KEYS[0]!.name },
  sender: { id: BILLING, kind: 'channel', address: 'billing@majujaya.co.id' },
  recipients: ['bu***@su***.id'],
  recipientCount: 1,
  subject: 'Tagihan November 2026 — PLG-00873',
  template: { id: TEMPLATE_ID, slug: 'tagihan-bulanan', version: 3 },
  metadata: { invoice_id: 'INV-2611-0873' },
  createdAt: ago(n * 7 * 60_000),
  sentAt: ago(n * 7 * 60_000 - 20_000),
  failure: null,
  ...init,
  ...(init.sender
    ? { sender: { id: init.sender, kind: 'channel', address: senderRef(init.sender).address } }
    : {}),
});

const OUTBOUND = [
  outbound(1, {}),
  outbound(2, {
    status: 'queued',
    sentAt: null,
    recipients: ['sa***@gm***.com'],
    subject: 'Tagihan November 2026 — PLG-00412',
    metadata: { invoice_id: 'INV-2611-0412' },
  }),
  outbound(3, {
    status: 'bounced',
    recipients: ['an***@ya***.co.id', 'ke***@ya***.co.id'],
    recipientCount: 3,
    subject: 'Pengingat: tagihan PLG-00090 jatuh tempo 25 Nov 2026',
    template: {
      id: '1e7d0000-0000-4000-8000-000000000002',
      slug: 'pengingat-jatuh-tempo',
      version: 1,
    },
    metadata: { invoice_id: 'INV-2611-0090' },
  }),
  outbound(4, {
    status: 'failed',
    sentAt: null,
    sender: CS,
    recipients: ['de***@ou***.com'],
    subject: 'Pembayaran November 2026 sudah kami terima',
    template: {
      id: '1e7d0000-0000-4000-8000-000000000003',
      slug: 'pembayaran-diterima',
      version: 2,
    },
    metadata: { invoice_id: 'INV-2611-0733', channel: 'transfer' },
    failure: {
      reason: 'recipient_rejected',
      message: 'Server email menolak semua alamat penerima.',
      smtpCode: 550,
    },
  }),
  outbound(5, {
    source: 'test',
    apiKey: null,
    recipients: ['ri***@ma***.co.id'],
    subject: '[Tes] Tagihan November 2026 — PLG-00873',
    metadata: null,
  }),
];

async function emailApiMocks(
  page: Page,
  options: { templates?: unknown[]; archived?: unknown[] } = {},
): Promise<void> {
  await page.route(/\/api\/v1\/settings\/email-templates(\?|$)/, (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const archived = new URL(route.request().url()).searchParams.get('archived') === 'true';
    return json(route, {
      templates: archived ? (options.archived ?? ARCHIVED) : (options.templates ?? SUMMARIES),
    });
  });
  await page.route(`${API}/settings/email-templates/presets`, (route) =>
    json(route, {
      presets: EMAIL_TEMPLATE_PRESETS.map((item) => ({
        key: item.key,
        name: item.name,
        description: item.description,
        subject: item.subject,
        layout: item.layout,
        variables: item.variables,
      })),
    }),
  );
  await page.route(`${API}/settings/email-templates/${TEMPLATE_ID}`, (route) =>
    json(route, { template: TEMPLATE }),
  );
  await page.route(`${API}/settings/email-templates/${TEMPLATE_ID}/versions`, (route) =>
    json(route, { versions: VERSIONS }),
  );
  await page.route(`${API}/channels`, (route) => json(route, { channels: CHANNELS }));
  await page.route(`${API}/settings/email-senders`, (route) => json(route, { senders: SENDERS }));
  await page.route(`${API}/settings/api-keys`, (route) => json(route, { apiKeys: API_KEYS }));
  await page.route(`${API}/settings/api`, (route) =>
    json(route, { settings: { docsEnabled: true } }),
  );
  await page.route(/\/api\/v1\/settings\/email-outbound(\?|$)/, (route) =>
    json(route, { emails: OUTBOUND, nextCursor: 'kursor-berikutnya' }),
  );
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
}

/** Buka tab editor (Radix Tabs aktif saat mousedown). */
async function openTab(page: Page, name: string): Promise<void> {
  await page.getByRole('tab', { name }).click();
  // Foto tanpa cincin fokus sisa klik tab.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

function screen(
  name: string,
  path: string,
  waitFor: string,
  options: Parameters<typeof emailApiMocks>[1] & {
    prepare?: Screen['prepare'];
    tall?: boolean;
    limits?: boolean;
  } = {},
): Screen {
  return {
    name,
    path,
    tall: options.tall ?? true,
    before: async (page) => {
      await quietSecurity(page);
      if (options.limits) await inboxMocks(page, { sentLast24Hours: 4212 });
      await emailApiMocks(page, options);
    },
    waitFor,
    prepare: async (page) => {
      if (options.prepare) await options.prepare(page);
      await settle(page);
    },
  };
}

const EDITOR = `/pengaturan/template-email/${TEMPLATE_ID}`;

export const emailApiScreens: Screen[] = [
  screen('template-email-daftar', '/pengaturan/template-email', 'text=Pengingat jatuh tempo'),
  screen('template-email-kosong', '/pengaturan/template-email', 'text=Belum ada template email', {
    templates: [],
    archived: [],
  }),
  screen('template-email-preset', '/pengaturan/template-email', 'text=Pengingat jatuh tempo', {
    tall: false,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Pakai preset' }).click();
      await page
        .getByRole('dialog', { name: 'Pilih preset template email' })
        .getByText('Layanan aktif kembali')
        .waitFor();
    },
  }),
  screen('template-email-editor', EDITOR, 'text=Slug untuk API'),
  // Tab Isi digulir ke tengah (kartu variabel): Simpan draf/Terbitkan tetap terlihat (menempel).
  screen('template-email-editor-gulir', EDITOR, 'text=Slug untuk API', {
    tall: false,
    prepare: async (page) => {
      await page.getByText('{{periode}}', { exact: true }).first().scrollIntoViewIfNeeded();
    },
  }),
  screen('template-email-pratinjau', EDITOR, 'text=Slug untuk API', {
    prepare: async (page) => {
      await openTab(page, 'Pratinjau');
      await page.locator('iframe[title^="Pratinjau email"]').waitFor();
      await page.waitForTimeout(400);
    },
  }),
  screen('template-email-pratinjau-hp-gelap', EDITOR, 'text=Slug untuk API', {
    prepare: async (page) => {
      await openTab(page, 'Pratinjau');
      await page.getByRole('radio', { name: 'HP' }).click();
      await page.getByRole('radio', { name: 'Gelap' }).click();
      await page.locator('iframe[title^="Pratinjau email"]').waitFor();
      await page.waitForTimeout(400);
    },
  }),
  screen('template-email-riwayat', EDITOR, 'text=Slug untuk API', {
    prepare: async (page) => {
      await openTab(page, 'Riwayat versi');
      await page.getByText('Versi lama').first().waitFor();
    },
  }),
  screen('template-email-terbit', EDITOR, 'text=Slug untuk API', {
    tall: false,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Terbitkan' }).click();
      await page.getByRole('dialog', { name: 'Terbitkan Tagihan bulanan?' }).waitFor();
    },
  }),
  screen('apikey-email', '/pengaturan/api-key', 'text=Aplikasi billing'),
  screen('apikey-email-buat', '/pengaturan/api-key', 'text=Aplikasi billing', {
    tall: false,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Buat API key' }).click();
      const dialog = page.getByRole('dialog', { name: 'Buat API key' });
      await dialog.getByLabel('Nama', { exact: true }).fill('Billing n8n');
      await dialog.getByRole('checkbox', { name: /Kirim pesan di percakapan/ }).uncheck();
      await dialog.getByRole('checkbox', { name: /Kirim, jadwalkan, batalkan/ }).check();
      await dialog.getByRole('checkbox', { name: /^Billing/ }).check();
      await dialog.getByLabel(/Host URL lampiran/).fill('billing.btd.co.id\n*.majujaya.co.id');
      await dialog.getByText('Pengirim email yang boleh dipakai').scrollIntoViewIfNeeded();
    },
  }),
  screen('apikey-email-ubah', '/pengaturan/api-key', 'text=Aplikasi billing', {
    tall: false,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Ubah akses email Aplikasi billing' }).click();
      await page.getByRole('dialog', { name: 'Akses email Aplikasi billing' }).waitFor();
    },
  }),
  screen(
    'email-api-riwayat',
    '/pengaturan/api-key/email-terkirim',
    'text=Tagihan November 2026 — PLG-00412',
  ),
  screen('batas-kirim-email', '/pengaturan/batas-kirim', 'text=Email per pengirim', {
    limits: true,
    prepare: async (page) => {
      await page.getByText('Email per pengirim').scrollIntoViewIfNeeded();
    },
  }),
];
