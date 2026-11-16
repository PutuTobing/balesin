import {
  API_ROUTES,
  apiPath,
  type ApiKey,
  type OutgoingWebhook,
  type WebhookDelivery,
} from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { apiError, fakeSession, json, type FakeHandler } from '../../test/fake-api';
import { TEST_CODE, TEST_PASSWORD, confirmIdentity } from '../../test/identity';
import { renderApp } from '../../test/render-app';
import { expiryFrom, impliedScopes } from './api-key-form';

const k = t.apiKeys;
const w = t.webhooks;
const SECRET = `blsn_live_0123456789abcdef_${'S'.repeat(43)}`;
const WEBHOOK_SECRET = `whsec_${'W'.repeat(32)}`;

const apiKey: ApiKey = {
  id: '6f1c2a90-4444-4c4c-9a9a-000000000001',
  name: 'n8n produksi',
  displayPrefix: 'blsn_live_0123456789abcdef_',
  scopes: ['messages:send'],
  allowedIps: ['203.0.113.10'],
  dailySendLimit: 500,
  expiresAt: '2027-11-17T03:00:00.000Z',
  revokedAt: null,
  lastUsedAt: '2026-11-17T02:00:00.000Z',
  createdBy: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
  createdAt: '2026-11-10T03:00:00.000Z',
  status: 'active',
};

const webhook: OutgoingWebhook = {
  id: '6f1c2a90-5555-4c4c-9a9a-000000000001',
  url: 'https://n8n.contoh.test/webhook/inbox',
  description: 'Bot tagihan',
  events: ['message.received', 'conversation.resolved'],
  enabled: true,
  disabledReason: null,
  consecutiveFailures: 0,
  lastDeliveryAt: '2026-11-17T02:00:00.000Z',
  secretRotatedAt: '2026-11-10T03:00:00.000Z',
  previousSecretExpiresAt: null,
  createdAt: '2026-11-10T03:00:00.000Z',
};

const delivery: WebhookDelivery = {
  id: '6f1c2a90-6666-4c4c-9a9a-000000000001',
  event: 'message.received',
  status: 'failed',
  attempts: 6,
  httpStatus: 500,
  durationMs: 812,
  error: 'http_500',
  responseSnippet: '<script>alert(1)</script> Internal error',
  payloadPurged: false,
  createdAt: '2026-11-17T01:00:00.000Z',
  deliveredAt: null,
  nextAttemptAt: null,
};

function apiKeyRoutes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    [`GET ${API_ROUTES.apiKeys.list}`]: () => json({ apiKeys: [apiKey] }),
    [`POST ${API_ROUTES.apiKeys.list}`]: ({ body }) =>
      json(
        {
          apiKey: { ...apiKey, id: '6f1c2a90-4444-4c4c-9a9a-000000000002', ...(body as object) },
          secret: SECRET,
        },
        { status: 201 },
      ),
    [`POST ${apiPath(API_ROUTES.apiKeys.revoke, { apiKeyId: apiKey.id })}`]: () =>
      json({ apiKey: { ...apiKey, status: 'revoked', revokedAt: '2026-11-17T04:00:00.000Z' } }),
    [`GET ${API_ROUTES.apiKeys.settings}`]: () => json({ settings: { docsEnabled: true } }),
    [`PUT ${API_ROUTES.apiKeys.settings}`]: ({ body }) => json({ settings: body }),
    ...extra,
  };
}

