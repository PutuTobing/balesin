/**
 * Tes penjaga review keamanan web — panel detail, Batas kirim, banner channel
 * (docs/security-reviews/2026-11-19-fase2-panel-batas-kirim-web.md).
 */
import { API_ROUTES, apiPath, type SecurityEvent, type SendingLimits } from '@balesin/shared';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/id';
import { media } from '../lib/media';
import { emptySecuritySummary, fakeSession, json } from '../test/fake-api';
import {
  fakeChannelSummary,
  fakeContact,
  fakeConversation,
  fakeEvent,
  fakeNote,
  fakeTag,
} from '../test/fake-inbox';
import { setMediaQuery } from '../test/match-media';
import { renderApp } from '../test/render-app';

const HTML = '<img src=x onerror="window.__xss=1">';
const p = t.inbox.panel;

afterEach(() => {
  vi.restoreAllMocks();
});

function noInjectedElements() {
  expect(document.querySelector('img[src="x"]')).toBeNull();
  expect(document.querySelector('[onerror]')).toBeNull();
  expect((window as { __xss?: number }).__xss).toBeUndefined();
}

// ── Panel detail ────────────────────────────────────────────────────────────

const conversation = fakeConversation({
  status: 'served',
  assignee: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
  windowExpiresAt: new Date(Date.now() + 5 * 3_600_000).toISOString(),
});
const evilTag = fakeTag({ name: `VIP ${HTML}`, color: 'yellow' });
const contact = fakeContact({
  id: conversation.contact.id,
  tags: [{ id: evilTag.id, name: evilTag.name, color: evilTag.color }],
  email: 'budi@contoh.id',
  notes: `Catatan ${HTML}`,
  attributes: [{ key: `Kunci ${HTML}`, value: `Nilai ${HTML}` }],
});
const inbox = {
  conversations: [conversation],
  contacts: [contact],
  messages: { [conversation.id]: [] },
  channels: [fakeChannelSummary()],
  tags: [evilTag],
  notes: { [conversation.id]: [fakeNote({ body: `Sesi ${HTML}` })] },
  events: {
    [conversation.id]: [
      fakeEvent({ kind: 'tag_added', tag: { name: evilTag.name, color: 'yellow' } }),
    ],
  },
};

function panel() {
  return within(screen.getByRole('complementary', { name: t.inbox.detail.label }));
}

async function openPanel() {
  act(() => setMediaQuery(media.desktop, true));
  const view = await renderApp(`/inbox?chat=${conversation.id}`, { inbox });
  await panel().findByText('budi@contoh.id');
  return view;
}

describe('review keamanan — panel detail', () => {
  it('nama tag, catatan kontak, atribut tetap TEKS (bukan HTML)', async () => {
    await openPanel();
    expect(panel().getByText(`Catatan ${HTML}`)).toBeVisible();
    expect(panel().getByText(`Kunci ${HTML}`)).toBeVisible();
    expect(panel().getByText(`Nilai ${HTML}`)).toBeVisible();
    expect(panel().getAllByText(evilTag.name).length).toBeGreaterThan(0);
    noInjectedElements();
  });

  it('ekspor: GET dengan header CSRF, alamat tanpa data, tidak menulis storage, tidak ke console', async () => {
    const createObjectURL = vi.fn(() => 'blob:ekspor');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    const { api } = await openPanel();
    setItem.mockClear();
    fireEvent.click(panel().getByRole('button', { name: p.exportContact }));
    expect(await panel().findByText(p.exported)).toBeVisible();

    const path = apiPath(API_ROUTES.inbox.contactExport, { contactId: contact.id });
    const [request] = api.requests.filter((item) => item.method === 'GET' && item.path === path);
    expect(request?.headers['x-csrf-token']).toBeTruthy();
    expect([...(request?.query.keys() ?? [])]).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
    for (const spy of logs) {
      for (const args of spy.mock.calls)
        expect(JSON.stringify(args)).not.toContain('budi@contoh.id');
    }
    // Tautan unduhan sementara sudah dilepas dari DOM.
    expect(document.querySelector('a[href^="blob:"]')).toBeNull();
  });
});

// ── Batas kirim ─────────────────────────────────────────────────────────────

const pausedLimits: SendingLimits = {
  dailyPerUser: 500,
  dailyPerOrganization: 5000,
  perConversationPerMinute: 20,
  sentLast24Hours: 10,
  paused: {
    at: '2026-11-16T03:00:00.000Z',
    by: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0002', name: `Admin ${HTML}` },
    reason: `Darurat ${HTML}`,
  },
};

describe('review keamanan — Batas kirim', () => {
  it('alasan & nama penarik rem dari pengguna lain tampil sebagai teks', async () => {
    await renderApp('/pengaturan/batas-kirim', {
      routes: {
        [`GET ${API_ROUTES.sendingLimits.settings}`]: () => json({ limits: pausedLimits }),
      },
    });
    expect(
      await screen.findByText(t.sendingLimits.pausedReason(pausedLimits.paused!.reason!)),
    ).toBeVisible();
    noInjectedElements();
  });

  it('CS tidak memuat pengaturan batas (alasan/pelaku rem) walau rem ditarik', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const { api } = await renderApp(`/inbox?chat=${conversation.id}`, {
      session: fakeSession('cs'),
      inbox,
      routes: {
        [`GET ${API_ROUTES.inbox.sendingStatus}`]: () => json({ paused: true }),
        [`GET ${API_ROUTES.sendingLimits.settings}`]: () => json({ limits: pausedLimits }),
      },
    });
    await screen.findByRole('heading', { level: 1 });
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(
      api.requests.filter((item) => item.path === API_ROUTES.sendingLimits.settings),
    ).toHaveLength(0);
    expect(
      screen.queryByText(t.sendingLimits.pausedReason(pausedLimits.paused!.reason!)),
    ).toBeNull();
  });
});

// ── Banner → channel ────────────────────────────────────────────────────────

function webhookEvent(channelId: unknown): SecurityEvent {
  return {
    id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c21',
    kind: 'webhook_signature_failed',
    severity: 'warning',
    occurredAt: '2026-11-14T01:00:00.000Z',
    actor: null,
    subject: null,
    details: { channelId, failures: 5 },
  } as SecurityEvent;
}

function summaryOf(event: SecurityEvent) {
  return { ...emptySecuritySummary, events: [event], latestWarningAt: event.occurredAt };
}

describe('review keamanan — tautan banner ke channel', () => {
  it('channelId UUID sah → tautan ke halaman nomor itu', async () => {
    const id = '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0abc';
    await renderApp('/inbox', { securitySummary: summaryOf(webhookEvent(id)) });
    const link = await screen.findByRole('link', { name: t.securityBanner.reviewChannel });
    expect(link).toHaveAttribute('href', `/pengaturan/channel/${id}`);
  });

  it.each([
    ['jalur relatif', '../tim'],
    ['URL penuh', 'https://penyerang.contoh/x'],
    ['bukan string', 42],
  ])('channelId tidak sah (%s) → tidak ada tautan channel', async (_label, channelId) => {
    await renderApp('/inbox', { securitySummary: summaryOf(webhookEvent(channelId)) });
    await screen.findByRole('region', { name: t.securityBanner.title(1) });
    expect(screen.queryByRole('link', { name: t.securityBanner.reviewChannel })).toBeNull();
  });
});
