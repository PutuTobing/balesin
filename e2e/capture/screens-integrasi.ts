import type { Page } from '@playwright/test';
import { apiError, json } from './mocks';
import { quietSecurity } from './mocks-tim';
import type { Screen } from './screens';

/**
 * Fase 3: Pengaturan → API key dan Pengaturan → Webhook (data tiruan, bentuk = skema bersama).
 * Rahasia contoh di foto bukan kunci sungguhan.
 */
const API = '**/api/v1';
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();
const RINA = { id: 'a1a2b3c4-0000-4000-8000-0000000000c1', name: 'Rina Kartika' };

const API_KEYS = [
  {
    id: '7b8c9d0e-0000-4000-8000-000000000001',
    name: 'n8n produksi',
    displayPrefix: 'blsn_live_3f9a1c2b7d4e8f60_',
    scopes: ['messages:send', 'contacts:write'],
    allowedIps: ['203.0.113.10'],
    dailySendLimit: 1000,
    expiresAt: inFuture(300 * 24 * HOUR),
    revokedAt: null,
    lastUsedAt: ago(12 * 60_000),
    createdBy: RINA,
    createdAt: ago(40 * 24 * HOUR),
    status: 'active',
  },
  {
    id: '7b8c9d0e-0000-4000-8000-000000000002',
    name: 'Laporan harian (baca saja)',
    displayPrefix: 'blsn_live_a17c0e9d33b2f514_',
    scopes: ['conversations:read', 'contacts:read'],
    allowedIps: null,
    dailySendLimit: 500,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdBy: RINA,
    createdAt: ago(3 * 24 * HOUR),
    status: 'active',
  },
  {
    id: '7b8c9d0e-0000-4000-8000-000000000003',
    name: 'Bot lama',
    displayPrefix: 'blsn_live_0d4b8e21c6f7a933_',
    scopes: ['messages:send'],
    allowedIps: null,
    dailySendLimit: 500,
    expiresAt: null,
    revokedAt: ago(5 * 24 * HOUR),
    lastUsedAt: ago(6 * 24 * HOUR),
    createdBy: RINA,
    createdAt: ago(90 * 24 * HOUR),
    status: 'revoked',
  },
];

const WEBHOOKS = [
  {
    id: '8c9d0e1f-0000-4000-8000-000000000001',
    url: 'https://n8n.majujaya.co.id/webhook/balesin-inbox',
    description: 'Bot tagihan & lapor gangguan',
    events: ['message.received', 'conversation.resolved', 'contact.updated'],
    enabled: true,
    disabledReason: null,
    consecutiveFailures: 0,
    lastDeliveryAt: ago(3 * 60_000),
    secretRotatedAt: ago(2 * HOUR),
    previousSecretExpiresAt: inFuture(22 * HOUR),
    createdAt: ago(30 * 24 * HOUR),
  },
  {
    id: '8c9d0e1f-0000-4000-8000-000000000002',
    url: 'https://crm.contoh.test/hooks/whatsapp?token=rahasia-penerima',
    description: null,
    events: ['conversation.created', 'conversation.assigned'],
    enabled: false,
    disabledReason: 'auto_failures',
    consecutiveFailures: 20,
    lastDeliveryAt: ago(26 * HOUR),
    secretRotatedAt: ago(20 * 24 * HOUR),
    previousSecretExpiresAt: null,
    createdAt: ago(20 * 24 * HOUR),
  },
];

const DELIVERIES = [
  {
    id: '9d0e1f2a-0000-4000-8000-000000000001',
    event: 'message.received',
    status: 'succeeded',
    attempts: 1,
    httpStatus: 200,
    durationMs: 184,
    error: null,
    responseSnippet: '{"ok":true}',
    payloadPurged: false,
    createdAt: ago(3 * 60_000),
    deliveredAt: ago(3 * 60_000),
    nextAttemptAt: null,
  },
  {
    id: '9d0e1f2a-0000-4000-8000-000000000002',
    event: 'conversation.resolved',
    status: 'pending',
    attempts: 2,
    httpStatus: 503,
    durationMs: 10_000,
    error: 'timeout',
    responseSnippet: null,
    payloadPurged: false,
    createdAt: ago(20 * 60_000),
    deliveredAt: null,
    nextAttemptAt: inFuture(8 * 60_000),
  },
  {
    id: '9d0e1f2a-0000-4000-8000-000000000003',
    event: 'webhook.test',
    status: 'failed',
    attempts: 1,
    httpStatus: 404,
    durationMs: 92,
    error: 'http_404',
    responseSnippet: 'Cannot POST /webhook/balesin-inbox',
    payloadPurged: true,
    createdAt: ago(8 * 24 * HOUR),
    deliveredAt: ago(8 * 24 * HOUR),
    nextAttemptAt: null,
  },
];

