/**
 * Tes penjaga review keamanan web — Pengaturan → API key & Webhook
 * (docs/security-reviews/2026-11-19-fase3-integrasi-web.md). Semua `it` = regresi.
 */
import {
  API_ROUTES,
  apiPath,
  type ApiKey,
  type OutgoingWebhook,
  type WebhookDelivery,
} from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import { fakeSession, json, type FakeHandler } from '../../test/fake-api';
import { confirmIdentity } from '../../test/identity';
import { renderApp } from '../../test/render-app';

const k = t.apiKeys;
const w = t.webhooks;
const SECRET = `blsn_live_fedcba9876543210_${'Q'.repeat(43)}`;
const WEBHOOK_SECRET = `whsec_${'Z'.repeat(32)}`;
const HTML = '"><img src=x onerror="window.__xss=1">';

const apiKey: ApiKey = {
  id: '6f1c2a90-4444-4c4c-9a9a-000000000011',
  name: `Kunci ${HTML}`,
  displayPrefix: 'blsn_live_fedcba9876543210_',
  scopes: ['messages:send'],
  allowedIps: null,
  dailySendLimit: 500,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  createdBy: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: `Admin ${HTML}` },
  createdAt: '2026-11-10T03:00:00.000Z',
  status: 'active',
};

const webhook: OutgoingWebhook = {
  id: '6f1c2a90-5555-4c4c-9a9a-000000000011',
  url: `https://n8n.contoh.test/hook?x=${HTML}`,
  description: `Ket ${HTML}`,
  events: ['message.received'],
  enabled: true,
  disabledReason: null,
  consecutiveFailures: 0,
  lastDeliveryAt: null,
  secretRotatedAt: '2026-11-10T03:00:00.000Z',
  previousSecretExpiresAt: null,
  createdAt: '2026-11-10T03:00:00.000Z',
};

const delivery: WebhookDelivery = {
  id: '6f1c2a90-6666-4c4c-9a9a-000000000011',
  event: 'message.received',
  status: 'failed',
  attempts: 1,
  httpStatus: 400,
  durationMs: 10,
  error: 'http_400',
  responseSnippet: `<html>${HTML}</html>`,
  payloadPurged: false,
  createdAt: '2026-11-17T01:00:00.000Z',
  deliveredAt: null,
  nextAttemptAt: null,
};

function routes(): Record<string, FakeHandler> {
  const id = webhook.id;
  return {
    [`GET ${API_ROUTES.apiKeys.list}`]: () => json({ apiKeys: [apiKey] }),
    [`POST ${API_ROUTES.apiKeys.list}`]: () =>
      json(
        { apiKey: { ...apiKey, id: '6f1c2a90-4444-4c4c-9a9a-000000000012' }, secret: SECRET },
        { status: 201 },
      ),
    [`GET ${API_ROUTES.apiKeys.settings}`]: () => json({ settings: { docsEnabled: true } }),
    [`GET ${API_ROUTES.outgoingWebhooks.list}`]: () => json({ webhooks: [webhook] }),
    [`POST ${apiPath(API_ROUTES.outgoingWebhooks.rotateSecret, { webhookId: id })}`]: () =>
      json({ webhook, secret: WEBHOOK_SECRET }),
    [`GET ${apiPath(API_ROUTES.outgoingWebhooks.deliveries, { webhookId: id })}`]: () =>
      json({ deliveries: [delivery], nextCursor: null }),
    [`GET ${API_ROUTES.outgoingWebhooks.privateNetwork}`]: () => json({ settings: { cidrs: [] } }),
  };
}

/** Rahasia tidak boleh ada di cache Query/mutasi, storage, atribut DOM, maupun console. */
function expectSecretNowhere(
  view: Awaited<ReturnType<typeof renderApp>>,
  secret: string,
  spies: { setItem: { mock: { calls: unknown[][] } }; logs: { mock: { calls: unknown[][] } }[] },
) {
  const queries = view.queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.state.data);
  const mutations = view.queryClient
    .getMutationCache()
    .getAll()
    .map((m) => m.state.data);
  expect(JSON.stringify([queries, mutations])).not.toContain(secret);
  for (const call of spies.setItem.mock.calls) expect(JSON.stringify(call)).not.toContain(secret);
  for (const spy of spies.logs) {
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(secret);
  }
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.value, `${element.tagName}[${attribute.name}]`).not.toContain(secret);
    }
  }
}

