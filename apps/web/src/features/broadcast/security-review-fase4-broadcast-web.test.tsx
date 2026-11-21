/**
 * Tes penjaga review keamanan web — UI broadcast, konektor data, alarm Telegram
 * (docs/security-reviews/2026-11-21-fase4-broadcast-web.md). Semua `it` = regresi.
 */
import { API_ROUTES, apiPath, type BroadcastCampaign } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { fakeSession, json, type FakeHandler } from '../../test/fake-api';
import { fakeBroadcast, fakeReport, withRecipients } from '../../test/fake-broadcasts';
import { fakeChannelSummary } from '../../test/fake-inbox';
import { fakeTemplate } from '../../test/fake-templates';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';
import { secretSpies } from '../../test/secret-nowhere';

const R = API_ROUTES.broadcasts;
const HTML = '"><img src=x onerror="window.__xss=1">';
const TOKEN = '987654321:AAHzzzzReviewTokenTelegram_abcdefgh';
const path = (route: string, broadcastId: string) => apiPath(route, { broadcastId });

afterEach(() => {
  vi.restoreAllMocks();
});

function noInjection() {
  expect(document.querySelector('img[src="x"]')).toBeNull();
  expect(document.querySelector('[onerror]')).toBeNull();
  expect((window as { __xss?: number }).__xss).toBeUndefined();
}

function base(routes: Record<string, FakeHandler>, role: 'owner' | 'cs' | 'teknisi' = 'owner') {
  const template = fakeTemplate({ id: '7e000000-0000-4000-8000-000000000901' });
  return {
    session: fakeSession(role),
    inbox: { channels: [fakeChannelSummary()] },
    routes: {
      [`GET ${API_ROUTES.templates.list}`]: () => json({ templates: [template] }),
      [`GET ${apiPath(API_ROUTES.templates.template, { templateId: template.id })}`]: () =>
        json({ template }),
      ...routes,
    },
  };
}

/** Rahasia tidak ada di cache Query/mutasi, storage, console, atau HTML (atribut/teks). */
function expectNotLeaked(
  view: Awaited<ReturnType<typeof renderApp>>,
  secret: string,
  spies: ReturnType<typeof secretSpies>,
) {
  const cache = [
    view.queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
    view.queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => [mutation.state.data, mutation.state.variables]),
  ];
  expect(JSON.stringify(cache)).not.toContain(secret);
  for (const call of spies.setItem.mock.calls) expect(JSON.stringify(call)).not.toContain(secret);
  for (const spy of spies.logs) {
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(secret);
  }
  expect(document.documentElement.outerHTML).not.toContain(secret);
}

describe('review keamanan — data penerima & kampanye tampil sebagai teks', () => {
  it('nama kampanye, kolom & sumber CSV, alasan penolakan, alasan gagal penerima → teks', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const campaign: BroadcastCampaign = {
      ...withRecipients(fakeBroadcast({ name: `Kampanye ${HTML}`, status: 'running' }), 2, [
        'nomor',
        `nama ${HTML}`.slice(0, 40),
      ]),
      source: {
        kind: 'upload',
        label: `pelanggan ${HTML}.csv`,
        importedAt: new Date().toISOString(),
      },
    };
    const routes: Record<string, FakeHandler> = {
      [`GET ${path(R.broadcast, campaign.id)}`]: () =>
        json({
          broadcast: {
            ...campaign,
            approval: { ...campaign.approval, rejectionReason: `Tolak ${HTML}` },
          },
        }),
      [`GET ${path(R.report, campaign.id)}`]: () =>
        json({
          report: fakeReport({
            failures: [
              { reason: 'meta_rejected', errorCode: 131000, message: `Gagal ${HTML}`, count: 1 },
            ],
          }),
        }),
      [`GET ${path(R.recipients, campaign.id)}`]: () =>
        json({
          recipients: [
            {
              id: '7a000000-0000-4000-8000-000000000001',
              row: 2,
              phone: '+6281200000001',
              status: 'failed',
              skipReason: null,
              messageStatus: 'failed',
              failure: { reason: 'meta_rejected', errorCode: 131000, message: `Alasan ${HTML}` },
              conversationId: null,
              processedAt: new Date().toISOString(),
              repliedAt: null,
            },
          ],
          nextCursor: null,
        }),
    };
    await renderApp(`/broadcast/${campaign.id}`, base(routes));
    await waitFor(() => expect(document.body.textContent).toContain('Kampanye'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    noInjection();
    expect(document.body.textContent).toContain('onerror');
  });
});

describe('review keamanan — token Telegram', () => {
  const telegram = {
    configured: false,
    enabled: false,
    tokenTail: null,
    chatId: null,
    lastTest: null,
    updatedAt: null,
  };

  it('selama konfirmasi identitas & setelah dibatalkan: token tidak di cache/storage/console/HTML', async () => {
    const spies = secretSpies();
    const view = await renderApp(
      '/pengaturan/alarm',
      base({ [`GET ${API_ROUTES.alarms.telegram}`]: () => json({ telegram }) }),
    );
    expect(await screen.findByText(t.alarms.notConfiguredTitle)).toBeVisible();
    fireEvent.change(screen.getByLabelText(t.alarms.tokenLabel), { target: { value: TOKEN } });
    fireEvent.change(screen.getByLabelText(t.alarms.chatIdLabel), {
      target: { value: '-1001234567890' },
    });
    fireEvent.click(screen.getByRole('button', { name: t.alarms.save }));
    const identity = within(await screen.findByRole('dialog', { name: t.alarms.confirmTitle }));
    expectNotLeaked(view, TOKEN, spies);
    fireEvent.click(identity.getByRole('button', { name: t.identity.cancel }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: t.alarms.confirmTitle })).toBeNull(),
    );
    expectNotLeaked(view, TOKEN, spies);
    expect(view.api.requests.filter((request) => request.method === 'PUT')).toEqual([]);
  });
});

describe('review keamanan — guard halaman', () => {
  it('CS & Teknisi dialihkan dari Broadcast, Konektor data, Alarm tanpa memanggil API-nya', async () => {
    for (const role of ['cs', 'teknisi'] as const) {
      for (const target of ['/broadcast', '/pengaturan/konektor-data', '/pengaturan/alarm']) {
        const view = await renderApp(target, base({}, role));
        await waitFor(() => expect(view.router.state.location.pathname).not.toBe(target));
        const touched = view.api.requests.filter(
          (request) =>
            request.path.startsWith(R.list) ||
            request.path.startsWith(R.connectors) ||
            request.path.startsWith(API_ROUTES.alarms.telegram),
        );
        expect(touched, `${role} ${target}`).toEqual([]);
        view.unmount();
      }
    }
  });
});