function webhookRoutes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  const id = webhook.id;
  return {
    [`GET ${API_ROUTES.outgoingWebhooks.list}`]: () => json({ webhooks: [webhook] }),
    [`POST ${API_ROUTES.outgoingWebhooks.list}`]: ({ body }) =>
      json(
        { webhook: { ...webhook, ...(body as object) }, secret: WEBHOOK_SECRET },
        { status: 201 },
      ),
    [`PATCH ${apiPath(API_ROUTES.outgoingWebhooks.webhook, { webhookId: id })}`]: ({ body }) =>
      json({ webhook: { ...webhook, ...(body as object) } }),
    [`DELETE ${apiPath(API_ROUTES.outgoingWebhooks.webhook, { webhookId: id })}`]: () =>
      json({ deleted: true }),
    [`POST ${apiPath(API_ROUTES.outgoingWebhooks.rotateSecret, { webhookId: id })}`]: () =>
      json({ webhook, secret: WEBHOOK_SECRET }),
    [`POST ${apiPath(API_ROUTES.outgoingWebhooks.test, { webhookId: id })}`]: () =>
      json(
        { delivery: { ...delivery, status: 'pending', event: 'webhook.test' } },
        { status: 201 },
      ),
    [`GET ${apiPath(API_ROUTES.outgoingWebhooks.deliveries, { webhookId: id })}`]: () =>
      json({ deliveries: [delivery], nextCursor: null }),
    [`POST ${apiPath(API_ROUTES.outgoingWebhooks.redeliver, { webhookId: id, deliveryId: delivery.id })}`]:
      () => json({ delivery: { ...delivery, status: 'pending' } }, { status: 201 }),
    [`GET ${API_ROUTES.outgoingWebhooks.privateNetwork}`]: () => json({ settings: { cidrs: [] } }),
    [`PUT ${API_ROUTES.outgoingWebhooks.privateNetwork}`]: ({ body }) =>
      json({ settings: { cidrs: (body as { cidrs: string[] }).cidrs } }),
    ...extra,
  };
}

const requestsTo = (
  api: Awaited<ReturnType<typeof renderApp>>['api'],
  method: string,
  path: string,
) => api.requests.filter((request) => request.method === method && request.path === path);

describe('isian API key', () => {
  it('izin tingkat atas mencakup izin baca; masa berlaku tanggal dibatasi', () => {
    expect([...impliedScopes(new Set(['messages:send']))].sort()).toEqual([
      'conversations:read',
      'messages:read',
    ]);
    const now = Date.parse('2026-11-17T03:00:00.000Z');
    expect(expiryFrom('never', '', now)).toBeNull();
    expect(expiryFrom('d30', '', now)).toBe('2026-12-17T03:00:00.000Z');
    expect(expiryFrom('custom', '2026-11-16', now)).toBeUndefined();
    expect(expiryFrom('custom', '2030-01-01', now)).toBeUndefined();
    expect(expiryFrom('custom', '2027-01-31', now)).toMatch(/^2027-01-31|^2027-02-01/);
  });
});