async function integrationMocks(
  page: Page,
  options: { apiKeys?: unknown[] | 'hang' | 'fail'; webhooks?: unknown[] } = {},
): Promise<void> {
  await page.route(`${API}/settings/api-keys`, (route) => {
    if (route.request().method() === 'POST') {
      return json(
        route,
        {
          apiKey: { ...API_KEYS[0], id: '7b8c9d0e-0000-4000-8000-000000000009', name: 'Bot WA' },
          secret: 'blsn_live_5e2d9a7c1b0f4e38_Q2hhbmdlTWVJc05vdEFSZWFsS2V5Rm9yUGhvdG9zMTI',
        },
        201,
      );
    }
    if (options.apiKeys === 'hang') return undefined;
    if (options.apiKeys === 'fail') {
      return apiError(route, 503, 'UNAVAILABLE', 'Server sedang sibuk. Coba lagi sebentar lagi.');
    }
    return json(route, { apiKeys: options.apiKeys ?? API_KEYS });
  });
  await page.route(`${API}/settings/api`, (route) =>
    json(route, { settings: { docsEnabled: true } }),
  );
  await page.route(`${API}/settings/webhooks`, (route) => {
    if (route.request().method() === 'POST') {
      return json(
        route,
        { webhook: WEBHOOKS[0], secret: 'whsec_Q29udG9oUmFoYXNpYVVudHVrRm90b0JhbGVzaW4' },
        201,
      );
    }
    return json(route, { webhooks: options.webhooks ?? WEBHOOKS });
  });
  await page.route(/\/api\/v1\/settings\/webhooks\/[0-9a-f-]{36}\/deliveries(\?|$)/, (route) =>
    json(route, { deliveries: DELIVERIES, nextCursor: null }),
  );
  await page.route(`${API}/settings/webhooks-private-network`, (route) =>
    json(route, { settings: { cidrs: ['192.168.10.0/24'] } }),
  );
}

function screen(
  name: string,
  path: string,
  waitFor: string,
  options: Parameters<typeof integrationMocks>[1] & {
    prepare?: Screen['prepare'];
    waitUntil?: Screen['waitUntil'];
  } = {},
): Screen {
  return {
    name,
    path,
    waitUntil: options.waitUntil,
    before: async (page) => {
      await quietSecurity(page);
      await integrationMocks(page, options);
    },
    waitFor,
    prepare: options.prepare,
  };
}

async function settle(page: Page): Promise<void> {
  await page.mouse.move(1, 1);
}

export const integrationScreens: Screen[] = [
  screen('api-key', '/pengaturan/api-key', 'text=n8n produksi'),
  screen('api-key-kosong', '/pengaturan/api-key', 'text=Belum ada API key', { apiKeys: [] }),
  screen('api-key-memuat', '/pengaturan/api-key', '[aria-busy="true"]', {
    apiKeys: 'hang',
    waitUntil: 'domcontentloaded',
  }),
  screen('api-key-gagal', '/pengaturan/api-key', 'text=API key belum bisa dimuat', {
    apiKeys: 'fail',
  }),
  screen('api-key-buat', '/pengaturan/api-key', 'text=n8n produksi', {
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Buat API key' }).click();
      await page.getByRole('dialog', { name: 'Buat API key' }).waitFor();
      await page.getByLabel('Nama', { exact: true }).fill('Bot WA');
      await page.getByRole('checkbox', { name: /Baca & cari kontak/ }).check();
      await settle(page);
    },
  }),
  screen('api-key-rahasia', '/pengaturan/api-key', 'text=n8n produksi', {
    prepare: async (page) => {
      // Dialog rahasia tanpa konfirmasi identitas sungguhan: jawaban POST tiruan langsung dipakai.
      await page.getByRole('button', { name: 'Buat API key' }).click();
      await page.getByLabel('Nama', { exact: true }).fill('Bot WA');
      await page.getByRole('button', { name: 'Buat key' }).click();
      const identity = page.getByRole('dialog', { name: 'Buat API key baru?' });
      await identity.getByLabel('Password', { exact: true }).fill('Kopi-Senja-Tenang-42');
      await identity.getByLabel('Kode verifikasi').fill('123456');
      await identity.getByRole('button', { name: 'Buat key', exact: true }).click();
      await page.getByRole('dialog', { name: 'Salin API key sekarang' }).waitFor();
      await settle(page);
    },
  }),
  screen('api-key-cabut', '/pengaturan/api-key', 'text=n8n produksi', {
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Cabut n8n produksi' }).click();
      await page.getByRole('dialog', { name: 'Cabut API key n8n produksi?' }).waitFor();
      await settle(page);
    },
  }),
  screen('webhook', '/pengaturan/webhook', 'text=Bot tagihan & lapor gangguan'),
  screen('webhook-kosong', '/pengaturan/webhook', 'text=Belum ada webhook', { webhooks: [] }),
  screen('webhook-tambah', '/pengaturan/webhook', 'text=Bot tagihan & lapor gangguan', {
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Tambah webhook' }).click();
      await page.getByRole('dialog', { name: 'Tambah webhook' }).waitFor();
      await settle(page);
    },
  }),
  screen('webhook-riwayat', '/pengaturan/webhook', 'text=Bot tagihan & lapor gangguan', {
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Riwayat' }).first().click();
      await page
        .getByRole('dialog', { name: 'Riwayat pengiriman' })
        .getByText('HTTP 200')
        .waitFor();
      await settle(page);
    },
  }),
  screen('webhook-menu', '/pengaturan/webhook', 'text=Bot tagihan & lapor gangguan', {
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Tindakan lain' }).first().click();
      await page.getByRole('menu').waitFor();
    },
  }),
  screen('webhook-jaringan-privat', '/pengaturan/webhook', 'text=Bot tagihan & lapor gangguan', {
    prepare: async (page) => {
      await page.getByLabel('CIDR jaringan privat').scrollIntoViewIfNeeded();
      await settle(page);
    },
  }),
];
