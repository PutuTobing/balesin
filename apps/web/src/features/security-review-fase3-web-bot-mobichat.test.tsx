/**
 * Tes penjaga review keamanan web — UI bot, pesan interaktif, webhook MobiChat
 * (docs/security-reviews/2026-11-20-fase3-web-bot-mobichat.md). Semua `it` = regresi.
 */
import { API_ROUTES, type OutgoingWebhook } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/id';
import { media } from '../lib/media';
import { apiError, json, type FakeHandler } from '../test/fake-api';
import { fakeChannelSummary, fakeConversation, fakeMessage } from '../test/fake-inbox';
import { setMediaQuery } from '../test/match-media';
import { confirmIdentity } from '../test/identity';
import { renderApp } from '../test/render-app';
import { expectSecretNowhere, secretSpies } from '../test/secret-nowhere';

const w = t.webhooks;
const KEY = ['blsn', 'live', '00112233445566ff', 'K'.repeat(43)].join('_');
const HTML = '"><img src=x onerror="window.__xss=1">';

afterEach(() => {
  vi.restoreAllMocks();
});

function noInjection() {
  expect(document.querySelector('img[src="x"]')).toBeNull();
  expect(document.querySelector('[onerror]')).toBeNull();
  expect((window as { __xss?: number }).__xss).toBeUndefined();
}

const webhook: OutgoingWebhook = {
  id: '6f1c2a90-5555-4c4c-9a9a-000000000021',
  url: 'https://n8n.contoh.test/webhook/inbox',
  description: null,
  events: ['message.received'],
  enabled: true,
  disabledReason: null,
  consecutiveFailures: 0,
  lastDeliveryAt: null,
  secretRotatedAt: '2026-11-10T03:00:00.000Z',
  previousSecretExpiresAt: null,
  createdAt: '2026-11-10T03:00:00.000Z',
};

function routes(extra: Record<string, FakeHandler> = {}): Record<string, FakeHandler> {
  return {
    [`GET ${API_ROUTES.outgoingWebhooks.list}`]: () => json({ webhooks: [webhook] }),
    [`GET ${API_ROUTES.outgoingWebhooks.privateNetwork}`]: () => json({ settings: { cidrs: [] } }),
    ...extra,
  };
}

async function fillMobichatKey() {
  fireEvent.click(await screen.findByRole('button', { name: w.create }));
  const dialog = within(await screen.findByRole('dialog', { name: w.formTitleCreate }));
  fireEvent.click(dialog.getByRole('radio', { name: w.formats.mobichat }));
  fireEvent.change(dialog.getByLabelText(w.urlLabel), {
    target: { value: 'https://n8n.contoh.test/webhook/ulan' },
  });
  fireEvent.change(dialog.getByLabelText(new RegExp(`^${w.mobichatKeyLabel}`)), {
    target: { value: KEY },
  });
  fireEvent.click(dialog.getByRole('button', { name: w.save }));
  return within(await screen.findByRole('dialog', { name: w.confirmCreateTitle }));
}

describe('review keamanan — API key MobiChat di formulir webhook', () => {
  it('selama konfirmasi identitas & setelah dibatalkan: key tidak di DOM/isian/cache/storage/console', async () => {
    const watch = secretSpies();
    const view = await renderApp('/pengaturan/webhook', { routes: routes() });
    const identity = await fillMobichatKey();
    expectSecretNowhere(view, KEY, watch);
    fireEvent.click(identity.getByRole('button', { name: t.identity.cancel }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: w.confirmCreateTitle })).toBeNull(),
    );
    expectSecretNowhere(view, KEY, watch);
    expect(
      view.api.requests.filter(
        (r) => r.method === 'POST' && r.path === API_ROUTES.outgoingWebhooks.list,
      ),
    ).toEqual([]);
  });

  it('server menolak key (400): galat tampil, key tidak tersisa di mana pun', async () => {
    const watch = secretSpies();
    const view = await renderApp('/pengaturan/webhook', {
      routes: routes({
        [`POST ${API_ROUTES.outgoingWebhooks.list}`]: () =>
          apiError(400, 'VALIDATION_ERROR', 'API key tidak valid untuk organisasi ini.', { details: [{ field: 'mobichat.apiKey', message: 'API key tidak valid.' }] }),
      }),
    });
    await fillMobichatKey();
    await confirmIdentity(w.confirmCreateTitle, w.save);
    await waitFor(() =>
      expect(
        view.api.requests.filter(
          (r) => r.method === 'POST' && r.path === API_ROUTES.outgoingWebhooks.list,
        ),
      ).toHaveLength(1),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expectSecretNowhere(view, KEY, watch);
  });
});

describe('review keamanan — isi interaktif tetap teks', () => {
  it('daftar keluar (judul bagian, baris, deskripsi, footer, tombol daftar) & balasan pelanggan → teks', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const conversation = fakeConversation({
      status: 'served',
      assignee: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
      windowExpiresAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
    });
    await renderApp(`/inbox?chat=${conversation.id}`, {
      inbox: {
        conversations: [conversation],
        messages: {
          [conversation.id]: [
            fakeMessage({
              direction: 'outbound',
              senderKind: 'bot',
              type: 'interactive',
              text: `Pilih ${HTML}`,
              status: 'delivered',
              createdAt: new Date(Date.now() - 7_200_000).toISOString(),
              interactiveMessage: {
                kind: 'list',
                header: `Judul ${HTML}`,
                body: `Pilih ${HTML}`,
                footer: `Kaki ${HTML}`,
                buttonText: `Menu ${HTML}`.slice(0, 20),
                sections: [
                  {
                    title: `Bag ${HTML}`.slice(0, 24),
                    rows: [
                      {
                        id: 'r1',
                        title: `Baris ${HTML}`.slice(0, 24),
                        description: `Desk ${HTML}`,
                      },
                    ],
                  },
                ],
              },
            }),
            fakeMessage({
              direction: 'inbound',
              senderKind: 'customer',
              type: 'interactive',
              text: `Balasan ${HTML}`,
              createdAt: new Date(Date.now() - 3_600_000).toISOString(),
              interactive: {
                kind: 'list_reply',
                id: `../${HTML}`,
                title: `Pilihan ${HTML}`,
                description: `Desk ${HTML}`,
              },
            }),
          ],
        },
        channels: [fakeChannelSummary()],
      },
    });
    await screen.findByRole('list', { name: t.inbox.content.choicesLabel });
    noInjection();
    expect(document.body.textContent).toContain('onerror');
  });
});