describe('Pengaturan → API key', () => {
  it('daftar + peringatan cakupan; buat dengan konfirmasi → kunci tampil sekali', async () => {
    const { api } = await renderApp('/pengaturan/api-key', { routes: apiKeyRoutes() });
    expect(await screen.findByText('n8n produksi')).toBeVisible();
    expect(screen.getByText(k.scopeWarningTitle)).toBeVisible();
    expect(screen.queryByText(SECRET)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: k.create }));
    const dialog = within(await screen.findByRole('dialog', { name: k.formTitle }));
    fireEvent.click(dialog.getByRole('button', { name: k.next }));
    expect(await dialog.findByText('Nama API key wajib diisi.')).toBeVisible();

    fireEvent.change(dialog.getByLabelText(k.nameLabel), { target: { value: 'Bot WA' } });
    // messages:send (bawaan) → baca pesan & percakapan tercentang + terkunci.
    expect(dialog.getByRole('checkbox', { name: /Baca pesan/ })).toBeDisabled();
    fireEvent.click(dialog.getByRole('checkbox', { name: /Baca & cari kontak/ }));
    fireEvent.change(dialog.getByLabelText(k.ipsLabel), {
      target: { value: '203.0.113.10\n10.0.0.0/8' },
    });
    fireEvent.click(dialog.getByRole('button', { name: k.next }));
    await confirmIdentity(k.confirmTitle, k.next);

    const secret = within(await screen.findByRole('dialog', { name: k.secretTitle }));
    expect(secret.getByText(SECRET)).toBeVisible();
    const body = requestsTo(api, 'POST', API_ROUTES.apiKeys.list)[0]?.body as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      name: 'Bot WA',
      scopes: ['messages:send', 'contacts:read'],
      allowedIps: ['203.0.113.10', '10.0.0.0/8'],
      dailySendLimit: 500,
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
    fireEvent.click(secret.getByRole('button', { name: k.done }));
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull());
  });

  it('cabut tanpa konfirmasi identitas, dengan dialog jelas', async () => {
    const { api } = await renderApp('/pengaturan/api-key', { routes: apiKeyRoutes() });
    fireEvent.click(await screen.findByRole('button', { name: k.revoke('n8n produksi') }));
    const dialog = within(
      await screen.findByRole('dialog', { name: k.revokeTitle('n8n produksi') }),
    );
    fireEvent.click(dialog.getByRole('button', { name: k.revokeConfirm }));
    expect(await screen.findByText(k.revoked('n8n produksi'))).toBeVisible();
    expect(
      requestsTo(api, 'POST', apiPath(API_ROUTES.apiKeys.revoke, { apiKeyId: apiKey.id })),
    ).toHaveLength(1);
  });

  it('saklar dokumentasi + tautan /api/docs', async () => {
    const { api } = await renderApp('/pengaturan/api-key', { routes: apiKeyRoutes() });
    expect(await screen.findByRole('link', { name: k.docsOpen })).toHaveAttribute(
      'href',
      '/api/docs',
    );
    fireEvent.click(screen.getByRole('checkbox', { name: k.docsEnabled }));
    expect(await screen.findByText(k.docsSaved)).toBeVisible();
    expect(requestsTo(api, 'PUT', API_ROUTES.apiKeys.settings)[0]?.body).toEqual({
      docsEnabled: false,
    });
  });

  it('Supervisor dialihkan; tanpa permintaan API key', async () => {
    const { router, api } = await renderApp('/pengaturan/api-key', {
      routes: apiKeyRoutes(),
      session: fakeSession('supervisor'),
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/pengaturan'));
    expect(requestsTo(api, 'GET', API_ROUTES.apiKeys.list)).toHaveLength(0);
  });
});