function spies() {
  return {
    setItem: vi.spyOn(Storage.prototype, 'setItem'),
    logs: [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ],
  };
}

function noInjection() {
  expect(document.querySelector('img[src="x"]')).toBeNull();
  expect(document.querySelector('[onerror]')).toBeNull();
  expect((window as { __xss?: number }).__xss).toBeUndefined();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('review keamanan — API key', () => {
  it('rahasia hanya di teks dialog selama terbuka; tidak di cache/storage/atribut/console; hilang setelah ditutup', async () => {
    const watch = spies();
    const view = await renderApp('/pengaturan/api-key', { routes: routes() });
    expect(await screen.findByText(apiKey.name)).toBeVisible();
    noInjection();

    fireEvent.click(screen.getByRole('button', { name: k.create }));
    const dialog = within(await screen.findByRole('dialog', { name: k.formTitle }));
    fireEvent.change(dialog.getByLabelText(k.nameLabel), { target: { value: 'Bot WA' } });
    fireEvent.click(dialog.getByRole('button', { name: k.next }));
    await confirmIdentity(k.confirmTitle, k.next);

    const secretDialog = within(await screen.findByRole('dialog', { name: k.secretTitle }));
    expect(secretDialog.getByText(SECRET)).toBeVisible();
    expectSecretNowhere(view, SECRET, watch);

    fireEvent.click(secretDialog.getByRole('button', { name: k.done }));
    await waitFor(() => expect(document.body.innerHTML).not.toContain(SECRET));
    expectSecretNowhere(view, SECRET, watch);
  });

  it('CS & Supervisor dialihkan dari API key dan Webhook tanpa memanggil API-nya', async () => {
    for (const role of ['cs', 'supervisor'] as const) {
      for (const path of ['/pengaturan/api-key', '/pengaturan/webhook']) {
        const view = await renderApp(path, { session: fakeSession(role), routes: routes() });
        await waitFor(() => expect(view.router.state.location.pathname).not.toBe(path));
        const touched = view.api.requests.filter(
          (request) =>
            request.path.startsWith(API_ROUTES.apiKeys.list) ||
            request.path.startsWith(API_ROUTES.outgoingWebhooks.list),
        );
        expect(touched, `${role} ${path}`).toEqual([]);
        view.unmount();
      }
    }
  });
});

describe('review keamanan — Webhook', () => {
  it('URL, keterangan, dan potongan jawaban riwayat tampil sebagai teks', async () => {
    await renderApp('/pengaturan/webhook', { routes: routes() });
    expect(await screen.findByText(webhook.url)).toBeInTheDocument();
    expect(screen.getByText(webhook.description!)).toBeInTheDocument();
    noInjection();
    fireEvent.click(screen.getByRole('button', { name: w.history }));
    const history = within(await screen.findByRole('dialog', { name: w.historyTitle }));
    expect(await history.findByText(delivery.responseSnippet!)).toBeInTheDocument();
    noInjection();
  });

  it('rotasi: rahasia whsec_ sekali, tidak di cache/storage/atribut/console, hilang setelah ditutup', async () => {
    const watch = spies();
    const view = await renderApp('/pengaturan/webhook', { routes: routes() });
    await screen.findByText(webhook.url);
    fireEvent.keyDown(screen.getByRole('button', { name: w.actions }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: w.rotate }));
    // Langkah pilihan (cabut rahasia lama sekarang?) sebelum konfirmasi identitas.
    const options = within(await screen.findByRole('dialog', { name: w.rotateOptionsTitle }));
    fireEvent.click(options.getByRole('button', { name: w.next }));
    await confirmIdentity(w.confirmRotateTitle, w.rotate);
    const secretDialog = within(await screen.findByRole('dialog', { name: w.secretTitle }));
    expect(secretDialog.getByText(WEBHOOK_SECRET)).toBeVisible();
    expectSecretNowhere(view, WEBHOOK_SECRET, watch);
    await act(async () => {
      fireEvent.click(secretDialog.getByRole('button', { name: w.done }));
      await Promise.resolve();
    });
    await waitFor(() => expect(document.body.innerHTML).not.toContain(WEBHOOK_SECRET));
    expectSecretNowhere(view, WEBHOOK_SECRET, watch);
  });
});