describe('Pengaturan → Webhook', () => {
  it('tambah: kejadian, konfirmasi identitas → rahasia sekali', async () => {
    const { api } = await renderApp('/pengaturan/webhook', { routes: webhookRoutes() });
    expect(await screen.findByText(webhook.url)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: w.create }));
    const dialog = within(await screen.findByRole('dialog', { name: w.formTitleCreate }));
    fireEvent.change(dialog.getByLabelText(w.urlLabel), {
      target: { value: 'https://crm.contoh.test/hook' },
    });
    fireEvent.click(dialog.getByRole('checkbox', { name: /Percakapan selesai/ }));
    fireEvent.click(dialog.getByRole('button', { name: w.save }));
    await confirmIdentity(w.confirmCreateTitle, w.save);
    const secret = within(await screen.findByRole('dialog', { name: w.secretTitle }));
    expect(secret.getByText(WEBHOOK_SECRET)).toBeVisible();
    expect(requestsTo(api, 'POST', API_ROUTES.outgoingWebhooks.list)[0]?.body).toMatchObject({
      url: 'https://crm.contoh.test/hook',
      events: ['message.received', 'conversation.resolved'],
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
  });

  it('ubah keterangan tanpa konfirmasi; ganti URL wajib konfirmasi', async () => {
    const path = apiPath(API_ROUTES.outgoingWebhooks.webhook, { webhookId: webhook.id });
    const { api } = await renderApp('/pengaturan/webhook', { routes: webhookRoutes() });
    fireEvent.click(await screen.findByRole('button', { name: w.edit }));
    let dialog = within(await screen.findByRole('dialog', { name: w.formTitleEdit }));
    fireEvent.change(dialog.getByLabelText(w.descriptionLabel), { target: { value: 'CRM' } });
    fireEvent.click(dialog.getByRole('button', { name: w.save }));
    expect(await screen.findByText(w.saved)).toBeVisible();
    expect(requestsTo(api, 'PATCH', path)[0]?.body).toEqual({
      events: webhook.events,
      description: 'CRM',
    });

    fireEvent.click(screen.getByRole('button', { name: w.edit }));
    dialog = within(await screen.findByRole('dialog', { name: w.formTitleEdit }));
    fireEvent.change(dialog.getByLabelText(w.urlLabel), {
      target: { value: 'https://baru.contoh.test/hook' },
    });
    fireEvent.click(dialog.getByRole('button', { name: w.save }));
    await confirmIdentity(w.confirmUrlTitle, w.save);
    await waitFor(() => expect(requestsTo(api, 'PATCH', path)).toHaveLength(2));
    expect(requestsTo(api, 'PATCH', path)[1]?.body).toMatchObject({
      url: 'https://baru.contoh.test/hook',
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
  });

  it('event tes, riwayat (potongan jawaban sebagai teks) + kirim ulang', async () => {
    const { api } = await renderApp('/pengaturan/webhook', { routes: webhookRoutes() });
    fireEvent.click(await screen.findByRole('button', { name: w.test }));
    expect(await screen.findByText(w.testSent)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: w.history }));
    const dialog = within(await screen.findByRole('dialog', { name: w.historyTitle }));
    expect(await dialog.findByText(/HTTP 500/)).toBeVisible();
    // Jawaban penerima = teks (tidak dirender sebagai HTML).
    expect(dialog.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(document.querySelector('script:not([src])')).toBeNull();
    fireEvent.click(dialog.getByRole('button', { name: w.redeliver }));
    expect(await dialog.findByText(w.redelivered)).toBeVisible();
    expect(
      requestsTo(
        api,
        'POST',
        apiPath(API_ROUTES.outgoingWebhooks.redeliver, {
          webhookId: webhook.id,
          deliveryId: delivery.id,
        }),
      ),
    ).toHaveLength(1);
  });

  it('dinonaktifkan otomatis: alasan jelas; aktifkan lagi lewat menu', async () => {
    const auto = {
      ...webhook,
      enabled: false,
      disabledReason: 'auto_failures' as const,
      consecutiveFailures: 20,
    };
    const { api } = await renderApp('/pengaturan/webhook', {
      routes: webhookRoutes({
        [`GET ${API_ROUTES.outgoingWebhooks.list}`]: () => json({ webhooks: [auto] }),
      }),
    });
    expect(await screen.findByText(w.autoDisabled(20))).toBeVisible();
    expect(screen.getByRole('button', { name: w.test })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('button', { name: w.actions }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: w.enable }));
    await waitFor(() =>
      expect(
        requestsTo(
          api,
          'PATCH',
          apiPath(API_ROUTES.outgoingWebhooks.webhook, { webhookId: webhook.id }),
        )[0]?.body,
      ).toEqual({ enabled: true }),
    );
  });

  it('jaringan privat: simpan dengan konfirmasi; galat server tampil di isian', async () => {
    const { api } = await renderApp('/pengaturan/webhook', {
      routes: webhookRoutes({
        [`PUT ${API_ROUTES.outgoingWebhooks.privateNetwork}`]: () =>
          apiError(400, 'VALIDATION_ERROR', 'Data tidak valid.', {
            details: [{ field: 'cidrs.0', message: 'Bukan jaringan privat: 8.8.8.0/24.' }],
          }),
      }),
    });
    fireEvent.change(await screen.findByLabelText(w.privateLabel), {
      target: { value: '8.8.8.0/24' },
    });
    fireEvent.click(screen.getByRole('button', { name: w.privateSave }));
    await confirmIdentity(w.privateConfirmTitle, w.privateSave);
    expect(await screen.findByText('Bukan jaringan privat: 8.8.8.0/24.')).toBeVisible();
    expect(
      requestsTo(api, 'PUT', API_ROUTES.outgoingWebhooks.privateNetwork)[0]?.body,
    ).toMatchObject({ cidrs: ['8.8.8.0/24'] });
    act(() => undefined);
  });
});
